import test from 'node:test'
import assert from 'node:assert/strict'
import { assessActivityPattern, buildActivityBaseline, getEstablishedActivityPatterns } from '../src/activity-baseline.ts'

const wallet = `0x${'1'.repeat(64)}`
const sender = `0x${'2'.repeat(64)}`
const other = `0x${'3'.repeat(64)}`

function tx(digest, overrides = {}) {
  return {
    digest, timestampMs: 1_780_000_000_000, status: 'success', kind: '1', sender,
    balanceChangeDirection: 'increase', coinType: '0x2::sui::SUI', amount: '1',
    verifiedFacts: {}, generatedSummary: 'Net increase of 1 SUI.', ...overrides,
  }
}

test('establishes a repeated incoming pattern only after a second comparable observation', () => {
  const one = buildActivityBaseline([tx('one')], wallet)
  assert.equal(assessActivityPattern(tx('one'), wallet, one).pattern.observations, 1)
  assert.equal(getEstablishedActivityPatterns(one).length, 0)

  const two = buildActivityBaseline([tx('one'), tx('two', { timestampMs: 1_780_086_400_000 })], wallet)
  const result = assessActivityPattern(tx('two'), wallet, two)
  assert.equal(result.pattern.observations, 2)
  assert.match(result.explanation, /Seen 2 times/)
  assert.equal(getEstablishedActivityPatterns(two).length, 1)
})

test('keeps transfers from different counterparties or assets in separate patterns', () => {
  const patterns = buildActivityBaseline([
    tx('one'),
    tx('two', { sender: other }),
    tx('three', { coinType: '0xabc::token::USDC' }),
  ], wallet)
  assert.equal(patterns.size, 3)
  assert.equal(getEstablishedActivityPatterns(patterns).length, 0)
})

test('recognizes the same verified contract action from the same sender without token details', () => {
  const redeem = tx('redeem-1', {
    coinType: undefined, amount: undefined, balanceChangeDirection: undefined,
    verifiedFacts: { moduleName: 'balance', functionName: 'redeem_funds' },
  })
  const baseline = buildActivityBaseline([redeem, { ...redeem, digest: 'redeem-2' }], wallet)
  const result = assessActivityPattern(redeem, wallet, baseline)
  assert.equal(result.pattern.observations, 2)
  assert.match(result.explanation, /balance::redeem_funds/)
})

test('keeps app interaction patterns separate when their observed asset flows differ', () => {
  const appInteraction = (digest, timestampMs, moduleName, functionName, assetBalanceChanges, generatedSummary) => tx(digest, {
    timestampMs,
    sender: wallet,
    coinType: undefined,
    amount: undefined,
    balanceChangeDirection: undefined,
    verifiedFacts: { moduleName, functionName },
    assetBalanceChanges,
    generatedSummary,
  })
  const first = appInteraction('wal-stake', 1_780_000_000_000, 'staking', 'stake_with_pool', [
    { coinType: '0xabc::wal::WAL', amount: '6393064505' },
    { coinType: '0xdef::usdt::USDT', amount: '-179246' },
    { coinType: '0x2::sui::SUI', amount: '-1400000' },
  ], 'Your wallet net SUI balance decreased. Your WAL balance increased by 6393064505 base units. Your USDT balance decreased by 179246 base units.')
  const differentAction = appInteraction('spring-redeem', 1_780_021_600_000, 'coin', 'redeem_funds', [
    { coinType: '0xdef::usdt::USDT', amount: '-20000' },
    { coinType: '0x123::usdc::USDC', amount: '19881' },
    { coinType: '0x2::sui::SUI', amount: '-4000000' },
  ], 'Your wallet net SUI balance decreased. Your USDT balance decreased by 20000 base units. Your USDC balance increased by 19881 base units.')
  const differentStakeAsset = appInteraction('sui-stake', 1_780_021_600_000, 'staking', 'stake_with_pool', [
    { coinType: '0x2::sui::SUI', amount: '-263400000' },
    { coinType: '0xspring::spring_sui::SPRING_SUI', amount: '227567873' },
  ], 'Your wallet net SUI balance decreased. Your SPRING_SUI balance increased by 227567873 base units.')
  const repeatedFirst = { ...first, digest: 'wal-stake-repeat', timestampMs: 1_780_043_200_000 }
  const baseline = buildActivityBaseline([first, differentAction, differentStakeAsset, repeatedFirst], wallet)

  assert.equal(baseline.size, 3)
  assert.equal(assessActivityPattern(first, wallet, baseline).pattern.observations, 2)
  assert.equal(assessActivityPattern(differentStakeAsset, wallet, baseline).pattern.observations, 1)
  assert.equal(assessActivityPattern(differentAction, wallet, baseline).pattern.observations, 1)
  assert.match(assessActivityPattern(first, wallet, baseline).explanation, /same observed asset flow/)
})

test('separates NFT marketplace patterns by on-chain object type even when both paid SUI gas', () => {
  const nftAction = (digest, type, objectType) => tx(digest, {
    sender: wallet,
    coinType: '0x2::sui::SUI',
    amount: '0.0010',
    balanceChangeDirection: 'decrease',
    assetBalanceChanges: [{ coinType: '0x2::sui::SUI', amount: '-1000000' }],
    objectTypeChanges: [{ type, objectType, count: 1 }],
    verifiedFacts: { moduleName: 'marketplace', functionName: type === 'transferred' ? 'buy' : 'mint' },
    generatedSummary: `Called marketplace::${type === 'transferred' ? 'buy' : 'mint'}. Your wallet net SUI balance decreased by 0.0010 SUI.`,
  })
  const collectionA = nftAction('mint-a', 'created', '0xabc::art::Collectible')
  const collectionB = nftAction('mint-b', 'created', '0xdef::art::Collectible')
  const repeatedCollectionA = nftAction('mint-a-repeat', 'created', '0xabc::art::Collectible')
  const purchasedNft = nftAction('buy-a', 'transferred', '0xabc::art::Collectible')
  const baseline = buildActivityBaseline([collectionA, collectionB, repeatedCollectionA, purchasedNft], wallet)

  assert.equal(baseline.size, 3)
  assert.equal(assessActivityPattern(collectionA, wallet, baseline).pattern.observations, 2)
  assert.equal(assessActivityPattern(collectionB, wallet, baseline).pattern.observations, 1)
  assert.match(assessActivityPattern(collectionA, wallet, baseline).explanation, /same NFT or object change types/)
  assert.equal(assessActivityPattern(purchasedNft, wallet, baseline).pattern.observations, 1)
})

test('does not compare failed transactions or transactions without usable anchors', () => {
  const failed = tx('failed', { status: 'failure' })
  const unknown = tx('unknown', { sender: wallet, balanceChangeDirection: undefined, coinType: undefined, verifiedFacts: {} })
  const baseline = buildActivityBaseline([failed, unknown], wallet)
  assert.equal(baseline.size, 0)
  assert.equal(assessActivityPattern(unknown, wallet, baseline).key, null)
})

test('excludes Walrus setup activity marked as system transactions', () => {
  const system = tx('setup', { activityAssessment: { status: 'system', explanation: 'Walrus setup' } })
  assert.equal(buildActivityBaseline([system], wallet).size, 0)
  assert.match(assessActivityPattern(system, wallet, new Map()).explanation, /excluded/)
})
