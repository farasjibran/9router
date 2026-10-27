import { normalizeNousFreeModels } from "open-sse/services/nous.js";

// Free OpenCode models that don't use the "-free" id suffix
const KNOWN_FREE_OPENCODE_MODELS = ["big-pickle"];

// Upstream returns "Model is unavailable" for this id (2026-09-02) — re-enable when fixed
const DEAD_FREE_OPENCODE_MODELS = new Set(["deepseek-v4-flash-free"]);

export const FILTERS = {
  // Generic OpenAI-shaped /v1/models catalogue: { data: [{ id, name?, context_length? }] }.
  // Used by groq, tokenrouter, tokenharbor, venice, dahl, bai, perplexity-agent and
  // vercel-ai-gateway. Without this entry the route returned 400 "Unknown filter
  // type" and the provider silently showed no suggested models.
  openai: (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => typeof m?.id === "string" && m.id.trim() !== "")
      .map((m) => ({
        id: m.id,
        name: m.name || m.id,
        contextLength: Number(m.context_length ?? m.contextLength ?? m.limit?.context) || undefined,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),

  // Gemini returns { models: [{ name: "models/gemini-3.8-flash", displayName, ... }] }.
  // Strip the "models/" prefix and keep only ids that support generateContent
  // (skips embedding/tts-only entries that would fail a chat call).
  gemini: (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => typeof m?.name === "string")
      .filter((m) => !Array.isArray(m.supportedGenerationMethods) || m.supportedGenerationMethods.includes("generateContent"))
      .map((m) => ({
        id: m.name.replace(/^models\//, ""),
        name: m.displayName || m.name.replace(/^models\//, ""),
        contextLength: Number(m.inputTokenLimit) || undefined,
      }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),

  // Pollinations Classic returns a bare array of model descriptors:
  // [{ name: "openai-fast", description, tier: "anonymous", aliases: [...] }].
  // Only the anonymous tier is reachable without a Pollen key.
  "pollinations-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => typeof m?.name === "string" && (!m.tier || m.tier === "anonymous"))
      .map((m) => ({ id: m.name, name: m.description || m.name })),

  "openrouter-free": (models) =>
    models
      .filter(
        (m) =>
          m.pricing?.prompt === "0" &&
          m.pricing?.completion === "0" &&
          m.context_length >= 200000
      )
      .map((m) => ({ id: m.id, name: m.name, contextLength: m.context_length }))
      .sort((a, b) => b.contextLength - a.contextLength),

  "opencode-free": (models) =>
    models
      .filter((m) => (m.id?.endsWith("-free") || KNOWN_FREE_OPENCODE_MODELS.includes(m.id)) && !DEAD_FREE_OPENCODE_MODELS.has(m.id))
      .map((m) => ({ id: m.id, name: m.id })),

  // Go subscription catalogue — every /models id is selectable; the endpoint lane
  // per model is resolved by the family regex (see open-sse/providers/models/helpers.js)
  "opencode-go": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => typeof m?.id === "string")
      .map((m) => ({ id: m.id, name: m.id })),

  // models.dev returns a large catalog; keep only mimo models
  "mimo-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => m.id?.startsWith("mimo") || m.name?.toLowerCase().includes("mimo"))
      .map((m) => ({ id: m.id, name: m.name || m.id })),

  // MiniMax Code (mcode) live catalog: {providers:[{providerId:"minimax",
  // config:{models:{<id>:{name, limit, modalities, thinking_config}}}}]} —
  // arrives wrapped in a single-element array (see route normalization).
  "minimax-code": (raw) => {
    const env = Array.isArray(raw) ? raw[0] : raw;
    const p = (Array.isArray(env?.providers) ? env.providers : []).find((x) => x?.providerId === "minimax");
    const ms = p?.config?.models;
    if (!ms || typeof ms !== "object") return [];
    return Object.entries(ms)
      .filter(([id, m]) => typeof id === "string" && id.trim() !== "" && m && typeof m === "object")
      .map(([id, m]) => ({ id, name: m?.name || id, contextLength: Number(m?.limit?.context) || undefined }))
      .sort((a, b) => (b.contextLength || 0) - (a.contextLength || 0));
  },

  "airforce-free": (models) =>
    (Array.isArray(models) ? models : [])
      .filter((m) => (m.tier === "free" || m.id?.endsWith(":free")) && m.supports_chat === true && (!m.media_type || m.media_type === "chat" || m.media_type === "text"))
      .map((m) => ({ id: m.id, name: m.name || m.id, contextLength: m.context_length }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id))),

  "nous-free": normalizeNousFreeModels,
};
