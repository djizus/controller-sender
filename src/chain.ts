// Starknet reads for the page: token list, balances, NFT ownership and metadata.
// Everything goes to the Cartridge RPC as batched starknet_call requests, except
// the NFT transfer index, which comes from this site's /api/nfts function.

const RPC_URL = "https://api.cartridge.gg/x/starknet/mainnet";
const EKUBO_TOKENS_URL =
  "https://prod-api.ekubo.org/tokens?chainId=23448594291968334&pageSize=10000&minVisibilityPriority=0";
const LOOKUP_URL = "https://api.cartridge.gg/lookup";

// starknet_keccak of the entrypoint names.
const SELECTOR = {
  balanceOf: "0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e",
  decimals: "0x4c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9",
  symbol: "0x216b05c387bab9ac31918a3e61672f4618601f3c598a2f3f2710f37053e1ea4",
  name: "0x361458367e696363fbcc70777d07ebbd2394e89fd0adcaf147faccd1d294d60",
  ownerOf: "0x3552df12bdc6089cf963c40c4cf56fbfd4bd14680c244d1c5494c2790f1ea5c", // owner_of
  tokenUri: "0x226ad7e84c1fe08eb4c525ed93cccadf9517670341304571e66f7c4f95cbe54", // token_uri
  tokenURI: "0x12a7823b0c6bee58f8c694888f32f862c6584caa8afa0242de046d298ba684d", // legacy camelCase
};

const FELT_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;

export interface TokenInfo {
  address: string; // normalized (lowercase, no leading zeros)
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string;
  usdPrice?: number;
  custom?: boolean;
}

export interface HeldToken extends TokenInfo {
  raw: bigint;
}

export interface HeldNft {
  address: string; // collection contract
  tokenId: bigint;
  symbol: string;
  name: string;
}

export interface Call {
  contractAddress: string;
  entrypoint: string;
  calldata: string[];
}

export function normalizeAddress(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (!trimmed.startsWith("0x")) return trimmed;
  const body = trimmed.slice(2).replace(/^0+/, "");
  return body ? `0x${body}` : "0x0";
}

export function isValidAddress(addr: string): boolean {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(addr)) return false;
  const v = BigInt(addr);
  return v > 0n && v < FELT_PRIME;
}

// ---------------------------------------------------------------------------
// JSON-RPC

interface RawCall {
  to: string;
  selector: string;
  calldata: string[];
}

// Batches of 200 calls run in parallel. An NFT-heavy controller needs a couple
// of thousand owner_of calls per refresh, which one batch would serialize.
async function rpcCalls(calls: RawCall[]): Promise<(string[] | null)[]> {
  const out: (string[] | null)[] = new Array(calls.length).fill(null);
  const BATCH = 200;
  const starts: number[] = [];
  for (let i = 0; i < calls.length; i += BATCH) starts.push(i);
  await Promise.all(
    starts.map(async (start) => {
      const chunk = calls.slice(start, start + BATCH);
      try {
        const res = await fetch(RPC_URL, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            chunk.map((c, j) => ({
              jsonrpc: "2.0",
              id: start + j,
              method: "starknet_call",
              params: {
                request: { contract_address: c.to, entry_point_selector: c.selector, calldata: c.calldata },
                block_id: "latest",
              },
            })),
          ),
          signal: AbortSignal.timeout(30_000),
        });
        const body = await res.json();
        if (!Array.isArray(body)) return;
        for (const r of body) {
          if (Number.isInteger(r?.id) && r.id >= start && r.id < start + chunk.length) {
            out[r.id] = r.result ?? null;
          }
        }
      } catch {
        // leave the chunk as nulls
      }
    }),
  );
  return out;
}

export function u256Calldata(value: bigint): string[] {
  return [`0x${(value & ((1n << 128n) - 1n)).toString(16)}`, `0x${(value >> 128n).toString(16)}`];
}

function u256FromResult(result: string[] | null): bigint | null {
  if (!result || result.length === 0) return null;
  try {
    const low = BigInt(result[0]);
    const high = result.length > 1 ? BigInt(result[1]) : 0n;
    return low + (high << 128n);
  } catch {
    return null;
  }
}

function feltToString(value: bigint): string {
  let hex = value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return new TextDecoder().decode(bytes).replace(/\0/g, "");
}

// Handles Cairo0 short strings (single felt), Cairo0 felt arrays (length-prefixed)
// and Cairo1 ByteArray results.
function decodeStringResult(result: string[] | null): string | null {
  if (!result || result.length === 0) return null;
  try {
    if (result.length === 1) return feltToString(BigInt(result[0])) || null;
    const words = Number(BigInt(result[0]));
    if (result.length === words + 3) {
      let s = "";
      for (let i = 1; i <= words; i++) s += feltToString(BigInt(result[i]));
      if (Number(BigInt(result[words + 2])) > 0) s += feltToString(BigInt(result[words + 1]));
      return s || null;
    }
    if (result.length === words + 1) {
      return result.slice(1).map((f) => feltToString(BigInt(f))).join("") || null;
    }
    return feltToString(BigInt(result[0])) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Amounts

export function formatUnits(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const int = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int.toString();
}

export function parseAmount(amount: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error("Invalid amount. Use a plain decimal number.");
  const frac = m[2] ?? "";
  if (frac.replace(/0+$/, "").length > decimals) {
    throw new Error(`Too many decimal places (token has ${decimals})`);
  }
  return (
    BigInt(m[1]) * 10n ** BigInt(decimals) +
    BigInt(frac.slice(0, decimals).padEnd(decimals, "0") || "0")
  );
}

// ---------------------------------------------------------------------------
// Tokens

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

let tokenList: Promise<TokenInfo[]> | null = null;

// The Ekubo list, fetched once per page load, or the fallback list if Ekubo is down.
function getTokenList(): Promise<TokenInfo[]> {
  tokenList ??= (async () => {
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
      return [...byAddress.values()];
    } catch (err) {
      console.warn(`Ekubo token list unavailable (${(err as Error).message}), using fallback list`);
      return FALLBACK_TOKENS;
    }
  })();
  return tokenList;
}

// Tokens with a balance, plus every custom token even at zero.
export async function getHeldTokens(address: string, customTokens: TokenInfo[]): Promise<HeldToken[]> {
  const byAddress = new Map((await getTokenList()).map((t) => [t.address, t]));
  for (const t of customTokens) {
    if (!byAddress.has(t.address)) byAddress.set(t.address, { ...t, custom: true });
  }
  const tokens = [...byAddress.values()];
  const results = await rpcCalls(
    tokens.map((t) => ({ to: t.address, selector: SELECTOR.balanceOf, calldata: [address] })),
  );
  const held: HeldToken[] = [];
  tokens.forEach((t, i) => {
    const raw = u256FromResult(results[i]);
    if (raw === null) return;
    if (raw > 0n || t.custom) held.push({ ...t, raw });
  });
  return held;
}

// Reads symbol, name and decimals of an ERC20 contract.
export async function readToken(address: string): Promise<TokenInfo> {
  const [symbolRes, nameRes, decimalsRes] = await rpcCalls([
    { to: address, selector: SELECTOR.symbol, calldata: [] },
    { to: address, selector: SELECTOR.name, calldata: [] },
    { to: address, selector: SELECTOR.decimals, calldata: [] },
  ]);
  const decimals = decimalsRes?.[0] !== undefined ? Number(BigInt(decimalsRes[0])) : null;
  if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error("Could not read decimals(). Is this an ERC20 contract on mainnet?");
  }
  return {
    address,
    symbol: decodeStringResult(symbolRes) ?? "???",
    name: decodeStringResult(nameRes) ?? "Unknown token",
    decimals,
    custom: true,
  };
}

// ---------------------------------------------------------------------------
// NFTs

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Candidates come from the transfer index; owner_of decides what is still held.
// Sorted by contract, then token id.
export async function getHeldNfts(address: string): Promise<HeldNft[]> {
  const res = await fetch(`/api/nfts?address=${address}`);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
  const candidates = (body.candidates as any[]).map((c) => ({
    address: String(c.address),
    tokenId: BigInt(c.tokenId),
    symbol: typeof c.symbol === "string" ? c.symbol : null,
    name: typeof c.name === "string" ? c.name : null,
  }));
  const owners = await rpcCalls(
    candidates.map((c) => ({ to: c.address, selector: SELECTOR.ownerOf, calldata: u256Calldata(c.tokenId) })),
  );
  const held: HeldNft[] = [];
  candidates.forEach((c, i) => {
    const owner = owners[i]?.[0];
    if (!owner || normalizeAddress(owner) !== address) return;
    held.push({
      address: c.address,
      tokenId: c.tokenId,
      symbol: c.symbol ?? shortAddress(c.address),
      name: c.name ?? "Unknown collection",
    });
  });
  return held.sort(
    (a, b) => a.address.localeCompare(b.address) || (a.tokenId < b.tokenId ? -1 : a.tokenId > b.tokenId ? 1 : 0),
  );
}

// token_uri is often a data: URI with the whole metadata (Cartridge games render
// the SVG on-chain), so the caller decodes it.
export async function tokenUri(contract: string, tokenId: bigint): Promise<string | null> {
  const calldata = u256Calldata(tokenId);
  let [result] = await rpcCalls([{ to: contract, selector: SELECTOR.tokenUri, calldata }]);
  if (!result) [result] = await rpcCalls([{ to: contract, selector: SELECTOR.tokenURI, calldata }]);
  return decodeStringResult(result)?.trim() || null;
}

// ---------------------------------------------------------------------------
// Usernames

export async function lookupUsername(username: string): Promise<string | null> {
  const res = await fetch(LOOKUP_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ usernames: [username] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  const address = body?.results?.[0]?.addresses?.[0];
  return typeof address === "string" && isValidAddress(address) ? normalizeAddress(address) : null;
}

// ---------------------------------------------------------------------------
// Transactions

export interface TxOutcome {
  status: "succeeded" | "reverted" | "pending";
  revertReason?: string;
}

// Polls the receipt until the transaction is in a block, for up to two minutes.
export async function waitForTransaction(hash: string): Promise<TxOutcome> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "starknet_getTransactionReceipt", params: { transaction_hash: hash } }),
        signal: AbortSignal.timeout(15_000),
      });
      const receipt = (await res.json())?.result;
      if (receipt?.execution_status === "SUCCEEDED") return { status: "succeeded" };
      if (receipt?.execution_status === "REVERTED") {
        return { status: "reverted", revertReason: String(receipt.revert_reason ?? "") };
      }
    } catch {
      // not indexed yet or a network blip; poll again
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  return { status: "pending" };
}
