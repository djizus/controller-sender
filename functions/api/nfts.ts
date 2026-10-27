// NFT candidates for an address: every ERC721 token it ever received, from
// Starkscan's transfer index. Starkscan refuses browser requests, so the page
// asks here. The page verifies ownership on-chain with owner_of, so a stale
// index can only hide a token, never show one that is gone.
//
// Starkscan serves its v1 API without a key on its own origin. Set the
// STARKSCAN_API_KEY secret to use the official API host with a key instead.

interface Env {
  STARKSCAN_API_KEY?: string;
}

const CACHE_SECONDS = 300;

export async function onRequestGet({ request, env }: { request: Request; env: Env }): Promise<Response> {
  const input = new URL(request.url).searchParams.get("address") ?? "";
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(input)) {
    return Response.json({ error: "Invalid address" }, { status: 400 });
  }
  const address = `0x${input.slice(2).toLowerCase().replace(/^0+/, "")}`;

  const cache = await caches.open("nfts");
  const cacheKey = new Request(`https://cache.internal/nfts/${address}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const baseUrl = env.STARKSCAN_API_KEY ? "https://api.starkscan.co" : "https://starkscan.co";
  const byKey = new Map<string, { address: string; tokenId: string; symbol: string | null; name: string | null }>();
  let cursor: string | null = null;
  do {
    const url = new URL(`${baseUrl}/v1/SN_MAIN/address/${address}/transfers`);
    url.searchParams.set("direction", "in");
    url.searchParams.set("type", "erc721");
    url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("cursor", cursor);
    const res = await fetch(url, {
      headers: env.STARKSCAN_API_KEY ? { "x-starkscan-api-key": env.STARKSCAN_API_KEY } : {},
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return Response.json({ error: `Starkscan HTTP ${res.status}` }, { status: 502 });
    const page = (await res.json()) as { items?: any[]; nextCursor?: string | null };
    for (const t of page.items ?? []) {
      if (!t?.tokenAddress || t.tokenId === null || t.tokenId === undefined) continue;
      const contract = `0x${String(t.tokenAddress).slice(2).toLowerCase().replace(/^0+/, "")}`;
      const tokenId = BigInt(t.tokenId).toString();
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

  const response = Response.json(
    { candidates: [...byKey.values()] },
    { headers: { "cache-control": `public, max-age=${CACHE_SECONDS}` } },
  );
  await cache.put(cacheKey, response.clone());
  return response;
}
