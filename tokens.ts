// Token discovery: Ekubo mainnet token list, with a static fallback list.

export interface TokenInfo {
  address: string; // normalized (lowercase, no leading zeros)
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string;
  usdPrice?: number;
  custom?: boolean;
}

export const EKUBO_TOKENS_URL =
  "https://prod-api.ekubo.org/tokens?chainId=23448594291968334&pageSize=10000&minVisibilityPriority=0";

export const ETH_ADDRESS = normalizeAddress(
  "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
);
export const STRK_ADDRESS = normalizeAddress(
  "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d",
);

export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (!trimmed.startsWith("0x")) return trimmed;
  const body = trimmed.slice(2).replace(/^0+/, "");
  return body ? `0x${body}` : "0x0";
}

const FALLBACK_TOKENS: TokenInfo[] = [
  { name: "Starknet Token", symbol: "STRK", address: "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d", decimals: 18 },
  { name: "Bonk", symbol: "BONK", address: "0x074238dfa02063792077820584c925b679a013cbab38e5ca61af5627d1eda736", decimals: 5 },
  { name: "Starknet Brother", symbol: "BROTHER", address: "0x03b405a98c9e795d427fe82cdeeeed803f221b52471e3a757574a2b4180793ee", decimals: 18 },
  { name: "Bitcoin", symbol: "BTC", address: "0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac", decimals: 8 },
  { name: "DOG GO TO THE MOON DOG", symbol: "DOG", address: "0x040e81cfeb176bfdbc5047bbc55eb471cfab20a6b221f38d8fda134e1bfffca4", decimals: 5 },
  { name: "Daydreams dreams", symbol: "DREAMS", address: "0x04fcaf2a7b4a072fe57c59beee807322d34ed65000d78611c909a46fead07fb1", decimals: 6 },
  { name: "Ekubo", symbol: "EKUBO", address: "0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87", decimals: 18 },
  { name: "Ethereum", symbol: "ETH", address: "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7", decimals: 18 },
  { name: "Lords", symbol: "LORDS", address: "0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49", decimals: 18 },
  { name: "Pain au lait", symbol: "PAL", address: "0x049201f03a0f0a9e70e28dcd74cbf44931174dbe3cc4b2ff488898339959e559", decimals: 18 },
  { name: "SCHIZODIO", symbol: "SCHIZODIO", address: "0x00acc2fa3bb7f6a6726c14d9e142d51fe3984dbfa32b5907e1e76425177875e2", decimals: 18 },
  { name: "Starknet Sister", symbol: "SSTR", address: "0x0102d5e124c51b936ee87302e0f938165aec96fb6c2027ae7f3a5ed46c77573b", decimals: 18 },
  { name: "Brother Eli SLAY", symbol: "SLAY", address: "0x02ab526354a39e7f5d272f327fa94e757df3688188d4a92c6dc3623ab79894e2", decimals: 18 },
  { name: "Solana", symbol: "SOL", address: "0x01e70aedffd376afe33cebdf51ed5365131dccb2a5b2cb36d02b785442912b9b", decimals: 9 },
  { name: "Starknet", symbol: "STARK", address: "0x01a613a0d4d6f90e1a5da760c01dd1bac06b2101380d94c93dffa50e139a0b5d", decimals: 18 },
  { name: "StarkPepe", symbol: "STRKPEPE", address: "0x0541acf195ae5f3642a36a629710a02fef2042eb113ab9077e14f5dc18b16a4e", decimals: 18 },
  { name: "StarkRock", symbol: "STROCK", address: "0x07e03e6fa091f362c9a018f75085cbcd25c08cc00fc1c29609549e671cd9ef1b", decimals: 18 },
  { name: "Swapsicle", symbol: "SWAPS", address: "0x03136bc0668928dc01fec9b6f191490847849a615a27db0a3a8917ab7a87af46", decimals: 18 },
  { name: "Tether USD", symbol: "USDT", address: "0x06b2fc004d3287591ac780ba960a1d8a41f62faf2fbe4f11ccba41688b6a3834", decimals: 6 },
  { name: "USD Coin", symbol: "USDC", address: "0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8", decimals: 6 },
  { name: "Wrapped Bitcoin", symbol: "WBTC", address: "0x0207aa0825f096798ac053fa25a27c84c212d90fcec546be46811138707c67a0", decimals: 8 },
  { name: "Wrap Ether", symbol: "WETH", address: "0x0490bbd7b2a05ffea8ee7b3c886f2f59031524ad45a08f1674db1e11a5ae0fa3", decimals: 18 },
  { name: "Una Coin", symbol: "UNA", address: "0x025ea8240e43f8e012ea894ee400cf5928b557c66db1f83d099ce3633d74458c", decimals: 18 },
].map((t) => ({ ...t, address: normalizeAddress(t.address) }));

const CACHE_TTL_MS = 60 * 60 * 1000;
let cache: { at: number; tokens: TokenInfo[] } | null = null;

export async function getTokenList(): Promise<TokenInfo[]> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.tokens;
  try {
    const res = await fetch(EKUBO_TOKENS_URL, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as any[];
    const byAddress = new Map<string, TokenInfo>();
    for (const t of raw) {
      if (!t?.address || !t?.symbol || !Number.isInteger(t.decimals)) continue;
      const address = normalizeAddress(String(t.address));
      if (byAddress.has(address)) continue;
      byAddress.set(address, {
        address,
        symbol: String(t.symbol),
        name: String(t.name ?? t.symbol),
        decimals: t.decimals,
        logoUrl: typeof t.logo_url === "string" ? t.logo_url : undefined,
        usdPrice: typeof t.usd_price === "number" ? t.usd_price : undefined,
      });
    }
    if (byAddress.size === 0) throw new Error("empty token list");
    cache = { at: Date.now(), tokens: [...byAddress.values()] };
    return cache.tokens;
  } catch (err) {
    console.warn(`Ekubo token list unavailable (${(err as Error).message}), using fallback list`);
    return FALLBACK_TOKENS;
  }
}
