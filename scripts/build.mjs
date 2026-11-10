import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { build } from 'vite'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDirectory = process.argv[2] || 'dist'

await build({
  root: projectRoot,
  configFile: false,
  plugins: [react()],
  build: {
    outDir: outputDirectory,
    // Keep existing artifacts in place; Vite's default cleanup can be blocked
    // on Windows while a local preview has files open.
    emptyOutDir: false,
    // The remaining ~599 KiB Transformers.js chunk is lazy-loaded only when
    // local Walrus embeddings are first needed; its compressed transfer is ~174 KiB.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          const normalizedId = id.replaceAll('\\', '/')
          if (!normalizedId.includes('/node_modules/')) return undefined

          if (/\/node_modules\/(react|react-dom|scheduler)\//.test(normalizedId)) return 'react-vendor'
          if (normalizedId.includes('/node_modules/@wallet-standard/')) return 'wallet-standard'
          if (normalizedId.includes('/node_modules/@scure/') || normalizedId.includes('/node_modules/@noble/')) return 'crypto-vendor'
          if (normalizedId.includes('/node_modules/@protobuf-ts/') || normalizedId.includes('/node_modules/@protobufjs/')) return 'protobuf-vendor'
          if (normalizedId.includes('/node_modules/@mysten/')) return 'mysten-sdk'

          return undefined
        },
      },
    },
  },
})
