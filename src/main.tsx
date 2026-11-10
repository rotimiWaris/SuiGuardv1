import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DAppKitProvider } from '@mysten/dapp-kit-react'
import App from './App.tsx'
import { dAppKit } from './dapp-kit'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DAppKitProvider dAppKit={dAppKit}>
      <App />
    </DAppKitProvider>
  </StrictMode>,
)
