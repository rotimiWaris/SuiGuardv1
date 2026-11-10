// Must stay first — ESM runs every import before the body, so a setGlobalDispatcher()
// call further down lands after ./routes/* have made their module-scope calls.
import './proxy-bootstrap.mjs'
// Second, before any ./routes/* read the key at module load: this applies
// /creds/creds.json onto process.env, so `process.env.TATUM_API_KEY` is set on
// the controller path (which delivers the key as a file, not an env var) and
// stays live across the rotation push. A no-op where the key is already in env.
import './credentials-store.mjs'
import express from 'express'
import { createServer as createHttpServer } from 'http'
import { createServer as createViteServer } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'url'
import path from 'path'
import tatumRoutes from './routes/tatum.mjs'
import walrusMemoryRoutes from './routes/walrus-memory.mjs'
import { credentialGuard } from './credential-guard.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(__dirname, '..')

// Run from the project root. The preview-sidecar starts this server with CWD=/,
// but tooling that resolves paths from the CWD — notably Tailwind's `content`
// globs — must see the project files, or it silently generates no utilities
// (unstyled preview). `vite build` already runs from here; this makes dev match.
process.chdir(root)

const app = express()
app.use(express.json())

// Redact the Tatum API key from every response before it leaves the process.
app.use(credentialGuard)

app.use('/api/tatum', tatumRoutes)
app.use('/api/walrus-memory', walrusMemoryRoutes)

const server = createHttpServer(app)

app.get('/api/health', (_req, res) => res.status(200).json({ status: 'ok' }))

if (process.env.NODE_ENV === 'production') {
  const dist = path.join(root, 'dist')
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API route not found.' }))
  app.use(express.static(dist, { index: false, maxAge: '1h' }))
  app.get('*', (_req, res, next) => {
    res.sendFile(path.join(dist, 'index.html'), error => {
      if (error) next(error)
    })
  })
} else {
  // Keep Vite middleware and HMR for local development only.
  const vite = await createViteServer({
    root,
    configFile: false,
    cacheDir: path.join(root, '.vite'),
    plugins: [react()],
    server: {
      middlewareMode: true,
      hmr: { server },
      allowedHosts: true,
    },
    appType: 'spa',
  })
  app.use(vite.middlewares)
}

const port = Number.parseInt(process.env.PORT || '3000', 10)
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  throw new Error('PORT must be a valid TCP port number.')
}
server.listen(port, '0.0.0.0', () => {
  const actualPort = server.address()?.port ?? port
  console.log(`SuiGuard ${process.env.NODE_ENV === 'production' ? 'production' : 'development'} server listening on :${actualPort}`)
})
