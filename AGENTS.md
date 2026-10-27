# Agent guide

Controller Sender is a web page on Cloudflare Pages that sends ERC20 tokens and ERC721
NFTs from a Cartridge Controller to any Starknet mainnet address. Users connect with the
Controller SDK and approve every send in its popup. Live at https://controller.realms.party.
Read `README.md` first. Its Usage section is the feature map: update it in the change that
adds, moves or removes a feature.

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
  the custom domain `controller.realms.party`.

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
