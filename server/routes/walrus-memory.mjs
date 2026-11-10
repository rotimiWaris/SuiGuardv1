import { Router } from 'express'

const router = Router()

const RELAYERS = {
  mainnet: 'https://relayer.memory.walrus.xyz',
  testnet: 'https://relayer-staging.memory.walrus.xyz',
}

const ALLOWED_PATHS = new Set([
  'GET /version',
  'GET /health',
  'POST /api/remember/manual',
  'POST /api/recall/manual',
  'POST /api/restore',
])

function isOwnerDelegateKeyLookup(method, path) {
  return method === 'GET' && /^\/api\/accounts\/0x[0-9a-fA-F]{1,64}\/delegate-keys$/.test(path)
}

const FORWARDED_HEADERS = [
  'content-type',
  'x-public-key',
  'x-signature',
  'x-timestamp',
  'x-nonce',
  'x-account-id',
  'x-seal-session',
]

router.use('/:network', async (req, res) => {
  const relay = RELAYERS[req.params.network]
  if (!relay) return res.status(400).json({ error: 'Unsupported Walrus Memory network.' })

  // The SDK's serverUrl is /api/walrus-memory/:network, so forwarding this
  // suffix preserves the exact request path used to sign authenticated calls.
  const upstreamPath = req.originalUrl.replace(/^\/api\/walrus-memory\/[^/]+/, '') || '/'
  const methodPath = `${req.method} ${upstreamPath}`
  if (!ALLOWED_PATHS.has(methodPath) && !isOwnerDelegateKeyLookup(req.method, upstreamPath)) {
    return res.status(404).json({ error: 'Walrus Memory route is not available through this proxy.' })
  }

  const headers = new Headers()
  for (const name of FORWARDED_HEADERS) {
    const value = req.get(name)
    if (value) headers.set(name, value)
  }

  try {
    const upstream = await fetch(`${relay}${upstreamPath}`, {
      method: req.method,
      headers,
      ...(req.method === 'POST' ? { body: JSON.stringify(req.body ?? {}) } : {}),
      signal: AbortSignal.timeout(30_000),
    })

    res.status(upstream.status)
    const contentType = upstream.headers.get('content-type')
    const retryAfter = upstream.headers.get('retry-after')
    if (contentType) res.set('content-type', contentType)
    if (retryAfter) res.set('retry-after', retryAfter)
    return res.send(Buffer.from(await upstream.arrayBuffer()))
  } catch (_error) {
    return res.status(502).json({ error: 'Could not reach the Walrus Memory relayer.' })
  }
})

export default router
