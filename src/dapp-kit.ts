import { createDAppKit } from '@mysten/dapp-kit-react'
import { SuiGrpcClient } from '@mysten/sui/grpc'

const rpcUrls = {
  mainnet: 'https://fullnode.mainnet.sui.io:443',
  testnet: 'https://fullnode.testnet.sui.io:443',
} as const

export const dAppKit = createDAppKit({
  networks: ['mainnet', 'testnet'],
  defaultNetwork: 'mainnet',
  createClient: (network) => new SuiGrpcClient({ network, baseUrl: rpcUrls[network] }),
  autoConnect: true,
})

declare module '@mysten/dapp-kit-react' {
  interface Register {
    dAppKit: typeof dAppKit
  }
}
