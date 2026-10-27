# Controller Sender

A web page that sends ERC20 tokens and ERC721 NFTs from a
[Cartridge Controller](https://cartridge.gg) to any Starknet address, such as a Ready
wallet. Mainnet only. It runs on Cloudflare Pages at https://controller.realms.party.

You connect with your Cartridge passkey. The page never holds a key. Every send goes
through the Controller popup, where you approve it.

## Usage

**Connect.** Click "Connect Controller" and log in. The page remembers the connection in
this browser until you click Disconnect. Your username and address show in the header.
Click the address to copy it.

**Pick what to send.** The Balances card lists every token with a balance and every NFT
the controller holds. Tick a token to add it. Click an NFT collection to list its NFTs
and tick the ones you want, or tick the collection itself to select all of them. ⟳
reloads the lists.

**Send.** Each ticked item appears in the Send card. Enter an amount for every token, or
press MAX. Enter a recipient, either a raw address or `@username`, then press Send and
check the summary. Approve in the Controller popup. Everything goes out in one
transaction, so if one transfer fails, none are sent. The page then reports one of:

- **Sent**, with a Voyager link, once the transaction is in a block.
- **Reverted**, with the reason, if it landed but failed.
- **Submitted, not confirmed yet**, if it took more than two minutes. Check the link.
- **Transfer not sent**, if the popup was closed or refused it. Nothing went on-chain.

On a phone the Send card is a bar at the bottom of the screen with the selection count.
Tap it to open the card.

**Add a token.** Tokens outside the Ekubo list can be added by contract address at the
bottom of the token list. The page reads `symbol`, `name` and `decimals` on-chain.

**Settings.** Save a default recipient. Custom tokens and the default recipient are
stored in this browser only.

## Fees

Gas is paid in STRK from the controller. A send costs little. A single transfer charged
about 0.09 STRK in October 2026. Starknet, though, only runs a transaction if the account
holds its maximum fee, and the Controller popup sets that maximum about 20 times above
the expected cost to survive price spikes. A single transfer then needs about 1.7 STRK in
the account, and larger multicalls need more. With too little, the popup shows "Add
funds" and the page reports "Transfer not sent: Validation failure". Keep around 3 STRK
in the controller.

## How it works

- The page is static HTML, CSS and one JavaScript bundle. `src/app.js` is the UI and
  `src/chain.ts` does the Starknet reads. esbuild bundles them with the
  `@cartridge/controller` SDK into `public/app.js`.
- Tokens come from the Ekubo mainnet list, with USD prices and logos. A static fallback
  list covers the case where Ekubo is down.
- Balances, `owner_of`, `token_uri`, token metadata and transaction receipts are
  `starknet` JSON-RPC requests from the browser to `api.cartridge.gg/x/starknet/mainnet`,
  batched 200 calls at a time. `@username` resolves through Cartridge's lookup API.
- NFTs come from Starkscan's transfer index: every ERC721 token the controller ever
  received is a candidate, and `owner_of` on-chain decides which ones it still holds. A
  stale index can hide an NFT but never show one that is gone. Starkscan refuses browser
  requests, so `functions/api/nfts.ts` fetches the index and caches it for five minutes.
  NFTs are grouped by collection name, since one collection can span several contracts.
- NFT images come from `token_uri`. The browser decodes the metadata and shows
  `data:image/` or `https` images only, loading each one when it scrolls into view. IPFS
  links load from Pinata's public gateway, which sends CORS headers. The gateway host is
  fixed, so a token contract can only choose the path. Public gateways rate-limit
  Cloudflare's servers, so the site does not proxy IPFS.
- A send is one `account.execute` multicall. A token is a
  `transfer(recipient, amount)` call and an NFT is a
  `transfer_from(controller, recipient, id)` call. The page then polls the receipt.
- The look follows [play.realms.party](https://play.realms.party): its colors, the Bokor
  and Atkinson Hyperlegible Next fonts, the Realms logo and the landscape art. Fonts and
  images load from that site, so this repository holds none of them.

## Known limits

- Pinata throttles a browser that requests many IPFS images in a short time. Those images
  then show a placeholder until the limit clears.
- The NFT list depends on Starkscan's keyless endpoint. If it goes away, set the
  `STARKSCAN_API_KEY` secret (see Development).

## Security model

The site holds no keys and no user data. Signing happens in Cartridge's keychain iframe,
which shows each multicall and asks for approval. Third-party strings (token names,
symbols, metadata) are escaped before they are rendered. `public/_headers` sets a Content
Security Policy that only runs scripts from the site itself, loads fonts only from the
site and play.realms.party, frames only Cartridge's keychain, and forbids framing the
site.

## Development

```bash
npm install
npm run dev      # build, then wrangler pages dev on http://127.0.0.1:3210
npm run check    # tsc --noEmit
npm run deploy   # build, then wrangler pages deploy
```

`npm run deploy` needs `wrangler login` and a Pages project named `controller-sender`. The
custom domain `controller.realms.party` is attached to that project in Cloudflare. Set the
`STARKSCAN_API_KEY` secret on the project to use Starkscan's official API with a key
instead of the keyless endpoint.

## License

MIT
