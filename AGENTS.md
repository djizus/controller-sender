# Agent guide

Controller Sender is a web page on Cloudflare Pages that sends ERC20 tokens and ERC721
NFTs from a Cartridge Controller to any Starknet mainnet address. Users connect with the
Controller SDK and approve every send in its popup. Live at https://controller.realms.party.
`README.md` is written for players who are not technical. Keep it free of jargon and put
technical detail here. Its "How to send" and "Other things you can do" sections are the
feature map. Update them in the change that adds, moves or removes a feature.

## Layout

- `src/app.js`: the UI. Connection, balance lists, selection, Send card, settings.
  Settings live in `localStorage`.
- `src/chain.ts`: Starknet reads from the browser. Batched `starknet_call` RPC, Ekubo
  token list with a static fallback, NFT ownership, `token_uri`, username lookup,
  receipt polling.
- `functions/api/nfts.ts`: Starkscan transfer index for an address, cached five minutes.
  The only server code.
- `public/index.html`, `public/style.css`: markup and styles. The design tokens copy
  play.realms.party; fonts, logo and art load from that site. Below 820 px the layout is
  one column and the Send card is a bottom sheet.
- `public/_headers`: the CSP and other security headers.
- `public/app.js`: build output, gitignored.
- `wrangler.toml`: the Pages project. Production is the `controller-sender` project with
  the custom domain `controller.realms.party` (proxied CNAME in the realms.party zone).
  Set the `STARKSCAN_API_KEY` secret on it to use Starkscan's official API with a key.

## How it works

- The page is static HTML, CSS and one JavaScript bundle. esbuild bundles `src/app.js`
  and `src/chain.ts` with the `@cartridge/controller` SDK into `public/app.js`.
- Tokens come from the Ekubo mainnet list, with USD prices and logos. A static fallback
  list covers the case where Ekubo is down.
- Balances, `owner_of`, `token_uri`, token metadata and receipts are JSON-RPC requests
  from the browser to `api.cartridge.gg/x/starknet/mainnet`, batched 200 calls at a time.
  `@username` resolves through `api.cartridge.gg/lookup`.
- NFTs come from Starkscan's transfer index. Every ERC721 token the controller ever
  received is a candidate, and `owner_of` on-chain decides which ones it still holds, so a
  stale index can hide an NFT but never show one that is gone. Starkscan returns 403 to
  requests with a browser Origin, so `functions/api/nfts.ts` fetches it. NFTs are grouped
  by collection name, since one collection can span several contracts.
- NFT images come from `token_uri`. The browser decodes the metadata and shows
  `data:image/` or `https` images only, loading each when it scrolls into view. IPFS links
  load from `gateway.pinata.cloud`, which sends CORS headers. Every public gateway tested
  rate-limits Cloudflare Worker egress, so the site does not proxy IPFS. Pinata also
  throttles a browser that opens many images at once; those show a placeholder.
- A send is one `account.execute` multicall: `transfer(recipient, u256 amount)` per token
  and `transfer_from(controller, recipient, u256 id)` per NFT. The page then polls the
  receipt for up to two minutes.

## Fees

Gas is self-paid in STRK. A single transfer charged about 0.09 STRK in October 2026, but
the keychain sets resource bounds near 20 times the estimate (about 4x gas amount, 4.5x
gas price), and Starknet rejects a transaction whose maximum fee exceeds the balance. A
single transfer needs about 1.7 STRK on hand. Below that the popup shows "Add funds" and
`execute` rejects with "Validation failure". The SDK's `selfFundedGasMultiplier` is
already at its 1.5 minimum, so the page cannot lower this.

## Security model

The site holds no keys and no user data. Signing happens in Cartridge's keychain iframe.
Third-party strings are escaped before rendering. `public/_headers` sets a CSP that runs
scripts only from the site, loads fonts only from the site and play.realms.party, frames
only `x.cartridge.gg`, and forbids framing the site.

## Commands

```bash
npm install
npm run dev      # build, then wrangler pages dev on http://127.0.0.1:3210
npm run check    # tsc --noEmit
npm run deploy   # build, then wrangler pages deploy
```

There is no test suite. Verify a change with `npm run check`, then `npm run dev` and drive
the page in a browser at desktop width and at 390 px. Logging in needs a real passkey. To
see the connected view without one, build a scratch bundle with
`esbuild src/app.js --bundle --format=esm --alias:@cartridge/controller=<mock>` where the
mock's `probe()` returns `{ address, execute }`, and serve it in place of `/app.js`. Keep
the mock out of the repository. A real send is tested by a person on the live site.

## Rules

- Never commit usernames, addresses or home paths. Scan the diff before every commit.
- The site holds no keys. Every transaction goes through `account.execute` so the user
  approves it in the Controller popup. No session keys, no server-side signing.
- The Controller account object has no `waitForTransaction`. Use `waitForTransaction`
  from `src/chain.ts`. Once `execute` returns a hash the send is on its way: never report
  it as failed because a later step threw.
- Third-party strings (token names, symbols, metadata, error messages) go through
  `esc()` before they reach `innerHTML`. Keep the CSP in `public/_headers` strict. A new
  external host goes into the narrowest directive that needs it.
- Functions fetch fixed hosts only. A request can choose a path or an address, never a
  host. Public IPFS gateways and similar services rate-limit Cloudflare's servers, so test
  a new upstream from a deployed function before relying on it.
- Prefer deleting a rule to adding a special case. No new config values, flags or modes
  for cases that do not exist yet.
- Prose in the repo (README, UI copy, comments, commit messages) is plain and direct. No
  em dashes, no formulaic contrasts, no filler.
