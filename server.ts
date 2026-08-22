// Controller Sender: local webapp to send ERC20 tokens from a Cartridge Controller.
// Wraps the `controller` CLI (session auth / execute) and queries balances via
// batched starknet_call JSON-RPC. Binds to localhost only.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ETH_ADDRESS,
  STRK_ADDRESS,
  getTokenList,
  normalizeAddress,
  type TokenInfo,
} from "./tokens.ts";

const APP_DIR = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(APP_DIR, "public");
const CONFIG_PATH = join(APP_DIR, "config.json");
const POLICIES_PATH = join(APP_DIR, "policies.json");

const HOST = "127.0.0.1";
const PORT = Number(process.env.PORT ?? 3210);
const CONTROLLER_BIN = process.env.CONTROLLER_BIN ?? "controller";
const CHAIN_ID = "SN_MAIN";
const RPC_URL = process.env.STARKNET_RPC ?? "https://api.cartridge.gg/x/starknet/mainnet";

// starknet_keccak of the entrypoint names (verified with starknet.js getSelectorFromName).
const SELECTOR = {
  balanceOf: "0x2e4263afad30923c891518314c3c95dbe830a16874e8abc5777a9a20b54c76e",
  decimals: "0x4c4fb1ab068f6039d5780c68dd0fa2f8742cceb3426d19667778ca7f3518a9",
  symbol: "0x216b05c387bab9ac31918a3e61672f4618601f3c598a2f3f2710f37053e1ea4",
  name: "0x361458367e696363fbcc70777d07ebbd2394e89fd0adcaf147faccd1d294d60",
};

const FELT_PRIME = 2n ** 251n + 17n * 2n ** 192n + 1n;

// ---------------------------------------------------------------------------
// App config (default recipient, custom tokens)

interface AppConfig {
  account: string;
  defaultRecipient: string | null;
  customTokens: TokenInfo[];
}

function loadConfig(): AppConfig {
  let raw: any = {};
  if (existsSync(CONFIG_PATH)) raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  return {
    account: process.env.CONTROLLER_ACCOUNT ?? String(raw.account ?? ""),
    defaultRecipient: raw.defaultRecipient ?? null,
    customTokens: Array.isArray(raw.customTokens) ? raw.customTokens : [],
  };
}

const config = loadConfig();
// Cartridge username whose controller this app operates. The CLI's --account
// label must be an existing Cartridge username; using it gives this app its own
// session storage without clobbering the default (game) session.
const ACCOUNT = config.account;
if (!ACCOUNT) {
  console.error(
    "No Cartridge username configured. Copy config.example.json to config.json and set \"account\", " +
      "or set CONTROLLER_ACCOUNT.",
  );
  process.exit(1);
}

function saveConfig(): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

// ---------------------------------------------------------------------------
// controller CLI wrapper

interface CliResult {
  status?: string;
  data?: any;
  message?: string;
  error_code?: string;
  recovery_hint?: string;
}

// The CLI emits a STREAM of pretty-printed JSON objects (progress events plus
// the final result), so split on balanced braces and parse each one.
function parseJsonObjects(text: string): any[] {
  const objs: any[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          objs.push(JSON.parse(text.slice(start, i + 1)));
        } catch {}
        start = -1;
      }
    }
  }
  return objs;
}

function interpretCliOutput(text: string): CliResult | null {
  const objs = parseJsonObjects(text ?? "").filter((o) => o && typeof o === "object");
  if (objs.length === 0) return null;
  if (objs.length === 1) return objs[0];
  const errors = objs.filter((o) => o.status === "error");
  if (errors.length > 0) return errors[errors.length - 1];
  const successes = objs.filter((o) => o.status === "success");
  if (successes.length > 0) {
    // Merge the data of all success events so fields like transaction_hash survive.
    const data = Object.assign(
      {},
      ...successes.map((o) => (o.data && typeof o.data === "object" ? o.data : {})),
    );
    return { status: "success", data };
  }
  return objs[objs.length - 1];
}

function runController(
  args: string[],
  opts: { account?: string | null; timeoutMs?: number } = {},
): Promise<CliResult> {
  const account = opts.account === undefined ? ACCOUNT : opts.account;
  const full = [...args, "--json", "--no-color", ...(account ? ["--account", account] : [])];
  return new Promise((resolvePromise) => {
    execFile(
      CONTROLLER_BIN,
      full,
      { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const parsed = interpretCliOutput(`${stdout}\n${stderr}`);
        // A terminal result is success or error; anything else means the CLI
        // died mid-stream (crash or timeout), so surface stderr and exit info instead.
        if (
          parsed &&
          typeof parsed === "object" &&
          (parsed.status === "success" || parsed.status === "error")
        ) {
          return resolvePromise(parsed);
        }
        const details = [
          parsed?.message ? `last event: ${parsed.message}` : null,
          stderr?.trim() ? `stderr: ${stderr.trim().slice(-1500)}` : null,
          err ? `process: ${err.message}` : null,
        ]
          .filter(Boolean)
          .join(" | ");
        resolvePromise({
          status: "error",
          message: details || (stdout || "controller command failed").trim().slice(0, 2000),
        });
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Session helpers

interface SenderSession {
  address: string;
  expiresAt: number;
  expiresFormatted: string;
  transferContracts: string[];
}

function extractTransferContracts(policies: string[]): string[] {
  const contracts = new Set<string>();
  for (const p of policies) {
    const idx = p.lastIndexOf(":");
    if (idx <= 0) continue;
    if (p.slice(idx + 1) === "transfer") contracts.add(normalizeAddress(p.slice(0, idx)));
  }
  return [...contracts];
}

async function getSenderSession(): Promise<SenderSession | null> {
  const res = await runController(["session", "status"]);
  const s = res.data?.session;
  if (!s?.address || s.is_expired) return null;
  return {
    address: normalizeAddress(s.address),
    expiresAt: s.expires_at,
    expiresFormatted: s.expires_at_formatted ?? "",
    transferContracts: extractTransferContracts(s.policies ?? []),
  };
}

// Before a session exists for ACCOUNT, resolve its controller address via lookup
// so balances work immediately. Callers prefer the session address when present.
let lookupAddress: string | null = null;
async function lookupControllerAddress(): Promise<string | null> {
  if (lookupAddress) return lookupAddress;
  const res = await runController(["lookup", "--usernames", ACCOUNT], { account: null });
  const addr = JSON.stringify(res.data ?? {}).match(/0x[0-9a-fA-F]{40,66}/)?.[0] ?? null;
  lookupAddress = addr ? normalizeAddress(addr) : null;
  return lookupAddress;
}

// ---------------------------------------------------------------------------
// Starknet JSON-RPC (batched starknet_call)

interface RawCall {
  to: string;
  selector: string;
  calldata: string[];
}

function rpcRequest(call: RawCall, id: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "starknet_call",
    params: {
      request: {
        contract_address: call.to,
        entry_point_selector: call.selector,
        calldata: call.calldata,
      },
      block_id: "latest",
    },
  };
}

async function rpcCalls(calls: RawCall[]): Promise<(string[] | null)[]> {
  if (calls.length === 0) return [];
  try {
    const res = await fetch(RPC_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(calls.map((c, i) => rpcRequest(c, i))),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json();
    if (Array.isArray(body)) {
      const byId = new Map(body.map((r: any) => [r.id, r]));
      return calls.map((_, i) => byId.get(i)?.result ?? null);
    }
  } catch {
    // fall through to individual requests
  }
  const out: (string[] | null)[] = new Array(calls.length).fill(null);
  const CHUNK = 20;
  for (let i = 0; i < calls.length; i += CHUNK) {
    await Promise.all(
      calls.slice(i, i + CHUNK).map(async (c, j) => {
        try {
          const res = await fetch(RPC_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(rpcRequest(c, 0)),
            signal: AbortSignal.timeout(15_000),
          });
          const body: any = await res.json();
          out[i + j] = body.result ?? null;
        } catch {
          out[i + j] = null;
        }
      }),
    );
  }
  return out;
}

function u256FromResult(result: string[] | null): bigint | null {
  if (!result || result.length === 0) return null;
  try {
    const low = BigInt(result[0]);
    const high = result.length > 1 ? BigInt(result[1]) : 0n;
    return low + (high << 128n);
  } catch {
    return null;
  }
}

function feltToString(value: bigint): string {
  let hex = value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return Buffer.from(hex, "hex").toString("utf8").replace(/\0/g, "");
}

// Handles both Cairo0 short strings (single felt) and Cairo1 ByteArray results.
function decodeStringResult(result: string[] | null): string | null {
  if (!result || result.length === 0) return null;
  try {
    if (result.length === 1) return feltToString(BigInt(result[0])) || null;
    const words = Number(BigInt(result[0]));
    if (result.length === words + 3) {
      let s = "";
      for (let i = 1; i <= words; i++) s += feltToString(BigInt(result[i]));
      if (Number(BigInt(result[words + 2])) > 0) s += feltToString(BigInt(result[words + 1]));
      return s || null;
    }
    return feltToString(BigInt(result[0])) || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tokens & balances

async function allTokens(): Promise<TokenInfo[]> {
  const list = await getTokenList();
  const byAddress = new Map(list.map((t) => [t.address, t]));
  for (const t of config.customTokens) {
    if (!byAddress.has(t.address)) byAddress.set(t.address, { ...t, custom: true });
  }
  return [...byAddress.values()];
}

interface HeldToken extends TokenInfo {
  raw: bigint;
}

async function getHeldTokens(address: string): Promise<HeldToken[]> {
  const tokens = await allTokens();
  const results = await rpcCalls(
    tokens.map((t) => ({ to: t.address, selector: SELECTOR.balanceOf, calldata: [address] })),
  );
  const held: HeldToken[] = [];
  tokens.forEach((t, i) => {
    const raw = u256FromResult(results[i]);
    if (raw === null) return;
    if (raw > 0n || t.custom) held.push({ ...t, raw });
  });
  return held;
}

function formatUnits(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const int = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int.toString();
}

function parseAmount(amount: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!m) throw new Error("Invalid amount. Use a plain decimal number.");
  const frac = m[2] ?? "";
  if (frac.replace(/0+$/, "").length > decimals) {
    throw new Error(`Too many decimal places (token has ${decimals})`);
  }
  return (
    BigInt(m[1]) * 10n ** BigInt(decimals) +
    BigInt(frac.slice(0, decimals).padEnd(decimals, "0") || "0")
  );
}

function isValidAddress(addr: string): boolean {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(addr)) return false;
  const v = BigInt(addr);
  return v > 0n && v < FELT_PRIME;
}

// ---------------------------------------------------------------------------
// Session authorization flow

interface AuthState {
  status: "idle" | "pending" | "authorized" | "failed";
  url: string | null;
  error: string | null;
}

let auth: AuthState = { status: "idle", url: null, error: null };
let authProc: ChildProcess | null = null;
let authOutput = "";

async function writePoliciesFile(): Promise<number> {
  const address = (await getSenderSession())?.address ?? (await lookupControllerAddress());
  const tokens = await allTokens();
  const include = new Map<string, TokenInfo>();
  if (address) {
    for (const t of await getHeldTokens(address)) include.set(t.address, t);
  }
  for (const t of tokens) {
    if (t.custom || t.address === ETH_ADDRESS || t.address === STRK_ADDRESS) {
      include.set(t.address, t);
    }
  }
  const contracts: Record<string, unknown> = {};
  for (const t of include.values()) {
    contracts[t.address] = {
      name: `${t.symbol} Token`,
      methods: [
        {
          name: "transfer",
          entrypoint: "transfer",
          description: `Transfer ${t.symbol} to another address`,
        },
      ],
    };
  }
  writeFileSync(POLICIES_PATH, JSON.stringify({ contracts }, null, 2));
  return include.size;
}

async function startAuth(): Promise<AuthState> {
  if (authProc) {
    authProc.kill();
    authProc = null;
  }
  const count = await writePoliciesFile();
  if (count === 0) {
    auth = { status: "failed", url: null, error: "No tokens to authorize (no balances found)" };
    return auth;
  }
  auth = { status: "pending", url: null, error: null };
  authOutput = "";
  // stdbuf: the CLI block-buffers its output when writing to a pipe, which would
  // delay the authorization URL until the process exits.
  const proc = spawn(
    "stdbuf",
    ["-o0", "-e0", CONTROLLER_BIN,
     "session", "auth", "--file", POLICIES_PATH, "--chain-id", CHAIN_ID, "--overwrite",
     "--no-color", "--account", ACCOUNT],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  authProc = proc;
  const onData = (buf: Buffer) => {
    authOutput += buf.toString();
    if (!auth.url) {
      const m = authOutput.match(/https:\/\/[^\s"']+/);
      if (m) auth.url = m[0];
    }
  };
  proc.stdout!.on("data", onData);
  proc.stderr!.on("data", onData);
  proc.on("exit", (code) => {
    if (authProc === proc) authProc = null;
    if (code === 0) {
      auth = { ...auth, status: "authorized", error: null };
    } else if (auth.status === "pending") {
      auth = { ...auth, status: "failed", error: authOutput.trim().slice(-500) || `exit code ${code}` };
    }
  });
  // Wait for the authorization URL (or an early failure), then hand it to the UI.
  const t0 = Date.now();
  while (auth.status === "pending" && !auth.url && Date.now() - t0 < 20_000) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (auth.status === "pending" && !auth.url) {
    proc.kill();
    auth = { status: "failed", url: null, error: `No authorization URL from CLI: ${authOutput.trim().slice(-500)}` };
  }
  return auth;
}

// ---------------------------------------------------------------------------
// API handlers

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(code, { "content-type": "application/json" });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolvePromise(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function cliError(res: ServerResponse, result: CliResult, fallback: string): void {
  sendJson(res, 502, {
    error: result.message || fallback,
    errorCode: result.error_code ?? null,
    recoveryHint: result.recovery_hint ?? null,
  });
}

// The API is unauthenticated, so it must only be reachable by pages served from
// this server. Rejecting a foreign Host defeats DNS rebinding; requiring JSON on
// writes forces a CORS preflight (which fails, since no CORS headers are sent)
// instead of letting any website fire a "simple" text/plain POST at /api/transfer.
function isTrustedRequest(req: IncomingMessage): boolean {
  if (req.headers.host !== `${HOST}:${PORT}` && req.headers.host !== `localhost:${PORT}`) return false;
  if (req.method === "GET") return true;
  return (req.headers["content-type"] ?? "").startsWith("application/json");
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (!isTrustedRequest(req)) return sendJson(res, 403, { error: "Cross-origin request rejected" });
  const route = `${req.method} ${url.pathname}`;

  switch (route) {
    case "GET /api/status": {
      const session = await getSenderSession();
      const address = session?.address ?? (await lookupControllerAddress());
      return sendJson(res, 200, {
        network: "mainnet",
        address,
        username: ACCOUNT,
        session: session
          ? {
              expiresAt: session.expiresAt,
              expiresFormatted: session.expiresFormatted,
              transferContracts: session.transferContracts,
            }
          : null,
        auth,
        defaultRecipient: config.defaultRecipient,
      });
    }

    case "GET /api/balances": {
      const session = await getSenderSession();
      const address = session?.address ?? (await lookupControllerAddress());
      if (!address) {
        return sendJson(res, 409, {
          error: "No controller session found. Authorize a session first.",
        });
      }
      const allowed = new Set(session?.transferContracts ?? []);
      const held = await getHeldTokens(address);
      const tokens = held
        .map((t) => {
          const balance = formatUnits(t.raw, t.decimals);
          const usd = t.usdPrice !== undefined ? Number(balance) * t.usdPrice : null;
          return {
            address: t.address,
            symbol: t.symbol,
            name: t.name,
            decimals: t.decimals,
            logoUrl: t.logoUrl ?? null,
            custom: t.custom ?? false,
            raw: t.raw.toString(),
            balance,
            usd,
            transferAllowed: allowed.has(t.address),
          };
        })
        .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0) || Number(BigInt(b.raw) - BigInt(a.raw)));
      return sendJson(res, 200, { address, tokens });
    }

    case "POST /api/auth": {
      const state = await startAuth();
      return sendJson(res, state.status === "failed" ? 502 : 200, state);
    }

    case "POST /api/transfer": {
      const body = await readBody(req);
      const tokenAddress = normalizeAddress(String(body.address ?? ""));
      const recipientInput = String(body.recipient ?? "").trim();
      const amountInput = String(body.amount ?? "").trim();

      if (!isValidAddress(recipientInput)) {
        return sendJson(res, 400, { error: "Invalid recipient address" });
      }
      const recipient = normalizeAddress(recipientInput);
      const token = (await allTokens()).find((t) => t.address === tokenAddress);
      if (!token) return sendJson(res, 400, { error: "Unknown token" });

      let raw: bigint;
      try {
        raw = parseAmount(amountInput, token.decimals);
      } catch (err) {
        return sendJson(res, 400, { error: (err as Error).message });
      }
      if (raw <= 0n) return sendJson(res, 400, { error: "Amount must be greater than zero" });

      const session = await getSenderSession();
      if (!session) {
        return sendJson(res, 409, { needsReauth: true, error: "No active sender session" });
      }
      if (!session.transferContracts.includes(token.address)) {
        return sendJson(res, 409, {
          needsReauth: true,
          error: `The session has no transfer permission for ${token.symbol}. Re-authorize.`,
        });
      }

      // Always self-pay gas. The paymaster does not subsidize most plain transfers.
      const result = await runController(
        ["execute", token.address, "transfer", `${recipient},u256:${raw}`,
         "--wait", "--timeout", "120", "--chain-id", CHAIN_ID, "--no-paymaster"],
        { timeoutMs: 180_000 },
      );
      if (result.status !== "success") {
        console.error(
          `[${new Date().toISOString()}] [transfer FAILED] ${amountInput} ${token.symbol} -> ${recipient}\n`,
          JSON.stringify(result, null, 2),
        );
        return cliError(res, result, "Transfer failed");
      }
      const dataStr = JSON.stringify(result.data ?? {});
      const txHash =
        result.data?.transaction_hash ??
        result.data?.tx_hash ??
        dataStr.match(/0x[0-9a-fA-F]{50,66}/)?.[0] ??
        null;
      console.log(
        `[${new Date().toISOString()}] [transfer OK] ${amountInput} ${token.symbol} -> ${recipient} tx=${txHash}`,
      );
      return sendJson(res, 200, { txHash, data: result.data ?? null });
    }

    case "GET /api/lookup": {
      const username = (url.searchParams.get("username") ?? "").trim().replace(/^@/, "");
      if (!/^[a-zA-Z0-9._-]{1,40}$/.test(username)) {
        return sendJson(res, 400, { error: "Invalid username" });
      }
      const result = await runController(["lookup", "--usernames", username], { account: null });
      if (result.status !== "success") return cliError(res, result, "Lookup failed");
      const address = JSON.stringify(result.data ?? {}).match(/0x[0-9a-fA-F]{40,66}/)?.[0] ?? null;
      return sendJson(res, 200, { username, address: address ? normalizeAddress(address) : null });
    }

    case "POST /api/tokens": {
      const body = await readBody(req);
      const input = String(body.address ?? "").trim();
      if (!isValidAddress(input)) return sendJson(res, 400, { error: "Invalid token address" });
      const address = normalizeAddress(input);
      if ((await allTokens()).some((t) => t.address === address)) {
        return sendJson(res, 409, { error: "Token already in the list" });
      }
      const [symbolRes, nameRes, decimalsRes] = await rpcCalls([
        { to: address, selector: SELECTOR.symbol, calldata: [] },
        { to: address, selector: SELECTOR.name, calldata: [] },
        { to: address, selector: SELECTOR.decimals, calldata: [] },
      ]);
      const decimals = decimalsRes?.[0] !== undefined ? Number(BigInt(decimalsRes[0])) : null;
      if (decimals === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        return sendJson(res, 400, {
          error: "Could not read decimals(). Is this an ERC20 contract on mainnet?",
        });
      }
      const token: TokenInfo = {
        address,
        symbol: decodeStringResult(symbolRes) ?? "???",
        name: decodeStringResult(nameRes) ?? "Unknown token",
        decimals,
        custom: true,
      };
      config.customTokens.push(token);
      saveConfig();
      return sendJson(res, 200, { token, needsReauth: true });
    }

    case "GET /api/settings":
      return sendJson(res, 200, { defaultRecipient: config.defaultRecipient });

    case "POST /api/settings": {
      const body = await readBody(req);
      const recipient = String(body.defaultRecipient ?? "").trim();
      if (recipient && !isValidAddress(recipient)) {
        return sendJson(res, 400, { error: "Invalid recipient address" });
      }
      config.defaultRecipient = recipient ? normalizeAddress(recipient) : null;
      saveConfig();
      return sendJson(res, 200, { defaultRecipient: config.defaultRecipient });
    }

    default:
      return sendJson(res, 404, { error: `No route: ${route}` });
  }
}

// ---------------------------------------------------------------------------
// Static files

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

async function serveStatic(pathname: string, res: ServerResponse): Promise<void> {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + sep)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const content = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(content);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
    else await serveStatic(url.pathname, res);
  } catch (err) {
    if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Controller Sender running → http://${HOST}:${PORT}`);
});

// Don't leave a `controller session auth` child waiting for approval after the server is gone.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    authProc?.kill();
    process.exit(0);
  });
}
