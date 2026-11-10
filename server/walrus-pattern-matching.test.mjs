import test from 'node:test'
import assert from 'node:assert/strict'
import { describePatternMatch, getAssetFlowSignature, getSavedAssetFlowSignature, isAssetSwapFlow, isRelevantTransactionMemory } from '../src/transaction-patterns.ts'

const wallet = `0x${'1'.repeat(64)}`
const sender = `0x${'2'.repeat(64)}`
const otherSender = `0x${'3'.repeat(64)}`
const sui = '0x2::sui::SUI'

function transaction(overrides = {}) {
  return {
    digest: 'new-receive-digest',
    status: 'success',
    kind: '1',
    sender,
    balanceChangeDirection: 'increase',
    coinType: sui,
    verifiedFacts: {},
    generatedSummary: 'Received SUI',
    ...overrides,
  }
}

function memory(overrides = {}) {
  return {
    type: 'suiguard-transaction-context',
    version: 1,
    walletAddress: wallet,
    txDigest: 'labeled-receive-digest',
    label: 'familiar',
    explanation: 'Regular transfer from my other wallet',
    transactionSummary: 'Incoming SUI from sender',
    reviewedAt: '2026-11-09T00:00:00.000Z',
    network: 'mainnet',
    direction: 'incoming',
    coinType: sui,
    counterparty: sender,
    ...overrides,
  }
}

test('recognizes a repeat receive from the same wallet when semantic distance is weak', () => {
  const tx = transaction()
  assert.equal(isRelevantTransactionMemory(memory(), wallet, 'mainnet', tx, 0.8), true)
  assert.match(describePatternMatch(memory(), tx, wallet), /same counterparty and asset/)
})

test('recognizes a repeat receive when Tatum omits the asset type', () => {
  const tx = transaction({ coinType: undefined })
  assert.equal(isRelevantTransactionMemory(memory(), wallet, 'mainnet', tx, 0.9), true)
  assert.match(describePatternMatch(memory(), tx, wallet), /asset details were unavailable/)
})

test('does not match a different sender or a known different asset', () => {
  assert.equal(isRelevantTransactionMemory(memory(), wallet, 'mainnet', transaction({ sender: otherSender }), 0), false)
  assert.equal(isRelevantTransactionMemory(memory(), wallet, 'mainnet', transaction({ coinType: '0xabc::coin::OTHER' }), 0), false)
})

test('does not match the same counterparty in the opposite direction', () => {
  const outgoing = transaction({
    sender: wallet,
    recipient: sender,
    balanceChangeDirection: 'decrease',
    generatedSummary: 'Sent SUI',
  })
  assert.equal(isRelevantTransactionMemory(memory(), wallet, 'mainnet', outgoing, 0), false)
})

test('recognizes legacy redeem_funds memories with sender/function summary but no network or asset fields', () => {
  const saved = memory({
    network: undefined,
    direction: 'other',
    coinType: undefined,
    counterparty: undefined,
    moduleName: undefined,
    functionName: undefined,
    transactionSummary: `Wallet: ${wallet}\nSender: ${wallet}\nFunction: balance::redeem_funds`,
  })
  const repeatedRedeem = transaction({
    sender: wallet,
    balanceChangeDirection: undefined,
    coinType: undefined,
    generatedSummary: 'Called balance::redeem_funds',
    verifiedFacts: { moduleName: 'balance', functionName: 'redeem_funds' },
  })
  assert.equal(isRelevantTransactionMemory(saved, wallet, 'mainnet', repeatedRedeem, 0.9), true)
})

const usdc = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const suiType = '0x2::sui::SUI'
const routerSwapCall = { moduleName: 'router', functionName: 'new_swap_context' }
const swapFlow = (changes) => changes.map(([type, coin]) => ({
  type,
  objectId: `object-${type}-${coin}`,
  objectType: `0x2::coin::Coin<${coin}>`,
}))

test('matches router swaps only when the same sender has the same observed asset balance flow', () => {
  const firstSwap = transaction({
    sender: wallet,
    balanceChangeDirection: undefined,
    coinType: undefined,
    verifiedFacts: routerSwapCall,
    assetBalanceChanges: [{ coinType: suiType, amount: '-163700000' }, { coinType: usdc, amount: '134731' }],
    generatedSummary: "Your wallet's net SUI balance decreased by 0.1637 SUI. Your USDC balance increased by 134731 base units; token decimals were not included in Tatum's response.",
  })
  const savedSwap = memory({
    txDigest: firstSwap.digest,
    // A swap has both outgoing and incoming asset flows. Older generic
    // direction labels can conflict with the authoritative per-asset flow.
    direction: 'incoming',
    counterparty: undefined,
    coinType: undefined,
    initiatorAddress: wallet,
    moduleName: 'router',
    functionName: 'new_swap_context',
    transactionSummary: `Wallet: ${wallet}\nSender: ${wallet}\nFunction: router::new_swap_context\nSummary: Your wallet's net SUI balance decreased by 0.1637 SUI. Your USDC balance increased by 134731 base units; token decimals were not included in Tatum's response.`,
  })
  const matchingSwap = transaction({
    ...firstSwap,
    digest: 'same-route-again',
    verifiedFacts: { moduleName: 'balance', functionName: 'send_funds' },
    generatedSummary: "Transferred 1 object. Sent funds using Sui's address-balance transfer function. Your wallet's net SUI balance decreased by 0.1637 SUI, including gas and other SUI changes. Your USDC balance increased by 134731 base units; token decimals were not included in Tatum's response.",
  })
  const reverseOrDifferentRoute = transaction({
    ...firstSwap,
    digest: 'other-route',
    assetBalanceChanges: [
      { coinType: '0x375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT', amount: '-200000' },
      { coinType: usdc, amount: '200000' },
    ],
  })
  const reverseSwap = transaction({
    ...firstSwap,
    digest: 'reverse-sui-usdc',
    assetBalanceChanges: [{ coinType: suiType, amount: '100000000' }, { coinType: usdc, amount: '-100000' }],
  })

  assert.equal(getAssetFlowSignature(matchingSwap), 'balance|SUI:decreased|USDC:increased')
  assert.equal(getSavedAssetFlowSignature(savedSwap), 'balance|SUI:decreased|USDC:increased')
  assert.equal(isAssetSwapFlow(getAssetFlowSignature(matchingSwap)), true)
  assert.equal(isRelevantTransactionMemory(savedSwap, wallet, 'mainnet', matchingSwap, 0.95), true)
  assert.equal(isRelevantTransactionMemory(savedSwap, wallet, 'mainnet', reverseOrDifferentRoute, 0.01), false)
  assert.equal(isRelevantTransactionMemory(savedSwap, wallet, 'mainnet', reverseSwap, 0.01), false)
  assert.match(describePatternMatch(savedSwap, matchingSwap, wallet), /same observed asset balance flow/)

  const summaryOnlyRepeat = transaction({
    ...matchingSwap,
    digest: 'summary-only-same-swap',
    assetBalanceChanges: undefined,
  })
  assert.equal(getAssetFlowSignature(summaryOnlyRepeat), 'balance|SUI:decreased|USDC:increased')
  assert.equal(isRelevantTransactionMemory(savedSwap, wallet, 'mainnet', summaryOnlyRepeat, 0.95), true)
})

test('does not related-match legacy router memories without coin-flow evidence', () => {
  const legacySwap = memory({
    direction: 'other',
    counterparty: undefined,
    coinType: undefined,
    initiatorAddress: wallet,
    moduleName: 'router',
    functionName: 'new_swap_context',
    transactionSummary: `Wallet: ${wallet}\nSender: ${wallet}\nFunction: router::new_swap_context`,
  })
  const anotherSwap = transaction({
    sender: wallet,
    balanceChangeDirection: undefined,
    coinType: undefined,
    verifiedFacts: routerSwapCall,
    assetBalanceChanges: [{ coinType: suiType, amount: '-163700000' }, { coinType: usdc, amount: '134731' }],
    generatedSummary: "Your wallet's net SUI balance decreased by 0.1637 SUI. Your USDC balance increased by 134731 base units; token decimals were not included in Tatum's response.",
  })
  assert.equal(isRelevantTransactionMemory(legacySwap, wallet, 'mainnet', anotherSwap, 0), false)
})

test('does not apply a saved staking interaction to a different observed asset flow', () => {
  const savedStake = memory({
    direction: 'other',
    counterparty: undefined,
    coinType: undefined,
    initiatorAddress: wallet,
    moduleName: 'staking',
    functionName: 'stake_with_pool',
    assetFlowSignature: 'balance|SUI:decreased|WAL:decreased',
  })
  const sameStakeFlow = transaction({
    sender: wallet,
    balanceChangeDirection: undefined,
    coinType: undefined,
    verifiedFacts: { moduleName: 'staking', functionName: 'stake_with_pool' },
    assetBalanceChanges: [{ coinType: suiType, amount: '-1700000' }, { coinType: '0xabc::wal::WAL', amount: '-1000000000' }],
    generatedSummary: 'Staked WAL. Your WAL balance decreased by 1000000000 base units.',
  })
  const differentStakeFlow = transaction({
    sender: wallet,
    balanceChangeDirection: undefined,
    coinType: undefined,
    verifiedFacts: { moduleName: 'staking', functionName: 'stake_with_pool' },
    assetBalanceChanges: [{ coinType: suiType, amount: '-263400000' }, { coinType: '0xspring::spring_sui::SPRING_SUI', amount: '227567873' }],
    generatedSummary: 'Staked SUI. Your SPRING_SUI balance increased by 227567873 base units.',
  })

  assert.equal(isRelevantTransactionMemory(savedStake, wallet, 'mainnet', sameStakeFlow, 0.9), true)
  assert.equal(isRelevantTransactionMemory(savedStake, wallet, 'mainnet', differentStakeFlow, 0.01), false)
})

test('matches repeated WAL withdrawals when Tatum selects a different representative coin', () => {
  const savedWithdrawal = memory({
    direction: 'incoming',
    counterparty: undefined,
    coinType: '0xabc::wal::WAL',
    initiatorAddress: wallet,
    moduleName: 'staking',
    functionName: 'withdraw_stake',
    assetFlowSignature: 'balance|SUI:increased|WAL:increased',
    objectTypeFlowSignature: 'objects|created:0xabc::staking::receipt|deleted:0xabc::staking::stake',
  })
  const repeatedWithdrawal = transaction({
    sender: wallet,
    balanceChangeDirection: 'increase',
    coinType: suiType,
    verifiedFacts: { moduleName: 'staking', functionName: 'withdraw_stake' },
    assetBalanceChanges: [
      { coinType: suiType, amount: '200000' },
      { coinType: '0xabc::wal::WAL', amount: '1000000000' },
    ],
    objectTypeChanges: [
      { type: 'created', objectType: '0xabc::staking::Receipt', count: 1 },
      { type: 'deleted', objectType: '0xabc::staking::Stake', count: 1 },
    ],
    generatedSummary: 'Your wallet net SUI balance increased. Your WAL balance increased by 1000000000 base units.',
  })

  assert.equal(isRelevantTransactionMemory(savedWithdrawal, wallet, 'mainnet', repeatedWithdrawal, 0.9), true)

  // Older Walrus records can lack object type metadata even when current
  // Tatum responses include it. Matching balance flows still identify this
  // exact staking action safely; object types remain strict when both exist.
  const legacySavedWithdrawal = memory({
    ...savedWithdrawal,
    objectTypeFlowSignature: undefined,
  })
  assert.equal(isRelevantTransactionMemory(legacySavedWithdrawal, wallet, 'mainnet', repeatedWithdrawal, 0.9), true)
})

test('does not apply an NFT mint label to another created object type', () => {
  const savedMint = memory({
    direction: 'other',
    counterparty: undefined,
    coinType: '0x2::sui::SUI',
    initiatorAddress: wallet,
    moduleName: 'marketplace',
    functionName: 'mint',
    assetFlowSignature: 'balance|SUI:decreased',
    objectTypeFlowSignature: 'objects|created:0xabc::art::collectible',
  })
  const nftTx = (digest, objectType, objectAction = 'created', functionName = 'mint') => transaction({
    digest,
    sender: wallet,
    recipient: undefined,
    balanceChangeDirection: 'decrease',
    coinType: '0x2::sui::SUI',
    assetBalanceChanges: [{ coinType: suiType, amount: '-1000000' }],
    objectTypeChanges: [{ type: objectAction, objectType, count: 1 }],
    verifiedFacts: { moduleName: 'marketplace', functionName },
    generatedSummary: `Called marketplace::${functionName}. Your wallet net SUI balance decreased by 0.0010 SUI.`,
  })

  assert.equal(isRelevantTransactionMemory(savedMint, wallet, 'mainnet', nftTx('same-collection', '0xabc::art::Collectible'), 0.9), true)
  assert.equal(isRelevantTransactionMemory(savedMint, wallet, 'mainnet', nftTx('other-collection', '0xdef::art::Collectible'), 0.01), false)

  const savedPurchase = memory({
    ...savedMint,
    txDigest: 'saved-nft-purchase',
    functionName: 'buy',
    objectTypeFlowSignature: 'objects|transferred:0xabc::art::collectible',
  })
  assert.equal(isRelevantTransactionMemory(savedPurchase, wallet, 'mainnet', nftTx('repeat-purchase', '0xabc::art::Collectible', 'transferred', 'buy'), 0.9), true)
  assert.equal(isRelevantTransactionMemory(savedPurchase, wallet, 'mainnet', nftTx('different-purchase', '0xdef::art::Collectible', 'transferred', 'buy'), 0.01), false)
})
