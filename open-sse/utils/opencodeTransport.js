// OpenCode's free-tier gate fingerprints the TLS stack, not just the request.
// Measured on one machine with an identical method, URL, headers, body and
// session (2026-10-26):
//
//   Bun fetch / Bun node:https (BoringSSL)   -> 200
//   Node fetch / node:https / node:http2     -> 429 FreeUsageLimitError
//   wreq-js chrome_120 / chrome_146          -> 429 FreeUsageLimitError
//
// So the free lane is replayed through a loopback Bun sidecar when Bun is
// installed. Fail-open: no Bun (or a failed hop) keeps the previous direct
// behaviour instead of breaking requests.
//
// Env escapes: OPENCODE_TRANSPORT=off, OPENCODE_BUN_BIN=<path>.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { OPENCODE_TRANSPORT_CONFIG } from "../config/runtimeConfig.js";
import { getWritableDataDir } from "./writableDataDir.js";
import { dbg } from "./debugLog.js";

const SIDECAR_FILE = "opencode-transport.mjs";
const SIDECAR_HOST = "opencode.ai";
const INTERNAL_PREFIX = "x-9router-";
const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length",
]);

// The sidecar is written at runtime so standalone/CLI builds do not have to
// ship an extra asset. It binds loopback only and requires a per-process token.
const SIDECAR_SOURCE = `
const token = process.env.OPENCODE_TRANSPORT_TOKEN || "";
const HOP = new Set(${JSON.stringify([...HOP_BY_HOP])});

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 255,
  async fetch(req) {
    const incoming = new URL(req.url);
    if (incoming.pathname === "/health") return new Response("ok");
    if (req.headers.get("x-9router-token") !== token) {
      return new Response("forbidden", { status: 403 });
    }

    let target;
    try {
      target = new URL(req.headers.get("x-9router-upstream") || "");
    } catch {
      return new Response("bad upstream", { status: 400 });
    }
    if (target.protocol !== "https:" || target.hostname !== "${SIDECAR_HOST}") {
      return new Response("bad upstream", { status: 400 });
    }

    const headers = new Headers();
    for (const [key, value] of req.headers) {
      const lower = key.toLowerCase();
      if (lower.startsWith("${INTERNAL_PREFIX}") || HOP.has(lower)) continue;
      headers.set(key, value);
    }

    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
    const proxy = req.headers.get("x-9router-proxy") || undefined;
    const res = await fetch(target.toString(), {
      method: req.method,
      headers,
      body,
      redirect: "manual",
      ...(proxy ? { proxy } : {}),
    });

    const out = new Headers();
    res.headers.forEach((value, key) => {
      if (!HOP.has(key.toLowerCase())) out.set(key, value);
    });
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers: out });
  },
});

console.log("PORT=" + server.port);
process.stdin.resume();
process.stdin.on("end", () => process.exit(0));
process.stdin.on("close", () => process.exit(0));
`;

let child = null;
let port = 0;
let token = "";
let starting = null;
let lastFailureAt = 0;
let bunRequired = false;

/** The transport is pointless inside unit tests: it must never be a network hop there. */
export function isOpenCodeTransportEnabled() {
  return OPENCODE_TRANSPORT_CONFIG.enabled
    && !process.env.VITEST
    && process.env.NODE_ENV !== "test";
}

/** Only the free lane lives on /inference/v1; paid Zen traffic stays on /zen/v1. */
export function isOpencodeFreeUrl(url) {
  try {
    const parsed = new URL(String(url));
    return parsed.hostname === SIDECAR_HOST && parsed.pathname.startsWith("/inference/v1/");
  } catch {
    return false;
  }
}

async function isFreeUsageRejection(response) {
  if (!response || (response.status !== 429 && response.status !== 403)) return false;
  try {
    const text = await response.clone().text();
    return /FreeUsageLimitError|FreeTierError/.test(text);
  } catch {
    return false;
  }
}

function writeSidecarFile() {
  const dir = path.join(getWritableDataDir(), "runtime");
  const file = path.join(dir, SIDECAR_FILE);
  fs.mkdirSync(dir, { recursive: true });
  let current = "";
  try {
    current = fs.readFileSync(file, "utf8");
  } catch {
    // first run
  }
  if (current !== SIDECAR_SOURCE) fs.writeFileSync(file, SIDECAR_SOURCE);
  return file;
}

function resetSidecar(markFailure) {
  if (child) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
  child = null;
  port = 0;
  if (markFailure) lastFailureAt = Date.now();
}

function bunCandidates() {
  const list = [OPENCODE_TRANSPORT_CONFIG.bunBin];
  // A server started by a service manager often lacks ~/.bun/bin in PATH.
  if (!process.env.OPENCODE_BUN_BIN) {
    const exe = process.platform === "win32" ? "bun.exe" : "bun";
    list.push(path.join(osHomedir(), ".bun", "bin", exe));
    if (process.platform === "darwin") list.push("/opt/homebrew/bin/bun", "/usr/local/bin/bun");
    if (process.platform === "linux") list.push("/usr/local/bin/bun", "/usr/bin/bun");
  }
  return [...new Set(list)];
}

function osHomedir() {
  return process.env.HOME || process.env.USERPROFILE || "";
}

function probeBinary(bin) {
  return new Promise((resolve) => {
    const proc = spawn(bin, ["--version"], { stdio: "ignore", windowsHide: true });
    const done = (ok) => {
      clearTimeout(timer);
      resolve(ok);
    };
    const timer = setTimeout(() => {
      try {
        proc.kill();
      } catch {
        // already gone
      }
      done(false);
    }, 3000);
    timer.unref?.();
    proc.on("error", () => done(false));
    proc.on("exit", (code) => done(code === 0));
  });
}

async function resolveBunBinary() {
  for (const bin of bunCandidates()) {
    if (await probeBinary(bin)) return bin;
  }
  return null;
}

async function startSidecar() {
  const bunBin = await resolveBunBinary();
  if (!bunBin) {
    dbg("OPENCODE", "transport unavailable: no working Bun binary found");
    lastFailureAt = Date.now();
    return null;
  }
  return new Promise((resolve) => {
    let script;
    try {
      script = writeSidecarFile();
    } catch (error) {
      dbg("OPENCODE", `transport disabled: cannot write sidecar (${error.message})`);
      lastFailureAt = Date.now();
      resolve(null);
      return;
    }

    token = crypto.randomBytes(24).toString("hex");
    const proc = spawn(bunBin, [script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, OPENCODE_TRANSPORT_TOKEN: token },
    });

    let settled = false;
    let stdout = "";
    const finish = (result, reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (result) {
        child = proc;
        port = result;
        // Never keep the parent alive; the sidecar exits when our stdin pipe closes.
        proc.unref();
        proc.stdout?.unref?.();
        proc.stderr?.unref?.();
        resolve({ port, token });
      } else {
        resetSidecar(true);
        dbg("OPENCODE", `transport unavailable: ${reason}`);
        resolve(null);
      }
    };

    const timer = setTimeout(
      () => finish(null, `startup timeout after ${OPENCODE_TRANSPORT_CONFIG.startupTimeoutMs}ms`),
      OPENCODE_TRANSPORT_CONFIG.startupTimeoutMs,
    );

    proc.on("error", (error) => finish(null, error.message));
    proc.on("exit", (code) => {
      if (!settled) finish(null, `exit ${code}`);
      else if (child === proc) resetSidecar(false);
    });
    proc.stderr?.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) dbg("OPENCODE", `transport stderr: ${text.slice(0, 300)}`);
    });
    proc.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
      const match = stdout.match(/PORT=(\d+)/);
      if (match) finish(Number(match[1]), "");
    });
  });
}

async function ensureSidecar() {
  if (child && port) return { port, token };
  if (starting) return starting;
  if (Date.now() - lastFailureAt < OPENCODE_TRANSPORT_CONFIG.retryAfterFailureMs) return null;
  starting = startSidecar().finally(() => {
    starting = null;
  });
  return starting;
}

async function fetchViaTransport(url, init = {}, proxyOptions = null) {
  // A Vercel relay is a transport of its own; do not bypass it.
  if (proxyOptions?.vercelRelayUrl) return null;

  const sidecar = await ensureSidecar();
  if (!sidecar) return null;

  const headers = new Headers(init.headers || {});
  headers.delete("host");
  headers.delete("content-length");
  headers.set(`${INTERNAL_PREFIX}token`, sidecar.token);
  headers.set(`${INTERNAL_PREFIX}upstream`, String(url));
  const proxy = proxyOptions?.connectionProxyUrl;
  if (proxy) headers.set(`${INTERNAL_PREFIX}proxy`, proxy);

  try {
    return await fetch(`http://127.0.0.1:${sidecar.port}/`, {
      method: init.method || "POST",
      headers,
      body: init.body,
      signal: init.signal,
    });
  } catch (error) {
    if (init.signal?.aborted) throw error;
    dbg("OPENCODE", `transport hop failed: ${error.message}`);
    resetSidecar(true);
    return null;
  }
}

/**
 * Fetch an OpenCode free-lane request, replaying through Bun when Node's TLS
 * stack is refused.
 *
 * First request goes direct (so tests and already-working paths pay nothing).
 * A gate rejection is replayed once through the sidecar; on success the process
 * remembers Bun is required and uses it up front for the rest of the session.
 *
 * @param {string} url
 * @param {object} init - fetch init
 * @param {object|null} proxyOptions
 * @param {(url: string, init: object, proxyOptions: object|null) => Promise<Response>} direct
 * @param {object} [deps] - test seams
 * @returns {Promise<Response>}
 */
export async function fetchFreeLane(url, init, proxyOptions, direct, deps = {}) {
  const enabled = deps.enabled ?? isOpenCodeTransportEnabled();
  const viaTransport = deps.viaTransport || fetchViaTransport;
  if (!enabled || !isOpencodeFreeUrl(url)) return direct(url, init, proxyOptions);

  if (bunRequired) {
    const replayed = await viaTransport(url, init, proxyOptions);
    if (replayed) return replayed;
  }

  const response = await direct(url, init, proxyOptions);
  if (!(await isFreeUsageRejection(response))) return response;

  const replayed = await viaTransport(url, init, proxyOptions);
  if (!replayed) return response;

  bunRequired = true;
  dbg("OPENCODE", "free lane replayed through the Bun TLS transport");
  return replayed;
}

/** Test-only: clear the learned transport state. */
export function resetOpenCodeTransportForTests() {
  resetSidecar(false);
  starting = null;
  lastFailureAt = 0;
  bunRequired = false;
}
