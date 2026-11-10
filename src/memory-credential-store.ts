export interface BrowserMemoryCredential {
  ownerAddress: string
  network: 'mainnet' | 'testnet'
  accountId: string
  delegatePrivateKey: string
  delegatePublicKeyHex: string
  savedMemoryCache?: BrowserSavedMemory[]
}

export interface BrowserSavedMemory {
  txDigest: string
  blobId: string
  text: string
}

interface EncryptedCredentialRecord {
  id: string
  ownerAddress: string
  network: 'mainnet' | 'testnet'
  cryptoKey: CryptoKey
  iv: Uint8Array
  ciphertext: ArrayBuffer
}

const DATABASE_NAME = 'suiguard-browser-memory'
const DATABASE_VERSION = 1
const OBJECT_STORE = 'credentials'

function recordId(ownerAddress: string, network: 'mainnet' | 'testnet') {
  return `${network}:${ownerAddress.toLowerCase()}`
}

function openCredentialDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(OBJECT_STORE)) {
        database.createObjectStore(OBJECT_STORE, { keyPath: 'id' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Could not open browser memory storage.'))
    request.onblocked = () => reject(new Error('Browser memory storage upgrade is blocked by another open tab.'))
  })
}

async function readRecord(id: string): Promise<EncryptedCredentialRecord | null> {
  const database = await openCredentialDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const request = database.transaction(OBJECT_STORE, 'readonly').objectStore(OBJECT_STORE).get(id)
      request.onsuccess = () => resolve((request.result as EncryptedCredentialRecord | undefined) || null)
      request.onerror = () => reject(request.error || new Error('Could not read the saved memory profile.'))
    })
  } finally {
    database.close()
  }
}

export async function saveBrowserMemoryCredential(credential: BrowserMemoryCredential) {
  const id = recordId(credential.ownerAddress, credential.network)
  const existing = await readRecord(id)
  const cryptoKey = existing?.cryptoKey || await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const savedMemoryCache = credential.savedMemoryCache ?? (existing
    ? (await decryptCredentialRecord(existing)).savedMemoryCache
    : undefined)
  const plaintext = new TextEncoder().encode(JSON.stringify({ ...credential, savedMemoryCache }))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, plaintext)
  const database = await openCredentialDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OBJECT_STORE, 'readwrite')
      transaction.objectStore(OBJECT_STORE).put({
        id,
        ownerAddress: credential.ownerAddress,
        network: credential.network,
        cryptoKey,
        iv,
        ciphertext,
      } satisfies EncryptedCredentialRecord)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error('Could not save the browser memory profile.'))
      transaction.onabort = () => reject(transaction.error || new Error('Saving the browser memory profile was interrupted.'))
    })
  } finally {
    database.close()
  }
}

async function decryptCredentialRecord(record: EncryptedCredentialRecord): Promise<BrowserMemoryCredential> {
  const iv = record.iv.buffer.slice(record.iv.byteOffset, record.iv.byteOffset + record.iv.byteLength) as ArrayBuffer
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, record.cryptoKey, record.ciphertext)
  return JSON.parse(new TextDecoder().decode(plaintext)) as BrowserMemoryCredential
}

export async function saveBrowserMemoryCache(
  ownerAddress: string,
  network: 'mainnet' | 'testnet',
  memories: BrowserSavedMemory[],
) {
  const credential = await loadBrowserMemoryCredential(ownerAddress, network)
  if (!credential) throw new Error('No encrypted browser memory profile is available for this wallet.')
  const byDigest = new Map((credential.savedMemoryCache || []).map(memory => [memory.txDigest, memory]))
  memories.forEach(memory => byDigest.set(memory.txDigest, memory))
  const savedMemoryCache = [...byDigest.values()]
  await saveBrowserMemoryCredential({ ...credential, savedMemoryCache })
  return savedMemoryCache
}

export async function loadBrowserMemoryCredential(ownerAddress: string, network: 'mainnet' | 'testnet') {
  const record = await readRecord(recordId(ownerAddress, network))
  if (!record) return null
  const value = await decryptCredentialRecord(record) as Partial<BrowserMemoryCredential>
  if (
    value.ownerAddress?.toLowerCase() !== ownerAddress.toLowerCase() ||
    value.network !== network ||
    typeof value.accountId !== 'string' ||
    typeof value.delegatePrivateKey !== 'string' ||
    typeof value.delegatePublicKeyHex !== 'string' ||
    (value.savedMemoryCache !== undefined && (!Array.isArray(value.savedMemoryCache) || value.savedMemoryCache.some(memory =>
      !memory || typeof memory.txDigest !== 'string' || typeof memory.blobId !== 'string' || typeof memory.text !== 'string'
    )))
  ) {
    throw new Error('The saved browser memory profile is invalid. Set up Walrus Memory again.')
  }
  return value as BrowserMemoryCredential
}

export async function deleteBrowserMemoryCredential(ownerAddress: string, network: 'mainnet' | 'testnet') {
  const database = await openCredentialDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(OBJECT_STORE, 'readwrite')
      transaction.objectStore(OBJECT_STORE).delete(recordId(ownerAddress, network))
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error || new Error('Could not remove the saved memory profile.'))
      transaction.onabort = () => reject(transaction.error || new Error('Removing the browser memory profile was interrupted.'))
    })
  } finally {
    database.close()
  }
}
