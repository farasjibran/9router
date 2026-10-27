export default {
  id: "pollinations",
  priority: 200,
  hasFree: true,
  alias: "poll",
  aliases: ["pollinations-ai"],
  uiAlias: "poll",
  display: {
    name: "Pollinations",
    icon: "local_florist",
    color: "#FF6B35",
    textIcon: "PL",
    website: "https://pollinations.ai",
    notice: {
      text: "Keyless emergency fallback — no signup, no API key. Classic API exposes a single text model (openai-fast, GPT-OSS 20B on OVH) and is rate-limited to roughly one request per 15-30s per IP, best-effort. For every model and higher limits use a Pollen key from enter.pollinations.ai.",
      signupUrl: "https://enter.pollinations.ai",
    },
  },
  category: "free",
  authType: "none",
  noAuth: true,
  transport: {
    baseUrl: "https://text.pollinations.ai/openai",
    // Pollinations ignores Authorization entirely (verified: no header, empty
    // header and Bearer public all return 200), so the virtual "public"
    // credential injected by auth.js for noAuth providers is harmless here.
    validateUrl: "https://text.pollinations.ai/models",
  },
  models: [
    // Classic API anonymous tier currently advertises exactly one text model.
    // The upstream alias set (openai / gpt-oss / gpt-oss-20b / ovh-reasoning)
    // all resolve to the same endpoint.
    { id: "openai-fast", name: "GPT-OSS 20B (OVH) — Free", contextLength: 131072 },
  ],
  modelsFetcher: { url: "https://text.pollinations.ai/models", type: "pollinations-free" },
};
