const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  assets: new Map(), // key -> token or NFT, rebuilt on every balance load
  collections: [],
  selection: new Map(), // key -> { amount } for what the Send card will send
  expanded: new Set(), // collection keys whose NFTs are listed
  sending: false,
  resolvedRecipient: null, // set when @username lookup succeeds
  authPolling: false,
};

// ---------------------------------------------------------------------------
// Helpers

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error || `${res.status} ${res.statusText}`);
    err.body = body;
    throw err;
  }
  return body;
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
// Status & session

async function loadStatus() {
  const s = await api("/api/status");
  state.status = s;

  if (s.username) {
    $("username").textContent = s.username;
    $("username").hidden = false;
  }
  if (s.address) {
    $("address").textContent = short(s.address);
    $("address").hidden = false;
    $("address").onclick = () => {
      navigator.clipboard.writeText(s.address);
      toast("Controller address copied");
    };
  }

  const pill = $("session-pill");
  if (s.session) {
    pill.textContent = `session active · expires ${s.session.expiresFormatted.replace(" UTC", "")}`;
    pill.className = "pill session on";
  } else {
    pill.textContent = "no transfer session";
    pill.className = "pill session off";
  }

  $("auth-banner").hidden = !!s.session && s.auth.status !== "pending";

  if (s.auth.status === "pending" && s.auth.url) {
    $("auth-link").href = s.auth.url;
    $("auth-link-row").hidden = false;
    startAuthPolling();
  } else {
    $("auth-link-row").hidden = true;
  }

  if (s.defaultRecipient) {
    $("default-recipient").value = s.defaultRecipient;
    if (!$("recipient").value) $("recipient").value = s.defaultRecipient;
  }
  return s;
}

async function startAuth() {
  const btn = $("auth-btn");
  btn.disabled = true;
  btn.textContent = "Preparing…";
  try {
    const res = await api("/api/auth", { method: "POST", body: "{}" });
    if (res.url) {
      $("auth-link").href = res.url;
      $("auth-link-row").hidden = false;
      window.open(res.url, "_blank");
      startAuthPolling();
    }
  } catch (err) {
    toast(`Authorization failed: ${err.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Authorize session";
  }
}

function startAuthPolling() {
  if (state.authPolling) return;
  state.authPolling = true;
  const timer = setInterval(async () => {
    try {
      const s = await api("/api/status");
      if (s.session && s.auth.status !== "pending") {
        clearInterval(timer);
        state.authPolling = false;
        $("auth-banner").hidden = true;
        toast("Session authorized ✓", "success");
        await loadStatus();
        await loadBalances();
      } else if (s.auth.status === "failed") {
        clearInterval(timer);
        state.authPolling = false;
        toast(`Authorization failed: ${s.auth.error || "unknown error"}`, "error");
      }
    } catch {
      /* keep polling */
    }
  }, 3000);
}

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

const noPerm = (what) =>
  `<span class="tag" title="The session cannot transfer this ${what} yet. Re-authorize to allow it.">no perm</span>`;

async function loadBalances() {
  const box = $("balances");
  try {
    const res = await api("/api/balances");
    state.assets = new Map();
    for (const t of res.tokens) state.assets.set(tokenKey(t.address), { kind: "token", ...t });
    for (const c of res.collections) {
      for (const n of c.tokens) {
        state.assets.set(nftKey(n.address, n.tokenId), { kind: "nft", symbol: c.symbol, name: c.name, ...n });
      }
    }
    for (const key of state.selection.keys()) if (!state.assets.has(key)) state.selection.delete(key);

    if (res.tokens.length === 0) {
      box.innerHTML = '<p class="muted">No token balances found.</p>';
    } else {
      box.innerHTML = "";
      let total = 0;
      for (const t of res.tokens) {
        total += t.usd ?? 0;
        const row = document.createElement("label");
        row.className = "token-row";
        row.innerHTML = `
          <input type="checkbox" data-key="${esc(tokenKey(t.address))}" />
          <span class="token-fallback">${esc(t.symbol.slice(0, 3))}</span>
          <div class="token-meta">
            <div class="sym">${esc(t.symbol)}${t.transferAllowed ? "" : noPerm("token")}</div>
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
    renderNfts(res);
    syncSelection();
  } catch (err) {
    box.innerHTML = `<p class="muted">${esc(err.message)}</p>`;
  }
}

$("balances").addEventListener("change", (e) => toggle([e.target.dataset.key], e.target.checked));

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

// IPFS goes through this server, since public gateways refuse browser requests.
function httpUrl(u) {
  if (u.startsWith("ipfs://")) {
    const path = u.slice(7);
    // Paths sometimes carry raw spaces; leave already-encoded ones alone.
    return `/api/ipfs/${/%[0-9a-f]{2}/i.test(path) ? path : encodeURI(path)}`;
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
      api(`/api/nft-uri?address=${address}&tokenId=${tokenId}`)
        .then((r) => imageFromUri(r.uri))
        .catch(() => null),
    );
  }
  return nftImages.get(key);
}

function renderNfts(res) {
  const box = $("nfts");
  state.collections = res.collections;
  if (res.nftError) {
    box.innerHTML = `<p class="muted">NFTs unavailable: ${esc(res.nftError)}</p>`;
    return;
  }
  if (res.collections.length === 0) {
    box.innerHTML = '<p class="muted">No NFTs found.</p>';
    return;
  }
  box.innerHTML = "";
  for (const c of res.collections) {
    const ckey = collectionKey(c);
    const keys = c.tokens.map((t) => nftKey(t.address, t.tokenId));
    const open = state.expanded.has(ckey);
    const n = c.tokens.length;
    const allowed = c.tokens.every((t) => t.transferAllowed);
    const row = document.createElement("div");
    row.className = "token-row collection";
    row.innerHTML = `
      <input type="checkbox" class="all" title="Select all" />
      <span class="token-fallback">${esc(c.symbol.slice(0, 3))}</span>
      <div class="token-meta">
        <div class="sym">${esc(c.symbol)}${allowed ? "" : noPerm("collection")}</div>
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
      renderNfts(res);
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
        const res = await api(`/api/lookup?username=${encodeURIComponent(value.slice(1))}`);
        if (res.address) {
          state.resolvedRecipient = res.address;
          $("recipient-hint").textContent = `@${res.username} → ${short(res.address)}`;
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

// What the form would send right now: one entry per selected asset.
function pendingTransfer() {
  const recipient = finalRecipient();
  if (state.selection.size === 0) return { error: "Tick something to send" };
  if (!recipient) return { error: "Recipient not resolved yet" };
  const items = [];
  for (const [key, sel] of state.selection) {
    const a = state.assets.get(key);
    if (a.kind === "nft") {
      items.push({ asset: a, label: `${a.symbol} #${a.tokenId}`, body: { address: a.address, tokenId: a.tokenId } });
      continue;
    }
    if (!sel.amount) return { error: `Enter an amount for ${a.symbol}` };
    const usd = tokenUsd(a, sel.amount);
    items.push({
      asset: a,
      label: `${sel.amount} ${a.symbol}${usd === null ? "" : ` (≈ ${fmtUsd(usd)})`}`,
      body: { address: a.address, amount: sel.amount },
    });
  }
  return { items, recipient, body: { recipient, transfers: items.map((i) => i.body) } };
}

$("send-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const p = pendingTransfer();
  if (p.error) return toast(p.error, "error");
  const blocked = [...new Set(p.items.filter((i) => !i.asset.transferAllowed).map((i) => i.asset.symbol))];
  if (blocked.length) {
    $("auth-banner").hidden = false;
    return toast(`The session cannot transfer ${blocked.join(", ")} yet. Click "Authorize session" first.`, "error");
  }
  $("c-items").innerHTML = p.items.map((i) => `<li>${esc(i.label)}</li>`).join("");
  $("c-recipient").textContent = p.recipient;
  $("c-atomic").hidden = p.items.length < 2;
  $("confirm-modal").showModal();
});

$("c-cancel").onclick = () => $("confirm-modal").close();

$("c-confirm").onclick = async () => {
  const p = pendingTransfer();
  $("confirm-modal").close();
  if (p.error) return toast(p.error, "error");
  state.sending = true;
  $("send-btn").disabled = true;
  $("send-btn").textContent = "Sending… (waiting for confirmation)";
  const what = p.items.length === 1 ? p.items[0].label : `${p.items.length} items`;
  try {
    const res = await api("/api/transfer", { method: "POST", body: JSON.stringify(p.body) });
    if (res.txHash) {
      toast(
        `Sent ${esc(what)} ✓ <a href="https://voyager.online/tx/${esc(res.txHash)}" target="_blank" rel="noopener">View on Voyager ↗</a>`,
        "success",
        true,
      );
    } else {
      toast(`Transfer submitted (no tx hash returned)`, "success");
    }
    state.selection.clear();
    setTimeout(loadBalances, 4000);
  } catch (err) {
    if (err.body?.needsReauth) {
      $("auth-banner").hidden = false;
      toast(`${err.message}`, "error");
    } else {
      const hint = err.body?.recoveryHint ? `. ${err.body.recoveryHint}` : "";
      toast(`Transfer failed: ${err.message}${hint}`, "error");
    }
  } finally {
    state.sending = false;
    syncSelection();
  }
};

// ---------------------------------------------------------------------------
// Add token & settings

$("add-token-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const address = $("add-token-address").value.trim();
  if (!address) return;
  try {
    const res = await api("/api/tokens", { method: "POST", body: JSON.stringify({ address }) });
    $("add-token-address").value = "";
    toast(`Added ${res.token.symbol}. Re-authorize the session to enable transfers.`, "success");
    $("auth-banner").hidden = false;
    await loadBalances();
  } catch (err) {
    toast(`Could not add token: ${err.message}`, "error");
  }
});

$("settings-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const res = await api("/api/settings", {
      method: "POST",
      body: JSON.stringify({ defaultRecipient: $("default-recipient").value.trim() }),
    });
    toast("Default recipient saved", "success");
    if (res.defaultRecipient && !$("recipient").value) {
      $("recipient").value = res.defaultRecipient;
    }
  } catch (err) {
    toast(`Could not save: ${err.message}`, "error");
  }
});

$("auth-btn").onclick = startAuth;
$("refresh-btn").onclick = loadBalances;

// ---------------------------------------------------------------------------
// Boot

(async () => {
  try {
    const s = await loadStatus();
    if (!s.defaultRecipient) $("settings").open = true;
    await loadBalances();
  } catch (err) {
    toast(`Failed to load: ${err.message}`, "error");
  }
})();
