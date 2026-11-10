export const WALRUS_MEMORY_NETWORKS = {
  mainnet: {
    packageId: '0xe7c16fbea0560e7057e2bf7422feaa4fb313749fc69c9e9092fac7a33b81d7f5',
    registryId: '0x8bf82c9e09e36b8d1c38298f68b7cb68e7b8762887e7592add9986d5e9cf199f',
    relayerUrl: 'https://relayer.memory.walrus.xyz',
  },
  testnet: {
    packageId: '0x0a625e2db2af6f591a4c80a3d8551ddf11656089cc3a20c5e9e7f8fb75b9265c',
    registryId: '0x736aef9906798fca4460490ccdf8e8502ef170122dc26ecae32111b78c6b42dd',
    relayerUrl: 'https://relayer-staging.memory.walrus.xyz',
  },
} as const

export const SUI_GUARD_MEMORY_NAMESPACE = 'suiguard-minilm-l6-v2'
