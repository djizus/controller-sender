// NFT discovery: every ERC721 token the address ever received, from Starkscan's
// transfer index. Ownership is verified on-chain afterwards, so a stale index can
// only hide a token, never show one that is gone.

import { normalizeAddress } from "./tokens.ts";

export interface NftCandidate {
  address: string; // collection contract, normalized
  tokenId: bigint;
  symbol: string | null;
  name: string | null;
}

// Starkscan serves its v1 API without a key on its own origin. Set
// STARKSCAN_API_KEY to use the official API host with a key instead.
const API_KEY = process.env.STARKSCAN_API_KEY;
const BASE_URL = API_KEY ? "https://api.starkscan.co" : "https://starkscan.co";

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; candidates: NftCandidate[] }>();

export async function getNftCandidates(address: string): Promise<NftCandidate[]> {
  const hit = cache.get(address);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.candidates;

  const byKey = new Map<string, NftCandidate>();
  let cursor: string | null = null;
  do {
    const url = new URL(`${BASE_URL}/v1/SN_MAIN/address/${address}/transfers`);
    url.searchParams.set("direction", "in");
    url.searchParams.set("type", "erc721");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, {
      headers: API_KEY ? { "x-starkscan-api-key": API_KEY } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Starkscan HTTP ${res.status}`);
    const page = (await res.json()) as { items: any[]; nextCursor: string | null };
    for (const t of page.items ?? []) {
      if (!t?.tokenAddress || t.tokenId === null || t.tokenId === undefined) continue;
      const contract = normalizeAddress(String(t.tokenAddress));
      const tokenId = BigInt(t.tokenId);
      const key = `${contract}:${tokenId}`;
      if (!byKey.has(key)) {
        byKey.set(key, {
          address: contract,
          tokenId,
          symbol: typeof t.tokenSymbol === "string" ? t.tokenSymbol : null,
          name: typeof t.tokenName === "string" ? t.tokenName : null,
        });
      }
    }
    cursor = page.nextCursor ?? null;
  } while (cursor);

  const candidates = [...byKey.values()];
  cache.set(address, { at: Date.now(), candidates });
  return candidates;
}
