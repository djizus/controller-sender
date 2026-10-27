import Controller from "@cartridge/controller";
import {
  formatUnits,
  getHeldNfts,
  getHeldTokens,
  isValidAddress,
  lookupUsername,
  normalizeAddress,
  parseAmount,
  readToken,
  tokenUri,
  u256Calldata,
  waitForTransaction,
} from "./chain.ts";

const $ = (id) => document.getElementById(id);

const controller = new Controller({ defaultChainId: "0x534e5f4d41494e" }); // SN_MAIN

const state = {
  account: null, // the connected Controller account
  address: null, // its normalized address
  assets: new Map(), // key -> token or NFT, rebuilt on every balance load
  selection: new Map(), // key -> { amount } for what the Send card will send
  expanded: new Set(), // collection keys whose NFTs are listed
  sending: false,
  resolvedRecipient: null, // set when @username lookup succeeds
};

// ---------------------------------------------------------------------------
// Helpers

// Per-browser settings: the default recipient and tokens added by address.
// Storage can be unavailable (private windows, blocked site data); the page
// then works without remembering anything.
function loadSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function toast(message, kind = "info", html = false) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  if (html) el.innerHTML = message;
  else el.textContent = message;
  el.title = "Click to dismiss";
  el.addEventListener("click", (e) => {
    if (e.target.tagName !== "A") el.remove();
  });
  $("toasts").appendChild(el);
  // Errors stay until dismissed so a failure is not missed.
  if (kind !== "error") setTimeout(() => el.remove(), 8000);
}

// Token metadata comes from third parties (Ekubo list, on-chain name()), so it
// must never reach innerHTML unescaped.
function esc(v) {
  return String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function short(addr) {
  return addr && addr.length > 14 ? `${addr.slice(0, 8)}…${addr.slice(-6)}` : addr;
}

function fmtUsd(v) {
  if (v === null || v === undefined) return "";
  return v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function fmtBalance(b) {
  const [int, frac] = b.split(".");
  if (!frac) return int;
  return `${int}.${frac.slice(0, 6)}`;
}

// ---------------------------------------------------------------------------
// Connection

async function showAccount(account) {
  state.account = account;
  state.address = account ? normalizeAddress(account.address) : null;
  $("connect-card").hidden = !!account;
  $("app").hidden = !account;
  $("disconnect-btn").hidden = !account;
  $("address").hidden = !account;
  $("username").hidden = true;
  if (!account) return;
  $("address").textContent = short(state.address);
  controller.username()?.then((name) => {
    if (!name || state.account !== account) return;
    $("username").textContent = name;
    $("username").hidden = false;
  });
  await loadBalances();
}

async function connect() {
  const btn = $("connect-btn");
  btn.disabled = true;
  try {
    const account = await controller.connect();
    if (account) await showAccount(account);
  } catch (err) {
    toast(`Could not connect: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
  }
}

async function disconnect() {
  await controller.disconnect();
  state.selection.clear();
  state.assets = new Map();
  await showAccount(null);
}

$("address").onclick = () => {
  navigator.clipboard.writeText(state.address);
  toast("Controller address copied");
};

// ---------------------------------------------------------------------------
// Balances. Ticking a token or an NFT adds it to the Send card.

const tokenKey = (address) => `token:${address}`;
const nftKey = (address, tokenId) => `nft:${address}:${tokenId}`;
const collectionKey = (c) => `${c.symbol}\n${c.name}`;

// Swaps the text placeholder for an image once it scrolls into view, so a
// collection of hundreds of NFTs only resolves the images on screen.
// getSrc returns a URL or a promise of one.
const pendingIcons = new WeakMap(); // placeholder -> load function
const iconObserver = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    iconObserver.unobserve(e.target);
    pendingIcons.get(e.target)?.();
    pendingIcons.delete(e.target);
  }
});

function setIcon(fallback, getSrc, cls = "") {
  pendingIcons.set(fallback, async () => {
    const url = await getSrc();
    if (!url) return;
    const img = document.createElement("img");
    img.className = cls;
    img.alt = "";
    img.onload = () => fallback.replaceWith(img);
    img.src = url;
  });
  iconObserver.observe(fallback);
}

function tokenIcon(fallback, t) {
  if (/^https?:\/\//.test(t.logoUrl ?? "")) setIcon(fallback, () => t.logoUrl);
}

async function loadBalances() {
  const box = $("balances");
  try {
    const address = state.address;
    const [held, nfts] = await Promise.all([
      getHeldTokens(address, loadSetting("customTokens", [])),
      getHeldNfts(address).then(
        (list) => ({ list, error: null }),
        (err) => ({ list: [], error: err.message }),
      ),
    ]);
    if (address !== state.address) return; // disconnected or switched meanwhile
    const tokens = held
      .map((t) => {
        const balance = formatUnits(t.raw, t.decimals);
        return { ...t, balance, usd: t.usdPrice !== undefined ? Number(balance) * t.usdPrice : null };
      })
      .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || (b.raw > a.raw ? 1 : b.raw < a.raw ? -1 : 0));
    const collections = groupCollections(nfts.list);

    state.assets = new Map();
    for (const t of tokens) state.assets.set(tokenKey(t.address), { kind: "token", ...t });
    for (const c of collections) {
      for (const n of c.tokens) {
        state.assets.set(nftKey(n.address, n.tokenId), { kind: "nft", symbol: c.symbol, name: c.name, ...n });
      }
    }
    for (const key of state.selection.keys()) if (!state.assets.has(key)) state.selection.delete(key);

    if (tokens.length === 0) {
      box.innerHTML = '<p class="muted">No token balances found.</p>';
    } else {
      box.innerHTML = "";
      let total = 0;
      for (const t of tokens) {
        total += t.usd ?? 0;
        const row = document.createElement("label");
        row.className = "token-row";
        row.innerHTML = `
          <input type="checkbox" data-key="${esc(tokenKey(t.address))}" />
          <span class="token-fallback">${esc(t.symbol.slice(0, 3))}</span>
          <div class="token-meta">
            <div class="sym">${esc(t.symbol)}</div>
            <div class="nm">${esc(t.name)}</div>
          </div>
          <div class="token-nums">
            <div class="bal">${fmtBalance(t.balance)}</div>
            <div class="usd">${fmtUsd(t.usd)}</div>
          </div>`;
        tokenIcon(row.querySelector(".token-fallback"), t);
        box.appendChild(row);
      }
      $("total-usd").textContent = total > 0 ? `≈ ${fmtUsd(total)}` : "";
    }
    renderNfts(collections, nfts.error);
    syncSelection();
  } catch (err) {
    box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

$("balances").addEventListener("change", (e) => toggle([e.target.dataset.key], e.target.checked));

// A collection is a symbol and name. One collection can span several contracts
// (seasonal deployments, per-type chests), so each token carries its contract.
function groupCollections(nfts) {
  const groups = new Map();
  for (const n of nfts) {
    const key = `${n.symbol}\n${n.name}`;
    if (!groups.has(key)) groups.set(key, { symbol: n.symbol, name: n.name, tokens: [] });
    groups.get(key).tokens.push({ address: n.address, tokenId: n.tokenId.toString() });
  }
  return [...groups.values()].sort((a, b) => b.tokens.length - a.tokens.length);
}

function toggle(keys, on) {
  for (const key of keys) {
    if (on && !state.selection.has(key)) state.selection.set(key, { amount: "" });
    if (!on) state.selection.delete(key);
  }
  syncSelection();
}

// ---------------------------------------------------------------------------
// NFT images. The server returns the raw token URI; the metadata is decoded
// here, so the server never fetches a URL chosen by a token contract. Only
// data:image/ and https image sources are used.

const nftImages = new Map(); // "address:tokenId" -> Promise<string|null>

// Pinata's gateway sends CORS headers, so the browser reads IPFS metadata from it
// directly. Gateways rate-limit Cloudflare's servers, so a proxy here would fail.
function httpUrl(u) {
  if (u.startsWith("ipfs://")) {
    const path = u.slice(7);
    // Paths sometimes carry raw spaces; leave already-encoded ones alone.
    return `https://gateway.pinata.cloud/ipfs/${/%[0-9a-f]{2}/i.test(path) ? path : encodeURI(path)}`;
  }
  return /^https:\/\//.test(u) ? u : null;
}

function parseMetadata(text) {
  try {
    return JSON.parse(text);
  } catch {
    const m = /"image"\s*:\s*"([^"]+)"/.exec(text);
    return m ? { image: m[1] } : null;
  }
}

async function imageFromUri(uri) {
  if (!uri) return null;
  let meta;
  if (uri.startsWith("data:image/")) return uri;
  if (uri.startsWith("data:application/json")) {
    const comma = uri.indexOf(",");
    const payload = uri.slice(comma + 1);
    let text;
    if (uri.slice(0, comma).includes(";base64")) text = atob(payload);
    else {
      try {
        text = decodeURIComponent(payload);
      } catch {
        text = payload;
      }
    }
    meta = parseMetadata(text);
  } else {
    const url = httpUrl(uri);
    if (!url) return null;
    const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
    meta = parseMetadata(await res.text());
  }
  const image = meta?.image ?? meta?.image_url ?? null;
  if (!image) return null;
  return image.startsWith("data:image/") ? image : httpUrl(image);
}

function nftImage(address, tokenId) {
  const key = `${address}:${tokenId}`;
  if (!nftImages.has(key)) {
    nftImages.set(
      key,
      tokenUri(address, BigInt(tokenId))
        .then(imageFromUri)
        .catch(() => null),
    );
  }
  return nftImages.get(key);
}

function renderNfts(collections, error) {
  const box = $("nfts");
  if (error) {
    box.innerHTML = `<p class="muted">NFTs unavailable: ${esc(error)}</p>`;
    return;
  }
  if (collections.length === 0) {
    box.innerHTML = '<p class="muted">No NFTs found.</p>';
    return;
  }
  box.innerHTML = "";
  for (const c of collections) {
    const ckey = collectionKey(c);
    const keys = c.tokens.map((t) => nftKey(t.address, t.tokenId));
    const open = state.expanded.has(ckey);
    const n = c.tokens.length;
    const row = document.createElement("div");
    row.className = "token-row collection";
    row.innerHTML = `
      <input type="checkbox" class="all" title="Select all" />
      <span class="token-fallback">${esc(c.symbol.slice(0, 3))}</span>
      <div class="token-meta">
        <div class="sym">${esc(c.symbol)}</div>
        <div class="nm">${esc(c.name)}</div>
      </div>
      <div class="token-nums">
        <div class="bal">${n}</div>
        <div class="usd">${n === 1 ? "NFT" : "NFTs"}</div>
      </div>
      <span class="caret">${open ? "▾" : "▸"}</span>`;
    setIcon(row.querySelector(".token-fallback"), () => nftImage(c.tokens[0].address, c.tokens[0].tokenId), "nft");
    const all = row.querySelector(".all");
    all.dataset.group = keys.join(" ");
    all.onclick = (e) => e.stopPropagation();
    all.onchange = (e) => {
      e.stopPropagation();
      toggle(keys, all.checked);
    };
    row.onclick = () => {
      if (open) state.expanded.delete(ckey);
      else state.expanded.add(ckey);
      renderNfts(collections);
      syncSelection();
    };
    box.appendChild(row);

    if (!open) continue;
    const contracts = new Set(c.tokens.map((t) => t.address)).size;
    const list = document.createElement("div");
    list.className = "nft-items";
    for (const t of c.tokens) {
      const item = document.createElement("label");
      item.className = "token-row";
      item.innerHTML = `
        <input type="checkbox" data-key="${esc(nftKey(t.address, t.tokenId))}" />
        <span class="token-fallback">#</span>
        <div class="token-meta">
          <div class="sym">#${esc(t.tokenId)}</div>
          ${contracts > 1 ? `<div class="nm mono">${short(t.address)}</div>` : ""}
        </div>`;
      setIcon(item.querySelector(".token-fallback"), () => nftImage(t.address, t.tokenId), "nft");
      list.appendChild(item);
    }
    box.appendChild(list);
  }
}

$("nfts").addEventListener("change", (e) => {
  if (e.target.dataset.key) toggle([e.target.dataset.key], e.target.checked);
});

// Brings every checkbox and the Send card in line with state.selection.
function syncSelection() {
  for (const box of document.querySelectorAll("input[data-key]")) {
    box.checked = state.selection.has(box.dataset.key);
  }
  for (const box of document.querySelectorAll("input[data-group]")) {
    const keys = box.dataset.group.split(" ");
    const picked = keys.filter((k) => state.selection.has(k)).length;
    box.checked = picked === keys.length;
    box.indeterminate = picked > 0 && picked < keys.length;
  }
  renderSelection();
}

// ---------------------------------------------------------------------------
// Send card: one line per selected asset, an amount for each token.

function tokenUsd(t, amount) {
  const n = parseFloat(amount);
  if (t.usd === null || Number.isNaN(n) || !(Number(t.balance) > 0)) return null;
  return (n * t.usd) / Number(t.balance);
}

function renderSelection() {
  const box = $("selection");
  box.innerHTML = "";
  const n = state.selection.size;
  $("send-count").textContent = n ? `${n} selected` : "";
  $("send-btn").disabled = n === 0 || state.sending;
  if (!state.sending) $("send-btn").textContent = n > 1 ? `Send ${n} items` : "Send";
  if (n === 0) {
    box.innerHTML = '<p class="muted small">Tick tokens or NFTs to add them here.</p>';
    return;
  }
  for (const [key, sel] of state.selection) {
    const a = state.assets.get(key);
    const row = document.createElement("div");
    row.className = "token-row";
    if (a.kind === "token") {
      row.innerHTML = `
        <span class="token-fallback">${esc(a.symbol.slice(0, 3))}</span>
        <div class="token-meta">
          <div class="sym">${esc(a.symbol)}</div>
          <div class="nm usd-hint"></div>
        </div>
        <input class="amt" placeholder="0.0" inputmode="decimal" autocomplete="off" spellcheck="false" />
        <button type="button" class="ghost max">MAX</button>`;
      tokenIcon(row.querySelector(".token-fallback"), a);
      const input = row.querySelector(".amt");
      const hint = row.querySelector(".usd-hint");
      const update = () => {
        sel.amount = input.value.trim();
        const usd = tokenUsd(a, sel.amount);
        hint.textContent = usd === null ? `${fmtBalance(a.balance)} available` : `≈ ${fmtUsd(usd)}`;
      };
      input.value = sel.amount;
      input.oninput = update;
      row.querySelector(".max").onclick = () => {
        input.value = a.balance;
        update();
      };
      update();
    } else {
      row.innerHTML = `
        <span class="token-fallback">#</span>
        <div class="token-meta">
          <div class="sym">${esc(a.symbol)} #${esc(a.tokenId)}</div>
          <div class="nm">${esc(a.name)}</div>
        </div>`;
      setIcon(row.querySelector(".token-fallback"), () => nftImage(a.address, a.tokenId), "nft");
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "ghost remove";
    remove.title = "Remove";
    remove.textContent = "×";
    remove.onclick = () => toggle([key], false);
    row.appendChild(remove);
    box.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Recipient (@username resolution)

let lookupTimer = null;
$("recipient").addEventListener("input", () => {
  state.resolvedRecipient = null;
  $("recipient-hint").textContent = "";
  clearTimeout(lookupTimer);
  const value = $("recipient").value.trim();
  if (value.startsWith("@") && value.length > 1) {
    lookupTimer = setTimeout(async () => {
      try {
        const address = await lookupUsername(value.slice(1));
        if ($("recipient").value.trim() !== value) return; // typed on meanwhile
        if (address) {
          state.resolvedRecipient = address;
          $("recipient-hint").textContent = `${value} → ${short(address)}`;
        } else {
          $("recipient-hint").textContent = `No controller found for ${value}`;
        }
      } catch (err) {
        $("recipient-hint").textContent = `Lookup failed: ${err.message}`;
      }
    }, 500);
  }
});

function finalRecipient() {
  const value = $("recipient").value.trim();
  if (value.startsWith("@")) return state.resolvedRecipient;
  return value;
}

// ---------------------------------------------------------------------------
// Send flow

// What the form would send right now: one call per selected asset.
function pendingTransfer() {
  const recipient = finalRecipient();
  if (state.selection.size === 0) return { error: "Tick something to send" };
  if (!recipient) return { error: "Recipient not resolved yet" };
  if (!isValidAddress(recipient)) return { error: "Invalid recipient address" };
  const items = [];
  for (const [key, sel] of state.selection) {
    const a = state.assets.get(key);
    if (a.kind === "nft") {
      items.push({
        label: `${a.symbol} #${a.tokenId}`,
        call: {
          contractAddress: a.address,
          entrypoint: "transfer_from",
          calldata: [state.address, recipient, ...u256Calldata(BigInt(a.tokenId))],
        },
      });
      continue;
    }
    if (!sel.amount) return { error: `Enter an amount for ${a.symbol}` };
    let raw;
    try {
      raw = parseAmount(sel.amount, a.decimals);
    } catch (err) {
      return { error: `${a.symbol}: ${err.message}` };
    }
    if (raw <= 0n) return { error: `${a.symbol}: amount must be greater than zero` };
    const usd = tokenUsd(a, sel.amount);
    items.push({
      label: `${sel.amount} ${a.symbol}${usd === null ? "" : ` (≈ ${fmtUsd(usd)})`}`,
      call: { contractAddress: a.address, entrypoint: "transfer", calldata: [recipient, ...u256Calldata(raw)] },
    });
  }
  return { items, recipient: normalizeAddress(recipient) };
}

$("send-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const p = pendingTransfer();
  if (p.error) return toast(p.error, "error");
  $("c-items").innerHTML = p.items.map((i) => `<li>${esc(i.label)}</li>`).join("");
  $("c-recipient").textContent = p.recipient;
  $("c-atomic").hidden = p.items.length < 2;
  $("confirm-modal").showModal();
});

$("c-cancel").onclick = () => $("confirm-modal").close();

// All transfers go out as one multicall, so they succeed or fail together.
// The Controller popup shows the calls and asks the user to approve them.
$("c-confirm").onclick = async () => {
  const p = pendingTransfer();
  $("confirm-modal").close();
  if (p.error) return toast(p.error, "error");
  state.sending = true;
  $("send-btn").disabled = true;
  $("send-btn").textContent = "Approve in Controller…";
  const what = p.items.length === 1 ? p.items[0].label : `${p.items.length} items`;
  let hash;
  try {
    ({ transaction_hash: hash } = await state.account.execute(p.items.map((i) => i.call)));
  } catch (err) {
    // The SDK rejects with its own error objects, not always Error instances.
    toast(`Transfer not sent: ${err?.message ?? JSON.stringify(err)}`, "error");
    state.sending = false;
    syncSelection();
    return;
  }
  // From here the transaction is on its way, so the selection is spent either way.
  state.selection.clear();
  const link = `<a href="https://voyager.online/tx/${esc(hash)}" target="_blank" rel="noopener">View on Voyager ↗</a>`;
  try {
    $("send-btn").textContent = "Sending… (waiting for confirmation)";
    const outcome = await waitForTransaction(hash);
    if (outcome.status === "succeeded") toast(`Sent ${esc(what)} ✓ ${link}`, "success", true);
    else if (outcome.status === "reverted") toast(`Transfer reverted: ${esc(outcome.revertReason)} ${link}`, "error", true);
    else toast(`Submitted, not confirmed yet. ${link}`, "info", true);
    setTimeout(loadBalances, 4000);
  } finally {
    state.sending = false;
    syncSelection();
  }
};

// ---------------------------------------------------------------------------
// Add token & settings

$("add-token-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("add-token-address").value.trim();
  if (!input) return;
  if (!isValidAddress(input)) return toast("Invalid token address", "error");
  const address = normalizeAddress(input);
  const custom = loadSetting("customTokens", []);
  if (custom.some((t) => t.address === address) || state.assets.has(tokenKey(address))) {
    return toast("Token already in the list", "error");
  }
  try {
    const token = await readToken(address);
    saveSetting("customTokens", [...custom, token]);
    $("add-token-address").value = "";
    toast(`Added ${token.symbol}`, "success");
    await loadBalances();
  } catch (err) {
    toast(`Could not add token: ${err.message}`, "error");
  }
});

$("settings-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const value = $("default-recipient").value.trim();
  if (value && !isValidAddress(value)) return toast("Invalid recipient address", "error");
  const recipient = value ? normalizeAddress(value) : null;
  saveSetting("defaultRecipient", recipient);
  toast(recipient ? "Default recipient saved" : "Default recipient cleared", "success");
  if (recipient && !$("recipient").value) $("recipient").value = recipient;
});

// On phones the Send card is a bottom sheet; its head opens and closes it.
$("send-head").onclick = () => $("send-card").classList.toggle("open");
$("connect-btn").onclick = connect;
$("disconnect-btn").onclick = disconnect;
$("refresh-btn").onclick = loadBalances;

// ---------------------------------------------------------------------------
// Boot

const defaultRecipient = loadSetting("defaultRecipient", null);
if (defaultRecipient) {
  $("default-recipient").value = defaultRecipient;
  $("recipient").value = defaultRecipient;
}

// probe() restores a connection made earlier in this browser without a popup.
controller.probe().then(showAccount, () => showAccount(null));
