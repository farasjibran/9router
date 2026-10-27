/**
 * Token Harbor quota.
 *
 * Token Harbor has no API-key quota endpoint. `GET /api/me/free-tier` exists but
 * it is authenticated by the dashboard's Supabase session cookie
 * (`sb-auth-auth-token.0/1`), not by a `thk_live_...` key — sending the key,
 * `x-api-key`, a query param, or the Supabase access token as a Bearer all
 * return `401 {"ok":false}` while the same key is perfectly valid on
 * `/v1/models`. What Token Harbor does instead is stamp its own quota onto every
 * request it answers:
 *
 *   x-th-free-used-pct: 15                consumed share of the rolling 7d free allowance
 *   x-th-free-resets:   2026-11-03T06:49:08.976558+00:00
 *   x-th-plan:          free
 *
 * Measured behaviour of those headers:
 *   - present on 200 responses of /v1/chat/completions and /v1/messages
 *   - absent on /v1/models, on 404, on 429, and on streamed (SSE) responses
 *
 * So quota is collected two ways, both keyed on the existing API key:
 *   1. passively — capture the headers off any response that carries them and
 *      cache the snapshot on the connection (`captureTokenHarborQuota`)
 *   2. by probing — spend one `:free` request (priced at $0, so it never touches
 *      the wallet) purely to read the headers back. It does consume one request
 *      of the free allowance, so it runs only when there is no usable snapshot,
 *      or when the user explicitly refreshes.
 *
 * Because a probe is not free, it is deliberately conservative:
 *   - a snapshot is reused until the allowance window it describes ends; once
 *     its reset time has passed the numbers are wrong, not merely old (a
 *     snapshot reading "exhausted" would keep reading exhausted)
 *   - failures back off exponentially per connection — the dashboard re-reads
 *     quota every 60s, so a provider that rejects the probe would otherwise
 *     drain the allowance at a request a minute
 */

import { PROVIDERS } from "../../config/providers.js";
import { parseResetTime, fetchWithTimeout, U } from "./shared.js";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb.js";

// Header names Token Harbor stamps onto the responses it answers.
const HDR_USED_PCT = "x-th-free-used-pct";
const HDR_RESETS = "x-th-free-resets";
const HDR_PLAN = "x-th-plan";

// Label of the single quota row this provider exposes.
const QUOTA_KEY = "Free allowance (7d)";

const NO_API_KEY_MESSAGE = "Token Harbor API key not available. Add a key to view usage.";
const PROBE_BACKOFF_MESSAGE =
  "Token Harbor turns down the quota probe right now. It retries by itself in a few minutes, or press refresh to try again immediately.";

// Probe timeouts — the probe is a real completion, so give the model room, but
// never let a hung upstream hold the usage card open.
const PROBE_TIMEOUT_MS = 15000;
const MODELS_TIMEOUT_MS = 10000;

// Failed-probe backoff: 1m, 2m, 4m … capped at 1h.
const PROBE_BACKOFF_BASE_MS = 60_000;
const PROBE_BACKOFF_MAX_MS = 60 * 60_000;
const probeBackoff = new Map(); // connectionId → { failures, nextAt }

function backoffKey(connectionId) {
  return connectionId || "default";
}

function canProbe(connectionId, now = Date.now()) {
  const state = probeBackoff.get(backoffKey(connectionId));
  return !state || state.nextAt <= now;
}

function recordProbeFailure(connectionId, now = Date.now()) {
  const key = backoffKey(connectionId);
  const failures = (probeBackoff.get(key)?.failures || 0) + 1;
  const delayMs = Math.min(PROBE_BACKOFF_BASE_MS * 2 ** (failures - 1), PROBE_BACKOFF_MAX_MS);
  probeBackoff.set(key, { failures, nextAt: now + delayMs });
}

function recordProbeSuccess(connectionId) {
  probeBackoff.delete(backoffKey(connectionId));
}

/**
 * A snapshot describes one allowance window; reuse it only while that window is
 * still open. A snapshot without a reset time (paid keys that track no free
 * allowance) never goes stale — there is no percentage to get wrong.
 */
function isSnapshotStale(captured, now = Date.now()) {
  const resetMs = Date.parse(captured?.resetsAt || "");
  return Number.isFinite(resetMs) ? resetMs <= now : false;
}

// Registry is the single source for URLs and the probe preference list.
const probeModels = () => {
  const models = U("tokenharbor").probeModels;
  return Array.isArray(models) ? models : [];
};
const probeUrl = () => PROVIDERS.tokenharbor?.baseUrl;
const modelsUrl = () => PROVIDERS.tokenharbor?.validateUrl;

function clampPct(value) {
  return Math.min(100, Math.max(0, value));
}

/**
 * Read the free-tier quota headers off an upstream response.
 *
 * @param {Headers|undefined} headers
 * @returns {{plan: string|null, usedPct: number|null, resetsAt: string|null}|null}
 *   null when the response carries no quota signal at all.
 */
export function parseFreeQuotaHeaders(headers) {
  // headers.get() returns null when absent, and Number(null) is 0 (a finite
  // number) — check presence explicitly so a missing header cannot masquerade
  // as a real "0% used" reading.
  if (typeof headers?.get !== "function") return null;

  const plan = headers.get(HDR_PLAN) || null;

  const pctRaw = headers.get(HDR_USED_PCT);
  const parsedPct = pctRaw === null || pctRaw === "" ? null : Number(pctRaw);
  const usedPct = Number.isFinite(parsedPct) ? clampPct(parsedPct) : null;

  if (usedPct === null && !plan) return null;

  return {
    plan,
    usedPct,
    resetsAt: parseResetTime(headers.get(HDR_RESETS)),
  };
}

function planLabel(plan, usedPct) {
  const base = !plan
    ? "Token Harbor"
    : plan === "free"
      ? "Free tier"
      : plan.charAt(0).toUpperCase() + plan.slice(1);
  return usedPct !== null && usedPct >= 100 ? `${base} (exhausted)` : base;
}

/**
 * Shape a captured snapshot into the payload the usage API returns.
 *
 * The quota row follows the shared "percent window" convention (used/total out
 * of 100) so the dashboard's generic quota parser and progress bar need no
 * Token Harbor special case.
 *
 * @param {{usedPct: number|null, resetsAt: string|null, plan: string|null, capturedAt?: string}} captured
 * @returns {object|null}
 */
export function buildUsagePayload(captured) {
  if (!captured) return null;

  const { usedPct, resetsAt, plan, capturedAt = null } = captured;

  // Paid keys report a plan but track no free allowance.
  if (usedPct === null || usedPct === undefined) {
    return {
      plan: planLabel(plan, null),
      message:
        plan === "free"
          ? "Token Harbor reported no free-allowance usage yet."
          : `Token Harbor plan: ${plan || "unknown"}. No free allowance is tracked on this key.`,
      capturedAt,
    };
  }

  const remaining = Math.max(0, 100 - usedPct);
  return {
    plan: planLabel(plan, usedPct),
    quotas: {
      [QUOTA_KEY]: {
        used: usedPct,
        total: 100,
        remaining,
        remainingPercentage: remaining,
        resetAt: resetsAt || null,
        unlimited: false,
      },
    },
    capturedAt,
  };
}

/**
 * Cache a captured snapshot on the connection.
 *
 * Best-effort on purpose: quota bookkeeping must never break, delay, or fail
 * the request that produced the snapshot.
 *
 * @param {string|null} connectionId
 * @param {object|null} captured
 */
export async function saveTokenHarborQuota(connectionId, captured) {
  if (!connectionId || !captured) return;
  try {
    // Re-read first: updateProviderConnection merges top-level keys only, so the
    // rest of providerSpecificData has to be carried over explicitly.
    const connection = await getProviderConnectionById(connectionId);
    if (!connection) return;
    await updateProviderConnection(connectionId, {
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        tokenHarborQuota: captured,
      },
    });
  } catch (error) {
    console.warn(`[TokenHarbor] quota cache failed: ${error.message}`);
  }
}

/**
 * Passive capture — called for every successful upstream response, a no-op
 * unless Token Harbor stamped quota headers on it (i.e. a non-streamed 200).
 *
 * @param {string|null} connectionId
 * @param {Response|undefined} response
 */
export async function captureTokenHarborQuota(connectionId, response) {
  const captured = parseFreeQuotaHeaders(response?.headers);
  if (!captured) return;
  await saveTokenHarborQuota(connectionId, { ...captured, capturedAt: new Date().toISOString() });
}

/** Current `:free` model ids from the live catalogue (costs no quota). */
async function fetchFreeModelIds(apiKey, proxyOptions) {
  const url = modelsUrl();
  if (!url) return [];

  try {
    const response = await fetchWithTimeout(
      url,
      { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
      MODELS_TIMEOUT_MS,
      proxyOptions,
    );
    if (!response.ok) return [];
    const json = await response.json().catch(() => null);
    const list = Array.isArray(json?.data) ? json.data : [];
    return list
      .map((model) => model?.id)
      .filter((id) => typeof id === "string" && id.endsWith(":free"));
  } catch {
    return [];
  }
}

/**
 * Send one minimal request and read the quota headers back off its response.
 *
 * @returns {Promise<{captured?: object, error?: string, fatal?: boolean}>}
 */
async function sendProbeRequest(url, apiKey, model, proxyOptions) {
  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1,
          stream: false,
          messages: [{ role: "user", content: "quota probe" }],
        }),
      },
      PROBE_TIMEOUT_MS,
      proxyOptions,
    );

    const captured = parseFreeQuotaHeaders(response.headers);
    // Drain the body so the socket is released — only the headers are wanted.
    await response.text().catch(() => {});

    if (captured) return { captured: { ...captured, capturedAt: new Date().toISOString() } };

    if (response.status === 401 || response.status === 403) {
      return { fatal: true, error: "Token Harbor authentication failed. Check the API key." };
    }
    if (response.status === 429) {
      // Account/IP level — retrying another model would only hammer a
      // rate-limited key, so stop probing instead of walking the seed list.
      return { fatal: true, error: "Token Harbor rate-limited the quota probe (429). Try again shortly." };
    }
    if (response.status === 404) {
      return { error: `Token Harbor no longer serves ${model}.` };
    }
    if (!response.ok) {
      return { error: `Token Harbor quota probe failed (${response.status}).` };
    }
    return { error: `Token Harbor answered ${model} without quota headers.` };
  } catch (error) {
    return { fatal: true, error: `Token Harbor error: ${error.message}` };
  }
}

async function tryProbeModels(url, models, apiKey, proxyOptions) {
  let lastError = "Token Harbor quota probe failed.";
  for (const model of models) {
    const result = await sendProbeRequest(url, apiKey, model, proxyOptions);
    if (result.captured) return result;
    if (result.fatal) return result;
    lastError = result.error || lastError;
  }
  return { error: lastError };
}

/**
 * Probe the free allowance with one `:free` request.
 *
 * Seed ids come from the registry so the happy path is a single request; the
 * `:free` set rotates, so if every seed id has been retired fall back to
 * discovering one from the live catalogue.
 *
 * @returns {Promise<{captured?: object, error?: string}>}
 */
async function probeFreeQuota(apiKey, proxyOptions) {
  const url = probeUrl();
  if (!url) return { error: "Token Harbor chat URL is not configured." };

  const seeds = probeModels();
  const seedResult = await tryProbeModels(url, seeds, apiKey, proxyOptions);
  if (seedResult.captured || seedResult.fatal) return seedResult;

  const fresh = (await fetchFreeModelIds(apiKey, proxyOptions)).filter((id) => !seeds.includes(id));
  if (fresh.length === 0) return seedResult;
  return tryProbeModels(url, fresh.slice(0, 1), apiKey, proxyOptions);
}

/**
 * Token Harbor usage for the dashboard card.
 *
 * The snapshot is reused while its allowance window is open, so the 60s
 * dashboard re-read costs nothing. A probe (one `:free` request) is spent only
 * when there is nothing usable to show — no snapshot yet, or the window it
 * describes has ended — and when the user hits refresh. `force` skips both the
 * cache and the failure backoff, because an explicit click is an explicit
 * instruction.
 *
 * @param {string|null|undefined} apiKey
 * @param {object|null} proxyOptions
 * @param {{force?: boolean, connectionId?: string, providerSpecificData?: object}} [ctx]
 */
export async function getTokenHarborUsage(apiKey, proxyOptions = null, ctx = {}) {
  const { force = false, connectionId = null, providerSpecificData = null } = ctx;

  if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
    return { message: NO_API_KEY_MESSAGE };
  }

  const cached = providerSpecificData?.tokenHarborQuota;
  const needsProbe = force || !cached || isSnapshotStale(cached);
  if (!needsProbe) {
    return buildUsagePayload(cached) || { message: PROBE_BACKOFF_MESSAGE };
  }

  // A recent failure still stands — do not spend another request on it.
  if (!force && !canProbe(connectionId)) {
    return { message: PROBE_BACKOFF_MESSAGE };
  }

  const { captured, error } = await probeFreeQuota(apiKey.trim(), proxyOptions);
  if (!captured) {
    recordProbeFailure(connectionId);
    // A stale snapshot is not shown as a fallback: its window has ended, so the
    // percentage in it is wrong rather than merely old.
    return { message: error || "Token Harbor quota probe failed." };
  }

  recordProbeSuccess(connectionId);
  await saveTokenHarborQuota(connectionId, captured);
  return buildUsagePayload(captured) || { message: "No Token Harbor quota data." };
}
