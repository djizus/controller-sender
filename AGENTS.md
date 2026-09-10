# Agent guide

Controller Sender is a local webapp that sends ERC20 tokens and ERC721 NFTs from a
Cartridge Controller to any Starknet mainnet address. It wraps the `controller` CLI,
which holds the session key. Read `README.md` first for setup and the security model.

## Layout

- `server.ts`: the whole backend. HTTP server bound to 127.0.0.1, CLI wrapper, batched
  `starknet_call` RPC, session policy checks, the `/api/*` routes and static file serving.
- `tokens.ts`: ERC20 discovery. Ekubo token list with a static fallback.
- `nfts.ts`: ERC721 discovery. Starkscan transfer index, verified on-chain with `owner_of`.
- `public/`: the frontend. Plain HTML, CSS and JavaScript, no build step, no framework.
- `config.json` and `policies.json`: per-user state. Both are gitignored and must stay so.

## Commands

```bash
npm install
npm run dev     # tsx server.ts, http://127.0.0.1:3210
npm run check   # tsc --noEmit
```

There is no test suite. Verify a change with `npm run check`, then run the app against the
real CLI and read `/api/status` and `/api/balances`. Test on a second port with
`PORT=3211 npm run dev` when an instance is already running.

## Rules

- Never commit `config.json`, `policies.json`, usernames, addresses or home paths. Scan
  the diff for them before every commit.
- The API has no login. Every route must keep working only for pages this server serves.
  Keep the `Host` check and the JSON content-type requirement on writes.
- Third-party strings (token names, symbols, error messages) go through `esc()` before
  they reach `innerHTML`.
- The server refuses a transfer unless the active session carries the matching policy for
  that contract. Do not bypass this check, even for testing.
- Every CLI call passes `--account`. The app must never touch the CLI's default session.
- Prefer deleting a rule to adding a special case. No new config values, flags or modes
  for cases that do not exist yet.
- Prose in the repo (README, UI copy, comments, commit messages) is plain and direct. No
  em dashes, no formulaic contrasts, no filler.
