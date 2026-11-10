import { Router } from 'express'
import { tatumSuiClient, MissingApiKeyError } from '../tatum-client.mjs'
import { GrpcTypes } from '@mysten/sui/grpc'

const router = Router()

// Default network configured via env or mainnet
const network = process.env.SUI_NETWORK || 'mainnet'
const DEFAULT_ACTIVITY_LIMIT = 15
const MAX_ACTIVITY_LIMIT = 50
const MAX_ACTIVITY_PAGES = 10
// Mainnet address-index scans can take longer than simple balance/status calls.
const ACTIVITY_TIMEOUT_MS = 30_000
const STATUS_CACHE_MS = 30_000
const BALANCE_CACHE_MS = 15_000
const rpcCache = new Map()

async function cachedRpc(key, ttlMs, operation) {
  const now = Date.now()
  const cached = rpcCache.get(key)
  if (cached && cached.expiresAt > now) return cached.promise

  const promise = Promise.resolve().then(operation)
  rpcCache.set(key, { promise, expiresAt: now + ttlMs })
  try {
    return await promise
  } catch (error) {
    if (rpcCache.get(key)?.promise === promise) rpcCache.delete(key)
    throw error
  }
}

function objectChangeType(change) {
  if (change.inputState === GrpcTypes.ChangedObject_InputObjectState.DOES_NOT_EXIST) return 'created'
  if (change.outputState === GrpcTypes.ChangedObject_OutputObjectState.DOES_NOT_EXIST) return 'deleted'
  if (change.idOperation === GrpcTypes.ChangedObject_IdOperation.CREATED) return 'created'
  if (change.idOperation === GrpcTypes.ChangedObject_IdOperation.DELETED) return 'deleted'
  if (change.inputOwner?.address && change.outputOwner?.address && change.inputOwner.address !== change.outputOwner.address) return 'transferred'
  if (change.inputState === GrpcTypes.ChangedObject_InputObjectState.EXISTS && change.outputState === GrpcTypes.ChangedObject_OutputObjectState.OBJECT_WRITE) return 'mutated'
  return undefined
}

function statusForGrpcError(error) {
  const code = error?.code
  // Some gRPC gateways wrap an upstream HTTP 429 as UNAVAILABLE and only put
  // the HTTP status in the message. Preserve the throttling signal for the UI.
  if (/HTTP status code 429\b/i.test(error?.message || '')) return 429
  if (code === 'UNAUTHENTICATED' || code === 'PERMISSION_DENIED' || code === 16 || code === 7) return 401
  if (code === 'RESOURCE_EXHAUSTED' || code === 8) return 429
  if (code === 'UNAVAILABLE' || code === 14) return 503
  if (code === 'DEADLINE_EXCEEDED' || code === 4) return 504
  return 502
}

function grpcErrorMessage(error) {
  const status = statusForGrpcError(error)
  if (status === 401) return 'Tatum rejected the API key or does not allow Sui gRPC access. Check the key and enabled product.'
  if (status === 429) return 'Tatum rate limit reached. Please wait a moment.'
  if (status === 503) return 'Tatum Sui gRPC is temporarily unavailable.'
  if (status === 504) return 'Tatum Sui gRPC request timed out.'
  const detail = typeof error?.message === 'string' ? error.message : ''
  if (detail.includes('Cannot read properties of undefined')) {
    return 'Tatum Sui gRPC returned an empty health response. Check that this API key has Sui gRPC access enabled.'
  }
  return detail || 'Tatum Sui gRPC request failed.'
}

function logGrpcFailure(route, error) {
  console.error(`[Tatum Sui gRPC] ${route}: ${error?.code || 'UNKNOWN'} ${error?.message || 'No error detail'}`)
}

async function withSuiClient(operation, timeoutMs) {
  const client = tatumSuiClient(network, timeoutMs)
  try {
    return await operation(client)
  } finally {
    client.close()
  }
}

async function getServiceInfo() {
  return cachedRpc(`service-info:${network}`, STATUS_CACHE_MS, async () => {
    const { response } = await withSuiClient(client => client.ledgerService.getServiceInfo({}), ACTIVITY_TIMEOUT_MS)
    return response
  })
}

function historyCoverageNote(lowestAvailableCheckpoint) {
  if (lowestAvailableCheckpoint === undefined || lowestAvailableCheckpoint === 0n) return null
  return `Tatum's available Sui transaction history starts at checkpoint ${lowestAvailableCheckpoint}. Earlier activity cannot be loaded through this endpoint.`
}

function earliestAvailableCheckpointFromError(error) {
  const match = String(error?.message || '').match(/lowest available checkpoint is\s+(\d+)/i)
  return match ? BigInt(match[1]) : undefined
}

function grpcTimestampToMs(timestamp) {
  if (!timestamp) return undefined
  return Number(timestamp.seconds) * 1000 + Math.floor((timestamp.nanos || 0) / 1_000_000)
}

function normalizeAddress(address) {
  return `0x${String(address || '').replace(/^0x/i, '').toLowerCase().padStart(64, '0')}`
}

function sameAddress(left, right) {
  return Boolean(left && right) && normalizeAddress(left) === normalizeAddress(right)
}

function addressFromArgument(programmable, argument) {
  if (argument?.input === undefined) return undefined
  const input = programmable?.inputs?.[argument.input]
  const literal = input?.literal?.kind
  if (literal?.oneofKind === 'stringValue' && /^0x[0-9a-f]{1,64}$/i.test(literal.stringValue)) {
    return normalizeAddress(literal.stringValue)
  }
  const bytes = input?.pure
  if (bytes instanceof Uint8Array && bytes.length === 32) {
    return `0x${Buffer.from(bytes).toString('hex')}`
  }
  return undefined
}

function coinName(coinType) {
  if (!coinType) return 'asset'
  const match = coinType.match(/::([A-Za-z0-9_]+)$/)
  return match?.[1] || 'asset'
}

function objectActionCounts(changedObjects = []) {
  return changedObjects.reduce((counts, change) => {
    const action = objectChangeType(change)
    if (action) counts[action] = (counts[action] || 0) + 1
    return counts
  }, {})
}

function formatObjectActions(counts) {
  const entries = [
    ['created', 'created'],
    ['mutated', 'updated'],
    ['transferred', 'transferred'],
    ['deleted', 'deleted'],
  ].filter(([action]) => counts[action])
  if (!entries.length) return ''
  return entries.map(([action, label]) => `${counts[action]} ${label}`).join(', ')
}

function formatMist(value, places = 4) {
  const amount = BigInt(value)
  const negative = amount < 0n
  const absolute = negative ? -amount : amount
  const whole = absolute / 1_000_000_000n
  const fractional = (absolute % 1_000_000_000n) / (10n ** BigInt(9 - places))
  return `${negative ? '-' : ''}${whole}.${fractional.toString().padStart(places, '0')}`
}

export function transformGrpcTransaction(tx, address) {
  const transaction = tx.transaction
  const effects = tx.effects
  const status = effects?.status?.success === undefined ? 'unknown' : effects.status.success ? 'success' : 'failure'
  const balanceChanges = (tx.balanceChanges || []).filter(change => sameAddress(change.address, address) && change.amount !== undefined)
  const assetBalanceChanges = [...balanceChanges.reduce((byType, change) => {
    const coinType = change.coinType || 'unknown'
    byType.set(coinType, (byType.get(coinType) || 0n) + BigInt(change.amount))
    return byType
  }, new Map())]
    .filter(([, amount]) => amount !== 0n)
    .map(([coinType, amount]) => ({ coinType, amount: amount.toString() }))
  const balanceChange = balanceChanges.find(change => change.coinType?.toLowerCase().endsWith('::sui::sui'))
  const amount = balanceChange
    ? formatMist((BigInt(balanceChange.amount) < 0n ? -BigInt(balanceChange.amount) : BigInt(balanceChange.amount)).toString())
    : undefined
  const gas = effects?.gasUsed
  const gasMist = gas
    ? BigInt(gas.computationCost || 0) + BigInt(gas.storageCost || 0) - BigInt(gas.storageRebate || 0)
    : undefined
  const programmable = transaction?.kind?.data?.oneofKind === 'programmableTransaction'
    ? transaction.kind.data.programmableTransaction
    : undefined
  const commands = programmable?.commands || []
  const moveCalls = commands.flatMap(command => command.command?.oneofKind === 'moveCall' ? [command.command.moveCall] : [])
  const moveCall = moveCalls[0]
  const moduleName = moveCall?.module
  const functionName = moveCall?.function
  const packageId = moveCall?.package
  const isSealAccessCheck = moveCalls.some(call => call.module === 'account' && call.function === 'seal_encrypt_fence')
  const changedObjects = effects?.changedObjects
  const changedObjectCount = Array.isArray(changedObjects) ? changedObjects.length : undefined
  const actionCounts = objectActionCounts(changedObjects)
  const objectActionText = formatObjectActions(actionCounts)
  const sender = transaction?.sender || address
  const sentObjects = (isSealAccessCheck ? [] : changedObjects || []).filter(change =>
    sameAddress(change.inputOwner?.address, address) &&
    change.outputOwner?.address && !sameAddress(change.inputOwner?.address, change.outputOwner.address)
  )
  const receivedObjects = (isSealAccessCheck ? [] : changedObjects || []).filter(change =>
    change.inputOwner?.address && sameAddress(change.outputOwner?.address, address) &&
    !sameAddress(change.inputOwner.address, change.outputOwner.address)
  )
  const recipientCandidates = new Set()
  const recipientFrom = argument => {
    const candidate = addressFromArgument(programmable, argument)
    if (candidate && !sameAddress(candidate, address)) recipientCandidates.add(candidate)
    return candidate
  }
  const nativeTransfers = []
  const splitCommands = commands.filter(command => command.command?.oneofKind === 'splitCoins')
  const mergeCommands = commands.filter(command => command.command?.oneofKind === 'mergeCoins')
  const publishCommands = commands.filter(command => command.command?.oneofKind === 'publish')
  const upgradeCommands = commands.filter(command => command.command?.oneofKind === 'upgrade')
  for (const command of commands) {
    const action = command.command
    if (action?.oneofKind === 'transferObjects') {
      if (!isSealAccessCheck) {
        const transfer = action.transferObjects
        const transferRecipient = recipientFrom(transfer.address)
        nativeTransfers.push({ objectCount: transfer.objects.length, recipient: transferRecipient })
      }
    } else if (action?.oneofKind === 'moveCall') {
      const call = action.moveCall
      const frameworkCall = call.package && normalizeAddress(call.package) === normalizeAddress('0x2')
      const isFundsSend = frameworkCall && ['coin', 'balance'].includes(call.module) && ['send_funds', 'send_funds_to_address'].includes(call.function)
      const isObjectTransfer = frameworkCall && call.module === 'transfer' && ['transfer', 'public_transfer', 'public_transfer_impl'].includes(call.function)
      if (isFundsSend || isObjectTransfer) recipientFrom(call.arguments?.at(-1))
    }
  }
  for (const change of sentObjects) {
    if (!sameAddress(change.outputOwner?.address, address)) recipientCandidates.add(normalizeAddress(change.outputOwner.address))
  }
  const recipient = recipientCandidates.size === 1 ? [...recipientCandidates][0] : undefined
  const objectChanges = (changedObjects || []).slice(0, 5).flatMap(change => {
    const type = objectChangeType(change)
    return type && change.objectId ? [{ objectId: change.objectId, type, objectType: change.objectType }] : []
  })
  const objectTypeChanges = [...(changedObjects || []).reduce((counts, change) => {
    const type = objectChangeType(change)
    if (!['created', 'mutated', 'deleted', 'transferred'].includes(type) || !change.objectType || /::coin::Coin</i.test(change.objectType)) return counts
    const key = `${type}|${change.objectType}`
    counts.set(key, (counts.get(key) || 0) + 1)
    return counts
  }, new Map())].map(([key, count]) => {
    const [type, objectType] = key.split('|')
    return { type, objectType, count }
  })
  const digest = tx.digest || transaction?.digest || ''
  const isMemWalAccountCreation = moduleName === 'account' && functionName === 'create_account' &&
    (changedObjects || []).some(change => change.objectType?.includes('::account::MemWalAccount'))
  const knownCallSummary = isMemWalAccountCreation
    ? 'Created a Walrus Memory account to manage encrypted memories.'
    : moveCalls.some(call => call.module === 'account' && call.function === 'add_delegate_key')
      ? 'Registered a delegate for the Walrus Memory account.'
    : moveCalls.some(call => call.module === 'account' && call.function === 'create_account')
      ? 'Created an on-chain account record.'
    : isSealAccessCheck
        ? 'Checked the Seal access rule used to protect encrypted data.'
        : moveCalls.some(call => call.module === 'kiosk' && call.function === 'purchase')
          ? 'Purchased an item through a Sui kiosk.'
          : moveCalls.some(call => call.module === 'kiosk' && ['list', 'list_with_purchase_cap'].includes(call.function))
            ? 'Listed an item in a Sui kiosk.'
            : moveCalls.some(call => call.module === 'kiosk' && ['delist', 'delist_with_purchase_cap'].includes(call.function))
              ? 'Removed an item listing from a Sui kiosk.'
              : undefined
  const moveCallNames = [...new Set(moveCalls.map(call => [call.module, call.function].filter(Boolean).join('::')).filter(Boolean))]
  const mainCallDescription = moveCallNames.length
    ? `Called ${moveCallNames.slice(0, 2).join(' and ')}${moveCallNames.length > 2 ? ` and ${moveCallNames.length - 2} other contract function${moveCallNames.length === 3 ? '' : 's'}` : ''}.`
    : undefined
  const balanceDescription = balanceChange
    ? `Your wallet's net SUI balance ${BigInt(balanceChange.amount) < 0n ? 'decreased' : 'increased'} by ${amount} SUI, including gas and other SUI changes.`
    : undefined
  const tokenBalanceDescriptions = [...balanceChanges
    .filter(change => !change.coinType?.toLowerCase().endsWith('::sui::sui'))
    .reduce((byType, change) => {
      const coinType = change.coinType || 'unknown token'
      byType.set(coinType, (byType.get(coinType) || 0n) + BigInt(change.amount))
      return byType
    }, new Map())]
    .filter(([, delta]) => delta !== 0n)
    .slice(0, 3)
    .map(([coinType, delta]) => `Your ${coinName(coinType)} balance ${delta < 0n ? 'decreased' : 'increased'} by ${delta < 0n ? -delta : delta} base units; token decimals were not included in Tatum's response.`)
  const changeDescription = changedObjectCount === undefined
    ? undefined
    : changedObjectCount === 0
      ? 'No on-chain objects changed.'
      : `On-chain object changes: ${objectActionText || `${changedObjectCount} records changed`}${changedObjectCount > 5 ? ` (${changedObjectCount} total)` : ''}.`
  const sentObjectDescription = sentObjects.length
    ? `Transferred ${sentObjects.length} object${sentObjects.length === 1 ? '' : 's'}${recipient ? ` to ${recipient}` : ''}.`
    : undefined
  const receivedObjectDescription = receivedObjects.length
    ? `Received ${receivedObjects.length} object${receivedObjects.length === 1 ? '' : 's'} from another address.`
    : undefined
  const nativeTransferDescription = nativeTransfers.length
    ? `Transferred ${nativeTransfers.reduce((count, transfer) => count + transfer.objectCount, 0)} object${nativeTransfers.reduce((count, transfer) => count + transfer.objectCount, 0) === 1 ? '' : 's'}${recipient ? ` to ${recipient}` : ''}.`
    : undefined
  const knownFundsTransfer = moveCalls.some(call => call.package && normalizeAddress(call.package) === normalizeAddress('0x2') &&
    ['coin', 'balance'].includes(call.module) && ['send_funds', 'send_funds_to_address'].includes(call.function))
  const failureDescription = effects?.status?.error?.description
    ? String(effects.status.error.description).replace(/\s+/g, ' ').slice(0, 240)
    : undefined
  const summary = status === 'failure'
    ? `This transaction failed${failureDescription ? `: ${failureDescription}` : ''}. The wallet may still have paid a network fee.`
    : status === 'unknown'
      ? 'This transaction was found, but its execution result is unavailable.'
      : [
          knownCallSummary,
          nativeTransferDescription,
          knownFundsTransfer ? `Sent funds${recipient ? ` to ${recipient}` : ''} using Sui's address-balance transfer function.` : undefined,
          nativeTransferDescription ? undefined : sentObjectDescription,
          receivedObjectDescription,
          !knownCallSummary && !nativeTransferDescription && !knownFundsTransfer && !sentObjectDescription && !receivedObjectDescription ? mainCallDescription : undefined,
          balanceDescription,
          ...tokenBalanceDescriptions,
          splitCommands.length ? `Split coins in ${splitCommands.length} command${splitCommands.length === 1 ? '' : 's'}.` : undefined,
          mergeCommands.length ? `Merged coins in ${mergeCommands.length} command${mergeCommands.length === 1 ? '' : 's'}.` : undefined,
          publishCommands.length ? `Published ${publishCommands.length} Move package${publishCommands.length === 1 ? '' : 's'}.` : undefined,
          upgradeCommands.length ? `Upgraded ${upgradeCommands.length} Move package${upgradeCommands.length === 1 ? '' : 's'}.` : undefined,
          changeDescription,
          !knownCallSummary && !mainCallDescription && !nativeTransferDescription && !knownFundsTransfer && !sentObjectDescription && !receivedObjectDescription && !balanceDescription && !changeDescription && !splitCommands.length && !mergeCommands.length && !publishCommands.length && !upgradeCommands.length
            ? 'Tatum returned no balance or object effects that identify the action performed.'
            : undefined,
        ].filter(Boolean).join(' ')

  return {
    digest,
    timestampMs: grpcTimestampToMs(tx.timestamp),
    status,
    kind: transaction?.kind?.kind === undefined ? 'Transaction' : String(transaction.kind.kind),
    sender,
    recipient,
    amount,
    balanceChangeDirection: balanceChange
      ? BigInt(balanceChange.amount) < 0n ? 'decrease' : 'increase'
      : undefined,
    coinType: balanceChange?.coinType,
    assetBalanceChanges,
    objectChangesCount: changedObjects?.length,
    objectChanges,
    objectTypeChanges,
    verifiedFacts: {
      gasUsed: gasMist === undefined ? undefined : `${formatMist(gasMist, 6)} SUI`,
      executedEpoch: effects?.epoch?.toString(),
      packageId,
      moduleName,
      functionName,
    },
    generatedSummary: summary,
  }
}

// 1. Health check & configuration status
router.get('/status', async (_req, res) => {
  const hasKey = Boolean(process.env.TATUM_API_KEY)
  if (!hasKey) {
    return res.json({
      status: 'no-api-key',
      network,
      message: 'TATUM_API_KEY is not set for this workspace.'
    })
  }

  try {
    const serviceInfo = await getServiceInfo()
    if (!serviceInfo) throw new Error('Tatum Sui gRPC returned no service information.')
    res.json({
      status: 'connected',
      network,
      tatumRpc: 'active',
      chain: serviceInfo.chain,
      latestCheckpoint: serviceInfo.checkpointHeight?.toString(),
    })
  } catch (error) {
    logGrpcFailure('status', error)
    const httpStatus = error instanceof MissingApiKeyError ? 401 : statusForGrpcError(error)
    if (httpStatus === 429) res.set('Retry-After', '5')
    res.status(httpStatus).json({
      status: error instanceof MissingApiKeyError ? 'no-api-key' : 'rpc-unavailable',
      network,
      message: error instanceof MissingApiKeyError ? error.message : grpcErrorMessage(error),
    })
  }
})

// Query indexed transactions where the selected address was affected, in descending order.
// Diagnostic endpoint: verify a known transaction directly, then check whether the
// affected-address index returns it at its exact checkpoint.
router.get('/activity-diagnostic/:address/:digest', async (req, res) => {
  const { address, digest } = req.params
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(address || '')) {
    return res.status(400).json({ error: 'Valid Sui public wallet address required.' })
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(digest || '')) {
    return res.status(400).json({ error: 'Valid Sui transaction digest required.' })
  }

  const normalizedAddress = normalizeAddress(address)
  try {
    const diagnostic = await withSuiClient(async client => {
      const transaction = await client.getTransaction({
        digest,
        include: { transaction: true, effects: true, balanceChanges: true },
      })
      const checkpoint = transaction.checkpoint
      const sender = transaction.transaction?.sender
      const balanceChanges = transaction.balanceChanges || []
      const addressBalanceChanges = balanceChanges.filter(change =>
        change.address?.toLowerCase() === normalizedAddress.toLowerCase()
      )

      let indexedMatch = false
      let indexQueryEndReason
      if (checkpoint !== null && checkpoint !== undefined) {
        const checkpointNumber = BigInt(checkpoint)
        const call = client.ledgerService.listTransactions({
          startCheckpoint: checkpointNumber,
          endCheckpoint: checkpointNumber + 1n,
          filter: {
            terms: [{
              literals: [{
                negated: false,
                predicate: { oneofKind: 'affectedAddress', affectedAddress: { address: normalizedAddress } },
              }],
            }],
          },
          readMask: { paths: ['digest'] },
          options: { limit: 50, ordering: 1 },
        })
        for await (const frame of call.responses) {
          if (frame.transaction?.digest === digest) indexedMatch = true
          if (frame.end?.reason !== undefined) indexQueryEndReason = frame.end.reason
        }
      }

      return {
        digest,
        foundByDigest: true,
        timestampMs: transaction.timestampMs,
        checkpoint,
        sender,
        addressIsSender: sender?.toLowerCase() === normalizedAddress.toLowerCase(),
        addressBalanceChanges,
        affectedAddressIndexMatch: indexedMatch,
        indexQueryEndReason: indexQueryEndReason ?? null,
      }
    })
    return res.json({ address, network, ...diagnostic })
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return res.status(401).json({ error: error.message, status: 'no-api-key' })
    }
    if (error?.name === 'TransactionError' && error?.reason === 'notFound') {
      return res.status(404).json({
        address,
        digest,
        network,
        foundByDigest: false,
        affectedAddressIndexMatch: null,
        message: 'Tatum Sui gRPC could not find this transaction by digest.',
      })
    }
    logGrpcFailure('activity-diagnostic', error)
    return res.status(statusForGrpcError(error)).json({ error: grpcErrorMessage(error) })
  }
})

router.get('/activity/:address', async (req, res) => {
  const { address } = req.params
  const pageSize = Math.min(Math.max(Number(req.query.pageSize) || DEFAULT_ACTIVITY_LIMIT, 1), MAX_ACTIVITY_LIMIT)
  const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : ''
  const requestedEndCheckpoint = typeof req.query.endCheckpoint === 'string' ? req.query.endCheckpoint : ''
  if (requestedEndCheckpoint && !/^\d+$/.test(requestedEndCheckpoint)) {
    return res.status(400).json({ error: 'Invalid end checkpoint. Fetch the first page again.' })
  }
  if (cursor && (!/^[A-Za-z0-9+/]+={0,2}$/.test(cursor) || Buffer.from(cursor, 'base64').toString('base64').replace(/=+$/, '') !== cursor.replace(/=+$/, ''))) {
    return res.status(400).json({ error: 'Invalid activity cursor. Fetch the first page again.' })
  }

  if (!address || !/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
    return res.status(400).json({ error: 'Valid Sui public wallet address required (0x followed by 1–64 hexadecimal characters).' })
  }
  const normalizedAddress = normalizeAddress(address)

  try {
    const serviceInfo = await getServiceInfo()
    let lowestAvailableCheckpoint = serviceInfo?.lowestAvailableCheckpoint == null
      ? undefined
      : BigInt(serviceInfo.lowestAvailableCheckpoint)

    // endCheckpoint is exclusive. If pagination has reached (or crossed) the
    // provider's retention floor, return a clean terminal page instead of
    // asking the gRPC service for pruned history.
    if (requestedEndCheckpoint && lowestAvailableCheckpoint !== undefined &&
      BigInt(requestedEndCheckpoint) <= lowestAvailableCheckpoint) {
      return res.json({
        address,
        network,
        method: 'tatum-sui-grpc',
        count: 0,
        transactions: [],
        hasNextPage: false,
        nextCursor: null,
        nextEndCheckpoint: null,
        lowestAvailableCheckpoint: lowestAvailableCheckpoint.toString(),
        historyCoverageNote: historyCoverageNote(lowestAvailableCheckpoint),
        paginationDiagnostics: {
          endReason: 3,
          endReasonName: 'CHECKPOINT_BOUND',
          requestedEndCheckpoint,
          lowestAvailableCheckpoint: lowestAvailableCheckpoint.toString(),
          stoppedAtRetentionFloor: true,
        },
        pageSize,
        pageLimit: MAX_ACTIVITY_PAGES,
      })
    }

    const { rawTransactions, nextCursor, endReason, watermarkCheckpoint, rangeErrorFloor } = await withSuiClient(async client => {
      const call = client.ledgerService.listTransactions({
        filter: {
          terms: [{
            literals: [{
              negated: false,
              predicate: { oneofKind: 'affectedAddress', affectedAddress: { address: normalizedAddress } },
            }],
          }],
        },
        ...(lowestAvailableCheckpoint !== undefined ? { startCheckpoint: lowestAvailableCheckpoint } : {}),
        ...(requestedEndCheckpoint ? { endCheckpoint: BigInt(requestedEndCheckpoint) } : {}),
        readMask: { paths: ['digest', 'transaction', 'effects', 'balance_changes', 'timestamp', 'checkpoint', 'objects'] },
        options: {
          limit: pageSize,
          ordering: 1,
          ...(cursor ? { before: Buffer.from(cursor, 'base64') } : {}),
        },
      })
      const transactions = []
      let pageCursor
      let pageEndReason
      let pageWatermarkCheckpoint
      let pageRangeErrorFloor
      try {
        for await (const frame of call.responses) {
          if (frame.transaction) transactions.push(frame.transaction)
          if (frame.watermark?.cursor) pageCursor = Buffer.from(frame.watermark.cursor).toString('base64')
          if (frame.watermark?.checkpoint !== undefined) pageWatermarkCheckpoint = frame.watermark.checkpoint.toString()
          if (frame.end?.reason !== undefined) pageEndReason = frame.end.reason
        }
      } catch (error) {
        pageRangeErrorFloor = earliestAvailableCheckpointFromError(error)
        if (pageRangeErrorFloor === undefined) throw error
        // Some gateways stream matching records and then signal that the scan
        // hit their retention floor. Keep those records and stop pagination.
        pageEndReason = 3
        pageWatermarkCheckpoint = pageRangeErrorFloor.toString()
        pageCursor = undefined
      }
      return {
        rawTransactions: transactions,
        nextCursor: pageCursor,
        endReason: pageEndReason,
        watermarkCheckpoint: pageWatermarkCheckpoint,
        rangeErrorFloor: pageRangeErrorFloor,
      }
    }, ACTIVITY_TIMEOUT_MS)
    if (rangeErrorFloor !== undefined &&
      (lowestAvailableCheckpoint === undefined || rangeErrorFloor > lowestAvailableCheckpoint)) {
      lowestAvailableCheckpoint = rangeErrorFloor
    }
    const transformed = rawTransactions.map(tx => transformGrpcTransaction(tx, normalizedAddress))
    const cursorAdvanced = Boolean(nextCursor && nextCursor !== cursor)
    const watermarkNumber = watermarkCheckpoint ? BigInt(watermarkCheckpoint) : undefined
    const aboveRetentionFloor = watermarkNumber !== undefined &&
      (lowestAvailableCheckpoint === undefined || watermarkNumber > lowestAvailableCheckpoint)
    const checkpointAdvanced = Boolean(
      aboveRetentionFloor &&
      (!requestedEndCheckpoint || watermarkNumber < BigInt(requestedEndCheckpoint))
    )
    // Cursor pagination continues a page/scan limit. At a checkpoint range
    // boundary, open the next older range with that checkpoint as its exclusive end.
    const useCursorContinuation = (endReason === 1 || endReason === 2) && cursorAdvanced
    const nextEndCheckpoint = endReason === 3 && checkpointAdvanced ? watermarkCheckpoint : requestedEndCheckpoint || null
    const hasNextPage = useCursorContinuation || (endReason === 3 && checkpointAdvanced)

    res.json({
      address,
      network,
      method: 'tatum-sui-grpc',
      count: transformed.length,
      transactions: transformed,
      hasNextPage,
      nextCursor: useCursorContinuation ? nextCursor : null,
      nextEndCheckpoint: hasNextPage ? nextEndCheckpoint : null,
      paginationDiagnostics: {
        endReason: endReason ?? null,
        endReasonName: endReason === 1 ? 'ITEM_LIMIT' : endReason === 2 ? 'SCAN_LIMIT' : endReason === 3 ? 'CHECKPOINT_BOUND' : endReason === 4 ? 'CURSOR_BOUND' : endReason === 5 ? 'LEDGER_TIP' : 'UNKNOWN',
        cursorReceived: Boolean(nextCursor),
        cursorLength: nextCursor?.length ?? 0,
        cursorAdvanced,
        watermarkCheckpoint: watermarkCheckpoint ?? null,
        requestedEndCheckpoint: requestedEndCheckpoint || null,
        checkpointAdvanced,
        lowestAvailableCheckpoint: lowestAvailableCheckpoint?.toString() ?? null,
        stoppedAtRetentionFloor: endReason === 3 && !checkpointAdvanced,
      },
      pageSize,
      pageLimit: MAX_ACTIVITY_PAGES,
      coverageNote: `Sui gRPC returns indexed transactions where the wallet was affected. Each page contains at most ${MAX_ACTIVITY_LIMIT} transactions. The service may stop earlier at its scan budget; a next cursor indicates more results.`,
      lowestAvailableCheckpoint: lowestAvailableCheckpoint?.toString() ?? null,
      historyCoverageNote: historyCoverageNote(lowestAvailableCheckpoint),
    })
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return res.status(401).json({ error: error.message, status: 'no-api-key' })
    }
    logGrpcFailure('activity', error)
    if (statusForGrpcError(error) === 429) res.set('Retry-After', '5')
    res.status(statusForGrpcError(error)).json({ error: grpcErrorMessage(error) })
  }
})

// Query native SUI and the first page of indexed coin balances.
router.get('/balance/:address', async (req, res) => {
  const { address } = req.params
  if (!address || !/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
    return res.status(400).json({ error: 'Valid Sui address required' })
  }
  const normalizedAddress = normalizeAddress(address)

  try {
    const suiBalance = await cachedRpc(`balance:${network}:${normalizedAddress}`, BALANCE_CACHE_MS, () =>
      withSuiClient(client => client.getBalance({ owner: normalizedAddress, coinType: '0x2::sui::SUI' }))
    )
    return res.json({
      address,
      network,
      suiBalance: formatMist(suiBalance.balance.balance || '0'),
    })
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return res.status(401).json({ error: error.message, status: 'no-api-key' })
    }
    logGrpcFailure('balance', error)
    if (statusForGrpcError(error) === 429) res.set('Retry-After', '5')
    res.status(statusForGrpcError(error)).json({ error: grpcErrorMessage(error) })
  }
})

// Query the first page of wallet-owned objects.
router.get('/objects/:address', async (req, res) => {
  const { address } = req.params
  if (!address || !/^0x[0-9a-fA-F]{1,64}$/.test(address)) {
    return res.status(400).json({ error: 'Valid Sui public wallet address required.' })
  }
  const normalizedAddress = normalizeAddress(address)
  try {
    const objects = await withSuiClient(client => client.listOwnedObjects({ owner: normalizedAddress, limit: 50 }))
    return res.json({
      address,
      network,
      objectCount: objects.objects.length,
      hasNextPage: objects.hasNextPage,
    })
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      return res.status(401).json({ error: error.message, status: 'no-api-key' })
    }
    logGrpcFailure('objects', error)
    res.status(statusForGrpcError(error)).json({ error: grpcErrorMessage(error) })
  }
})

export default router
