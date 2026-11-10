import { useState, useEffect, useRef } from 'react'
import { useCurrentAccount, useCurrentNetwork, useDAppKit } from '@mysten/dapp-kit-react'
import { ConnectButton } from '@mysten/dapp-kit-react/ui'
import type { MemWalManual } from '@mysten-incubation/memwal/manual'
import { loadBrowserMemoryCredential, saveBrowserMemoryCache, saveBrowserMemoryCredential, type BrowserSavedMemory } from './memory-credential-store'
import { WALRUS_MEMORY_NETWORKS, SUI_GUARD_MEMORY_NAMESPACE } from './walrus-config'
import type { TransactionMemoryContext } from './walrus-memory'
import { assessActivityPattern, buildActivityBaseline, getEstablishedActivityPatterns } from './activity-baseline'

export interface TransactionItem {
  digest: string
  timestampMs?: number
  status: 'success' | 'failure' | 'unknown'
  kind: string
  sender: string
  recipient?: string
  amount?: string
  balanceChangeDirection?: 'increase' | 'decrease'
  coinType?: string
  assetBalanceChanges?: Array<{ coinType: string; amount: string }>
  objectChangesCount?: number
  objectChanges?: Array<{
    type: 'created' | 'mutated' | 'deleted' | 'transferred'
    objectType?: string
    objectId: string
  }>
  objectTypeChanges?: Array<{
    type: 'created' | 'mutated' | 'deleted' | 'transferred'
    objectType: string
    count: number
  }>
  verifiedFacts: {
    gasUsed?: string
    executedEpoch?: string
    packageId?: string
    moduleName?: string
    functionName?: string
  }
  generatedSummary: string
  activityAssessment?: {
    status: 'exact' | 'matched' | 'unmatched' | 'unavailable' | 'system'
    explanation: string
  }
  userContext?: {
    label: 'familiar' | 'unfamiliar' | 'misunderstood'
    userExplanation: string
    knownApp?: string
    reviewedAt: string
    walrusBlobId?: string
    walrusStatus: 'uncommitted' | 'saving' | 'confirmed'
    matchedMemory?: {
      sourceBlobId: string
      txDigest: string
      date: string
      label: string
      explanation: string
      confidence: string
      source?: string
    }
  }
}

export interface WalrusMemoryRecord {
  id: string
  txDigest: string
  label: 'familiar' | 'unfamiliar' | 'misunderstood'
  explanation: string
  knownApp?: string
  reviewThreshold?: string
  explanationStyle?: string
  reviewedAt: string
  blobId: string
  epoch?: number
  confirmed: boolean
  storageSource?: string
}

const getWalrusBlobProofUrl = (blobId: string, network: string) =>
  `https://walruscan.com/${network === 'testnet' ? 'testnet' : 'mainnet'}/blob/${encodeURIComponent(blobId)}`

type MemoryOperation = {
  id: string
  kind: string
  status: string
  txDigest: string
  blobId?: string
  message: string
  at: string
}

export default function App() {
  const currentAccount = useCurrentAccount()
  const connectedNetwork = useCurrentNetwork()
  const dAppKit = useDAppKit()
  const autoFetchedAddressRef = useRef<string | null>(null)
  const activityAddressRef = useRef<string | null>(null)
  const activityRefreshInFlightRef = useRef(false)
  const lastActivityRefreshAtRef = useRef(0)
  const apiErrorRef = useRef<HTMLDivElement | null>(null)
  const saveSuccessRef = useRef<HTMLDivElement | null>(null)
  const walletConnectRef = useRef<HTMLDivElement | null>(null)
  const memoryViewRef = useRef<HTMLDivElement | null>(null)
  const [address, setAddress] = useState('')
  const [activeTab, setActiveTab] = useState<'all' | 'queue' | 'familiar' | 'unfamiliar' | 'memories'>('all')
  const [showGuide, setShowGuide] = useState(false)
  const [globalSearch, setGlobalSearch] = useState('')
  const [filterStatus, setFilterStatus] = useState('all')
  const [selectedTx, setSelectedTx] = useState<TransactionItem | null>(null)
  const [editingTx, setEditingTx] = useState<TransactionItem | null>(null)
  const [editingWalletAddress, setEditingWalletAddress] = useState('')
  const [copiedDigest, setCopiedDigest] = useState<string | null>(null)

  // Status & live indicators
  const [isLiveConnected, setIsLiveConnected] = useState(false)
  const [networkName, setNetworkName] = useState('mainnet')
  const [observedBalance, setObservedBalance] = useState<string>('—')
  const [isLoading, setIsLoading] = useState(false)
  const [apiErrorMessage, setApiErrorMessage] = useState<string | null>(null)
  const [hasFetchedActivity, setHasFetchedActivity] = useState(false)
  const [activityCursor, setActivityCursor] = useState<string | null>(null)
  const [activityEndCheckpoint, setActivityEndCheckpoint] = useState<string | null>(null)
  const [hasMoreActivity, setHasMoreActivity] = useState(false)
  const [activityPagesLoaded, setActivityPagesLoaded] = useState(0)
  const [isLoadingMoreActivity, setIsLoadingMoreActivity] = useState(false)
  const [visibleActivityCount, setVisibleActivityCount] = useState(20)
  const [activityBaselinePage, setActivityBaselinePage] = useState(0)
  const [memoryActivityPage, setMemoryActivityPage] = useState(0)

  // Label editor form state
  const [editLabel, setEditLabel] = useState<'familiar' | 'unfamiliar' | 'misunderstood'>('familiar')
  const [editExplanation, setEditExplanation] = useState('')
  const [editKnownApp, setEditKnownApp] = useState('')
  const [isSavingMemory, setIsSavingMemory] = useState(false)
  const [saveSuccessNotice, setSaveSuccessNotice] = useState<string | null>(null)

  // Live data only: never show invented activity as if it came from a wallet.
  const [transactions, setTransactions] = useState<TransactionItem[]>([])
  const transactionsRef = useRef<TransactionItem[]>([])

  useEffect(() => {
    transactionsRef.current = transactions
  }, [transactions])

  // Walrus memories state
  const [walrusMemories, setWalrusMemories] = useState<WalrusMemoryRecord[]>([])
  const savedMemoryCacheRef = useRef<BrowserSavedMemory[]>([])
  const [walrusClient, setWalrusClient] = useState<MemWalManual | null>(null)
  const walrusClientRef = useRef<MemWalManual | null>(null)
  const activeMemoryRecallCountRef = useRef(0)
  const retiredMemoryClientsRef = useRef(new Set<MemWalManual>())
  const destroyedMemoryClientsRef = useRef(new WeakSet<MemWalManual>())
  const memoryClientOwnersRef = useRef(new WeakMap<MemWalManual, string>())
  const memorySessionGenerationRef = useRef(0)
  const [memoryAccountId, setMemoryAccountId] = useState('')
  const [isConnectingMemory, setIsConnectingMemory] = useState(false)
  const [isRestoringMemory, setIsRestoringMemory] = useState(false)
  const [isRecallingMemory, setIsRecallingMemory] = useState(false)
  const memoryRecallCountRef = useRef(0)
  const [memoryStatusMessage, setMemoryStatusMessage] = useState<string | null>(null)
  const [memoryOperations, setMemoryOperations] = useState<MemoryOperation[]>([])
  const [memoryOperationPage, setMemoryOperationPage] = useState(0)
  const [verifyingMemoryDigest, setVerifyingMemoryDigest] = useState<string | null>(null)
  const memoryRestoreAttemptRef = useRef<string | null>(null)
  const memorySetupInProgressRef = useRef(false)
  const restoredClientNeedsRecallRef = useRef(false)
  const pendingDelegateRef = useRef<{
    accountId: string | null
    privateKey: string
    publicKey: Uint8Array
    registered: boolean
    lookupComplete: boolean
    walletAddress: string
    network: 'mainnet' | 'testnet'
  } | null>(null)

  useEffect(() => {
    if (!apiErrorMessage && !saveSuccessNotice) return
    setEditingTx(null)
    const frame = requestAnimationFrame(() => {
      const notice = apiErrorMessage ? apiErrorRef.current : saveSuccessRef.current
      notice?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      notice?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [apiErrorMessage, saveSuccessNotice])

  useEffect(() => {
    fetchStatus()
  }, [])

  useEffect(() => {
    const connectButton = walletConnectRef.current?.querySelector('mysten-dapp-kit-connect-button')
    const connectShadow = connectButton?.shadowRoot
    if (!connectButton || !connectShadow) return

    let observedAccountMenuShadow: ShadowRoot | null = null

    const removeAddAccountControl = () => {
      const liveConnectShadow = connectButton.shadowRoot
      if (!liveConnectShadow) return

      const accountMenuShadow = liveConnectShadow.querySelector('connected-account-menu')?.shadowRoot
      if (!accountMenuShadow) return

      if (accountMenuShadow !== observedAccountMenuShadow) {
        accountMenuObserver.disconnect()
        observedAccountMenuShadow = accountMenuShadow
        accountMenuObserver.observe(accountMenuShadow, { childList: true, subtree: true })
      }

      accountMenuShadow.querySelector('button[aria-label="Add more accounts"]')?.remove()
    }

    const accountMenuObserver = new MutationObserver(removeAddAccountControl)
    const connectObserver = new MutationObserver(removeAddAccountControl)
    connectObserver.observe(connectShadow, { childList: true, subtree: true })
    removeAddAccountControl()

    return () => {
      connectObserver.disconnect()
      accountMenuObserver.disconnect()
    }
  }, [])

  const destroyRetiredMemoryClients = () => {
    if (activeMemoryRecallCountRef.current > 0) return
    for (const client of retiredMemoryClientsRef.current) {
      retiredMemoryClientsRef.current.delete(client)
      if (destroyedMemoryClientsRef.current.has(client)) continue
      destroyedMemoryClientsRef.current.add(client)
      try {
        client.destroy()
      } catch (error) {
        console.warn('[Walrus Memory] Could not destroy retired client cleanly', error)
      }
    }
  }

  const retireMemoryClient = (client: MemWalManual) => {
    if (destroyedMemoryClientsRef.current.has(client)) return
    retiredMemoryClientsRef.current.add(client)
    destroyRetiredMemoryClients()
  }

  const replaceMemoryClient = (nextClient: MemWalManual | null) => {
    const previousClient = walrusClientRef.current
    if (previousClient === nextClient) return
    walrusClientRef.current = nextClient
    setWalrusClient(nextClient)
    if (previousClient) retireMemoryClient(previousClient)
  }

  useEffect(() => () => {
    if (walrusClientRef.current) retireMemoryClient(walrusClientRef.current)
  }, [])


  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/tatum/status')
      const data = await res.json()
      if (data.status === 'connected') {
        setIsLiveConnected(true)
        setNetworkName(data.network || 'mainnet')
        setApiErrorMessage(null)
      } else {
        setIsLiveConnected(false)
        setNetworkName(data.network || 'mainnet')
        setApiErrorMessage(data.message || data.error || 'Tatum Sui RPC could not be verified. Check the API key and network configuration.')
      }
    } catch (err) {
      setIsLiveConnected(false)
      setApiErrorMessage(err instanceof Error ? `Could not check Tatum connection: ${err.message}` : 'Could not check the Tatum connection.')
    }
  }

  const fetchBalance = async (targetAddress: string) => {
    if (!targetAddress || !targetAddress.startsWith('0x')) return
    try {
      const res = await fetch(`/api/tatum/balance/${targetAddress}`)
      if (res.ok) {
        const data = await res.json()
        if (data.suiBalance !== undefined) {
          setObservedBalance(`${data.suiBalance} SUI`)
        }
      }
    } catch (_err) {
      // ignore
    }
  }

  const memoryNetwork: 'mainnet' | 'testnet' = connectedNetwork === 'testnet' ? 'testnet' : 'mainnet'

  const handleConnectMemory = async () => {
    if (!currentAccount) {
      setMemoryStatusMessage('Connect your Sui wallet before connecting Walrus Memory.')
      return
    }
    const existingAccountId = memoryAccountId.trim()
    if (existingAccountId && !/^0x[0-9a-fA-F]{64}$/.test(existingAccountId)) {
      setMemoryStatusMessage('That existing account ID does not look like a valid Sui object ID.')
      return
    }

    setIsConnectingMemory(true)
    memorySetupInProgressRef.current = true
    setMemoryStatusMessage(null)
    let client: MemWalManual | null = null
    try {
      const [accountSdk, memorySdk] = await Promise.all([
        import('@mysten-incubation/memwal/account'),
        import('./walrus-memory'),
      ])
      let pending = pendingDelegateRef.current
      if (pending && (pending.walletAddress !== currentAccount.address || pending.network !== memoryNetwork)) {
        pendingDelegateRef.current = null
        pending = null
      }
      if (pending && !pending.accountId && existingAccountId) {
        pending.accountId = existingAccountId
      }
      if (!pending) {
        const saved = await loadBrowserMemoryCredential(currentAccount.address, memoryNetwork).catch(() => null)
        if (saved) {
          pending = {
            accountId: saved.accountId,
            privateKey: saved.delegatePrivateKey,
            publicKey: Uint8Array.from(saved.delegatePublicKeyHex.match(/.{2}/g) || [], byte => Number.parseInt(byte, 16)),
            registered: false,
            lookupComplete: false,
            walletAddress: currentAccount.address,
            network: memoryNetwork,
          }
        } else {
          const delegate = await accountSdk.generateDelegateKey()
          pending = {
            accountId: existingAccountId || null,
            privateKey: delegate.privateKey,
            publicKey: delegate.publicKey,
            registered: false,
            lookupComplete: false,
            walletAddress: currentAccount.address,
            network: memoryNetwork,
          }
        }
        pendingDelegateRef.current = pending
      }

      const walletSigner = {
        address: currentAccount.address,
        signAndExecuteTransaction: async ({ transaction }: { transaction: unknown }) => {
          const result = await dAppKit.signAndExecuteTransaction({
            transaction: transaction as never,
            account: currentAccount,
            network: memoryNetwork,
          })
          if ('$kind' in result && result.$kind === 'FailedTransaction') {
            throw new Error('The wallet reported that the transaction failed.')
          }
          const digestValue: unknown = 'digest' in result ? result.digest : result.Transaction.digest
          if (typeof digestValue !== 'string') throw new Error('The wallet returned no transaction digest.')
          return { digest: digestValue }
        },
        signPersonalMessage: async ({ message }: { message: Uint8Array }) => {
          const result = await dAppKit.signPersonalMessage({
            message,
            account: currentAccount,
            network: memoryNetwork,
          })
          return { signature: result.signature }
        },
      }

      if (!pending.lookupComplete) {
        setMemoryStatusMessage('Checking for a Walrus Memory account owned by this wallet...')
        const lookupResponse = await fetch(
          `/api/walrus-memory/${memoryNetwork}/api/accounts/${encodeURIComponent(currentAccount.address)}/delegate-keys`,
        )
        const lookupData = await lookupResponse.json().catch(() => ({}))
        if (!lookupResponse.ok) {
          throw new Error(lookupData.error || `Could not check for an existing memory account (HTTP ${lookupResponse.status}).`)
        }
        const discoveredAccountId = typeof lookupData.account_id === 'string' ? lookupData.account_id : ''
        if (discoveredAccountId && existingAccountId && discoveredAccountId.toLowerCase() !== existingAccountId.toLowerCase()) {
          throw new Error('The entered account ID does not belong to the connected wallet. Clear it to use the account SuiGuard discovered for this wallet.')
        }
        if (!discoveredAccountId && existingAccountId) {
          pending.accountId = existingAccountId
        } else if (!pending.accountId) {
          pending.accountId = discoveredAccountId || null
        }
        const pendingPublicKeyHex = Array.from(pending.publicKey, byte => byte.toString(16).padStart(2, '0')).join('')
        pending.registered = Array.isArray(lookupData.keys) && lookupData.keys.some(
          (key: { public_key?: unknown }) => typeof key.public_key === 'string' && key.public_key.toLowerCase() === pendingPublicKeyHex,
        )
        pending.lookupComplete = true
        if (pending.accountId) setMemoryAccountId(pending.accountId)
      }

      if (!pending.accountId) {
        setMemoryStatusMessage('Approve account creation in your wallet. SuiGuard will generate and register a delegate for this account next.')
        const account = await accountSdk.createAccount({
          packageId: WALRUS_MEMORY_NETWORKS[memoryNetwork].packageId,
          registryId: WALRUS_MEMORY_NETWORKS[memoryNetwork].registryId,
          walletSigner,
          suiNetwork: memoryNetwork,
        })
        if (!/^0x[0-9a-fA-F]{64}$/.test(account.accountId)) {
          throw new Error('The account transaction completed, but the SDK could not identify the new memory account. Enter its object ID as an existing account and retry.')
        }
        pending.accountId = account.accountId
        setMemoryAccountId(account.accountId)
      }

      if (!pending.registered) {
        setMemoryStatusMessage('Approve delegate registration in your wallet. This lets SuiGuard access this memory account without asking you to provide a private key.')
        await accountSdk.addDelegateKey({
          packageId: WALRUS_MEMORY_NETWORKS[memoryNetwork].packageId,
          registryId: WALRUS_MEMORY_NETWORKS[memoryNetwork].registryId,
          accountId: pending.accountId,
          publicKey: pending.publicKey,
          label: 'SuiGuard',
          walletSigner,
          suiNetwork: memoryNetwork,
        })
        pending.registered = true
      }

      const delegatePublicKeyHex = Array.from(pending.publicKey, byte => byte.toString(16).padStart(2, '0')).join('')
      await saveBrowserMemoryCredential({
        ownerAddress: currentAccount.address,
        network: memoryNetwork,
        accountId: pending.accountId,
        delegatePrivateKey: pending.privateKey,
        delegatePublicKeyHex,
      })

      client = memorySdk.createWalrusMemoryClient({
        network: memoryNetwork,
        accountId: pending.accountId,
        delegateKey: pending.privateKey,
        walletSigner,
      })
      memoryClientOwnersRef.current.set(client, `${memoryNetwork}:${currentAccount.address.toLowerCase()}`)
      await client.compatibility()
      replaceMemoryClient(client)
      setMemoryAccountId(pending.accountId)
      pendingDelegateRef.current = null
      setMemoryStatusMessage(`Walrus Memory is ready on ${memoryNetwork}. This browser saved your delegate key encrypted for this wallet.`)
      if (transactions.length > 0) {
        void recallTransactionContexts(client, address.trim(), transactions).then(recalled => {
          if (recalled) setTransactions(recalled)
        })
      }
    } catch (err: unknown) {
      if (client) retireMemoryClient(client)
      const message = err instanceof Error ? err.message : String(err)
      setMemoryStatusMessage(`Walrus Memory setup did not finish: ${message} If this wallet already has a memory account, enter its account object ID above and retry.`)
    } finally {
      memorySetupInProgressRef.current = false
      setIsConnectingMemory(false)
    }
  }

  const handleDisconnectMemory = () => {
    replaceMemoryClient(null)
    setWalrusMemories([])
    savedMemoryCacheRef.current = []
    pendingDelegateRef.current = null
    setMemoryStatusMessage('Walrus Memory disconnected. This browser will remember the encrypted profile for this wallet.')
  }

  const memoryWalletIdentityRef = useRef<string | null>(currentAccount?.address || null)
  useEffect(() => {
    const identity = currentAccount?.address ? `${currentAccount.address}:${connectedNetwork}` : null
    if (memoryWalletIdentityRef.current && identity !== memoryWalletIdentityRef.current) {
      pendingDelegateRef.current = null
      memorySessionGenerationRef.current += 1
      setMemoryAccountId('')
      setWalrusMemories([])
      savedMemoryCacheRef.current = []
      restoredClientNeedsRecallRef.current = false
      if (walrusClientRef.current) replaceMemoryClient(null)
      setMemoryStatusMessage('Wallet or network changed. Set up Walrus Memory for this account and network.')
    }
    memoryWalletIdentityRef.current = identity
  }, [currentAccount?.address, connectedNetwork])

  const recallTransactionContexts = async (
    client: MemWalManual,
    walletAddress: string,
    items: TransactionItem[],
    options: { localOnly?: boolean } = {},
  ) => {
    // Keep recall calls bounded so one large activity page does not burst the provider or relayer.
    if (retiredMemoryClientsRef.current.has(client) || destroyedMemoryClientsRef.current.has(client)) return null
    const ownerIdentity = memoryClientOwnersRef.current.get(client)
    const activeOwnerIdentity = currentAccount?.address
      ? `${memoryNetwork}:${currentAccount.address.toLowerCase()}`
      : null
    if (ownerIdentity && ownerIdentity !== activeOwnerIdentity) return null
    const recallGeneration = memorySessionGenerationRef.current
    activeMemoryRecallCountRef.current += 1
    memoryRecallCountRef.current += 1
    setIsRecallingMemory(true)
    try {
    const memorySdk = await import('./walrus-memory')
    const cachedMemories = savedMemoryCacheRef.current.flatMap(entry => {
      const memory = memorySdk.parseTransactionMemory(entry.text)
      if (!memory || memory.walletAddress.toLowerCase() !== walletAddress.toLowerCase() ||
        (memory.network && memory.network !== memoryNetwork) || memory.txDigest !== entry.txDigest) return []
      return [{ entry, memory }]
    }).sort((left, right) => right.memory.reviewedAt.localeCompare(left.memory.reviewedAt))
    let recalled = items.map(tx => {
      // Prefer an exact saved record, otherwise use the locally cached
      // counterparty/action pattern. This avoids relying on vector ranking for
      // an identical repeat transfer and prevents unrelated semantic hits.
      const systemActivity = memorySdk.isWalrusMemorySystemActivity(tx)
      const cached = cachedMemories
        .map(candidate => ({
          ...candidate,
          exact: candidate.memory.txDigest === tx.digest,
          relevant: !systemActivity && memorySdk.isRelevantTransactionMemory(candidate.memory, walletAddress, memoryNetwork, tx, 0),
        }))
        .find(candidate => candidate.exact || candidate.relevant)
      if (!cached) return tx
      return {
        ...tx,
        userContext: {
          label: cached.memory.label,
          userExplanation: cached.memory.explanation,
          knownApp: cached.memory.knownApp,
          reviewedAt: cached.memory.reviewedAt,
          walrusBlobId: cached.entry.blobId,
          walrusStatus: 'confirmed' as const,
          matchedMemory: {
            sourceBlobId: cached.entry.blobId,
            txDigest: cached.memory.txDigest,
            date: new Date(cached.memory.reviewedAt).toLocaleDateString(),
            label: cached.memory.label,
            explanation: cached.memory.explanation,
            confidence: cached.exact ? 'exact transaction match' : 'related transaction match',
            source: 'browser-cache',
          },
        },
        activityAssessment: {
          status: cached.exact ? 'exact' as const : 'matched' as const,
          explanation: memorySdk.describePatternMatch(cached.memory, tx, walletAddress),
        },
      }
    })
    let failedRecalls = 0
    const failedRecallDigests = new Set<string>()
    const checkedDigests = new Set((options.localOnly ? recalled : recalled.slice(0, 10)).map(tx => tx.digest))
    const recoveredCacheEntries: BrowserSavedMemory[] = []
    for (let offset = 0; !options.localOnly && offset < Math.min(items.length, 10); offset += 2) {
      const batch = recalled.slice(offset, offset + 2)
      const results = await Promise.all(batch.map(async (tx) => {
      const operationId = `auto-recall:${tx.digest}:${Date.now()}`
      setMemoryOperations(previous => [{
        id: operationId,
        kind: 'recall',
        status: 'pending',
        txDigest: tx.digest,
        message: `Checking Walrus Memory for this activity on ${memoryNetwork}…`,
        at: new Date().toISOString(),
      }, ...previous].slice(0, 12))
      try {
        const result = await client.recallManual(
          memorySdk.makeTransactionMemoryQuery(walletAddress, tx),
          { limit: 5, namespace: SUI_GUARD_MEMORY_NAMESPACE },
        )
        const match = result.results
          .map(hit => ({ hit, memory: memorySdk.parseTransactionMemory(hit.text) }))
          .sort((left, right) => Number(right.memory?.txDigest === tx.digest) - Number(left.memory?.txDigest === tx.digest))
          .find(candidate => candidate.memory && (memorySdk.isWalrusMemorySystemActivity(tx)
            ? candidate.memory.txDigest === tx.digest
            : memorySdk.isRelevantTransactionMemory(
                candidate.memory,
                walletAddress,
                memoryNetwork,
                tx,
                candidate.hit.distance,
              )))
        if (!match?.memory) {
          setMemoryOperations(previous => previous.map(operation => operation.id === operationId ? {
            ...operation,
            status: 'no-match',
            message: 'Walrus returned no context that passed SuiGuard’s relevance checks for this activity.',
          } : operation))
          return tx
        }

        const memory = match.memory
        recoveredCacheEntries.push({ txDigest: memory.txDigest, blobId: match.hit.blob_id, text: match.hit.text })
        setMemoryOperations(previous => previous.map(operation => operation.id === operationId ? {
          ...operation,
          status: 'confirmed',
          blobId: match.hit.blob_id,
          message: 'Walrus returned saved context and SuiGuard validated it against this activity.',
        } : operation))
        return {
          ...tx,
          userContext: {
            label: memory.label,
            userExplanation: memory.explanation,
            knownApp: memory.knownApp,
            reviewedAt: memory.reviewedAt,
            walrusBlobId: match.hit.blob_id,
            walrusStatus: 'confirmed' as const,
            matchedMemory: {
              sourceBlobId: match.hit.blob_id,
              txDigest: memory.txDigest,
              date: new Date(memory.reviewedAt).toLocaleDateString(),
              label: memory.label,
              explanation: memory.explanation,
              confidence: memory.txDigest === tx.digest
                ? 'exact transaction match'
                : `semantic distance ${match.hit.distance.toFixed(2)}`,
            source: 'walrus-recall',
            },
          },
          activityAssessment: {
            status: memory.txDigest === tx.digest ? 'exact' as const : 'matched' as const,
            explanation: memorySdk.describePatternMatch(memory, tx, walletAddress),
          },
        }
      } catch (err) {
        failedRecalls += 1
        failedRecallDigests.add(tx.digest)
        setMemoryOperations(previous => previous.map(operation => operation.id === operationId ? {
          ...operation,
          status: 'failed',
          message: err instanceof Error ? err.message : String(err),
        } : operation))
        console.warn('[Walrus Memory] Recall failed for transaction', tx.digest, err)
        return tx
      }
      }))
      results.forEach((tx, index) => { recalled[offset + index] = tx })
    }

    const recoveredMemories = recoveredCacheEntries.flatMap(entry => {
      const memory = memorySdk.parseTransactionMemory(entry.text)
      if (!memory || memory.walletAddress.toLowerCase() !== walletAddress.toLowerCase() ||
        (memory.network && memory.network !== memoryNetwork) || memory.txDigest !== entry.txDigest) return []
      return [{ entry, memory }]
    })
    const allKnownMemories = [...cachedMemories, ...recoveredMemories]
    const availablePatterns = allKnownMemories.map(candidate => candidate.memory)

    // A recall for one old labeled digest may be the first time this browser
    // has seen its full context. Apply that newly recovered pattern to every
    // loaded transaction in this same pass instead of waiting for the next
    // refresh (or depending on IndexedDB persistence succeeding).
    recalled = recalled.map(tx => {
      if (tx.userContext?.matchedMemory || memorySdk.isWalrusMemorySystemActivity(tx)) return tx
      const candidate = allKnownMemories.find(({ memory }) =>
        memorySdk.isRelevantTransactionMemory(memory, walletAddress, memoryNetwork, tx, 0),
      )
      if (!candidate) return tx
      const { entry, memory } = candidate
      return {
        ...tx,
        userContext: {
          label: memory.label,
          userExplanation: memory.explanation,
          knownApp: memory.knownApp,
          reviewedAt: memory.reviewedAt,
          walrusBlobId: entry.blobId,
          walrusStatus: 'confirmed' as const,
          matchedMemory: {
            sourceBlobId: entry.blobId,
            txDigest: memory.txDigest,
            date: new Date(memory.reviewedAt).toLocaleDateString(),
            label: memory.label,
            explanation: memory.explanation,
            confidence: memory.txDigest === tx.digest ? 'exact transaction match' : 'related transaction match',
            source: 'walrus-recall',
          },
        },
        activityAssessment: {
          status: memory.txDigest === tx.digest ? 'exact' as const : 'matched' as const,
          explanation: memorySdk.describePatternMatch(memory, tx, walletAddress),
        },
      }
    })

    recalled = recalled.map(tx => {
      if (tx.userContext?.matchedMemory) return tx
      if (memorySdk.isWalrusMemorySystemActivity(tx)) {
        return {
          ...tx,
          activityAssessment: {
            status: 'system' as const,
            explanation: 'This is Walrus Memory account or access activity, not a wallet transfer pattern. SuiGuard leaves it out of normal activity comparisons.',
          },
        }
      }
      if (!checkedDigests.has(tx.digest)) {
        return {
          ...tx,
          activityAssessment: {
            status: 'unavailable' as const,
            explanation: 'This activity has not been checked against saved patterns yet.',
          },
        }
      }
      if (failedRecallDigests.has(tx.digest)) {
        return {
          ...tx,
          activityAssessment: {
            status: 'unavailable' as const,
            explanation: 'SuiGuard could not complete the Walrus Memory check. Try fetching activity again.',
          },
        }
      }
      return {
        ...tx,
        activityAssessment: {
          status: 'unmatched' as const,
          explanation: memorySdk.describeUnmatchedPattern(tx, walletAddress, availablePatterns),
        },
      }
    })

    const currentOwnerIdentity = currentAccount?.address
      ? `${memoryNetwork}:${currentAccount.address.toLowerCase()}`
      : null
    if (
      recallGeneration !== memorySessionGenerationRef.current ||
      retiredMemoryClientsRef.current.has(client) ||
      (ownerIdentity && ownerIdentity !== currentOwnerIdentity)
    ) return null

    if (recoveredCacheEntries.length > 0) {
      const byDigest = new Map(savedMemoryCacheRef.current.map(entry => [entry.txDigest, entry]))
      recoveredCacheEntries.forEach(entry => byDigest.set(entry.txDigest, entry))
      savedMemoryCacheRef.current = [...byDigest.values()]
    }
    if (recoveredCacheEntries.length > 0 && currentAccount?.address) {
      try {
        savedMemoryCacheRef.current = await saveBrowserMemoryCache(currentAccount.address, memoryNetwork, recoveredCacheEntries)
      } catch (error) {
        console.warn('[Walrus Memory] Could not refresh encrypted browser cache', error)
      }
    }

    const seen = new Set<string>()
    const memories = recalled.flatMap(tx => {
      const context = tx.userContext
      const memoryDigest = context?.matchedMemory?.txDigest || tx.digest
      if (!context?.walrusBlobId || seen.has(memoryDigest)) return []
      seen.add(memoryDigest)
      return [{
        id: context.walrusBlobId,
        txDigest: memoryDigest,
        label: context.label,
        explanation: context.userExplanation,
        knownApp: context.knownApp,
        reviewedAt: context.reviewedAt,
        blobId: context.walrusBlobId,
        confirmed: true,
        storageSource: context.matchedMemory?.source === 'walrus-recall'
          ? 'recalled from Walrus'
          : context.matchedMemory?.source === 'browser-cache'
            ? 'encrypted browser cache'
            : 'Walrus Memory write result',
      } satisfies WalrusMemoryRecord]
    })
    setWalrusMemories(previous => {
      const byDigest = new Map(previous.map(memory => [memory.txDigest, memory]))
      memories.forEach(memory => byDigest.set(memory.txDigest, memory))
      return [...byDigest.values()]
    })
    if (failedRecalls > 0) {
      setMemoryStatusMessage(`Walrus Memory recall failed for ${failedRecalls} item${failedRecalls === 1 ? '' : 's'}. Activity is still available; retry by fetching it again.`)
    }
    return recalled
    } finally {
      activeMemoryRecallCountRef.current = Math.max(0, activeMemoryRecallCountRef.current - 1)
      memoryRecallCountRef.current = Math.max(0, memoryRecallCountRef.current - 1)
      setIsRecallingMemory(memoryRecallCountRef.current > 0)
      destroyRetiredMemoryClients()
    }
  }

  useEffect(() => {
    if (!currentAccount) {
      memoryRestoreAttemptRef.current = null
      setIsRestoringMemory(false)
      return
    }
    const walletAddress = currentAccount.address
    const network: 'mainnet' | 'testnet' = connectedNetwork === 'testnet' ? 'testnet' : 'mainnet'
    const identity = `${network}:${walletAddress.toLowerCase()}`
    if (memoryRestoreAttemptRef.current === identity) return
    memoryRestoreAttemptRef.current = identity
    setIsRestoringMemory(true)
    let cancelled = false

    void (async () => {
      try {
        const saved = await loadBrowserMemoryCredential(walletAddress, network)
        if (!saved || cancelled || memorySetupInProgressRef.current) return
        const response = await fetch(
          `/api/walrus-memory/${network}/api/accounts/${encodeURIComponent(walletAddress)}/delegate-keys`,
        )
        const data = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error || `Account check failed (HTTP ${response.status}).`)
        const registeredKeys: unknown[] = Array.isArray(data.keys) ? data.keys : []
        const delegateIsRegistered = registeredKeys.some((item) => {
          if (!item || typeof item !== 'object') return false
          const key = item as { public_key?: unknown }
          return typeof key.public_key === 'string' && key.public_key.toLowerCase() === saved.delegatePublicKeyHex.toLowerCase()
        })
        if (!delegateIsRegistered || String(data.account_id || '').toLowerCase() !== saved.accountId.toLowerCase()) {
          if (!cancelled) setMemoryStatusMessage('A saved profile exists, but its delegate is no longer registered for this account. Select Set up Walrus Memory to register a replacement.')
          return
        }

        const walletSigner = {
          address: walletAddress,
          signAndExecuteTransaction: async ({ transaction }: { transaction: unknown }) => {
            const result = await dAppKit.signAndExecuteTransaction({
              transaction: transaction as never,
              account: currentAccount,
              network,
            })
            if ('$kind' in result && result.$kind === 'FailedTransaction') {
              throw new Error('The wallet reported that the transaction failed.')
            }
            const digestValue: unknown = 'digest' in result ? result.digest : result.Transaction.digest
            if (typeof digestValue !== 'string') throw new Error('The wallet returned no transaction digest.')
            return { digest: digestValue }
          },
          signPersonalMessage: async ({ message }: { message: Uint8Array }) => {
            const result = await dAppKit.signPersonalMessage({ message, account: currentAccount, network })
            return { signature: result.signature }
          },
        }
        const { createWalrusMemoryClient, parseTransactionMemory, toWalrusMemoryRecord } = await import('./walrus-memory')
        const client = createWalrusMemoryClient({
          network,
          accountId: saved.accountId,
          delegateKey: saved.delegatePrivateKey,
          walletSigner,
        })
        memoryClientOwnersRef.current.set(client, `${network}:${walletAddress.toLowerCase()}`)
        await client.compatibility()
        if (cancelled) {
          retireMemoryClient(client)
          return
        }
        replaceMemoryClient(client)
        setMemoryAccountId(saved.accountId)
        savedMemoryCacheRef.current = saved.savedMemoryCache || []
        setWalrusMemories((saved.savedMemoryCache || []).flatMap(entry => {
          const memory = parseTransactionMemory(entry.text)
          if (!memory || memory.walletAddress.toLowerCase() !== walletAddress.toLowerCase() ||
            (memory.network && memory.network !== network) || memory.txDigest !== entry.txDigest) return []
          return [{ ...toWalrusMemoryRecord(memory, entry.blobId), storageSource: 'encrypted browser cache' }]
        }))
        setMemoryStatusMessage(`Walrus Memory restored on ${network} from this browser’s encrypted profile.`)
        restoredClientNeedsRecallRef.current = true
      } catch (error) {
        if (!cancelled) {
          const detail = error instanceof Error ? error.message : String(error)
          setMemoryStatusMessage(`Could not restore this browser’s Walrus Memory profile: ${detail}`)
        }
      } finally {
        if (!cancelled) setIsRestoringMemory(false)
      }
    })()

    return () => { cancelled = true }
  }, [currentAccount?.address, connectedNetwork])

  useEffect(() => {
    if (!walrusClient || !restoredClientNeedsRecallRef.current || transactions.length === 0) return
    const walletAddress = address.trim() || currentAccount?.address
    if (!walletAddress) return
    restoredClientNeedsRecallRef.current = false
    void recallTransactionContexts(walrusClient, walletAddress, transactions).then(recalled => {
      if (recalled) setTransactions(recalled)
    })
  }, [walrusClient, transactions, address, currentAccount?.address, memoryNetwork])

  const handleFetchActivity = async (requestedAddress?: string) => {
    const walletAddress = (requestedAddress ?? address).trim()
    if (!/^0x[0-9a-fA-F]{1,64}$/.test(walletAddress)) {
      setApiErrorMessage('Enter a valid public Sui address containing 1–64 hexadecimal characters after 0x.')
      return
    }

    setIsLoading(true)
    activityAddressRef.current = walletAddress
    setApiErrorMessage(null)
    setTransactions([])
    setHasFetchedActivity(false)
    setActivityCursor(null)
    setActivityEndCheckpoint(null)
    setHasMoreActivity(false)
    setActivityPagesLoaded(0)
    setVisibleActivityCount(20)
    setActivityBaselinePage(0)

    try {
      void fetchBalance(walletAddress)
      const res = await fetch(`/api/tatum/activity/${encodeURIComponent(walletAddress)}?pageSize=50`)
      const data = await res.json().catch(() => ({}))

      if (!res.ok) {
        if (res.status === 429) {
          throw new Error('Tatum rate limit reached. Wait a moment, then try again.')
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error('Tatum rejected the API key. Check TATUM_API_KEY in .env and restart the server.')
        }
        throw new Error(data.error || `Wallet activity request failed (HTTP ${res.status}).`)
      }

      if (!Array.isArray(data.transactions)) {
        throw new Error('Tatum returned an unexpected response. Check the server logs and Sui RPC response.')
      }

      setTransactions(data.transactions)
      if (walrusClient) {
        void recallTransactionContexts(walrusClient, walletAddress, data.transactions as TransactionItem[])
          .then(recalled => { if (recalled) setTransactions(recalled) })
          .catch(err => console.warn('[Walrus Memory] Activity recall failed', err))
      }
      setActivityCursor(data.nextCursor || null)
      setActivityEndCheckpoint(data.nextEndCheckpoint || null)
      setHasMoreActivity(Boolean(data.hasNextPage && (data.nextCursor || data.nextEndCheckpoint)))
      setActivityPagesLoaded(1)
      setHasFetchedActivity(true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setApiErrorMessage(`Failed to fetch activity: ${message}`)
    } finally {
      setIsLoading(false)
    }
  }

  const refreshActivitySilently = async (walletAddress: string) => {
    if (
      activityRefreshInFlightRef.current ||
      activityAddressRef.current !== walletAddress ||
      Date.now() - lastActivityRefreshAtRef.current < 30_000
    ) return
    activityRefreshInFlightRef.current = true
    lastActivityRefreshAtRef.current = Date.now()
    try {
      const res = await fetch(`/api/tatum/activity/${encodeURIComponent(walletAddress)}?pageSize=50`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !Array.isArray(data.transactions) || activityAddressRef.current !== walletAddress) return

      const incoming = data.transactions as TransactionItem[]
      const previousByDigest = new Map(transactionsRef.current.map(tx => [tx.digest, tx]))
      const incomingDigests = new Set(incoming.map(tx => tx.digest))
      const allLoadedTransactions = [
        ...incoming.map(tx => {
          const existing = previousByDigest.get(tx.digest)
          return {
            ...tx,
            ...(existing?.userContext ? { userContext: existing.userContext } : {}),
            ...(existing?.activityAssessment ? { activityAssessment: existing.activityAssessment } : {}),
          }
        }),
        ...transactionsRef.current.filter(tx => !incomingDigests.has(tx.digest)),
      ].sort((a, b) => (b.timestampMs || 0) - (a.timestampMs || 0))
      setTransactions(allLoadedTransactions)

      if (walrusClient && allLoadedTransactions.length > 0) {
        void recallTransactionContexts(walrusClient, walletAddress, allLoadedTransactions, { localOnly: true })
          .then(reassessed => {
            if (!reassessed || activityAddressRef.current !== walletAddress) return
            const reassessedByDigest = new Map(reassessed.map(tx => [tx.digest, tx]))
            setTransactions(previous => previous.map(tx => reassessedByDigest.get(tx.digest) || tx))
          })
          .catch(err => console.warn('[Walrus Memory] Loaded activity rescan failed', err))
      }
    } catch (err: unknown) {
      // Background refresh is best effort; keep the last successfully loaded activity visible.
      console.warn('[SuiGuard] Background activity refresh failed', err)
    } finally {
      activityRefreshInFlightRef.current = false
    }
  }

  useEffect(() => {
    if (!hasFetchedActivity || !activityAddressRef.current) return

    const refreshIfVisible = () => {
      const walletAddress = activityAddressRef.current
      if (document.visibilityState === 'visible' && walletAddress) {
        void refreshActivitySilently(walletAddress)
      }
    }
    const intervalId = window.setInterval(refreshIfVisible, 60_000)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [hasFetchedActivity, walrusClient])

  useEffect(() => {
    const walletAddress = currentAccount?.address
    if (!walletAddress) {
      autoFetchedAddressRef.current = null
      return
    }

    setAddress(walletAddress)
    if (autoFetchedAddressRef.current === walletAddress) return

    // Mark before starting the request so React StrictMode doesn't issue it twice.
    autoFetchedAddressRef.current = walletAddress
    void handleFetchActivity(walletAddress)
  }, [currentAccount?.address])
  const handleLoadMoreActivity = async () => {
    const walletAddress = address.trim()
    if ((!activityCursor && !activityEndCheckpoint) || isLoadingMoreActivity || activityPagesLoaded >= 10) return
    setIsLoadingMoreActivity(true)
    setApiErrorMessage(null)
    try {
      const params = new URLSearchParams({ pageSize: '50' })
      if (activityCursor) params.set('cursor', activityCursor)
      if (activityEndCheckpoint) params.set('endCheckpoint', activityEndCheckpoint)
      const res = await fetch(`/api/tatum/activity/${encodeURIComponent(walletAddress)}?${params}`)
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `Wallet activity request failed (HTTP ${res.status}).`)
      if (!Array.isArray(data.transactions)) throw new Error('Tatum returned an unexpected activity page.')

      const pageTransactions = data.transactions as TransactionItem[]

      setTransactions(previous => {
        const seen = new Set(previous.map(tx => tx.digest))
        return [...previous, ...pageTransactions.filter(tx => !seen.has(tx.digest))]
      })
      if (walrusClient) {
        void recallTransactionContexts(walrusClient, walletAddress, pageTransactions).then(recalled => {
          if (!recalled) return
          const byDigest = new Map(recalled.map(tx => [tx.digest, tx]))
          setTransactions(previous => previous.map(tx => byDigest.get(tx.digest) || tx))
        })
      }
      setActivityCursor(data.nextCursor || null)
      setActivityEndCheckpoint(data.nextEndCheckpoint || null)
      setHasMoreActivity(Boolean(data.hasNextPage && (data.nextCursor || data.nextEndCheckpoint)))
      setActivityPagesLoaded(previous => previous + 1)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setApiErrorMessage(`Failed to load more activity: ${message}`)
    } finally {
      setIsLoadingMoreActivity(false)
    }
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopiedDigest(text)
    setTimeout(() => setCopiedDigest(null), 2000)
  }


  const normalizedSearch = globalSearch.trim().toLowerCase()
  const filteredTxs = transactions.filter((tx) => {
    if (activeTab === 'queue' && tx.userContext) return false
    if (activeTab === 'familiar' && tx.userContext?.label !== 'familiar') return false
    if (activeTab === 'unfamiliar' && tx.userContext?.label !== 'unfamiliar') return false
    if (filterStatus !== 'all' && tx.status !== filterStatus) return false
    if (normalizedSearch) {
      const searchable = [
        tx.digest,
        tx.sender,
        tx.recipient,
        tx.amount,
        tx.coinType,
        tx.status,
        tx.generatedSummary,
        tx.verifiedFacts.packageId,
        tx.verifiedFacts.moduleName,
        tx.verifiedFacts.functionName,
        tx.userContext?.label,
        tx.userContext?.userExplanation,
        tx.userContext?.knownApp,
        tx.userContext?.matchedMemory?.explanation,
        tx.userContext?.walrusBlobId,
        ...(tx.assetBalanceChanges || []).flatMap(change => [change.coinType, change.amount]),
        ...(tx.objectChanges || []).flatMap(change => [change.type, change.objectType, change.objectId]),
      ].filter(Boolean).join(' ').toLowerCase()
      if (!searchable.includes(normalizedSearch)) return false
    }
    return true
  })

  const handleShowMoreActivity = async () => {
    if (visibleActivityCount < filteredTxs.length) {
      setVisibleActivityCount(count => count + 10)
      return
    }
    if (hasMoreActivity && activityPagesLoaded < 10) {
      await handleLoadMoreActivity()
      setVisibleActivityCount(count => count + 10)
    }
  }

  const totalCount = transactions.length
  const familiarCount = transactions.filter((t) => t.userContext?.label === 'familiar').length
  const unfamiliarCount = transactions.filter((t) => t.userContext?.label === 'unfamiliar').length
  const queueCount = transactions.filter((t) => !t.userContext).length
  const observedSuiTransactions = transactions.filter(tx => tx.coinType?.toLowerCase().endsWith('::sui::sui'))
  const observedSuiDeltas = observedSuiTransactions.flatMap(tx => {
    const amount = Number.parseFloat(tx.amount || '')
    if (!Number.isFinite(amount)) return []
    const summary = tx.generatedSummary.toLowerCase()
    const direction = tx.balanceChangeDirection ||
      (/\bnet increase\b|\breceived\b|\bincoming\b/.test(summary) ? 'increase' :
        /\bnet decrease\b|\bsent\b|\boutgoing\b/.test(summary) ? 'decrease' : undefined)
    if (!direction) return []
    return [direction === 'increase' ? amount : -amount]
  })
  const observedSuiDelta = observedSuiDeltas.reduce((sum, delta) => sum + delta, 0)
  const objectChangeRecords = transactions.reduce((sum, tx) => sum + (tx.objectChangesCount || 0), 0)
  const recalledContexts = transactions.filter(tx => tx.userContext?.matchedMemory)
  const recalledContextCalls = [...new Set(recalledContexts.map(tx => {
    const { moduleName, functionName } = tx.verifiedFacts
    return moduleName && functionName ? `${moduleName}::${functionName}` : null
  }).filter((name): name is string => Boolean(name)))].slice(0, 2)
  const activityBaseline = address.trim() ? buildActivityBaseline(transactions, address.trim()) : new Map()
  const establishedActivityPatterns = getEstablishedActivityPatterns(activityBaseline)
  const activityBaselinePageCount = Math.max(1, Math.ceil(establishedActivityPatterns.length / 5))
  const visibleBaselinePatterns = establishedActivityPatterns.slice(activityBaselinePage * 5, activityBaselinePage * 5 + 5)
  const visibleActivityTxs = filteredTxs.slice(0, visibleActivityCount)
  const comparableActivityCount = transactions.filter(tx => assessActivityPattern(tx, address.trim(), activityBaseline).key).length
  const familiarActivityCount = transactions.filter(tx => tx.userContext?.label === 'familiar').length
  const repeatedActivityCount = transactions.filter(tx => {
    const observation = assessActivityPattern(tx, address.trim(), activityBaseline)
    return Boolean(observation.pattern && observation.pattern.observations >= 2)
  }).length
  const insufficientActivityCount = transactions.filter(tx => {
    if (tx.status !== 'success' || tx.activityAssessment?.status === 'system') return false
    const observation = assessActivityPattern(tx, address.trim(), activityBaseline)
    return !observation.pattern || observation.pattern.observations < 2
  }).length
  const latestPatternTimestamp = Math.max(0, ...transactions.map(tx => tx.timestampMs || 0))
  const filteredWalrusMemories = normalizedSearch
    ? walrusMemories.filter(memory => [
        memory.label,
        memory.explanation,
        memory.knownApp,
        memory.txDigest,
        memory.blobId,
        memory.storageSource,
        memory.reviewedAt,
      ].some(value => value?.toLowerCase().includes(normalizedSearch)))
    : walrusMemories
  const memoryActivityPageSize = 5
  const memoryActivityPageCount = Math.max(1, Math.ceil(filteredWalrusMemories.length / memoryActivityPageSize))
  const safeMemoryActivityPage = Math.min(memoryActivityPage, memoryActivityPageCount - 1)
  const visibleWalrusMemories = filteredWalrusMemories.slice(
    safeMemoryActivityPage * memoryActivityPageSize,
    (safeMemoryActivityPage + 1) * memoryActivityPageSize,
  )
  const memoryOperationPageSize = 5
  const memoryOperationPageCount = Math.max(1, Math.ceil(memoryOperations.length / memoryOperationPageSize))
  const safeMemoryOperationPage = Math.min(memoryOperationPage, memoryOperationPageCount - 1)
  const visibleMemoryOperations = memoryOperations.slice(
    safeMemoryOperationPage * memoryOperationPageSize,
    (safeMemoryOperationPage + 1) * memoryOperationPageSize,
  )
  const isMemoryLoading = isConnectingMemory || isRestoringMemory || isRecallingMemory || isSavingMemory || Boolean(verifyingMemoryDigest)

  const openLabelModal = (tx: TransactionItem) => {
    setApiErrorMessage(null)
    setSaveSuccessNotice(null)
    setEditingTx(tx)
    setEditingWalletAddress(address.trim())
    setEditLabel(tx.userContext?.label || 'familiar')
    setEditExplanation(tx.userContext?.userExplanation || '')
    setEditKnownApp(tx.userContext?.knownApp || '')
  }

  const handleSaveMemory = async () => {
    if (!editingTx) return
    if (!walrusClient || !currentAccount) {
      setApiErrorMessage('Connect Walrus Memory and the wallet that owns this memory account before saving.')
      return
    }
    if (!editExplanation.trim()) {
      setApiErrorMessage('Add your explanation before saving this label.')
      return
    }
    setApiErrorMessage(null)
    setSaveSuccessNotice(null)
    setIsSavingMemory(true)
    const operationId = `write:${editingTx.digest}:${Date.now()}`
    const operationAt = new Date().toISOString()
    setMemoryOperations(previous => [{
      id: operationId,
      kind: 'write',
      status: 'pending',
      txDigest: editingTx.digest,
      message: `Writing encrypted context to Walrus Memory on ${memoryNetwork}…`,
      at: operationAt,
    }, ...previous].slice(0, 12))

    try {
      const memorySdk = await import('./walrus-memory')
      const memory: TransactionMemoryContext = {
        type: 'suiguard-transaction-context',
        version: 1,
        walletAddress: editingWalletAddress,
        txDigest: editingTx.digest,
        label: editLabel,
        explanation: editExplanation.trim(),
        knownApp: editKnownApp || undefined,
        transactionSummary: memorySdk.makeTransactionMemoryQuery(editingWalletAddress, editingTx),
        reviewedAt: new Date().toISOString(),
        network: memoryNetwork,
        direction: memorySdk.getTransactionDirection(editingTx, editingWalletAddress),
        coinType: editingTx.coinType,
        counterparty: memorySdk.getTransactionDirection(editingTx, editingWalletAddress) === 'incoming'
          ? editingTx.sender
          : memorySdk.getTransactionDirection(editingTx, editingWalletAddress) === 'outgoing'
            ? editingTx.recipient
            : undefined,
        initiatorAddress: editingTx.sender,
        moduleName: editingTx.verifiedFacts.moduleName,
        functionName: editingTx.verifiedFacts.functionName,
        assetFlowSignature: memorySdk.getAssetFlowSignature(editingTx),
        objectTypeFlowSignature: memorySdk.getObjectTypeFlowSignature(editingTx),
      }
      const result = await walrusClient.rememberManual(JSON.stringify(memory), SUI_GUARD_MEMORY_NAMESPACE)
      if (typeof result.blob_id !== 'string' || !result.blob_id) {
        throw new Error('Walrus Memory did not return a blob ID, so this write cannot be confirmed.')
      }
      const rec = memorySdk.toWalrusMemoryRecord(memory, result.blob_id)
      setMemoryOperations(previous => previous.map(operation => operation.id === operationId ? {
        ...operation,
        status: 'confirmed',
        blobId: result.blob_id,
        message: `Walrus returned a blob reference on ${memoryNetwork}.`,
      } : operation))

      try {
        savedMemoryCacheRef.current = await saveBrowserMemoryCache(currentAccount.address, memoryNetwork, [{
          txDigest: memory.txDigest,
          blobId: result.blob_id,
          text: JSON.stringify(memory),
        }])
      } catch (cacheError) {
        console.warn('[Walrus Memory] Could not update encrypted browser cache', cacheError)
        setMemoryStatusMessage('This memory was saved to Walrus, but the encrypted browser backup could not be updated.')
      }

      setWalrusMemories((prev) => [rec, ...prev.filter(memory => memory.txDigest !== rec.txDigest)])
      setTransactions((prev) =>
        prev.map((t) => t.digest === editingTx.digest
          ? {
              ...t,
              userContext: {
                label: editLabel,
                userExplanation: editExplanation.trim(),
                knownApp: editKnownApp.trim() || undefined,
                reviewedAt: rec.reviewedAt,
                walrusBlobId: rec.blobId,
                walrusStatus: 'confirmed',
                matchedMemory: {
                  sourceBlobId: rec.blobId,
                  txDigest: editingTx.digest,
                  date: new Date(rec.reviewedAt).toLocaleDateString(),
                  label: editLabel,
                  explanation: editExplanation.trim(),
                  confidence: 'exact transaction match',
                  source: 'just-saved',
                },
              },
              activityAssessment: {
                status: 'matched',
                explanation: 'You saved context for this activity. SuiGuard can now compare future activity against it.',
              },
            }
          : t)
      )
      // Re-check already loaded activity against this newly saved pattern.
      // Without this pass, only the transaction in the editor gets updated;
      // earlier and recently fetched repeats remain marked as unmatched.
      const activityToReassess = transactionsRef.current
      if (walrusClient && activityToReassess.length > 0) {
        void recallTransactionContexts(walrusClient, editingWalletAddress, activityToReassess)
          .then(reassessed => {
            if (!reassessed) return
            const byDigest = new Map(reassessed.map(tx => [tx.digest, tx]))
            setTransactions(previous => previous.map(tx => {
              const refreshed = byDigest.get(tx.digest)
              if (!refreshed) return tx
              if (refreshed.userContext?.matchedMemory) return refreshed
              if (refreshed.activityAssessment) {
                return { ...tx, activityAssessment: refreshed.activityAssessment }
              }
              return tx
            }))
          })
          .catch(error => console.warn('[Walrus Memory] Saved-pattern reassessment failed', error))
      }
      setEditingTx(null)
      setSaveSuccessNotice(`Saved to Walrus Memory with confirmed blob ${rec.blobId.substring(0, 18)}...`)
      setTimeout(() => setSaveSuccessNotice(null), 5000)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setMemoryOperations(previous => previous.map(operation => operation.id === operationId ? {
        ...operation,
        status: 'failed',
        message,
      } : operation))
      setApiErrorMessage(`Walrus write error: ${message}`)
    } finally {
      setIsSavingMemory(false)
    }
  }

  const verifyMemoryRecall = async (tx: TransactionItem) => {
    if (!walrusClient || !currentAccount?.address) {
      setMemoryStatusMessage('Connect the wallet and activate Walrus Memory before verifying a recall.')
      return
    }
    const operationId = `recall:${tx.digest}:${Date.now()}`
    setVerifyingMemoryDigest(tx.digest)
    setMemoryOperations(previous => [{
      id: operationId,
      kind: 'recall',
      status: 'pending',
      txDigest: tx.digest,
      message: `Checking Walrus Memory directly for related context on ${memoryNetwork}…`,
      at: new Date().toISOString(),
    }, ...previous].slice(0, 12))
    try {
      const memorySdk = await import('./walrus-memory')
      const result = await walrusClient.recallManual(
        memorySdk.makeTransactionMemoryQuery(currentAccount.address, tx),
        { limit: 5, namespace: SUI_GUARD_MEMORY_NAMESPACE },
      )
      const match = result.results
        .map(hit => ({ hit, memory: memorySdk.parseTransactionMemory(hit.text) }))
        .find(candidate => candidate.memory && memorySdk.isRelevantTransactionMemory(
          candidate.memory,
          currentAccount.address,
          memoryNetwork,
          tx,
          candidate.hit.distance,
        ))
      if (!match?.memory) {
        setMemoryOperations(previous => previous.map(operation => operation.id === operationId ? {
          ...operation,
          status: 'no-match',
          message: 'Walrus responded, but returned no context that passed SuiGuard’s relevance checks for this transaction.',
        } : operation))
        return
      }
      const memory = match.memory
      const blobId = match.hit.blob_id
      const context = {
        label: memory.label,
        userExplanation: memory.explanation,
        knownApp: memory.knownApp,
        reviewedAt: memory.reviewedAt,
        walrusBlobId: blobId,
        walrusStatus: 'confirmed' as const,
        matchedMemory: {
          sourceBlobId: blobId,
          txDigest: memory.txDigest,
          date: new Date(memory.reviewedAt).toLocaleDateString(),
          label: memory.label,
          explanation: memory.explanation,
          confidence: memory.txDigest === tx.digest ? 'exact transaction match' : 'related transaction match',
          source: 'walrus-recall',
        },
      }
      setTransactions(previous => previous.map(item => item.digest === tx.digest ? {
        ...item,
        userContext: context,
        activityAssessment: {
          status: memory.txDigest === tx.digest ? 'exact' : 'matched',
          explanation: memorySdk.describePatternMatch(memory, tx, currentAccount.address),
        },
      } : item))
      setWalrusMemories(previous => [{
        id: blobId,
        txDigest: memory.txDigest,
        label: memory.label,
        explanation: memory.explanation,
        knownApp: memory.knownApp,
        reviewedAt: memory.reviewedAt,
        blobId,
        confirmed: true,
        storageSource: 'walrus-memory recall',
      }, ...previous.filter(item => item.txDigest !== memory.txDigest)])
      setMemoryOperations(previous => previous.map(operation => operation.id === operationId ? {
        ...operation,
        status: 'confirmed',
        blobId,
        message: 'Walrus returned related encrypted context; SuiGuard validated its wallet, network, and transaction pattern.',
      } : operation))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setMemoryOperations(previous => previous.map(operation => operation.id === operationId ? {
        ...operation,
        status: 'failed',
        message,
      } : operation))
    } finally {
      setVerifyingMemoryDigest(null)
    }
  }

  return (
    <div className="sg-app min-h-screen bg-primary text-primary flex flex-col font-sans">
      {/* Informational Guardrail Banner: guidelines/components/alert.md */}
      <div className="sg-guardrail bg-secondary border-b border-secondary px-xl py-xs">
        <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between text-xs text-secondary gap-xs">
          <div className="flex items-center gap-xs">
            <span className="sg-small-mark" aria-hidden="true">i</span>
            <span>
              <strong>Onchain context, not a safety verdict:</strong> SuiGuard explains available transaction data; review anything unfamiliar.
            </span>
          </div>
          <div className="flex items-center gap-md">
            <span className="flex items-center gap-xs">
              <span
                className={`w-2 h-2 rounded-full ${
                  isLiveConnected ? 'bg-utility-success-600' : 'bg-utility-warning-600'
                }`}
              />
              <span>Tatum Sui Gateway: {isLiveConnected ? 'Live' : 'Unavailable'}</span>
            </span>
            <span className="flex items-center gap-xs">
              <span className="w-2 h-2 rounded-full bg-utility-brand-600" />
              <span>Walrus Memory: {walrusClient ? 'Configured' : 'Not connected'}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Main Page Header: guidelines/layout-dashboard.md */}
      <header className="sg-header flex flex-col gap-lg border-b border-secondary bg-primary px-xl py-lg lg:flex-row lg:items-start lg:justify-between">
        <div className="flex items-center gap-md">
          <div>
            <div className="flex items-center gap-xs">
              <h1 className="sg-wordmark text-heading-xs font-semibold text-primary"><span>Sui</span><em>Guard</em></h1>
              {/* Badge: guidelines/components/badge.md */}
              <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700 capitalize">
                {networkName}
              </span>
              <span className="inline-flex items-center gap-xs rounded-full border border-secondary bg-secondary px-md py-xxs text-xs font-medium text-tertiary">
                v1.0
              </span>
            </div>
            <p className="mt-xs text-sm text-tertiary">Wallet activity, with your context.</p>
          </div>
        </div>

        {/* Header Action & Memory Stats */}
        <div className="flex flex-wrap items-center gap-sm">
          <div className="sg-memory-count flex items-center gap-xs px-md py-sm rounded-lg bg-primary border border-secondary shadow-xs">
            <div className="text-xs">
              <span className="text-tertiary">Contexts loaded: </span>
              <span className="font-semibold text-primary">{walrusMemories.length}</span>
            </div>
          </div>
          {/* Secondary Button: guidelines/components/button.md */}
          <button
            onClick={() => {
              setShowGuide(false)
              setActiveTab('memories')
              window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
                memoryViewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }))
            }}
            aria-controls="walrus-memory-view"
            className="sg-memory-button inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <span>Memory</span>
            {isMemoryLoading && <span className="sg-loader" role="status" aria-label="Walrus Memory is loading" />}
          </button>
          <button type="button" onClick={() => setShowGuide(true)} className="sg-guide-button">
            How it works
          </button>
        </div>
      </header>

      {/* Address Search & Status Bar: guidelines/components/input.md & guidelines/components/button.md */}
      <section className="sg-wallet-bar border-b border-secondary bg-secondary px-xl py-lg">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-end justify-between gap-md">
          <div className="flex-1 max-w-2xl flex flex-col gap-sm">
            <label htmlFor="sui-address" className="text-sm font-medium text-secondary">
              Public Sui Wallet Address (connect or enter manually; no signing needed)
            </label>
            <div className="sg-address-input relative flex items-center">
              <input
                id="sui-address"
                type="text"
                value={address}
                onChange={(e) => {
                  setAddress(e.target.value)
                  setTransactions([])
                  setHasFetchedActivity(false)
                  setActivityCursor(null)
                  setActivityEndCheckpoint(null)
                  setHasMoreActivity(false)
                  setActivityPagesLoaded(0)
                  setObservedBalance('—')
                  setApiErrorMessage(null)
                }}
                placeholder="0x... public Sui address"
                className="w-full rounded-md bg-primary pl-6xl pr-2xl py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring font-mono"
              />
              <button
                onClick={() => copyToClipboard(address)}
                title="Copy address"
                className="absolute right-md text-fg-quaternary hover:text-fg-primary"
              >
                <span className="sg-copy-glyph" aria-hidden="true">Copy</span>
              </button>
            </div>
          </div>

          <div className="sg-wallet-actions flex items-center gap-sm self-end md:self-auto">
            <div ref={walletConnectRef} className="sg-wallet-connect" aria-label={`Sui wallet connection, ${connectedNetwork} network`}>
              <ConnectButton />
            </div>
            {/* Primary Button: guidelines/components/button.md */}
            <button
              onClick={() => handleFetchActivity()}
              disabled={isLoading || isLoadingMoreActivity}
              className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
            >
              {isLoading && <span className="sg-loader" aria-hidden="true" />}
              <span>{isLoading ? 'Querying...' : 'Fetch Activity'}</span>
            </button>
          </div>
        </div>

        {/* Status Chips */}
        <div className="max-w-7xl mx-auto mt-md flex flex-wrap items-center gap-xs text-xs text-tertiary">
          <span>Address:</span>
          {/* Badges: guidelines/components/badge.md */}
          <span className="inline-flex items-center gap-xs rounded-full border border-utility-success-200 bg-utility-success-50 px-md py-xxs text-xs font-medium text-utility-success-700">
            {address ? 'Public address' : 'Not connected'}
          </span>
            <span className="text-quaternary ml-auto">Balance and activity via Tatum Sui gRPC</span>
        </div>
      </section>

      {/* Main Content Body */}
      <main className="sg-main max-w-7xl mx-auto px-xl py-xl flex-1 w-full space-y-xl">
        {showGuide ? (
          <section className="sg-guide-page" aria-labelledby="guide-heading">
            <div className="sg-guide-topline">
              <span className="sg-guide-kicker">SuiGuard · field guide</span>
              <button type="button" onClick={() => setShowGuide(false)} className="sg-guide-back">Back to wallet <span aria-hidden="true">↗</span></button>
            </div>
            <header className="sg-guide-intro">
              <p>READ YOUR ACTIVITY. KEEP YOUR CONTEXT.</p>
              <h2 id="guide-heading">A clearer view of<br /><em>your onchain life.</em></h2>
              <span>SuiGuard pairs Sui transaction evidence with the explanations you choose to remember.</span>
            </header>
            <div className="sg-guide-grid">
              <article className="sg-guide-card sg-guide-card-dark"><span className="sg-guide-number">01</span><h3>Connect your Sui wallet</h3><p>Your public address lets SuiGuard request its onchain activity. SuiGuard cannot move funds; wallet signatures are used only when you approve a Walrus Memory action.</p></article>
              <article className="sg-guide-card"><span className="sg-guide-number">02</span><h3>Review the evidence</h3><p>Tatum supplies transaction details such as the digest, time, balance changes and object changes. SuiGuard explains those available facts and marks uncertainty for review.</p></article>
              <article className="sg-guide-card"><span className="sg-guide-number">03</span><h3>Save what it meant to you</h3><p>Add a label and your own explanation. The memory is encrypted before storage through Walrus Memory. Your note adds personal context; it does not alter the public transaction.</p></article>
              <article className="sg-guide-card sg-guide-card-lime"><span className="sg-guide-number">04</span><h3>Recognize it next time</h3><p>When a later activity resembles saved context, SuiGuard can recall that memory and show its source. A match is a helpful clue, not a safety verdict.</p></article>
            </div>
            <div className="sg-guide-proof">
              <div><span className="sg-guide-kicker">WHAT IS PUBLIC · WHAT IS YOURS</span><h3>Onchain facts stay public.<br />Your explanation stays yours.</h3></div>
              <p>Wallet addresses, transaction digests and chain effects are public on Sui. Personal labels and explanations are stored as encrypted Walrus Memory. A blob link opens that blob’s Walruscan record, where you can inspect its storage status and associated Sui object.</p>
            </div>
          </section>
        ) : <>
        <section className="sg-hero" aria-labelledby="dashboard-heading">
          <div className="sg-hero-brand-marks" aria-hidden="true">
            <img className="sg-hero-sui-logo" src="/brand/sui.png" alt="" />
            <img className="sg-hero-walrus-logo" src="/brand/walrus.jpg" alt="" />
          </div>
          <div className="sg-hero-copy-block">
            <p className="sg-eyebrow"><span className="sg-eyebrow-mark" /> Wallet field notes <span className="sg-eyebrow-separator">/</span> {networkName}</p>
            <h2 id="dashboard-heading">Know what moved.<br /><em>Remember why.</em></h2>
            <p className="sg-hero-copy">Verified transaction details, alongside the context you choose to keep.</p>
            
          </div>
          <div className="sg-balance-module" aria-label="Observed SUI balance">
            <span className="sg-balance-kicker">Observed balance <i /></span>
            <strong>{observedBalance.includes('SUI') ? observedBalance : 'Awaiting wallet data'}</strong>
            <span className="sg-balance-address">
              {address ? `${address.slice(0, 10)}…${address.slice(-6)}` : 'Connect a wallet or enter an address'}
            </span>
          </div>
        </section>
        {/* Error Alert: guidelines/components/alert.md */}
        {apiErrorMessage && (
          <div ref={apiErrorRef} tabIndex={-1} role="alert" className="sg-notice flex gap-lg rounded-xl bg-utility-warning-50 p-xl border border-utility-warning-200 items-start justify-between outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
            <div className="flex gap-md items-start">
            <span className="sg-status-letter sg-warning-letter" aria-hidden="true">!</span>
              <div>
                <p className="text-sm font-semibold text-utility-warning-600">Notice</p>
                <p className="mt-xxs text-sm text-tertiary">{apiErrorMessage}</p>
              </div>
            </div>
            <button
              onClick={() => setApiErrorMessage(null)}
              className="text-xs font-medium underline text-utility-warning-700"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Success Alert: guidelines/components/alert.md */}
        {saveSuccessNotice && (
          <div ref={saveSuccessRef} tabIndex={-1} role="status" className="sg-notice sg-success flex gap-lg rounded-xl bg-utility-success-50 p-xl border border-utility-success-200 items-start justify-between outline-none focus-visible:ring-2 focus-visible:ring-focus-ring">
            <div className="flex gap-md items-start">
            <span className="sg-status-letter sg-success-letter" aria-hidden="true">✓</span>
              <div>
                <p className="text-sm font-semibold text-utility-success-600">Walrus Memory Confirmed</p>
                <p className="mt-xxs text-sm text-tertiary">{saveSuccessNotice}</p>
              </div>
            </div>
            <button
              onClick={() => setSaveSuccessNotice(null)}
              className="text-xs font-medium underline text-utility-success-700"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Summary Metric Cards: guidelines/components/card.md */}
        <div className="sg-metrics grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-md">
          {/* Card 1 */}
          <section className="sg-metric rounded-xl border border-secondary bg-primary p-xl shadow-xs">
            <div className="flex items-center justify-between text-sm text-tertiary">
              <span>Observed Activity</span>
            </div>
            <p className="mt-md text-heading-xs font-semibold text-primary">{totalCount}</p>
            <p className="mt-xs text-xs text-tertiary">Recent transaction blocks</p>
          </section>

          {/* Card 2 */}
          <section className="sg-metric rounded-xl border border-secondary bg-primary p-xl shadow-xs">
            <div className="flex items-center justify-between text-sm text-tertiary">
              <span>Familiar (Approved)</span>
            </div>
            <p className="mt-md text-heading-xs font-semibold text-utility-success-700">{familiarCount}</p>
            <p className="mt-xs text-xs text-tertiary">Understood & confirmed by you</p>
          </section>

          {/* Card 3 */}
          <section className="sg-metric rounded-xl border border-secondary bg-primary p-xl shadow-xs">
            <div className="flex items-center justify-between text-sm text-tertiary">
              <span>Unfamiliar to You</span>
            </div>
            <p className="mt-md text-heading-xs font-semibold text-utility-warning-700">{unfamiliarCount}</p>
            <p className="mt-xs text-xs text-tertiary">Marked unfamiliar by you</p>
          </section>

          {/* Card 4 */}
          <section className="sg-metric rounded-xl border border-secondary bg-primary p-xl shadow-xs">
            <div className="flex items-center justify-between text-sm text-tertiary">
              <span>Review Queue</span>
            </div>
            <p className="mt-md text-heading-xs font-semibold text-primary">{queueCount}</p>
            <p className="mt-xs text-xs text-tertiary">Not yet labeled by user</p>
          </section>
        </div>

        {/* "What Changed?" summary panel: guidelines/components/card.md */}
        <section className="sg-insight rounded-xl border border-secondary bg-secondary p-xl">
          <div className="flex items-start gap-md">
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-primary">What changed? (Observed Summary)</h3>
              <p className="mt-xxs text-xs text-secondary">
                Calculated from the {totalCount} transaction{totalCount === 1 ? '' : 's'} currently loaded. Missing details are excluded; this is not necessarily the wallet’s full history.
              </p>
              <div className="mt-md grid grid-cols-1 md:grid-cols-3 gap-sm text-xs">
                <div className="sg-insight-cell p-sm rounded-md bg-primary border border-secondary">
                  <span className="text-tertiary block">Observed SUI transfer delta:</span>
                  <span className="font-semibold text-primary">
                    {observedSuiDeltas.length > 0
                      ? `${observedSuiDelta > 0 ? '+' : ''}${observedSuiDelta.toFixed(4)} SUI across ${observedSuiDeltas.length} transaction${observedSuiDeltas.length === 1 ? '' : 's'}`
                      : 'No SUI transfer amounts available'}
                  </span>
                </div>
                <div className="sg-insight-cell p-sm rounded-md bg-primary border border-secondary">
                  <span className="text-tertiary block">Object change records:</span>
                  <span className="font-semibold text-primary">
                    {objectChangeRecords} across {transactions.filter(tx => tx.objectChangesCount !== undefined).length} transaction{transactions.filter(tx => tx.objectChangesCount !== undefined).length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="sg-insight-cell p-sm rounded-md bg-primary border border-secondary">
                  <span className="text-tertiary block">Memory Context Applied:</span>
                  <span className="font-semibold text-utility-brand-700">
                    {recalledContexts.length > 0
                      ? `${recalledContexts.length} past context${recalledContexts.length === 1 ? '' : 's'} matched${recalledContextCalls.length ? `: ${recalledContextCalls.join(', ')}` : ''}`
                      : 'No matching past context on loaded activity'}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="sg-baseline-panel" aria-labelledby="wallet-patterns-heading">
          <div className="sg-baseline-heading">
            <div>
              <p className="sg-baseline-kicker">PERSONAL ACTIVITY BASELINE</p>
              <h3 id="wallet-patterns-heading">Patterns in this wallet’s loaded history</h3>
              <p>Repeated successful activity only. Scoped to {networkName} and the address shown above; this describes familiarity, not safety.</p>
            </div>
            <div className="sg-baseline-count"><strong>{establishedActivityPatterns.length}</strong><span>established<br />patterns</span></div>
          </div>
          <div className="sg-baseline-evidence-grid" aria-label="Activity understanding summary">
            <div><strong>{familiarActivityCount}</strong><span>Familiar context</span><small>Familiar label or recalled user context</small></div>
            <div><strong>{repeatedActivityCount}</strong><span>Repeated activity</span><small>Transactions in groups with 2+ comparable observations</small></div>
            <div><strong>{insufficientActivityCount}</strong><span>Needs more evidence</span><small>Limited details or history to compare</small></div>
          </div>
          {establishedActivityPatterns.length ? (
            <div className="sg-baseline-list">
              {visibleBaselinePatterns.map(pattern => (
                <div className="sg-baseline-row" key={pattern.key}>
                  <span className="sg-baseline-dot" aria-hidden="true" />
                  <div className="min-w-0">
                    <strong>{pattern.kind === 'transfer'
                      ? `${pattern.direction === 'incoming' ? 'Receive' : 'Send'} ${pattern.asset} · ${pattern.counterparty?.slice(0, 8)}…${pattern.counterparty?.slice(-6)}`
                      : pattern.action}</strong>
                    <span>{pattern.observations} observations in loaded history{pattern.meanIntervalDays !== undefined ? ` · about every ${pattern.meanIntervalDays < 1 ? `${Math.max(1, Math.round(pattern.meanIntervalDays * 24))} hours` : `${pattern.meanIntervalDays.toFixed(1)} days`}` : ''}</span>
                  </div>
                  <time>{pattern.lastSeen ? `Last seen ${new Date(pattern.lastSeen).toLocaleDateString()}` : 'Date unavailable'}</time>
                </div>
              ))}
            </div>
          ) : (
            <p className="sg-baseline-empty">{transactions.length
              ? 'No repeated comparable patterns yet. SuiGuard needs at least two successful observations with matching on-chain details.'
              : 'Fetch activity to build a baseline from the transactions returned for this wallet.'}</p>
          )}
          {activityBaselinePageCount > 1 && (
            <nav className="sg-pagination sg-baseline-pagination" aria-label="Personal activity baseline pages">
              <span className="sg-pagination-count">Showing {activityBaselinePage * 5 + 1}–{Math.min((activityBaselinePage + 1) * 5, establishedActivityPatterns.length)} of {establishedActivityPatterns.length}</span>
              <div className="sg-pagination-actions">
                <button type="button" onClick={() => setActivityBaselinePage(page => Math.max(0, page - 1))} disabled={activityBaselinePage === 0} aria-label="Previous baseline page">Previous</button>
                <span aria-live="polite">{activityBaselinePage + 1} / {activityBaselinePageCount}</span>
                <button type="button" onClick={() => setActivityBaselinePage(page => Math.min(activityBaselinePageCount - 1, page + 1))} disabled={activityBaselinePage >= activityBaselinePageCount - 1} aria-label="Next baseline page">Next</button>
              </div>
            </nav>
          )}
          <p className="sg-baseline-footnote">Compared {comparableActivityCount} comparable transaction{comparableActivityCount === 1 ? '' : 's'} from the {transactions.length} currently loaded{latestPatternTimestamp ? ` · latest activity ${new Date(latestPatternTimestamp).toLocaleDateString()}` : ''}. Tatum history limits and missing fields affect coverage. SUI comparisons use observed wallet balance change, which may include gas.</p>
        </section>

        {/* Tabs: guidelines/components/tabs.md & Filter: guidelines/components/select.md */}
        <div className="sg-tabs flex flex-col sm:flex-row sm:items-center justify-between gap-md border-b border-secondary">
          <div className="sg-tab-list flex gap-lg overflow-x-auto" role="tablist" aria-label="Activity views">
            <button
              onClick={() => setActiveTab('all')}
              role="tab"
              aria-selected={activeTab === 'all'}
              className={`border-b-2 px-md py-sm text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring ${
                activeTab === 'all'
                  ? 'border-brand text-brand-primary'
                  : 'border-transparent text-tertiary hover:text-secondary'
              }`}
            >
              All Activity ({totalCount})
            </button>
            <button
              onClick={() => setActiveTab('queue')}
              role="tab"
              aria-selected={activeTab === 'queue'}
              className={`border-b-2 px-md py-sm text-sm font-semibold transition-colors flex items-center gap-xs focus-visible:ring-2 focus-visible:ring-focus-ring ${
                activeTab === 'queue'
                  ? 'border-brand text-brand-primary'
                  : 'border-transparent text-tertiary hover:text-secondary'
              }`}
            >
              <span>Review Queue</span>
              {queueCount > 0 && (
                <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-sm py-xxs text-xs font-bold text-utility-brand-700">
                  {queueCount}
                </span>
              )}
            </button>
            <button
              onClick={() => setActiveTab('familiar')}
              role="tab"
              aria-selected={activeTab === 'familiar'}
              className={`border-b-2 px-md py-sm text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring ${
                activeTab === 'familiar'
                  ? 'border-brand text-brand-primary'
                  : 'border-transparent text-tertiary hover:text-secondary'
              }`}
            >
              Familiar ({familiarCount})
            </button>
            <button
              onClick={() => setActiveTab('unfamiliar')}
              role="tab"
              aria-selected={activeTab === 'unfamiliar'}
              className={`border-b-2 px-md py-sm text-sm font-semibold transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring ${
                activeTab === 'unfamiliar'
                  ? 'border-brand text-brand-primary'
                  : 'border-transparent text-tertiary hover:text-secondary'
              }`}
            >
              Unfamiliar ({unfamiliarCount})
            </button>
            <button
              onClick={() => setActiveTab('memories')}
              role="tab"
              aria-selected={activeTab === 'memories'}
              className={`border-b-2 px-md py-sm text-sm font-semibold transition-colors flex items-center gap-xs focus-visible:ring-2 focus-visible:ring-focus-ring ${
                activeTab === 'memories'
                  ? 'border-brand text-brand-primary'
                  : 'border-transparent text-tertiary hover:text-secondary'
              }`}
            >
              <span>Walrus Memories ({walrusMemories.length})</span>
            </button>
          </div>

          {/* Filters: guidelines/components/select.md */}
          {activeTab !== 'memories' && (
            <div className="flex items-center gap-xs text-xs pb-xs sm:pb-none">
              <span className="sg-filter-label">Filter</span>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="rounded-md bg-primary px-lg py-xs text-xs text-primary border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                <option value="all">Status: All</option>
                <option value="success">Success only</option>
                <option value="failure">Failure only</option>
              </select>
            </div>
          )}
        </div>

        {/* Content Section: Memories View OR Transactions List */}
        {activeTab === 'memories' ? (
          /* Dedicated Walrus Memory View */
          <div className="space-y-md" id="walrus-memory-view" ref={memoryViewRef}>
            <section className="sg-memory-banner rounded-xl border border-secondary bg-primary p-xl flex flex-col md:flex-row md:items-center justify-between gap-md shadow-xs">
              <div>
                <h3 className="text-sm font-semibold text-primary flex items-center gap-xs">
                  <span>Walrus Memory</span>
                </h3>
                <p className="mt-xxs text-xs text-secondary">
                  {walrusClient
                    ? `Relayer reachable on ${memoryNetwork} for ${memoryAccountId.slice(0, 10)}...${memoryAccountId.slice(-6)}.`
                    : 'Connect your Walrus Memory account to save and recall your transaction context.'}
                </p>
                {(isRestoringMemory || isRecallingMemory) && (
                  <p role="status" className="mt-xs inline-flex items-center gap-xs text-xs text-secondary">
                    <span className="sg-loader" aria-hidden="true" />
                    {isRestoringMemory
                      ? 'Restoring your encrypted Walrus Memory profile…'
                      : 'Loading saved context… If your wallet asks, sign its message to activate memory. This signature does not submit a transaction or move funds.'}
                  </p>
                )}
              </div>
              <div className="flex items-center gap-xs text-xs">
                {/* Badge */}
                <span className="inline-flex items-center gap-xs rounded-full border border-utility-brand-200 bg-utility-brand-50 px-md py-xxs text-xs font-medium text-utility-brand-700">
                  {walrusMemories.length} Contexts loaded
                </span>
              </div>
            </section>

            <section className="sg-memory-setup rounded-xl border border-secondary bg-primary p-xl space-y-md">
              <div className="sg-memory-onboarding">
                <h4>How SuiGuard uses your wallet and memory</h4>
                <div className="sg-memory-onboarding-grid">
                  <p><strong>Why connect</strong><span>Your public address lets SuiGuard request wallet activity from Tatum. Reading activity does not require a wallet signature.</span></p>
                  <p><strong>What is public</strong><span>Sui transactions, addresses, and onchain object changes are public. SuiGuard cannot make that history private.</span></p>
                    <p><strong>What you control</strong><span>Your labels and explanations are encrypted before Walrus storage. You choose what to save and can disconnect the current browser session; the encrypted browser profile remains for restoration.</span></p>
                </div>
              </div>
              {!walrusClient ? (
                <>
                  <div className="space-y-xs">
                    <h4 className="text-sm font-semibold text-primary">Set up Walrus Memory</h4>
                    <p className="text-xs text-tertiary">
                      Connect the Sui wallet that owns this memory. SuiGuard checks for its account and restores this browser’s encrypted delegate profile automatically. On first setup, it creates an account if needed and registers a delegate after you approve the wallet prompts.
                    </p>
                    <p className="text-xs text-tertiary">
                      Network follows the connected wallet: <strong className="capitalize text-secondary">{memoryNetwork}</strong>. A new account needs two wallet approvals: account creation and delegate registration. SuiGuard creates search embeddings locally; no embedding API key is needed.
                    </p>
                  </div>
                  <label className="flex max-w-2xl flex-col gap-xs text-xs font-medium text-secondary">
                    Existing Walrus Memory account ID <span className="font-normal text-tertiary">(optional; normally discovered from your wallet)</span>
                    <input
                      value={memoryAccountId}
                      onChange={event => setMemoryAccountId(event.target.value)}
                      placeholder="Paste an existing 0x... account object ID"
                      autoComplete="off"
                      className="rounded-md bg-primary px-lg py-sm text-xs text-primary placeholder:text-placeholder border border-primary font-mono focus-visible:ring-2 focus-visible:ring-focus-ring"
                    />
                  </label>
                  <div className="rounded-lg border border-secondary bg-secondary p-md text-xs text-tertiary space-y-xxs">
                    <p>Memory text and embeddings are processed in your browser. Seal-encrypted content and its search vector are sent to the Walrus relayer; plaintext is not sent to an embedding API. The delegate key is encrypted in this browser’s IndexedDB for this wallet and network.</p>
                    <p>To activate and load saved memory, sign the wallet’s message request when prompted. This Seal access signature is not a transaction and does not move funds. First-time setup separately needs wallet approval for account creation and delegate registration, which may use network gas.</p>
                    <a className="text-brand-primary underline" href="https://memory.walrus.xyz" target="_blank" rel="noreferrer">Open Walrus Memory dashboard</a>
                  </div>
                  {memoryStatusMessage && <p role="status" className="text-xs text-secondary">{memoryStatusMessage}</p>}
                  <button
                    type="button"
                    onClick={handleConnectMemory}
                    disabled={isConnectingMemory || !currentAccount}
                    className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
                  >
                    {isConnectingMemory && <span className="sg-loader" aria-hidden="true" />}
                    <span>{isConnectingMemory ? 'Setting up Walrus Memory...' : 'Set up Walrus Memory'}</span>
                  </button>
                </>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-md">
                  <div className="text-xs text-tertiary">
                    <span className="font-semibold text-utility-success-700">Configured</span>
                    <span> · Namespace: {SUI_GUARD_MEMORY_NAMESPACE} · Wallet: {currentAccount?.address.slice(0, 10)}...</span>
                    {memoryStatusMessage && <p role="status" className="mt-xs">{memoryStatusMessage}</p>}
                  </div>
                  <button type="button" onClick={handleDisconnectMemory} className="rounded-lg border border-primary bg-primary px-lg py-sm text-xs font-semibold text-secondary hover:bg-primary-hover">Disconnect</button>
                </div>
              )}
            </section>

            <section className="sg-memory-verification rounded-xl border border-secondary bg-primary p-xl" aria-labelledby="memory-verification-heading">
              <div className="flex flex-wrap items-start justify-between gap-sm">
                <div>
                  <h4 id="memory-verification-heading" className="text-sm font-semibold text-primary">Walrus Memory activity</h4>
                  <p className="mt-xxs text-xs text-tertiary">The 12 most recent writes and recalls recorded in this browser session, five per page. Blob references identify SDK results; this is not a count of every account write.</p>
                </div>
                <span className="sg-memory-network">{memoryNetwork.toUpperCase()} · {walrusClient ? 'CONNECTED' : 'NOT CONNECTED'}</span>
              </div>
              {memoryOperations.length ? (
                <>
                <ol className="sg-memory-operations">
                  {visibleMemoryOperations.map(operation => (
                    <li key={operation.id} data-status={operation.status}>
                      <span className="sg-memory-operation-status">{operation.status === 'confirmed' ? '✓' : operation.status === 'pending' ? '…' : operation.status === 'no-match' ? '—' : '!'}</span>
                      <div><strong>{operation.kind === 'write' ? 'Encrypted write' : 'Remote recall'} · {operation.status === 'confirmed' ? (operation.kind === 'write' ? 'confirmed' : 'recalled') : operation.status}</strong><p>{operation.message}</p><small>Tx {operation.txDigest.slice(0, 12)}… · {new Date(operation.at).toLocaleString()}</small>{operation.blobId && <a className="sg-proof-link" href={getWalrusBlobProofUrl(operation.blobId, memoryNetwork)} target="_blank" rel="noreferrer">Open Walrus proof ↗ <code>{operation.blobId}</code></a>}</div>
                    </li>
                  ))}
                </ol>
                {memoryOperations.length > memoryOperationPageSize && (
                  <nav className="sg-pagination sg-memory-pagination" aria-label="Walrus Memory activity pages">
                    <span className="sg-pagination-count">Showing {safeMemoryOperationPage * memoryOperationPageSize + 1}–{Math.min((safeMemoryOperationPage + 1) * memoryOperationPageSize, memoryOperations.length)} of {memoryOperations.length} operations</span>
                    <div className="sg-pagination-actions">
                      <button type="button" onClick={() => setMemoryOperationPage(page => Math.max(0, Math.min(safeMemoryOperationPage, page) - 1))} disabled={safeMemoryOperationPage === 0} aria-label="Previous Walrus Memory activity page">Previous</button>
                      <span aria-live="polite">{safeMemoryOperationPage + 1} / {memoryOperationPageCount}</span>
                      <button type="button" onClick={() => setMemoryOperationPage(page => Math.min(memoryOperationPageCount - 1, Math.max(safeMemoryOperationPage, page) + 1))} disabled={safeMemoryOperationPage >= memoryOperationPageCount - 1} aria-label="Next Walrus Memory activity page">Next</button>
                    </div>
                  </nav>
                )}
                </>
              ) : (
                <p className="sg-baseline-empty">No write or explicit recall has been recorded in this session. Existing contexts may still be restored from this browser’s encrypted cache.</p>
              )}
            </section>

            <div className="space-y-sm">
              <div className="sg-memory-searchbar">
                <label htmlFor="wallet-memory-search">Search saved memories</label>
                <input
                  id="wallet-memory-search"
                  type="search"
                  value={globalSearch}
                  onChange={event => {
                    setGlobalSearch(event.target.value)
                    setVisibleActivityCount(20)
                    setMemoryActivityPage(0)
                  }}
                  placeholder="Notes, app, label, transaction digest or blob ID"
                  autoComplete="off"
                />
                <span aria-live="polite">{filteredWalrusMemories.length} of {walrusMemories.length}</span>
              </div>
              {walrusMemories.length === 0 && (
                <section className="rounded-xl border border-secondary bg-primary p-xl text-sm text-secondary">
                  {walrusClient
                    ? 'No matching memories have been recalled for the currently loaded activity yet.'
                    : 'Connect Walrus Memory to recall saved context or persist a label.'}
                </section>
              )}
              {walrusMemories.length > 0 && filteredWalrusMemories.length === 0 && (
                <section className="sg-memory-search-empty" role="status">
                  No saved memories match “{globalSearch.trim()}”. Try another term.
                </section>
              )}
              {visibleWalrusMemories.map((mem) => (
                <section key={mem.id} className="sg-memory-entry rounded-xl border border-secondary bg-primary p-xl space-y-sm shadow-xs">
                  <div className="flex flex-wrap items-center justify-between gap-xs">
                    <div className="flex items-center gap-xs">
                      {/* Badge: guidelines/components/badge.md */}
                      <span
                        className={`inline-flex items-center gap-xs rounded-full px-md py-xxs text-xs font-medium ${
                          mem.label === 'familiar'
                            ? 'bg-utility-success-50 text-utility-success-700 border border-utility-success-200'
                            : mem.label === 'unfamiliar'
                            ? 'bg-utility-warning-50 text-utility-warning-700 border border-utility-warning-200'
                            : 'bg-utility-gray-50 text-utility-gray-700 border border-utility-gray-200'
                        }`}
                      >
                        {mem.label.toUpperCase()}
                      </span>
                      {mem.knownApp && (
                        <span className="inline-flex items-center rounded-full bg-secondary border border-secondary px-sm py-xxs text-xs text-secondary">
                          App: {mem.knownApp}
                        </span>
                      )}
                      <span className="text-xs text-tertiary">
                        Reviewed {new Date(mem.reviewedAt).toLocaleDateString()}
                      </span>
                    </div>

                    <div className="flex items-center gap-xs text-xs text-tertiary font-mono">
                      <a className="sg-proof-link sg-memory-proof-link" href={getWalrusBlobProofUrl(mem.blobId, memoryNetwork)} target="_blank" rel="noreferrer" title="Open this memory blob's Walrus onchain record">Blob proof: {mem.blobId.substring(0, 20)}... ↗</a>
                    </div>
                  </div>

                  <p className="text-sm text-primary italic">"{mem.explanation}"</p>

                  <div className="text-xs text-tertiary flex flex-wrap items-center justify-between gap-xs border-t border-secondary pt-xs font-mono">
                    <span>Tx: {mem.txDigest.substring(0, 24)}...</span>
                  </div>
                </section>
              ))}
            </div>
            {filteredWalrusMemories.length > memoryActivityPageSize && (
              <nav className="sg-pagination sg-memory-pagination" aria-label="Saved memory pages">
                <span className="sg-pagination-count">Showing {safeMemoryActivityPage * memoryActivityPageSize + 1}–{Math.min((safeMemoryActivityPage + 1) * memoryActivityPageSize, filteredWalrusMemories.length)} of {filteredWalrusMemories.length} saved memories</span>
                <div className="sg-pagination-actions">
                  <button type="button" onClick={() => setMemoryActivityPage(page => Math.max(0, Math.min(safeMemoryActivityPage, page) - 1))} disabled={safeMemoryActivityPage === 0} aria-label="Previous saved memories page">Previous</button>
                  <span aria-live="polite">{safeMemoryActivityPage + 1} / {memoryActivityPageCount}</span>
                  <button type="button" onClick={() => setMemoryActivityPage(page => Math.min(memoryActivityPageCount - 1, Math.max(safeMemoryActivityPage, page) + 1))} disabled={safeMemoryActivityPage >= memoryActivityPageCount - 1} aria-label="Next saved memories page">Next</button>
                </div>
              </nav>
            )}
          </div>
        ) : (
          /* Activity Feed List: guidelines/components/card.md */
          <div className="sg-activity-list space-y-md">
            <div className="sg-memory-searchbar">
              <label htmlFor="wallet-memory-search">Search wallet activities</label>
              <input
                id="wallet-memory-search"
                type="search"
                value={globalSearch}
                onChange={event => {
                  setGlobalSearch(event.target.value)
                  setVisibleActivityCount(20)
                  setMemoryActivityPage(0)
                }}
                placeholder="Digest, address, token, app, label or transaction details"
                autoComplete="off"
              />
              <span aria-live="polite">{filteredTxs.length} of {transactions.length}</span>
            </div>
            {filteredTxs.length === 0 ? (
              <section className="sg-empty rounded-xl border border-secondary bg-primary p-2xl text-center">
                <span className="sg-empty-index" aria-hidden="true">—</span>
                <h4 className="text-sm font-semibold text-primary">
                  {hasFetchedActivity && transactions.length === 0
                    ? 'No transactions found for this address'
                    : hasFetchedActivity
                      ? normalizedSearch
                        ? 'No wallet activities match your search'
                        : 'No activities match your filter'
                      : 'Enter a wallet address to get started'}
                </h4>
                <p className="mt-xxs text-xs text-tertiary">
                  {hasFetchedActivity && transactions.length === 0
                    ? 'Tatum returned no matching activity. Check the address and selected network.'
                    : hasFetchedActivity
                      ? normalizedSearch
                        ? 'Try another search term, or clear the search to see the activities in this view.'
                        : 'Try switching tabs or resetting the status filters.'
                      : 'Activity will appear here after you fetch it from the Sui network.'}
                </p>
              </section>
            ) : (
              visibleActivityTxs.map((tx) => {
                const isFamiliar = tx.userContext?.label === 'familiar'
                const isUnfamiliar = tx.userContext?.label === 'unfamiliar'
                const isUnlabeled = !tx.userContext

                return (
                  <section
                    key={tx.digest}
                    className="sg-transaction rounded-xl border border-secondary bg-primary p-xl space-y-md shadow-xs hover:border-primary transition-colors"
                  >
                    {/* Header Row: Status, Hash, Timestamp, Label Badge */}
                    <div className="flex flex-wrap items-center justify-between gap-xs">
                      <div className="flex items-center gap-sm">
                        <span
                          className={`flex size-8 items-center justify-center rounded-full text-xs shrink-0 ${
                            tx.status === 'success'
                              ? 'bg-utility-success-50 text-utility-success-700 border border-utility-success-200'
                              : tx.status === 'failure'
                                ? 'bg-utility-error-50 text-utility-error-700 border border-error-subtle'
                                : 'bg-utility-gray-50 text-utility-gray-700 border border-utility-gray-200'
                          }`}
                        >
                          <span className="sg-status-code">{tx.status === 'success' ? '✓' : tx.status === 'failure' ? 'ERR' : '—'}</span>
                        </span>
                        <div>
                          <div className="flex items-center gap-xs">
                            <span className="font-mono text-xs font-semibold text-primary">
                              {tx.digest.substring(0, 14)}...{tx.digest.substring(tx.digest.length - 8)}
                            </span>
                            <button
                              onClick={() => copyToClipboard(tx.digest)}
                              className="text-fg-quaternary hover:text-fg-primary text-xs"
                              title="Copy transaction digest"
                            >
                              <span>Copy</span>
                            </button>
                            {copiedDigest === tx.digest && (
                              <span className="text-xs text-utility-success-700">Copied</span>
                            )}
                          </div>
                          {tx.timestampMs && (
                            <div className="text-xs text-tertiary flex items-center gap-xxs mt-xxs">
                              <span>{new Date(tx.timestampMs).toLocaleTimeString()} ({new Date(tx.timestampMs).toLocaleDateString()})</span>
                            </div>
                          )}
                        </div>
                      </div>

                      {/* Right: Label badge or Review Needed CTA */}
                      <div className="flex items-center gap-xs">
                        {isUnlabeled ? (
                          /* Secondary Action Button: guidelines/components/button.md */
                          <button
                            onClick={() => openLabelModal(tx)}
                            className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-xs text-xs font-semibold text-brand-primary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
                          >
                            <span>{tx.activityAssessment?.status === 'unmatched' ? 'Review activity' : 'Add context'}</span>
                          </button>
                        ) : (
                          <div className="flex items-center gap-xs">
                            {/* Tinted Badges: guidelines/components/badge.md */}
                            <span
                              className={`inline-flex items-center gap-xs rounded-full px-md py-xxs text-xs font-medium ${
                                isFamiliar
                                  ? 'bg-utility-success-50 text-utility-success-700 border border-utility-success-200'
                                  : isUnfamiliar
                                  ? 'bg-utility-warning-50 text-utility-warning-700 border border-utility-warning-200'
                                  : 'bg-utility-gray-50 text-utility-gray-700 border border-utility-gray-200'
                              }`}
                            >
                              <span>{tx.userContext?.label.toUpperCase()}</span>
                            </span>
                            <button
                              onClick={() => openLabelModal(tx)}
                              className="text-xs text-tertiary hover:text-primary underline ml-xs"
                            >
                              Edit
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Section 1: App-generated Plain-Language Explanation */}
                    <div className="sg-context-box p-md rounded-md bg-secondary border border-secondary space-y-xs">
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-semibold text-secondary flex items-center gap-xs">
                          <span className="sg-fact-marker" aria-hidden="true" />
                          <span>SuiGuard explanation from Tatum data</span>
                        </span>
                        <span className="text-xs text-tertiary">Informational · derived from returned transaction facts</span>
                      </div>
                      <p className="text-sm text-primary">{tx.generatedSummary}</p>

                      {tx.activityAssessment && (
                        <div className="sg-pattern-assessment" data-status={tx.activityAssessment.status}>
                          <span className="sg-pattern-mark" aria-hidden="true" />
                          <div className="min-w-0">
                            <p className="sg-pattern-title">
                            {tx.activityAssessment.status === 'exact'
                              ? 'Exact transaction context'
                              : tx.activityAssessment.status === 'matched'
                              ? 'Matches a saved pattern'
                              : tx.activityAssessment.status === 'unmatched'
                                ? 'Needs your review'
                                : tx.activityAssessment.status === 'system'
                                  ? 'Walrus Memory activity'
                                  : 'Pattern check incomplete'}
                            </p>
                            <p className="sg-pattern-copy">{tx.activityAssessment.explanation}</p>
                          </div>
                        </div>
                      )}

                      {address.trim() && (() => {
                        const pattern = assessActivityPattern(tx, address.trim(), activityBaseline)
                        return pattern.key ? (
                          <div className="sg-baseline-assessment" data-established={Boolean(pattern.pattern && pattern.pattern.observations >= 2)}>
                            <span className="sg-baseline-dot" aria-hidden="true" />
                            <div>
                              <strong>{pattern.pattern && pattern.pattern.observations >= 2 ? 'Repeated activity pattern' : 'Pattern not established'}</strong>
                              <p>{pattern.explanation}</p>
                            </div>
                          </div>
                        ) : null
                      })()}

                      {/* Matched Memory Context (Walrus Recall) */}
                      {tx.userContext?.matchedMemory && (
                        <div className="mt-xs pt-xs border-t border-secondary flex items-start gap-xs text-xs text-secondary">
                          <div>
                            <span className="font-medium text-utility-brand-700">Memory Context: </span>
                            <span>
                              {tx.userContext.matchedMemory.confidence === 'exact transaction match'
                                ? `You saved context for this exact transaction on ${tx.userContext.matchedMemory.date}: `
                                : `You saved context for a related interaction on ${tx.userContext.matchedMemory.date}: `}
                              "{tx.userContext.matchedMemory.explanation}"
                            </span>
                            <span className="mt-xxs block text-tertiary">Source: {tx.userContext.matchedMemory.source === 'walrus-recall'
                              ? 'recalled from Walrus in this session'
                              : tx.userContext.matchedMemory.source === 'browser-cache'
                                ? 'restored from this browser’s encrypted cache; verify with Walrus below'
                                : 'saved to Walrus during this session'}</span>
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Section 2: User's Approved Label & Explanation */}
                    {tx.userContext && (
                      <div className="sg-context-box sg-user-context p-md rounded-md bg-secondary border border-secondary space-y-xs">
                        <div className="flex min-w-0 flex-col items-start gap-xxs text-xs text-tertiary sm:flex-row sm:items-start sm:justify-between">
                          <span className="font-medium text-secondary">Your Saved Context:</span>
                          {tx.userContext.walrusBlobId && (
                            <span className="max-w-full break-all font-mono text-xs text-utility-brand-700 sm:text-right">
                              <a className="sg-proof-link sg-activity-proof-link" href={getWalrusBlobProofUrl(tx.userContext.walrusBlobId, memoryNetwork)} target="_blank" rel="noreferrer" title="Open this memory blob's Walrus onchain record">Walrus Memory: {tx.userContext.walrusBlobId} ↗</a>
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-primary font-medium italic">
                          "{tx.userContext.userExplanation}"
                        </p>
                        {tx.userContext.knownApp && (
                          <div className="text-xs text-tertiary">
                            Known app: <strong className="text-secondary">{tx.userContext.knownApp}</strong>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Section 3: Tatum transaction evidence */}
                    <div className="border-t border-secondary pt-sm flex flex-wrap items-center justify-between gap-sm text-xs text-tertiary">
                      <div className="flex flex-wrap items-center gap-md">
                        <span className="font-semibold text-secondary">Tatum evidence:</span>
                        {tx.amount && (
                          <span className="flex items-center gap-xs">
                            <span className="text-quaternary">Net SUI balance change:</span>
                            <span className="font-semibold text-primary">
                              {tx.balanceChangeDirection === 'decrease' ? '−' : tx.balanceChangeDirection === 'increase' ? '+' : ''}{tx.amount} SUI
                            </span>
                          </span>
                        )}
                        {tx.verifiedFacts.packageId && (
                          <span className="flex items-center gap-xs font-mono">
                            <span className="text-quaternary font-sans">Contract call:</span>
                            <span className="text-secondary">
                              {tx.verifiedFacts.moduleName}::{tx.verifiedFacts.functionName}
                            </span>
                          </span>
                        )}
                        {tx.verifiedFacts.gasUsed && (
                          <span>Gas: {tx.verifiedFacts.gasUsed}</span>
                        )}
                        {tx.objectChangesCount !== undefined && (
                          <span>On-chain records changed: {tx.objectChangesCount}</span>
                        )}
                      </div>

                      <button
                        onClick={() => setSelectedTx(tx)}
                        className="text-xs text-brand-primary hover:underline flex items-center gap-xxs ml-auto"
                      >
                        <span>Inspect transaction</span>
                      </button>
                      {walrusClient && (
                        <button
                          type="button"
                          onClick={() => void verifyMemoryRecall(tx)}
                          disabled={verifyingMemoryDigest === tx.digest}
                          className="text-xs text-brand-primary hover:underline flex items-center gap-xxs disabled:opacity-60"
                        >
                          {verifyingMemoryDigest === tx.digest ? 'Checking Walrus…' : 'Verify with Walrus'}
                        </button>
                      )}
                    </div>
                  </section>
                )
              })
            )}
          </div>
        )}
        {activeTab !== 'memories' && hasFetchedActivity && (visibleActivityCount < filteredTxs.length || (hasMoreActivity && activityPagesLoaded < 10)) && (
          <div className="sg-activity-pagination">
            <span className="sg-pagination-count">Showing {Math.min(visibleActivityCount, filteredTxs.length)} of {filteredTxs.length} loaded activities</span>
            <button type="button" onClick={handleShowMoreActivity} disabled={isLoadingMoreActivity} className="sg-load-more-button">
              {isLoadingMoreActivity && <span className="sg-loader" aria-hidden="true" />}
              <span>{isLoadingMoreActivity ? 'Loading activity…' : 'Load more activities'}</span>
            </button>
          </div>
        )}
        {activeTab !== 'memories' && hasFetchedActivity && transactions.length > 0 && (
          <p className="pt-sm text-center text-xs text-tertiary">
            Activity comes from Tatum’s affected-address index. Up to 500 transactions are shown per search; the service may return fewer when its scan budget is reached.
          </p>
        )}
        </>}
      </main>

      {/* Label & Explanation Modal: guidelines/components/dialog.md */}
      {editingTx && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-md">
          {/* Backdrop: bg-overlay at opacity-70 */}
          <div className="fixed inset-0 bg-overlay opacity-70" onClick={() => setEditingTx(null)} />
          {/* Panel: rounded-lg bg-primary shadow-2xl */}
          <div className="relative flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-lg bg-primary shadow-2xl border border-secondary">
            <header className="flex items-start justify-between gap-lg border-b border-secondary p-xl">
              <div>
                <h2 className="text-lg font-semibold text-primary flex items-center gap-xs">
                  <span>Add Your Context</span>
                </h2>
                <p className="mt-xs text-sm text-tertiary">
                  Provide context in your own words. Your label is encrypted in this browser before it is stored.
                </p>
              </div>
              <button
                onClick={() => setEditingTx(null)}
                aria-label="Close dialog"
                className="text-fg-quaternary hover:text-fg-primary"
              >
                <span className="sg-close-mark" aria-hidden="true">×</span>
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-xl text-sm text-secondary space-y-md">
              <div className="flex flex-col gap-sm">
                <label className="text-sm font-medium text-secondary">
                  How does this activity feel to you?
                </label>
                <div className="grid grid-cols-3 gap-xs">
                  <button
                    type="button"
                    onClick={() => setEditLabel('familiar')}
                    className={`inline-flex items-center justify-center rounded-lg px-md py-sm text-sm font-semibold border transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring ${
                      editLabel === 'familiar'
                        ? 'bg-utility-success-50 border-utility-success-200 text-utility-success-700'
                        : 'bg-primary border-primary text-secondary hover:bg-primary-hover'
                    }`}
                  >
                    Familiar
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditLabel('unfamiliar')}
                    className={`inline-flex items-center justify-center rounded-lg px-md py-sm text-sm font-semibold border transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring ${
                      editLabel === 'unfamiliar'
                        ? 'bg-utility-warning-50 border-utility-warning-200 text-utility-warning-700'
                        : 'bg-primary border-primary text-secondary hover:bg-primary-hover'
                    }`}
                  >
                    Unfamiliar
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditLabel('misunderstood')}
                    className={`inline-flex items-center justify-center rounded-lg px-md py-sm text-sm font-semibold border transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring ${
                      editLabel === 'misunderstood'
                        ? 'bg-utility-gray-50 border-utility-gray-200 text-utility-gray-700'
                        : 'bg-primary border-primary text-secondary hover:bg-primary-hover'
                    }`}
                  >
                    Misunderstood
                  </button>
                </div>
              </div>

              {/* Input Recipe: guidelines/components/input.md */}
              <div className="flex flex-col gap-sm">
                <label className="text-sm font-medium text-secondary">
                  Your Explanation (What were you doing or expecting?)
                </label>
                <textarea
                  value={editExplanation}
                  onChange={(e) => setEditExplanation(e.target.value)}
                  placeholder="e.g. Regular transfer to my savings wallet"
                  rows={3}
                  className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>

              {/* Input Recipe: guidelines/components/input.md */}
              <div className="flex flex-col gap-sm">
                <label className="text-sm font-medium text-secondary">
                  Known Application or Project (Optional)
                </label>
                <input
                  type="text"
                  value={editKnownApp}
                  onChange={(e) => setEditKnownApp(e.target.value)}
                  placeholder="e.g. the app or wallet you recognize"
                  className="rounded-md bg-primary px-lg py-sm text-sm text-primary placeholder:text-placeholder border border-primary focus-visible:ring-2 focus-visible:ring-focus-ring"
                />
              </div>

              <div className="flex gap-md rounded-xl bg-secondary p-md border border-secondary text-xs text-tertiary">
                <span>
                  <strong>Privacy:</strong> Memory text and embeddings are processed in your browser. Seal-encrypted content and its search vector are sent to the Walrus relayer; plaintext is not sent to an embedding API.
                </span>
              </div>
            </div>

            <footer className="flex justify-end gap-sm border-t border-secondary p-xl">
              {/* Secondary Button */}
              <button
                type="button"
                onClick={() => setEditingTx(null)}
                className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                Cancel
              </button>
              {/* Primary Button */}
              <button
                type="button"
                onClick={handleSaveMemory}
                disabled={isSavingMemory || !editExplanation.trim()}
                className="inline-flex items-center gap-sm rounded-lg border border-transparent bg-brand-solid px-lg py-sm text-sm font-semibold text-primary-on-brand shadow-xs hover:bg-brand-solid-hover focus-visible:ring-2 focus-visible:ring-focus-ring disabled:opacity-50"
              >
                {isSavingMemory ? (
                  <>
                    <span className="sg-loader" aria-hidden="true" />
                    <span>Writing to Walrus...</span>
                  </>
                ) : (
                  <>
                    <span>{walrusClient ? 'Save label to Walrus' : 'Connect Walrus Memory first'}</span>
                  </>
                )}
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* Raw Verified Facts Dialog: guidelines/components/dialog.md */}
      {selectedTx && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-md">
          {/* Backdrop */}
          <div className="fixed inset-0 bg-overlay opacity-70" onClick={() => setSelectedTx(null)} />
          {/* Panel */}
          <div className="relative flex max-h-full w-full max-w-2xl flex-col overflow-hidden rounded-lg bg-primary shadow-2xl border border-secondary">
            <header className="flex items-start justify-between gap-lg border-b border-secondary p-xl">
              <div>
                <h2 className="text-lg font-semibold text-primary">Raw Verified Onchain Facts</h2>
                <p className="mt-xs text-sm text-tertiary">Direct inspection of Sui transaction block effects</p>
              </div>
              <button
                onClick={() => setSelectedTx(null)}
                aria-label="Close dialog"
                className="text-fg-quaternary hover:text-fg-primary"
              >
                <span className="sg-close-mark" aria-hidden="true">×</span>
              </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-xl text-xs font-mono space-y-sm bg-secondary border-t border-b border-secondary max-h-96">
              <div>
                <span className="text-tertiary">Digest: </span>
                <span className="text-primary">{selectedTx.digest}</span>
              </div>
              <div>
                <span className="text-tertiary">Status: </span>
                <span className={selectedTx.status === 'success' ? 'text-utility-success-700' : selectedTx.status === 'failure' ? 'text-utility-error-700' : 'text-utility-gray-700'}>
                  {selectedTx.status}
                </span>
              </div>
              <div>
                <span className="text-tertiary">Sender: </span>
                <span className="text-primary">{selectedTx.sender}</span>
              </div>
              {selectedTx.recipient && (
                <div>
                  <span className="text-tertiary">Recipient: </span>
                  <span className="text-primary">{selectedTx.recipient}</span>
                </div>
              )}
              {selectedTx.verifiedFacts.packageId && (
                <div>
                  <span className="text-tertiary">Contract: </span>
                  <span className="text-primary">
                    {selectedTx.verifiedFacts.packageId}::{selectedTx.verifiedFacts.moduleName}::{selectedTx.verifiedFacts.functionName}
                  </span>
                </div>
              )}
              {selectedTx.verifiedFacts.gasUsed && (
                <div>
                  <span className="text-tertiary">Gas Used: </span>
                  <span className="text-primary">{selectedTx.verifiedFacts.gasUsed}</span>
                </div>
              )}
              {selectedTx.objectChanges && selectedTx.objectChanges.length > 0 && (
                <div className="pt-xs">
                  <span className="text-tertiary block mb-xxs">Observed Object Changes:</span>
                  <ul className="list-disc list-inside space-y-xxs">
                    {selectedTx.objectChanges.map((chg, idx) => (
                      <li key={idx} className="text-secondary">
                        [{chg.type}] {chg.objectType || 'Object type unavailable'} ({chg.objectId})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            <footer className="flex justify-end gap-sm border-t border-secondary p-xl">
              <button
                onClick={() => setSelectedTx(null)}
                className="inline-flex items-center gap-sm rounded-lg bg-primary px-lg py-sm text-sm font-semibold text-secondary border border-primary shadow-xs hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-focus-ring"
              >
                Close
              </button>
            </footer>
          </div>
        </div>
      )}

      {/* Footer */}
      <footer className="border-t border-secondary bg-primary px-xl py-lg text-xs text-tertiary">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-md">
          <div className="flex items-center gap-xs">
            <span>Onchain activity is public; saved context is encrypted.</span>
          </div>
          <div>
            <span>Tatum Sui gRPC &middot; Walrus Memory</span>
          </div>
        </div>
      </footer>
    </div>
  )
}
