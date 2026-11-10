import type { TransactionItem } from './App'
import { getAssetFlowSignature, getObjectTypeFlowSignature, isAssetSwapFlow } from './transaction-patterns.ts'

export interface ActivityPattern {
  key: string
  kind: 'transfer' | 'contract'
  direction?: 'incoming' | 'outgoing'
  asset?: string
  counterparty?: string
  action?: string
  assetFlowSignature?: string
  objectTypeFlowSignature?: string
  observations: number
  firstSeen?: number
  lastSeen?: number
  meanIntervalDays?: number
  latestBalanceDelta?: number
  meanAbsoluteBalanceDelta?: number
}

export interface ActivityPatternObservation {
  key: string | null
  explanation: string
  pattern?: ActivityPattern
}

function normalizeAddress(address: string): string {
  return `0x${address.toLowerCase().replace(/^0x/, '').replace(/^0+/, '') || '0'}`
}

function assetName(coinType: string | undefined): string | undefined {
  if (!coinType) return undefined
  const match = coinType.match(/::([a-zA-Z0-9_]+)$/)
  if (!match) return undefined
  return match[1].toLowerCase() === 'sui' ? 'SUI' : match[1].toUpperCase()
}

function direction(tx: TransactionItem, wallet: string): 'incoming' | 'outgoing' | undefined {
  const own = normalizeAddress(wallet)
  const sender = tx.sender ? normalizeAddress(tx.sender) : undefined
  const recipient = tx.recipient ? normalizeAddress(tx.recipient) : undefined
  if (sender && sender !== own) return 'incoming'
  if (sender === own && recipient && recipient !== own) return 'outgoing'
  if (tx.balanceChangeDirection === 'increase') return 'incoming'
  if (tx.balanceChangeDirection === 'decrease' && /\b(sent|outgoing|transferred .* to 0x)/i.test(tx.generatedSummary)) return 'outgoing'
  return undefined
}

function counterparty(tx: TransactionItem, wallet: string): string | undefined {
  const own = normalizeAddress(wallet)
  const candidates = [tx.sender, tx.recipient].filter((value): value is string => Boolean(value))
  return candidates.find(value => normalizeAddress(value) !== own)
}

type PatternBase = Omit<ActivityPattern, 'observations' | 'firstSeen' | 'lastSeen' | 'meanIntervalDays' | 'latestBalanceDelta' | 'meanAbsoluteBalanceDelta'>

function patternKey(tx: TransactionItem, wallet: string): PatternBase | null {
  const txDirection = direction(tx, wallet)
  const asset = assetName(tx.coinType)
  const otherParty = counterparty(tx, wallet)

  const moduleName = tx.verifiedFacts.moduleName?.trim()
  const functionName = tx.verifiedFacts.functionName?.trim()
  const assetFlowSignature = getAssetFlowSignature(tx)
  const isRouterSwap = moduleName?.toLowerCase() === 'router' && isAssetSwapFlow(assetFlowSignature)
  const objectTypeFlowSignature = isRouterSwap ? undefined : getObjectTypeFlowSignature(tx)
  const hasObservedContractAssetFlow = Boolean(
    moduleName && functionName && tx.sender && (assetFlowSignature || objectTypeFlowSignature),
  )
  if (hasObservedContractAssetFlow && moduleName && functionName && tx.sender) {
    const sender = normalizeAddress(tx.sender)
    const observedFlow = [assetFlowSignature, objectTypeFlowSignature].filter(Boolean).join('~')
    return {
      key: `contract|${moduleName.toLowerCase()}|${functionName.toLowerCase()}|${sender}|${observedFlow}`,
      kind: 'contract',
      action: `${moduleName}::${functionName}`,
      counterparty: tx.sender,
      assetFlowSignature,
      objectTypeFlowSignature,
    }
  }

  if (txDirection && asset && otherParty) {
    return {
      key: `transfer|${txDirection}|${asset}|${normalizeAddress(otherParty)}`,
      kind: 'transfer', direction: txDirection, asset, counterparty: otherParty,
    }
  }

  if (moduleName && functionName && tx.sender) {
    const sender = normalizeAddress(tx.sender)
    return {
      key: `contract|${moduleName.toLowerCase()}|${functionName.toLowerCase()}|${sender}`,
      kind: 'contract', action: `${moduleName}::${functionName}`, counterparty: tx.sender,
    }
  }
  return null
}

function delta(tx: TransactionItem): number | undefined {
  if (assetName(tx.coinType) !== 'SUI' || !tx.amount) return undefined
  const value = Number.parseFloat(tx.amount)
  if (!Number.isFinite(value)) return undefined
  return tx.balanceChangeDirection === 'decrease' ? -Math.abs(value) : Math.abs(value)
}

export function buildActivityBaseline(
  transactions: TransactionItem[],
  walletAddress: string,
): Map<string, ActivityPattern> {
  const groups = new Map<string, { base: PatternBase; txs: TransactionItem[] }>()
  for (const tx of transactions) {
    if (tx.status !== 'success' || tx.activityAssessment?.status === 'system') continue
    const base = patternKey(tx, walletAddress)
    if (!base) continue
    const group = groups.get(base.key) ?? { base, txs: [] }
    group.txs.push(tx)
    groups.set(base.key, group)
  }

  const patterns = new Map<string, ActivityPattern>()
  for (const [key, group] of groups) {
    const times = group.txs.map(tx => tx.timestampMs).filter((value): value is number => Number.isFinite(value)).sort((a, b) => a - b)
    const intervals = times.slice(1).map((time, index) => (time - times[index]) / 86_400_000).filter(days => days >= 0)
    const deltas = group.txs.map(delta).filter((value): value is number => value !== undefined)
    patterns.set(key, {
      ...group.base,
      key,
      observations: group.txs.length,
      firstSeen: times[0],
      lastSeen: times[times.length - 1],
      ...(intervals.length ? { meanIntervalDays: intervals.reduce((sum, value) => sum + value, 0) / intervals.length } : {}),
      ...(deltas.length ? {
        latestBalanceDelta: deltas[deltas.length - 1],
        meanAbsoluteBalanceDelta: deltas.reduce((sum, value) => sum + Math.abs(value), 0) / deltas.length,
      } : {}),
    })
  }
  return patterns
}

export function assessActivityPattern(
  tx: TransactionItem,
  walletAddress: string,
  baseline: Map<string, ActivityPattern>,
): ActivityPatternObservation {
  if (tx.status !== 'success' || tx.activityAssessment?.status === 'system') {
    return { key: null, explanation: 'This activity is excluded from the personal pattern baseline.' }
  }
  const base = patternKey(tx, walletAddress)
  if (!base) return { key: null, explanation: 'Not enough on-chain detail to compare this activity with a saved baseline.' }
  const pattern = baseline.get(base.key)
  if (!pattern || pattern.observations < 2) {
    return { key: base.key, pattern, explanation: 'One comparable observation in the loaded activity. More repeated activity is needed before SuiGuard can call it an established pattern.' }
  }

  const notes = [`Seen ${pattern.observations} times in loaded activity.`]
  if (pattern.kind === 'transfer') notes.push(`${pattern.direction === 'incoming' ? 'Incoming' : 'Outgoing'} ${pattern.asset} activity with ${pattern.counterparty?.slice(0, 8)}…${pattern.counterparty?.slice(-6)}.`)
  if (pattern.kind === 'contract') {
    const flow = pattern.assetFlowSignature?.startsWith('balance|')
      ? pattern.assetFlowSignature.replace(/^balance\|/, '')
      .split('|')
      .map(item => {
        const [asset, change] = item.split(':')
        return asset && change ? `${asset} ${change}` : undefined
      })
      .filter((item): item is string => Boolean(item))
      : []
    const flowNotes = [
      ...(flow.length ? [`same observed asset flow (${flow.join(', ')})`] : []),
      ...(pattern.objectTypeFlowSignature ? ['the same NFT or object change types'] : []),
      ...(pattern.assetFlowSignature?.startsWith('objects|') ? ['the same observed object-change flow'] : []),
    ]
    notes.push(flowNotes.length
      ? `Repeated ${pattern.action} calls from the same sender with ${flowNotes.join(' and ')}.`
      : `Repeated ${pattern.action} calls from the same sender.`)
  }
  if (pattern.meanIntervalDays !== undefined) notes.push(`Average spacing about ${pattern.meanIntervalDays < 1 ? `${Math.max(1, Math.round(pattern.meanIntervalDays * 24))} hours` : `${pattern.meanIntervalDays.toFixed(1)} days`}.`)
  const currentDelta = delta(tx)
  if (currentDelta !== undefined && pattern.meanAbsoluteBalanceDelta !== undefined && pattern.meanAbsoluteBalanceDelta > 0) {
    const ratio = Math.abs(currentDelta) / pattern.meanAbsoluteBalanceDelta
    if (ratio >= 1.5 || ratio <= 0.5) {
      notes.push(`Observed wallet SUI balance change (${currentDelta >= 0 ? '+' : ''}${currentDelta.toFixed(4)} SUI) differs from the prior average (${pattern.meanAbsoluteBalanceDelta.toFixed(4)} SUI); this is a net balance change and may include gas.`)
    }
  }
  return { key: base.key, pattern, explanation: notes.join(' ') }
}

export function getEstablishedActivityPatterns(baseline: Map<string, ActivityPattern>): ActivityPattern[] {
  return [...baseline.values()].filter(pattern => pattern.observations >= 2)
    .sort((a, b) => b.observations - a.observations || (b.lastSeen ?? 0) - (a.lastSeen ?? 0))
}
