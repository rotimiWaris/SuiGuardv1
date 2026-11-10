import test from 'node:test'
import assert from 'node:assert/strict'
import { transformGrpcTransaction } from './tatum.mjs'
import { GrpcTypes } from '@mysten/sui/grpc'

const wallet = `0x${'a'.repeat(64)}`
const recipient = `0x${'b'.repeat(64)}`

function txFixture(overrides = {}) {
  return {
    digest: 'sample-digest',
    timestamp: { seconds: 1_800_000_000n, nanos: 0 },
    transaction: {
      sender: wallet,
      kind: { kind: GrpcTypes.TransactionKind_Kind.PROGRAMMABLE_TRANSACTION, data: { oneofKind: 'programmableTransaction', programmableTransaction: { inputs: [], commands: [] } } },
    },
    effects: { status: { success: true }, changedObjects: [], gasUsed: { computationCost: 500_000n, storageCost: 0n, storageRebate: 0n } },
    balanceChanges: [],
    ...overrides,
  }
}

test('describes a Sui funds transfer with verified recipient and net SUI change', () => {
  const transaction = txFixture({
    transaction: {
      sender: wallet,
      kind: {
        kind: GrpcTypes.TransactionKind_Kind.PROGRAMMABLE_TRANSACTION,
        data: {
          oneofKind: 'programmableTransaction',
          programmableTransaction: {
            inputs: [{ pure: new Uint8Array(Buffer.from(recipient.slice(2), 'hex')) }],
            commands: [{ command: { oneofKind: 'moveCall', moveCall: {
              package: '0x2', module: 'balance', function: 'send_funds', typeArguments: ['0x2::sui::SUI'], arguments: [{ input: 0 }],
            } } }],
          },
        },
      },
    },
    balanceChanges: [{ address: wallet, coinType: '0x2::sui::SUI', amount: '-1000500000' }],
  })

  const result = transformGrpcTransaction(transaction, wallet)
  assert.equal(result.recipient, recipient)
  assert.deepEqual(result.assetBalanceChanges, [{ coinType: '0x2::sui::SUI', amount: '-1000500000' }])
  assert.match(result.generatedSummary, /Sent funds to 0xbb/)
  assert.match(result.generatedSummary, /net SUI balance decreased by 1\.0005 SUI/)
})

test('describes a transferred object and its verified new owner', () => {
  const transaction = txFixture({
    effects: {
      status: { success: true },
      changedObjects: [{
        objectId: `0x${'c'.repeat(64)}`,
        inputState: GrpcTypes.ChangedObject_InputObjectState.EXISTS,
        outputState: GrpcTypes.ChangedObject_OutputObjectState.OBJECT_WRITE,
        inputOwner: { address: wallet },
        outputOwner: { address: recipient },
        objectType: '0x2::coin::Coin<0x2::sui::SUI>',
      }],
      gasUsed: { computationCost: 500_000n, storageCost: 0n, storageRebate: 0n },
    },
    balanceChanges: [{ address: wallet, coinType: '0x2::sui::SUI', amount: '-1000500000' }],
  })

  const result = transformGrpcTransaction(transaction, wallet)
  assert.equal(result.recipient, recipient)
  assert.match(result.generatedSummary, /Transferred 1 object to 0xbb/)
  assert.match(result.generatedSummary, /1 transferred/)
})

test('explains other contract calls and token deltas without guessing token decimals', () => {
  const transaction = txFixture({
    transaction: {
      sender: wallet,
      kind: {
        kind: GrpcTypes.TransactionKind_Kind.PROGRAMMABLE_TRANSACTION,
        data: {
          oneofKind: 'programmableTransaction',
          programmableTransaction: { inputs: [], commands: [{ command: { oneofKind: 'moveCall', moveCall: {
            package: recipient, module: 'vault', function: 'withdraw', typeArguments: [], arguments: [],
          } } }] },
        },
      },
    },
    balanceChanges: [{ address: wallet, coinType: `${recipient}::token::COIN`, amount: '-7' }],
  })

  const result = transformGrpcTransaction(transaction, wallet)
  assert.match(result.generatedSummary, /Called vault::withdraw/)
  assert.match(result.generatedSummary, /COIN balance decreased by 7 base units/)
  assert.equal(result.recipient, undefined)
})

test('includes the reported execution failure reason', () => {
  const result = transformGrpcTransaction(txFixture({
    effects: { status: { success: false, error: { description: 'Insufficient balance' } }, changedObjects: [] },
  }), wallet)

  assert.match(result.generatedSummary, /transaction failed: Insufficient balance/)
})

test('describes Seal access checks without presenting object effects as wallet transfers', () => {
  const transaction = txFixture({
    transaction: {
      sender: wallet,
      kind: {
        kind: GrpcTypes.TransactionKind_Kind.PROGRAMMABLE_TRANSACTION,
        data: {
          oneofKind: 'programmableTransaction',
          programmableTransaction: { inputs: [], commands: [
            { command: { oneofKind: 'transferObjects', transferObjects: { objects: [{}], address: { input: 0 } } } },
            { command: { oneofKind: 'moveCall', moveCall: {
              package: recipient, module: 'account', function: 'seal_encrypt_fence', typeArguments: [], arguments: [],
            } } },
          ] },
        },
      },
    },
    effects: {
      status: { success: true },
      changedObjects: [{
        objectId: `0x${'c'.repeat(64)}`,
        inputState: GrpcTypes.ChangedObject_InputObjectState.EXISTS,
        outputState: GrpcTypes.ChangedObject_OutputObjectState.OBJECT_WRITE,
        inputOwner: { address: recipient },
        outputOwner: { address: wallet },
        objectType: `${recipient}::account::MemWalAccount`,
      }],
      gasUsed: { computationCost: 500_000n, storageCost: 0n, storageRebate: 0n },
    },
    balanceChanges: [{ address: wallet, coinType: '0x2::sui::SUI', amount: '-500000' }],
  })

  const result = transformGrpcTransaction(transaction, wallet)
  assert.match(result.generatedSummary, /Checked the Seal access rule/)
  assert.doesNotMatch(result.generatedSummary, /Transferred 1 object|Received 1 object/)
  assert.match(result.generatedSummary, /On-chain object changes:/)
})

test('retains NFT created, mutated, and transferred object types across the full change set', () => {
  const changedObjects = Array.from({ length: 7 }, (_, index) => ({
    objectId: `object-${index}`,
    idOperation: index >= 5
      ? GrpcTypes.ChangedObject_IdOperation.NONE
      : GrpcTypes.ChangedObject_IdOperation.CREATED,
    inputState: index === 5 ? GrpcTypes.ChangedObject_InputObjectState.EXISTS : undefined,
    outputState: index === 5 ? GrpcTypes.ChangedObject_OutputObjectState.OBJECT_WRITE : undefined,
    inputOwner: index === 6 ? { address: recipient } : undefined,
    outputOwner: index === 6 ? { address: wallet } : undefined,
    objectType: index < 2 ? '0xabc::art::Collectible' : `0xabc::art::Edition${index}`,
  }))
  const result = transformGrpcTransaction(txFixture({
    effects: {
      status: { success: true },
      changedObjects,
      gasUsed: { computationCost: 500_000n, storageCost: 0n, storageRebate: 0n },
    },
  }), wallet)

  assert.deepEqual(result.objectTypeChanges, [
    { type: 'created', objectType: '0xabc::art::Collectible', count: 2 },
    ...Array.from({ length: 3 }, (_, index) => ({ type: 'created', objectType: `0xabc::art::Edition${index + 2}`, count: 1 })),
    { type: 'mutated', objectType: '0xabc::art::Edition5', count: 1 },
    { type: 'transferred', objectType: '0xabc::art::Edition6', count: 1 },
  ])
})
