export interface TokenMeta {
  address: string;
  symbol: string | null;
  decimals: number | null;
  metadataSource: "registry" | "onchain-read" | "unknown";
}

export const BASE_CHAIN = "eip155:8453";
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

/** Base mainnet tokens, each checked against on-chain symbol() and decimals(). */
const REGISTRY: Record<string, { symbol: string; decimals: number }> = {
  [BASE_USDC]: { symbol: "USDC", decimals: 6 },
  "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca": { symbol: "USDbC", decimals: 6 },
  "0x60a3e35cc302bfa44cb288bc5a4f316fdb1adb42": { symbol: "EURC", decimals: 6 },
  "0x4200000000000000000000000000000000000006": { symbol: "WETH", decimals: 18 },
  "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf": { symbol: "cbBTC", decimals: 8 },
  "0x2ae3f1ec7f1f5012cfeab0185bfc7aa3cf0dec22": { symbol: "cbETH", decimals: 18 },
  "0xc1cba3fcea344f92d9239c08c0568f6f2f0ee452": { symbol: "wstETH", decimals: 18 },
  "0x50c5725949a6f0c72e6c4a641f24049a917db0cb": { symbol: "DAI", decimals: 18 },
  "0xfde4c96c8593536e31f229ea8f37b2ada2699bb2": { symbol: "USDT", decimals: 6 },
  "0x940181a94a35a4569e4529a3cdfb74e38fd98631": { symbol: "AERO", decimals: 18 },
  "0x4ed4e862860bed51a9570b96d89af5e1b0efefed": { symbol: "DEGEN", decimals: 18 },
};

export function registryToken(address: string): TokenMeta | null {
  const entry = REGISTRY[address.toLowerCase()];
  return entry ? { address: address.toLowerCase(), ...entry, metadataSource: "registry" } : null;
}
