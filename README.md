# Controller Sender

Move your tokens and NFTs out of your Cartridge Controller, the wallet you use in Realms
and other Cartridge games, to any other wallet. You can send many things at once.

Open **https://controller.realms.party** in any browser, on a computer or a phone.

## Is it safe?

You log in with the same passkey you use in Cartridge games. The site never sees it and
cannot move anything on its own. Every send opens a Cartridge window that shows exactly
what will leave your wallet, and nothing happens until you approve it there.

## How to send

1. **Connect.** Press "Connect Controller" and log in with your passkey. The site
   remembers you in this browser until you press Disconnect.
2. **Pick what to send.** Your tokens and NFTs are listed under Balances and NFTs. Tick
   the ones you want to send.
   - To see the NFTs of a collection, click the collection. Tick single NFTs, or tick
     the collection's own box to pick all of them.
   - ⟳ refreshes the lists.
3. **Set the amounts.** Everything you ticked shows up in the Send box. Type an amount
   for each token, or press MAX to send all of it.
4. **Choose who receives it.** Paste a wallet address (it starts with `0x`) or type a
   Cartridge username with `@` in front, like `@friend`. Check the address twice. A send
   cannot be undone.
5. **Send.** Press Send, read the summary, then approve in the Cartridge window.

Everything you picked goes out together. If one part fails, nothing is sent, so you never
end up with half a transfer.

On a phone, the Send box sits at the bottom of the screen and shows how many things you
picked. Tap it to open it.

## What the messages mean

- **Sent ✓**: done. The "View on Voyager" link shows the transfer on the public explorer.
- **Transfer not sent**: you closed the Cartridge window, or it refused the send. Nothing
  left your wallet.
- **Transfer reverted**: the network tried and failed. Nothing left your wallet except
  the small network fee.
- **Submitted, not confirmed yet**: the network is slow. Open the Voyager link to follow
  it, and don't send again until it shows up.

## Fees

Each send pays a small network fee in STRK, Starknet's token. It costs a fraction of a
cent, but the wallet must hold **about 3 STRK** before the network accepts a send. Most of
that is only a safety margin and stays in your wallet.

If the Cartridge window shows "Add funds" and the site says "Validation failure", your
wallet is below that margin. Add some STRK and try again.

## Other things you can do

- **A token is missing from the list?** Paste its contract address into "Add token by
  address" under your tokens.
- **Always send to the same wallet?** Open Settings in the Send box and save it as your
  default recipient. It fills in automatically next time.

Your saved recipient and added tokens are kept in this browser only.

## Questions

- **Some NFT pictures don't show.** Some pictures are hosted on a service that slows down
  when many are opened at once. Wait a minute and refresh. Your NFTs are still there.
- **An NFT I just received is missing.** The list can take a few minutes to catch up.
  Press ⟳ later.
- **Which network is this?** Starknet mainnet, the real network. Sends move real assets.

## For developers

How the site is built, run and deployed is in [AGENTS.md](AGENTS.md).

## License

MIT
