# Controller Sender

A local webapp that sends any ERC20 token or ERC721 NFT from a
[Cartridge Controller](https://cartridge.gg) to any Starknet address, such as a Ready
wallet. Mainnet only.

It wraps [controller-cli](https://github.com/cartridge-gg/controller-cli). The CLI holds
the session key. This app builds the policy file, shows your balances and NFTs, and runs
`controller execute` for the transfers you confirm. Nothing else leaves your machine.

## Setup

1. Install the CLI. It puts `controller` in `~/.local/bin`.

   ```bash
   curl -fsSL https://raw.githubusercontent.com/cartridge-gg/controller-cli/main/install.sh | bash
   ```

2. Set your Cartridge username.

   ```bash
   cp config.example.json config.json   # then edit "account"
   ```

   You can export `CONTROLLER_ACCOUNT=<username>` instead.

3. Run it.

   ```bash
   npm install
   npm run dev   # http://127.0.0.1:3210
   ```

You need Node 20 or newer and `stdbuf` from coreutils.

## Usage

**Authorize session.** The app writes `policies.json` with `transfer` permission for every
token you hold, plus ETH, STRK and any custom tokens, and `transfer_from` permission for
every NFT collection you hold. It then runs `controller session auth` and opens the
Cartridge approval page. The CLI pre-fills and locks the username on that page. Log in
with your passkey. After you add a token or receive an NFT from a new collection,
authorize once more.

**Send.** Pick a token or an NFT collection. For a token, enter an amount. For an NFT,
pick the token ID. Enter a recipient and confirm. The recipient can be a raw address or
`@username`. Gas is paid from the controller.

**Settings.** Save a default recipient. It is stored in `config.json`.

## How it works

- Every CLI call passes `--account <username>`. The app gets its own session store and
  never touches the CLI's default session, the one games use.
- Tokens come from the Ekubo mainnet list, with USD prices and logos. You can add a token
  by address. A static fallback list covers the case where Ekubo is down.
- Balances are batched `starknet_call` requests to `api.cartridge.gg/x/starknet/mainnet`.
- NFTs come from Starkscan's transfer index: every ERC721 token the controller ever
  received is a candidate, and `owner_of` on-chain decides which ones it still holds. A
  stale index can hide an NFT but never show one that is gone. Candidates are cached for
  five minutes. NFTs are grouped by collection name, since one collection can span several
  contracts.
- NFT images come from `token_uri`. The browser decodes the metadata and shows
  `data:image/` or `https` images only. IPFS links are fetched by the server through
  Pinata's public gateway, because public gateways refuse browser requests. The gateway
  host is fixed, so a token contract can only choose the path.
- A token transfer runs `controller execute <token> transfer <recipient>,u256:<amount> --wait --no-paymaster`.
  An NFT transfer runs `controller execute <collection> transfer_from <controller>,<recipient>,u256:<id>`
  with the same flags. The server refuses either unless the active session carries the
  matching policy for that contract.

## Security model

The API has no login, so only pages served by this server may reach it. The server binds
to `127.0.0.1`. It rejects any request whose `Host` header is not its own, which blocks
DNS rebinding. It requires `application/json` on writes, so a cross-site request triggers
a CORS preflight that fails. Token names from third-party lists are escaped before they
are rendered. Do not expose this server on a network.

Environment overrides: `PORT`, `CONTROLLER_BIN`, `CONTROLLER_ACCOUNT`, `STARKNET_RPC`,
`STARKSCAN_API_KEY` (use the official Starkscan API host with a key instead of the
keyless endpoint on starkscan.co).

## Development

```bash
npm run check   # tsc --noEmit
```

## License

MIT
