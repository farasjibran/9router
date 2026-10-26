import crypto from "node:crypto";
import { DefaultExecutor } from "./default.js";
import { MEMORY_CONFIG } from "../config/runtimeConfig.js";
import { resolveSessionId } from "../utils/sessionManager.js";
import { isMuseSparkModel, isOpencodeFreeTierModel } from "../providers/models/helpers.js";
import { applyFingerprintTools } from "../utils/opencodeFingerprint.js";
import { fetchFreeLane } from "../utils/opencodeTransport.js";
import {
  normalizeResponsesInput,
  clampResponsesCallId,
  coerceResponsesArguments,
  coerceResponsesOutput,
} from "../translator/formats/responsesApi.js";

const SESSION_HEADER = "x-opencode-session";
const SESSION_FIELD = "_opencodeZenSession";
const MAX_SESSION_LENGTH = 256;

const ZEN_RESPONSES_BASE_URL = "https://opencode.ai/zen/v1/responses";
const INFERENCE_RESPONSES_BASE_URL = "https://opencode.ai/inference/v1/responses";
const MAX_TOOL_NAME_LEN = 128;
// OpenCode v2 UA shape: opencode/<channel>/<version>/<client>. Upstream rejects
// the v1 "opencode/1.18.x" form with 403 FreeTierError since 2026-10-14.
// Keep in step with the current CLI release (2.1.4, 2026-10-23).
const OPENCODE_UA = "opencode/latest/2.1.4/cli";
export const OPENCODE_SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
const BASE62_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function hasValidOpencodeVersion(ua) {
  const m = String(ua || "").match(/^opencode\/[a-z0-9-]+\/(\d+)\.\d+\.\d+\/[a-z0-9-]+$/i);
  return !!m && parseInt(m[1], 10) >= 2;
}

// *-free models on the keyed lane hit the same v2 free-tier gate as oc/*.
// They travel to /inference/v1; paid models stay on /zen/v1.
function toInferenceUrl(url) {
  return String(url || "").replace("opencode.ai/zen/v1/", "opencode.ai/inference/v1/");
}

function unstableRandom() {
  const bytes = crypto.randomBytes(14);
  let randomPart = "";
  for (let i = 0; i < 14; i++) {
    randomPart += BASE62_CHARS[bytes[i] % 62];
  }
  return randomPart;
}

// Session prefix = 12 hex of ~(timeMs * 0x1000 + counter), low 48 bits, like the CLI.
// Upstream decodes it and rejects a non-small counter with 403 FreeTierError
// (live probes: counter 0–16 pass, >=100 fail), so the counter must stay real.
const SESSION_PREFIX_MASK = (1n << 48n) - 1n;

function descendingTimeHex(time, counterValue) {
  return (~(BigInt(time) * 0x1000n + BigInt(counterValue)) & SESSION_PREFIX_MASK)
    .toString(16)
    .padStart(12, "0");
}

export function generateSessionId(timestamp = Date.now()) {
  return `ses_${descendingTimeHex(timestamp, 1)}${unstableRandom()}`;
}

export function generateRequestId(timestamp = Date.now()) {
  const current = BigInt(timestamp) * 0x1000n + 1n;
  const value = current;
  const time = Array.from({ length: 6 }, (_, index) =>
    Number((value >> BigInt(40 - 8 * index)) & 0xffn)
      .toString(16)
      .padStart(2, "0")
  ).join("");
  return `msg_${time}${unstableRandom()}`;
}

// Upstream decodes the prefix timestamp and rejects sessions whose time is in
// the future or older than the free-tier window (live probes: -60d passes,
// -100d and +30d answer 429). A digest-derived time is effectively random over
// 2^36 ms, so most translated ids were rejected even though the format matched.
// Mint with the current time and memoize per conversation/tool so a
// conversation keeps one stable, valid session for the cached TTL.
const translatedOpencodeSessions = new Map();
const MAX_TRANSLATED_SESSIONS = 5000;
const translatedSessionCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of translatedOpencodeSessions) {
    if (now - entry.lastUsed > MEMORY_CONFIG.sessionTtlMs) {
      translatedOpencodeSessions.delete(key);
    }
  }
}, MEMORY_CONFIG.sessionCleanupIntervalMs);
if (translatedSessionCleanup.unref) translatedSessionCleanup.unref();

export function translateSessionId(sessionId, clientTool = "") {
  if (typeof sessionId === "string" && OPENCODE_SESSION_RE.test(sessionId.trim())) {
    return sessionId.trim();
  }
  const key = `${clientTool || "generic"}\0${sessionId || ""}`;
  const existing = translatedOpencodeSessions.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.sessionId;
  }
  const translated = `ses_${descendingTimeHex(Date.now(), 1)}${unstableRandom()}`;
  if (translatedOpencodeSessions.size >= MAX_TRANSLATED_SESSIONS) {
    translatedOpencodeSessions.delete(translatedOpencodeSessions.keys().next().value);
  }
  translatedOpencodeSessions.set(key, { sessionId: translated, lastUsed: Date.now() });
  return translated;
}

function normalizeSession(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_SESSION_LENGTH) return null;
  return normalized;
}

function nativeSession(headers) {
  if (!headers || typeof headers !== "object") return null;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === SESSION_HEADER) {
      const normalized = normalizeSession(value);
      if (normalized && OPENCODE_SESSION_RE.test(normalized)) return normalized;
    }
  }
  return null;
}

function translatedSession(sessionId, clientTool) {
  return translateSessionId(sessionId, clientTool);
}

// Strip the thinking suffix "model(level)" so checks hit the base id.
function baseModelId(model) {
  return String(model || "").replace(/\([^()]+\)\s*$/, "").trim();
}

function isFreeModel(model) {
  return baseModelId(model).endsWith("-free");
}

function isResponsesModel(model) {
  return isMuseSparkModel(baseModelId(model));
}

// Flatten Chat Completions tool declarations into the Responses flat shape and
// drop hosted/nameless tools the /responses endpoint rejects.
function normalizeResponsesTools(body) {
  if (!Array.isArray(body.tools)) return;
  const validNames = new Set();
  body.tools = body.tools.filter((tool) => {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) return false;
    const fn = tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
    const rawName = typeof tool.name === "string" ? tool.name : (typeof fn?.name === "string" ? fn.name : "");
    const name = rawName.trim();
    if (!name) return false;
    const description = typeof tool.description === "string" ? tool.description : (typeof fn?.description === "string" ? fn.description : "");
    let parameters = (tool.parameters && typeof tool.parameters === "object" && !Array.isArray(tool.parameters))
      ? tool.parameters
      : (fn?.parameters && typeof fn.parameters === "object" && !Array.isArray(fn.parameters) ? fn.parameters : { type: "object", properties: {} });
    // Mirror the request translator: {type:"object"} without properties is rejected
    // by strict Responses backends, so fill in the empty properties map.
    if (parameters.type === "object" && !parameters.properties) parameters = { ...parameters, properties: {} };
    for (const k of Object.keys(tool)) delete tool[k];
    tool.type = "function";
    tool.name = name.slice(0, MAX_TOOL_NAME_LEN);
    if (description) tool.description = description;
    tool.parameters = parameters;
    validNames.add(tool.name);
    return true;
  });
  if (body.tool_choice && typeof body.tool_choice === "object" && !Array.isArray(body.tool_choice)) {
    if (body.tool_choice.type === "function") {
      const n = typeof body.tool_choice.name === "string" ? body.tool_choice.name.trim() : "";
      if (!n || !validNames.has(n)) delete body.tool_choice;
    }
  }
}

// Last line of defense for native Responses clients (sourceFormat === targetFormat
// skips translation): coerce items in place so malformed tool payloads 400 here
// with a clear shape instead of upstream as InputValidationError.
function sanitizeResponsesItems(body) {
  if (!Array.isArray(body.input)) return;
  body.input = body.input.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    // Strip prior-turn reasoning items: Muse Spark contributor models route to
    // an upstream Console backend where encrypted_content cannot be validated across
    // rotated accounts or sessions, causing 400 "reasoning encrypted_content was not issued to this caller".
    if (item.type === "reasoning") return false;
    delete item.encrypted_content;
    delete item.reasoning_encrypted_content;
    if (item.type === "function_call") {
      if (!item.name || typeof item.name !== "string" || item.name.trim() === "") return false;
      item.name = item.name.trim().slice(0, MAX_TOOL_NAME_LEN);
      item.call_id = clampResponsesCallId(item.call_id);
      item.arguments = coerceResponsesArguments(item.arguments);
      return true;
    }
    if (item.type === "function_call_output") {
      item.call_id = clampResponsesCallId(item.call_id);
      item.output = coerceResponsesOutput(item.output);
      return true;
    }
    return true;
  });
}

export class OpenCodeZenExecutor extends DefaultExecutor {
  constructor() {
    super("opencode-zen");
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    // Muse Spark lives on /responses even when a stale runtimeTransport leaks in.
    // Free models moved from /zen/v1 to /inference/v1 (OpenCode v2, same gate as
    // oc/*); paid models stay on /zen/v1.
    if (isResponsesModel(model)) {
      return isFreeModel(model) ? INFERENCE_RESPONSES_BASE_URL : ZEN_RESPONSES_BASE_URL;
    }
    const url = super.buildUrl(model, stream, urlIndex, credentials);
    return isFreeModel(model) ? toInferenceUrl(url) : url;
  }

  prepareRequestCredentials({ body, credentials, providerSessionId, clientTool } = {}) {
    const sourceCredentials = credentials || {};
    const native = nativeSession(sourceCredentials.rawHeaders);
    const resolved = normalizeSession(providerSessionId) || resolveSessionId({
      headers: sourceCredentials.rawHeaders,
      body,
      connectionId: sourceCredentials.connectionId,
      scope: "opencode-zen",
    });

    return {
      ...sourceCredentials,
      [SESSION_FIELD]: native || translatedSession(resolved, clientTool),
    };
  }

  async execute(args) {
    const credentials = this.prepareRequestCredentials(args);
    return super.execute({ ...args, credentials });
  }

  // *-free models share the oc/* free-tier gate, including its TLS check.
  // Paid /zen/v1 traffic falls through to the normal fetch.
  fetchUpstream(url, options, proxyOptions) {
    return fetchFreeLane(url, options, proxyOptions, (u, o, p) => super.fetchUpstream(u, o, p));
  }

  buildHeaders(credentials, stream = true, url, model) {
    const headers = super.buildHeaders(credentials || {}, stream, url, model);
    const raw = credentials?.rawHeaders || {};
    const lower = {};
    for (const [k, v] of Object.entries(raw)) lower[k.toLowerCase()] = v;
    const downstreamUa = lower["user-agent"] || "";
    // Free-tier gate: spoof the official client UA.
    headers["User-Agent"] = hasValidOpencodeVersion(downstreamUa) ? downstreamUa : OPENCODE_UA;
    headers["x-opencode-client"] = lower["x-opencode-client"] || "desktop";
    headers["x-opencode-project"] = lower["x-opencode-project"] || "global";
    const prepared = credentials?.[SESSION_FIELD];
    if (prepared) {
      headers[SESSION_HEADER] = prepared;
      headers["x-opencode-session-id"] = prepared;
      headers["x-session-affinity"] = prepared;
      headers["x-session-id"] = prepared;
    } else {
      const fallback = this.prepareRequestCredentials({ credentials });
      const fallbackSession = fallback[SESSION_FIELD];
      headers[SESSION_HEADER] = fallbackSession;
      headers["x-opencode-session-id"] = fallbackSession;
      headers["x-session-affinity"] = fallbackSession;
      headers["x-session-id"] = fallbackSession;
    }
    if (isOpencodeFreeTierModel(model)) {
      // Free-tier models are gated behind the attested free-tier identity even
      // on the keyed lane: a real oc_sk_* key answers 403 FreeTierError, while
      // `Bearer public` + session/request ids succeed. Paid models keep the
      // connection key untouched.
      headers["Authorization"] = "Bearer public";
      headers["x-opencode-request"] = generateRequestId();
    }
    return headers;
  }

  transformRequest(model, body, stream, credentials) {
    const out = super.transformRequest(model, body);
    // Only the free-tier gate requires the CLI `<env>` marker; paid models keep
    // their own system prompt untouched.
    const freeTier = isFreeModel(model || body?.model);
    // Free-tier gate: upstream 403s stream:false even when everything else is valid.
    if (out && typeof out === "object") out.stream = true;
    if (!isResponsesModel(model || body?.model)) {
      // OpenCode's inference service validates the effort enum strictly
      // (none|minimal|low|medium|high|xhigh|max) and answers
      // 400 "reasoning.effort: unknown variant 'auto'" otherwise. A thinking
      // intent without a level (bare thinking.enabled, Claude adaptive)
      // arrives here as "auto"; drop it so upstream picks its own default.
      // Same rule as normalizeOpencodeReasoning in the oc/* executor.
      if (out?.reasoning_effort === "auto") delete out.reasoning_effort;
      // Canonical read/shell fingerprint (same v2 gate as oc/*). The old
      // bash/glob/grep/read stubs are answered with 403 FreeTierError.
      applyFingerprintTools(out, false, { env: freeTier });
      return out;
    }
    const normalized = normalizeResponsesInput(out.input);
    if (normalized) out.input = normalized;
    if (!Array.isArray(out.input) || out.input.length === 0) {
      out.input = [{ type: "message", role: "user", content: [{ type: "input_text", text: "..." }] }];
    }
    // Responses names the output cap max_output_tokens, not max_tokens.
    if (out.max_output_tokens === undefined) {
      if (out.max_completion_tokens !== undefined) out.max_output_tokens = out.max_completion_tokens;
      else if (out.max_tokens !== undefined) out.max_output_tokens = out.max_tokens;
    }
    delete out.max_tokens;
    delete out.max_completion_tokens;
    if (out.reasoning_effort !== undefined && out.reasoning === undefined) {
      out.reasoning = { effort: out.reasoning_effort, summary: "auto" };
    }
    if (out.reasoning && typeof out.reasoning === "object" && !Array.isArray(out.reasoning)) {
      if (!out.reasoning.summary) out.reasoning.summary = "auto";
      // Same strict enum as the chat lane: "auto" is not a valid effort here.
      if (out.reasoning.effort === "auto") delete out.reasoning.effort;
    }
    delete out.reasoning_effort;
    out.stream = true;
    out.store = false;
    normalizeResponsesTools(out);
    sanitizeResponsesItems(out);
    // Fingerprint last, mirroring the oc/* executor: append canonical
    // read/shell and never default tool_choice to "none" (403 upstream).
    applyFingerprintTools(out, true, { env: freeTier });
    return out;
  }
}
