const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  tokens: [],
  collections: [], // NFT collections; select values are "nft:<index>"
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
// Balances

async function loadBalances() {
  const box = $("balances");
  try {
    const res = await api("/api/balances");
    state.tokens = res.tokens;
    if (res.tokens.length === 0) {
      box.innerHTML = '<p class="muted">No token balances found.</p>';
    } else {
      box.innerHTML = "";
      let total = 0;
      for (const t of res.tokens) {
        total += t.usd ?? 0;
        const row = document.createElement("div");
        row.className = "token-row";
        const abbr = esc(t.symbol.slice(0, 3));
        row.innerHTML = `
          <span class="token-fallback">${abbr}</span>
          <div class="token-meta">
            <div class="sym">${esc(t.symbol)}${t.transferAllowed ? "" : '<span class="tag" title="The session cannot transfer this token yet. Re-authorize to allow it.">no perm</span>'}</div>
            <div class="nm">${esc(t.name)}</div>
          </div>
          <div class="token-nums">
            <div class="bal">${fmtBalance(t.balance)}</div>
            <div class="usd">${fmtUsd(t.usd)}</div>
          </div>`;
        if (/^https?:\/\//.test(t.logoUrl ?? "")) {
          const img = document.createElement("img");
          img.alt = "";
          img.onload = () => row.firstElementChild.replaceWith(img);
          img.src = t.logoUrl;
        }
        row.style.cursor = "pointer";
        row.onclick = () => {
          $("token-select").value = t.address;
          updateAssetInputs();
        };
        box.appendChild(row);
      }
      $("total-usd").textContent = total > 0 ? `≈ ${fmtUsd(total)}` : "";
    }
    renderNfts(res);
    renderTokenSelect();
  } catch (err) {
    box.innerHTML = `<p class="muted">${err.message}</p>`;
  }
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
  res.collections.forEach((c, i) => {
    const row = document.createElement("div");
    row.className = "token-row";
    const n = c.tokens.length;
    const allowed = c.tokens.every((t) => t.transferAllowed);
    row.innerHTML = `
      <span class="token-fallback">${esc(c.symbol.slice(0, 3))}</span>
      <div class="token-meta">
        <div class="sym">${esc(c.symbol)}${allowed ? "" : '<span class="tag" title="The session cannot transfer this collection yet. Re-authorize to allow it.">no perm</span>'}</div>
        <div class="nm">${esc(c.name)}</div>
      </div>
      <div class="token-nums">
        <div class="bal">${n}</div>
        <div class="usd">${n === 1 ? "NFT" : "NFTs"}</div>
      </div>`;
    nftImage(c.tokens[0].address, c.tokens[0].tokenId).then((src) => {
      if (!src) return;
      const img = document.createElement("img");
      img.className = "nft";
      img.alt = "";
      img.onload = () => row.firstElementChild.replaceWith(img);
      img.src = src;
    });
    row.style.cursor = "pointer";
    row.onclick = () => {
      $("token-select").value = `nft:${i}`;
      updateAssetInputs();
    };
    box.appendChild(row);
  });
}

function updateNftPreview() {
  const a = selectedAsset();
  const img = $("nft-preview");
  const nft = a?.kind === "nft" ? selectedNft(a) : null;
  img.hidden = true;
  if (!nft) return;
  nftImage(nft.address, nft.tokenId).then((src) => {
    // The selection may have moved on while the image loaded.
    const current = selectedAsset();
    const now = current?.kind === "nft" ? selectedNft(current) : null;
    if (!src || !now || now.address !== nft.address || now.tokenId !== nft.tokenId) return;
    img.src = src;
    img.hidden = false;
  });
}

function renderTokenSelect() {
  const sel = $("token-select");
  const prev = sel.value;
  sel.innerHTML = "";
  const tokens = document.createElement("optgroup");
  tokens.label = "Tokens";
  for (const t of state.tokens) {
    const opt = document.createElement("option");
    opt.value = t.address;
    opt.textContent = `${t.symbol}  ${fmtBalance(t.balance)}`;
    tokens.appendChild(opt);
  }
  if (tokens.childElementCount) sel.appendChild(tokens);
  const nfts = document.createElement("optgroup");
  nfts.label = "NFTs";
  state.collections.forEach((c, i) => {
    const opt = document.createElement("option");
    opt.value = `nft:${i}`;
    opt.textContent = `${c.symbol}  ×${c.tokens.length}`;
    nfts.appendChild(opt);
  });
  if (nfts.childElementCount) sel.appendChild(nfts);
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  updateAssetInputs();
}

// The selected asset: an ERC20 token (with balance) or an NFT collection.
function selectedAsset() {
  const value = $("token-select").value;
  if (value.startsWith("nft:")) {
    const c = state.collections[Number(value.slice(4))];
    return c ? { kind: "nft", ...c } : null;
  }
  const t = state.tokens.find((t) => t.address === value);
  return t ? { kind: "token", ...t } : null;
}

// The chosen NFT within the selected collection, as { address, tokenId, transferAllowed }.
function selectedNft(collection) {
  return collection.tokens[Number($("token-id-select").value)] ?? null;
}

function updateAssetInputs() {
  const a = selectedAsset();
  const isNft = a?.kind === "nft";
  $("amount-label").hidden = isNft;
  $("amount").required = !isNft;
  $("token-id-label").hidden = !isNft;
  if (isNft) {
    const sel = $("token-id-select");
    const prevKey = selectedNft(a) ? `${selectedNft(a).address}:${selectedNft(a).tokenId}` : null;
    const contracts = new Set(a.tokens.map((t) => t.address)).size;
    sel.innerHTML = "";
    a.tokens.forEach((t, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = `#${t.tokenId}${contracts > 1 ? `  (${short(t.address)})` : ""}`;
      if (`${t.address}:${t.tokenId}` === prevKey) opt.selected = true;
      sel.appendChild(opt);
    });
  }
  updateNftPreview();
  updateAmountUsd();
}

function updateAmountUsd() {
  const t = selectedAsset();
  const amount = parseFloat($("amount").value);
  const el = $("amount-usd");
  if (t?.kind === "token" && t.usd !== null && !Number.isNaN(amount) && Number(t.balance) > 0) {
    el.textContent = `≈ ${fmtUsd((amount * t.usd) / Number(t.balance))}`;
  } else {
    el.textContent = "";
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

// What the form would send right now: the asset, the request body and a label.
function pendingTransfer() {
  const a = selectedAsset();
  const recipient = finalRecipient();
  if (!a) return { error: "Pick an asset" };
  if (!recipient) return { error: "Recipient not resolved yet" };
  if (a.kind === "nft") {
    const nft = selectedNft(a);
    if (!nft) return { error: "Pick a token ID" };
    return {
      asset: { ...a, transferAllowed: nft.transferAllowed },
      recipient,
      body: { address: nft.address, tokenId: nft.tokenId, recipient },
      label: `${a.symbol} #${nft.tokenId}`,
    };
  }
  const amount = $("amount").value.trim();
  if (!amount) return { error: "Enter an amount" };
  const usd =
    a.usd !== null && Number(a.balance) > 0
      ? ` (≈ ${fmtUsd((parseFloat(amount) * a.usd) / Number(a.balance))})`
      : "";
  return { asset: a, recipient, body: { address: a.address, amount, recipient }, label: `${amount} ${a.symbol}`, usd };
}

$("send-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const p = pendingTransfer();
  if (p.error) return toast(p.error, "error");
  if (!p.asset.transferAllowed) {
    $("auth-banner").hidden = false;
    return toast(`The session cannot transfer ${p.asset.symbol} yet. Click "Authorize session" first.`, "error");
  }
  $("c-token").textContent = `${p.asset.symbol} (${p.asset.name})`;
  $("c-amount").textContent = `${p.label}${p.usd ?? ""}`;
  $("c-recipient").textContent = p.recipient;
  $("confirm-modal").showModal();
});

$("c-cancel").onclick = () => $("confirm-modal").close();

$("c-confirm").onclick = async () => {
  const p = pendingTransfer();
  $("confirm-modal").close();
  if (p.error) return toast(p.error, "error");
  const btn = $("send-btn");
  btn.disabled = true;
  btn.textContent = "Sending… (waiting for confirmation)";
  try {
    const res = await api("/api/transfer", { method: "POST", body: JSON.stringify(p.body) });
    if (res.txHash) {
      toast(
        `Sent ${p.label} ✓ <a href="https://voyager.online/tx/${res.txHash}" target="_blank" rel="noopener">View on Voyager ↗</a>`,
        "success",
        true,
      );
    } else {
      toast(`Transfer submitted (no tx hash returned)`, "success");
    }
    $("amount").value = "";
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
    btn.disabled = false;
    btn.textContent = "Send";
  }
};

$("max-btn").onclick = () => {
  const t = selectedAsset();
  if (t?.kind === "token") {
    $("amount").value = t.balance;
    updateAmountUsd();
  }
};

$("amount").addEventListener("input", updateAmountUsd);
$("token-select").addEventListener("change", updateAssetInputs);
$("token-id-select").addEventListener("change", updateNftPreview);

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
