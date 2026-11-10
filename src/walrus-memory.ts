import { MemWalManual } from '@mysten-incubation/memwal/manual'
import type { WalletSigner } from '@mysten-incubation/memwal/manual'
import { embedLocally } from './local-embedding'
import { SUI_GUARD_MEMORY_NAMESPACE, WALRUS_MEMORY_NETWORKS } from './walrus-config'
export { SUI_GUARD_MEMORY_NAMESPACE, WALRUS_MEMORY_NETWORKS } from './walrus-config'
import type { TransactionItem, WalrusMemoryRecord } from './App'
import { describePatternMatch, getAssetFlowSignature, getObjectTypeFlowSignature, getTransactionDirection, isAssetSwapFlow, isRelevantTransactionMemory, normalizeCoinType } from './transaction-patterns'
import type { TransactionMemoryContext } from './transaction-patterns'
export { describePatternMatch, getAssetFlowSignature, getObjectTypeFlowSignature, getTransactionDirection, isAssetSwapFlow, isRelevantTransactionMemory } from './transaction-patterns'
export type { TransactionMemoryContext } from './transaction-patterns'

export function createWalrusMemoryClient(options: {
  network: 'mainnet' | 'testnet'
  accountId: string
  delegateKey: string
  walletSigner: WalletSigner
}) {
  const deployment = WALRUS_MEMORY_NETWORKS[options.network]
  const client = MemWalManual.create({
    key: options.delegateKey.trim(),
    accountId: options.accountId.trim(),
    // The SDK requires this field, but the instance embed method is replaced
    // below with a local model, so no API key is used or sent.
    embeddingApiKey: 'local-model-no-api-key',
    packageId: deployment.packageId,
    registryId: deployment.registryId,
    // Proxy relayer calls through the app server so local and deployed browser
    // origins do not depend on the public relayer's CORS allowlist.
    serverUrl: `${window.location.origin}/api/walrus-memory/${options.network}`,
    suiNetwork: options.network,
    namespace: SUI_GUARD_MEMORY_NAMESPACE,
    walletSigner: options.walletSigner,
  })

  // MemWalManual calls this method for both writes and recall. It is a regular
  // prototype method at runtime, so override it for this client instance.
  Object.defineProperty(client, 'embed', { configurable: true, value: embedLocally })
  return client
}

export function makeTransactionMemoryQuery(walletAddress: string, tx: TransactionItem) {
  return [
    'Sui wallet transaction context',
    `Wallet: ${walletAddress}`,
    `Digest: ${tx.digest}`,
    `Direction: ${getTransactionDirection(tx, walletAddress)}`,
    `Summary: ${tx.generatedSummary}`,
    `Coin: ${tx.coinType || 'unknown'}`,
    `Sender: ${tx.sender || 'unknown'}`,
    `Function: ${tx.verifiedFacts.moduleName || ''}::${tx.verifiedFacts.functionName || ''}`,
    `Observed asset flow: ${getAssetFlowSignature(tx) || 'unavailable'}`,
    `Observed object type flow: ${getObjectTypeFlowSignature(tx) || 'unavailable'}`,
  ].join('\n')
}

export function isWalrusMemorySystemActivity(tx: TransactionItem): boolean {
  const moduleName = tx.verifiedFacts.moduleName?.toLowerCase()
  const functionName = tx.verifiedFacts.functionName?.toLowerCase()
  if (moduleName !== 'account') return false
  if (functionName === 'seal_encrypt_fence' || functionName === 'add_delegate_key') return true
  return functionName === 'create_account' && tx.generatedSummary.toLowerCase().includes('walrus memory account')
}

export function describeUnmatchedPattern(
  tx: TransactionItem,
  walletAddress: string,
  memories: TransactionMemoryContext[],
): string {
  if ((tx.verifiedFacts.moduleName?.toLowerCase() === 'router' && /swap/i.test(tx.verifiedFacts.functionName || '')) || isAssetSwapFlow(getAssetFlowSignature(tx))) {
    return 'This is a swap-router interaction. SuiGuard could not confirm the same asset balance flow as a saved swap, so it left the saved label unapplied. Review this swap and add context if you recognize it.'
  }
  const direction = getTransactionDirection(tx, walletAddress)
  if (memories.length === 0) {
    return 'No saved transaction patterns were loaded for this wallet during this check. Confirm Walrus Memory is restored in this browser, then fetch activity again.'
  }
  if (direction === 'other') {
    return 'SuiGuard could not identify a transfer direction or known contract action, so it could not compare this activity confidently. Review the transaction details.'
  }
  if (!tx.coinType) {
    return 'Tatum did not provide enough asset information to compare this activity with saved patterns. Review the transaction details.'
  }

  const comparable = memories.filter(memory =>
    memory.direction === direction && memory.coinType && normalizeCoinType(memory.coinType) === normalizeCoinType(tx.coinType!),
  )
  if (comparable.length > 0) {
    return `This ${direction} activity uses an asset found in saved context, but its counterparty or contract action did not match the patterns checked. Review it and add context if you recognize it.`
  }
  return `SuiGuard found no saved ${direction} pattern for this asset in the patterns it checked. Review the activity and add context if you recognize it.`
}

export function parseTransactionMemory(text: string): TransactionMemoryContext | null {
  try {
    const value = JSON.parse(text) as Partial<TransactionMemoryContext>
    if (
      value.type !== 'suiguard-transaction-context' ||
      value.version !== 1 ||
      typeof value.walletAddress !== 'string' ||
      typeof value.txDigest !== 'string' ||
      !['familiar', 'unfamiliar', 'misunderstood'].includes(value.label || '') ||
      typeof value.explanation !== 'string' ||
      typeof value.transactionSummary !== 'string' ||
      typeof value.reviewedAt !== 'string'
    ) return null
    return value as TransactionMemoryContext
  } catch {
    return null
  }
}

export function toWalrusMemoryRecord(
  memory: TransactionMemoryContext,
  blobId: string,
): WalrusMemoryRecord {
  return {
    id: memory.txDigest,
    txDigest: memory.txDigest,
    label: memory.label,
    explanation: memory.explanation,
    knownApp: memory.knownApp,
    reviewedAt: memory.reviewedAt,
    blobId,
    confirmed: true,
    storageSource: 'walrus-memory',
  }
}
