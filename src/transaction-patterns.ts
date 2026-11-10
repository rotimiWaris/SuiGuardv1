import type { TransactionItem } from './App'

export interface TransactionMemoryContext {
  type: 'suiguard-transaction-context'
  version: 1
  walletAddress: string
  txDigest: string
  label: 'familiar' | 'unfamiliar' | 'misunderstood'
  explanation: string
  knownApp?: string
  transactionSummary: string
  reviewedAt: string
  network?: 'mainnet' | 'testnet'
  direction?: 'incoming' | 'outgoing' | 'other'
  coinType?: string
  counterparty?: string
  initiatorAddress?: string
  moduleName?: string
  functionName?: string
  assetFlowSignature?: string
  objectTypeFlowSignature?: string
}

export function getTransactionDirection(tx: TransactionItem, walletAddress?: string): 'incoming' | 'outgoing' | 'other' {
  const summary = tx.generatedSummary.toLowerCase()
  const normalizedWallet = walletAddress ? normalizeSuiAddress(walletAddress) : undefined
  const normalizedSender = tx.sender ? normalizeSuiAddress(tx.sender) : undefined
  const senderIsWallet = Boolean(normalizedWallet && normalizedSender === normalizedWallet)

  if (normalizedWallet && normalizedSender && !senderIsWallet) return 'incoming'
  if (senderIsWallet && tx.recipient && normalizeSuiAddress(tx.recipient) !== normalizedWallet) return 'outgoing'
  if (tx.balanceChangeDirection === 'increase') return 'incoming'
  if (tx.balanceChangeDirection === 'decrease') {
    if (/\b(sent funds|sent sui|transferred .* to 0x|net decrease .* observed transfers)\b/.test(summary)) return 'outgoing'
  }
  if (/\bnet increase\b|\bincoming transfer\b/.test(summary)) return 'incoming'
  if (/\bnet decrease\b|\bsent funds\b|\boutgoing transfer\b/.test(summary)) return 'outgoing'
  return 'other'
}

function normalizeSuiAddress(address: string): string {
  const hex = address.toLowerCase().replace(/^0x/, '').replace(/^0+/, '') || '0'
  return `0x${hex}`
}

function getMemoryCall(memory: TransactionMemoryContext): { moduleName?: string; functionName?: string } {
  const summaryCall = memory.transactionSummary.match(/(?:^|\n)Function:\s*([\w]+)::([\w]+)/i)
  return {
    moduleName: memory.moduleName || summaryCall?.[1],
    functionName: memory.functionName || summaryCall?.[2],
  }
}

function isRouterSwap(moduleName?: string, functionName?: string): boolean {
  return moduleName?.toLowerCase() === 'router' && Boolean(functionName && /swap/i.test(functionName))
}

export function isAssetSwapFlow(signature: string | undefined): boolean {
  if (!signature?.startsWith('balance|')) return false
  const directions = [...signature.matchAll(/(?:^|\|)[^|:]+:(decreased|increased)(?=\||$)/g)].map(match => match[1])
  return directions.includes('decreased') && directions.includes('increased')
}

export function getAssetFlowSignature(tx: TransactionItem): string | undefined {
  const balanceFlows = (tx.assetBalanceChanges || []).flatMap(change => {
    try {
      const amount = BigInt(change.amount)
      if (amount === 0n) return []
      const symbol = change.coinType.match(/::([a-zA-Z0-9_]+)$/)?.[1]?.toUpperCase()
      if (!symbol) return []
      return [`${symbol}:${amount < 0n ? 'decreased' : 'increased'}`]
    } catch {
      return []
    }
  }).sort()
  if (balanceFlows.length) return `balance|${balanceFlows.join('|')}`

  const summaryFlows = getSummaryAssetFlows(tx.generatedSummary)
  if (summaryFlows.length) return `balance|${summaryFlows.join('|')}`

  const flows = (tx.objectChanges || []).flatMap(change => {
    if (!change.objectType) return []
    return [`${change.type}:${normalizeCoinType(change.objectType)}`]
  }).sort()
  return flows.length ? `objects|${flows.join('|')}` : undefined
}

export function getObjectTypeFlowSignature(tx: TransactionItem): string | undefined {
  const counts = new Map<string, number>()
  for (const item of tx.objectTypeChanges || []) {
    if (!item.objectType || !['created', 'mutated', 'deleted', 'transferred'].includes(item.type) || /::coin::Coin</i.test(item.objectType)) continue
    const key = `${item.type}:${normalizeCoinType(item.objectType)}`
    counts.set(key, (counts.get(key) || 0) + item.count)
  }
  if (!tx.objectTypeChanges?.length) {
    for (const change of tx.objectChanges || []) {
      if (!['created', 'mutated', 'deleted', 'transferred'].includes(change.type) || !change.objectType || /::coin::Coin</i.test(change.objectType)) continue
      const key = `${change.type}:${normalizeCoinType(change.objectType)}`
      counts.set(key, (counts.get(key) || 0) + 1)
    }
  }
  const flows = [...counts].sort(([left], [right]) => left.localeCompare(right))
    .map(([type, count]) => `${type}${count > 1 ? `x${count}` : ''}`)
  return flows.length ? `objects|${flows.join('|')}` : undefined
}

export function getSavedAssetFlowSignature(memory: TransactionMemoryContext): string | undefined {
  if (memory.assetFlowSignature?.startsWith('balance|')) return memory.assetFlowSignature
  if (memory.assetFlowSignature?.startsWith('objects|')) return memory.assetFlowSignature
  const savedFlowLine = memory.transactionSummary.match(/(?:^|\n)Observed asset flow:\s*((?:balance|objects)\|[^\n]+)/i)?.[1]?.trim()
  if (savedFlowLine) return savedFlowLine
  const summary = memory.transactionSummary.match(/(?:^|\n)Summary:\s*([\s\S]*?)(?=\n(?:Coin:|Sender:|Function:|Coin object flow:|Asset balance flow:)|$)/i)?.[1]
  const summaryFlows = getSummaryAssetFlows(summary || memory.transactionSummary)
  if (summaryFlows.length) return `balance|${summaryFlows.join('|')}`
  const legacyObjectFlow = memory.transactionSummary.match(/(?:^|\n)Coin object flow:\s*(.+)/i)?.[1]?.trim()
  return legacyObjectFlow ? `objects|${legacyObjectFlow}` : undefined
}

function getSavedObjectTypeFlowSignature(memory: TransactionMemoryContext): string | undefined {
  if (memory.objectTypeFlowSignature?.startsWith('objects|')) return memory.objectTypeFlowSignature
  return memory.transactionSummary.match(/(?:^|\n)Observed object type flow:\s*(objects\|[^\n]+)/i)?.[1]?.trim()
}

function getSummaryAssetFlows(summary: string): string[] {
  const flows: string[] = []
  const sui = summary.match(/net SUI balance\s+(decreased|increased)/i)
  if (sui) flows.push(`SUI:${sui[1].toLowerCase()}`)
  for (const match of summary.matchAll(/Your\s+([a-zA-Z0-9_]+)\s+balance\s+(decreased|increased)\s+by\s+[\d,]+\s+base units/gi)) {
    if (match[1].toUpperCase() !== 'SUI') flows.push(`${match[1].toUpperCase()}:${match[2].toLowerCase()}`)
  }
  return [...new Set(flows)].sort()
}

export function normalizeCoinType(coinType: string): string {
  return coinType.toLowerCase().replace(/0x[0-9a-f]+/g, address => normalizeSuiAddress(address))
}

export function isRelevantTransactionMemory(
  memory: TransactionMemoryContext,
  walletAddress: string,
  network: 'mainnet' | 'testnet',
  tx: TransactionItem,
  distance: number,
): boolean {
  if (normalizeSuiAddress(memory.walletAddress) !== normalizeSuiAddress(walletAddress)) return false
  if (memory.network && memory.network !== network) return false
  if (memory.txDigest === tx.digest) return true

  const direction = getTransactionDirection(tx, walletAddress)

  const txCounterparties = [tx.sender, tx.recipient]
    .filter((counterparty): counterparty is string => Boolean(counterparty))
    .map(normalizeSuiAddress)
    .filter(counterparty => counterparty !== normalizeSuiAddress(walletAddress))
  const sameCounterparty = Boolean(memory.counterparty && txCounterparties.includes(normalizeSuiAddress(memory.counterparty)))
  const memoryCall = getMemoryCall(memory)
  const sameCall = Boolean(memoryCall.moduleName && memoryCall.functionName &&
    tx.verifiedFacts.moduleName && tx.verifiedFacts.functionName &&
    memoryCall.moduleName.toLowerCase() === tx.verifiedFacts.moduleName.toLowerCase() &&
    memoryCall.functionName.toLowerCase() === tx.verifiedFacts.functionName.toLowerCase())
  // Older records stored the transaction sender in the searchable summary;
  // newer records also keep it as a structured field.
  const savedInitiator = memory.initiatorAddress || memory.transactionSummary.match(/(?:^|\n)Sender:\s*(0x[0-9a-f]+)/i)?.[1]
  const sameInitiator = Boolean(savedInitiator && tx.sender &&
    normalizeSuiAddress(savedInitiator) === normalizeSuiAddress(tx.sender))
  const legacyDirectionMissing = !memory.direction || memory.direction === 'other'
  const directionConflict = direction !== 'other' && !legacyDirectionMissing && memory.direction !== direction
  const savedFlow = getSavedAssetFlowSignature(memory)
  const currentFlow = getAssetFlowSignature(tx)
  const savedObjectTypes = getSavedObjectTypeFlowSignature(memory)
  const currentObjectTypes = getObjectTypeFlowSignature(tx)
  const swapRelated = isRouterSwap(memoryCall.moduleName, memoryCall.functionName) ||
    isRouterSwap(tx.verifiedFacts.moduleName, tx.verifiedFacts.functionName) ||
    isAssetSwapFlow(savedFlow) || isAssetSwapFlow(currentFlow)
  if (swapRelated) {
    // A router can compose a swap with framework calls such as
    // balance::send_funds, so the first reported Move call may differ between
    // otherwise equivalent swaps. Match the wallet, pair, and both directions.
    // Older memories without balance-flow evidence remain exact-digest only.
    return Boolean(sameInitiator && isAssetSwapFlow(savedFlow) && isAssetSwapFlow(currentFlow) && savedFlow === currentFlow)
  }
  if (direction === 'other' && !(sameCall && sameInitiator)) return false

  const sameKnownAsset = Boolean(memory.coinType && tx.coinType &&
    normalizeCoinType(memory.coinType) === normalizeCoinType(tx.coinType))
  const savedHasObservedFlow = savedFlow?.startsWith('balance|') === true || savedFlow?.startsWith('objects|') === true
  const currentHasObservedFlow = currentFlow?.startsWith('balance|') === true || currentFlow?.startsWith('objects|') === true
  if (sameCall && sameInitiator) {
    if ((savedHasObservedFlow || currentHasObservedFlow) &&
      !(savedHasObservedFlow && currentHasObservedFlow && savedFlow === currentFlow)) return false
    // Object type details were added after early memory records were written.
    // Compare them strictly when both sides have them; when one side is a
    // legacy record without object metadata, an identical observed balance
    // flow is enough to preserve the app-action match.
    if (savedObjectTypes && currentObjectTypes && savedObjectTypes !== currentObjectTypes) return false
    if (Boolean(savedObjectTypes) !== Boolean(currentObjectTypes) &&
      !(savedFlow?.startsWith('balance|') && currentFlow?.startsWith('balance|') && savedFlow === currentFlow)) return false
    // coinType is a single representative field; for multi-asset app calls it
    // can vary with response ordering. Matching observed flows are stronger.
    if (memory.coinType && tx.coinType && !sameKnownAsset &&
      !savedHasObservedFlow && !currentHasObservedFlow && !savedObjectTypes && !currentObjectTypes) return false
    if (savedHasObservedFlow || currentHasObservedFlow || savedObjectTypes || currentObjectTypes) return true
    if (directionConflict) return false
    return true
  }
  if (directionConflict) return false
  if (memory.coinType && tx.coinType && !sameKnownAsset) return false
  if (sameCounterparty && direction !== 'other') return true
  // Some Sui actions such as balance::redeem_funds have no exposed transfer
  // recipient or coin delta. Matching the exact Move action and initiator is
  // a concrete anchor for those records even when direction/asset are absent.
  if (!Number.isFinite(distance) || distance > 0.25 || !sameKnownAsset) return false
  return sameCall
}

export function describePatternMatch(memory: TransactionMemoryContext, tx: TransactionItem, walletAddress: string): string {
  if (memory.txDigest === tx.digest) {
    return 'This is the exact transaction you labeled; the saved context applies to this transaction only.'
  }
  const direction = getTransactionDirection(tx, walletAddress)
  const sameCounterparty = Boolean(memory.counterparty && [tx.sender, tx.recipient]
    .filter((counterparty): counterparty is string => Boolean(counterparty))
    .some(counterparty => normalizeSuiAddress(counterparty) === normalizeSuiAddress(memory.counterparty!)))
  const memoryCall = getMemoryCall(memory)
  const sameCall = Boolean(memoryCall.moduleName && memoryCall.functionName &&
    memoryCall.moduleName.toLowerCase() === tx.verifiedFacts.moduleName?.toLowerCase() &&
    memoryCall.functionName.toLowerCase() === tx.verifiedFacts.functionName?.toLowerCase())

  const savedFlow = getSavedAssetFlowSignature(memory)
  const currentFlow = getAssetFlowSignature(tx)
  if (isRouterSwap(memoryCall.moduleName, memoryCall.functionName) || isRouterSwap(tx.verifiedFacts.moduleName, tx.verifiedFacts.functionName) || isAssetSwapFlow(savedFlow) || isAssetSwapFlow(currentFlow)) {
    const sameFlow = Boolean(isAssetSwapFlow(savedFlow) && isAssetSwapFlow(currentFlow) && currentFlow === savedFlow)
    return sameFlow
      ? `Matches a saved swap with the same observed asset balance flow${sameCall ? ` through ${memoryCall.moduleName}::${memoryCall.functionName}` : ''}.`
      : 'This swap activity has a different or unavailable asset balance flow, so saved swap context was not applied.'
  }

  const savedObjectTypes = getSavedObjectTypeFlowSignature(memory)
  const currentObjectTypes = getObjectTypeFlowSignature(tx)
  if (sameCall && savedObjectTypes && savedObjectTypes === currentObjectTypes) {
    return `Matches a saved ${memoryCall.moduleName}::${memoryCall.functionName} interaction with the same observed NFT or object changes.`
  }

  if (sameCounterparty) {
    const flow = direction === 'incoming' ? 'incoming' : direction === 'outgoing' ? 'outgoing' : 'wallet'
    const sameKnownAsset = Boolean(memory.coinType && tx.coinType &&
      normalizeCoinType(memory.coinType) === normalizeCoinType(tx.coinType))
    return sameKnownAsset
      ? `Matches saved ${flow} activity with the same counterparty and asset.`
      : `Matches saved ${flow} activity with the same counterparty; asset details were unavailable for comparison.`
  }
  if (sameCall) return `Matches a saved ${memoryCall.moduleName}::${memoryCall.functionName} contract interaction.`
  return 'Matches the same wallet interaction pattern you labeled.'
}
