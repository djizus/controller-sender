const $ = (id) => document.getElementById(id);

const state = {
  status: null,
  tokens: [],
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
          updateAmountUsd();
        };
        box.appendChild(row);
      }
      $("total-usd").textContent = total > 0 ? `≈ ${fmtUsd(total)}` : "";
    }
    renderTokenSelect();
  } catch (err) {
    box.innerHTML = `<p class="muted">${err.message}</p>`;
  }
}

function renderTokenSelect() {
  const sel = $("token-select");
  const prev = sel.value;
  sel.innerHTML = "";
  for (const t of state.tokens) {
    const opt = document.createElement("option");
    opt.value = t.address;
    opt.textContent = `${t.symbol}  ${fmtBalance(t.balance)}`;
    sel.appendChild(opt);
  }
  if (prev && state.tokens.some((t) => t.address === prev)) sel.value = prev;
  updateAmountUsd();
}

function selectedToken() {
  return state.tokens.find((t) => t.address === $("token-select").value) ?? null;
}

function updateAmountUsd() {
  const t = selectedToken();
  const amount = parseFloat($("amount").value);
  const el = $("amount-usd");
  if (t && t.usd !== null && !Number.isNaN(amount) && Number(t.balance) > 0) {
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

$("send-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const t = selectedToken();
  const recipient = finalRecipient();
  const amount = $("amount").value.trim();
  if (!t) return toast("Pick a token", "error");
  if (!recipient) return toast("Recipient not resolved yet", "error");
  if (!amount) return toast("Enter an amount", "error");
  if (!t.transferAllowed) {
    $("auth-banner").hidden = false;
    return toast(`The session cannot transfer ${t.symbol} yet. Click "Authorize session" first.`, "error");
  }
  $("c-token").textContent = `${t.symbol} (${t.name})`;
  $("c-amount").textContent = `${amount} ${t.symbol}${
    t.usd !== null && Number(t.balance) > 0
      ? ` (≈ ${fmtUsd((parseFloat(amount) * t.usd) / Number(t.balance))})`
      : ""
  }`;
  $("c-recipient").textContent = recipient;
  $("confirm-modal").showModal();
});

$("c-cancel").onclick = () => $("confirm-modal").close();

$("c-confirm").onclick = async () => {
  const t = selectedToken();
  const recipient = finalRecipient();
  const amount = $("amount").value.trim();
  $("confirm-modal").close();
  const btn = $("send-btn");
  btn.disabled = true;
  btn.textContent = "Sending… (waiting for confirmation)";
  try {
    const res = await api("/api/transfer", {
      method: "POST",
      body: JSON.stringify({ address: t.address, amount, recipient }),
    });
    if (res.txHash) {
      toast(
        `Sent ${amount} ${t.symbol} ✓ <a href="https://voyager.online/tx/${res.txHash}" target="_blank" rel="noopener">View on Voyager ↗</a>`,
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
  const t = selectedToken();
  if (t) {
    $("amount").value = t.balance;
    updateAmountUsd();
  }
};

$("amount").addEventListener("input", updateAmountUsd);
$("token-select").addEventListener("change", updateAmountUsd);

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
