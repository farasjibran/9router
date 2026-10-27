export default {
  id: "groq",
  priority: 60,
  hasFree: true,
  alias: "groq",
  display: {
    name: "Groq",
    icon: "speed",
    color: "#F55036",
    textIcon: "GQ",
    website: "https://groq.com",
    notice: {
      apiKeyUrl: "https://console.groq.com/keys",
    },
  },
  category: "apikey",
  transport: {
    baseUrl: "https://api.groq.com/openai/v1/chat/completions",
    validateUrl: "https://api.groq.com/openai/v1/models",
    // No dedicated quota endpoint; rate-limit info rides on x-ratelimit-*
    // response headers, always included. Reuse the models list (already
    // used as validateUrl) so reading usage never costs tokens.
    usage: {
      url: "https://api.groq.com/openai/v1/models",
    },
  },
  modelsFetcher: { url: "https://api.groq.com/openai/v1/models", type: "openai" },
  models: [
    // Snapshot of https://api.groq.com/openai/v1/models (verified live). Groq
    // decommissions models aggressively — the previous list still declared
    // llama-3.3-70b-versatile, llama-4-maverick, qwen3-32b and
    // distil-whisper-large-v3-en, all of which now return 404 / decommissioned.
    { id: "openai/gpt-oss-120b", name: "GPT-OSS 120B", contextLength: 131072 },
    { id: "openai/gpt-oss-20b", name: "GPT-OSS 20B", contextLength: 131072 },
    { id: "qwen/qwen3.8-27b", name: "Qwen3.8 27B", contextLength: 131072 },
    { id: "allam-2-7b", name: "ALLaM 2 7B", contextLength: 4096 },
    { id: "openai/gpt-oss-safeguard-20b", name: "GPT-OSS Safeguard 20B", contextLength: 131072 },
    { id: "whisper-large-v3", name: "Whisper Large v3", params: ["language","response_format","temperature","prompt"], kind: "stt" },
    { id: "whisper-large-v3-turbo", name: "Whisper Large v3 Turbo", params: ["language","response_format","temperature","prompt"], kind: "stt" },
  ],
  serviceKinds: ["llm","imageToText","stt"],
  sttConfig: {
    baseUrl: "https://api.groq.com/openai/v1/audio/transcriptions",
    authType: "apikey",
    authHeader: "bearer",
    format: "openai",
  },
  features: {
    usage: true,
    usageApikey: true,
  },
};
