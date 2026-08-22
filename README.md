# Controller Sender

A local webapp that sends any ERC20 token from a [Cartridge Controller](https://cartridge.gg)
to any Starknet address, such as a Ready wallet. Mainnet only.

It wraps [controller-cli](https://github.com/cartridge-gg/controller-cli). The CLI holds
the session key. This app builds the policy file, shows your balances, and runs
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
token you hold, plus ETH, STRK and any custom tokens, then runs `controller session auth`
and opens the Cartridge approval page. The CLI pre-fills and locks the username on that
page. Log in with your passkey. After you add a token, authorize once more.

**Send.** Pick a token, enter an amount and a recipient, confirm. The recipient can be a
raw address or `@username`. Gas is paid from the controller.

**Settings.** Save a default recipient. It is stored in `config.json`.

## How it works

- Every CLI call passes `--account <username>`. The app gets its own session store and
  never touches the CLI's default session, the one games use.
- Tokens come from the Ekubo mainnet list, with USD prices and logos. You can add a token
  by address. A static fallback list covers the case where Ekubo is down.
- Balances are one batched `starknet_call` request to `api.cartridge.gg/x/starknet/mainnet`.
- A transfer runs `controller execute <token> transfer <recipient>,u256:<amount> --wait --no-paymaster`.
  The server refuses it unless the active session carries a `transfer` policy for that token.

## Security model

The API has no login, so only pages served by this server may reach it. The server binds
to `127.0.0.1`. It rejects any request whose `Host` header is not its own, which blocks
DNS rebinding. It requires `application/json` on writes, so a cross-site request triggers
a CORS preflight that fails. Token names from third-party lists are escaped before they
are rendered. Do not expose this server on a network.

Environment overrides: `PORT`, `CONTROLLER_BIN`, `CONTROLLER_ACCOUNT`, `STARKNET_RPC`.

## Development

```bash
npm run check   # tsc --noEmit
```

## License

MIT
