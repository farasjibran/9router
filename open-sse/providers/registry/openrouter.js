export default {
  id: "openrouter",
  priority: 10,
  hasFree: true,
  alias: "openrouter",
  display: {
    name: "OpenRouter",
    icon: "router",
    color: "#F97316",
    textIcon: "OR",
    website: "https://openrouter.ai",
    notice: {
      text: "Free tier: ~20 :free chat models, no credit card needed. 50 free-model requests/day (20 RPM); 1,000/day after a one-time 10-credit top-up. Free variants are rate-limited and rotate without notice.",
      apiKeyUrl: "https://openrouter.ai/settings/keys",
    },
  },
  category: "freeTier",
  authType: "apikey",
  authModes: ["apikey"],
  transport: {
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    thinkingFormat: "openai",
    headers: {
      "HTTP-Referer": "https://endpoint-proxy.local",
      "X-Title": "Endpoint Proxy",
    },
  },
  models: [
    // ── Chat (:free) — snapshot of the zero-price catalogue, verified against
    // https://openrouter.ai/api/v1/models. Roster rotates; modelsFetcher below
    // re-reads the live list and passthroughModels accepts anything newer.
    { id: "openrouter/free", name: "Free Models Router (auto)", contextLength: 200000 },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "Nemotron 3 Ultra 550B (Free)", contextLength: 1000000 },
    { id: "nvidia/nemotron-3.5-super-vl:free", name: "Nemotron 3.5 Super VL (Free)", contextLength: 1000000 },
    { id: "nvidia/nemotron-3.5-lightning:free", name: "Nemotron 3.5 Lightning (Free)", contextLength: 1000000 },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "Nemotron 3 Nano Omni 30B (Free)", contextLength: 256000 },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "Nemotron 3 Super 120B (Free)", contextLength: 262144 },
    { id: "thinkingmachines/inkling:free", name: "Inkling (Free)", contextLength: 1048576 },
    { id: "thinkingmachines/inkling-small:free", name: "Inkling Small (Free)", contextLength: 1048576 },
    { id: "google/gemma-4-31b-it:free", name: "Gemma 4 31B (Free)", contextLength: 262144 },
    { id: "google/gemma-4-26b-a4b-it:free", name: "Gemma 4 26B A4B (Free)", contextLength: 262144 },
    { id: "dots-studio/dots-3-note-preview:free", name: "Dots 3 Note Preview (Free)", contextLength: 512000 },
    { id: "xingchen-agi/xing4.0-29b-a4b:free", name: "Xing4.0 29B A4B (Free)", contextLength: 262144 },
    { id: "poolside/laguna-s-2.1:free", name: "Laguna S 2.1 (Free)", contextLength: 262144 },
    { id: "poolside/laguna-xs-2.1:free", name: "Laguna XS 2.1 (Free)", contextLength: 262144 },
    { id: "cohere/north-mini-code:free", name: "North Mini Code (Free)", contextLength: 256000 },
    { id: "recursive/flint-v1.0:free", name: "Flint v1.0 (Free)", contextLength: 262144 },
    // ── Embeddings
    { id: "openai/text-embedding-3-large", name: "OpenAI Text Embedding 3 Large", kind: "embedding" },
    { id: "openai/text-embedding-3-small", name: "OpenAI Text Embedding 3 Small", kind: "embedding" },
    { id: "openai/text-embedding-ada-002", name: "OpenAI Text Embedding Ada 002", kind: "embedding" },
    { id: "qwen/qwen3-embedding-8b", name: "Qwen3 Embedding 8B", kind: "embedding" },
    { id: "perplexity/pplx-embed-v1-4b", name: "Perplexity Embed V1 4B", kind: "embedding" },
    { id: "perplexity/pplx-embed-v1-0.6b", name: "Perplexity Embed V1 0.6B", kind: "embedding" },
    { id: "nvidia/llama-nemotron-embed-vl-1b-v2:free", name: "NVIDIA Nemotron Embed VL 1B V2 (Free)", kind: "embedding" },
    { id: "openai/gpt-4o-mini-tts", name: "GPT-4o Mini TTS", kind: "tts" },
    { id: "openai/tts-1-hd", name: "TTS-1 HD", kind: "tts" },
    { id: "openai/tts-1", name: "TTS-1", kind: "tts" },
    { id: "openai/dall-e-3", name: "DALL-E 3 (via OpenRouter)", params: ["size","quality","style","response_format"], kind: "image" },
    { id: "openai/gpt-image-1", name: "GPT Image 1 (via OpenRouter)", params: ["n","size","quality","response_format"], kind: "image" },
    { id: "google/imagen-3.0-generate-002", name: "Imagen 3 (via OpenRouter)", params: ["n","size"], kind: "image" },
    { id: "black-forest-labs/FLUX.1-schnell", name: "FLUX.1 Schnell (via OpenRouter)", params: ["n","size"], kind: "image" },
    { id: "google/veo-3.1", name: "Veo 3.1 (via OpenRouter)", params: ["duration","aspect_ratio","resolution"], kind: "video" },
    { id: "openai/sora-2-pro", name: "Sora 2 Pro (via OpenRouter)", params: ["duration","aspect_ratio","resolution"], kind: "video" },
    { id: "bytedance/seedance-2.0", name: "Seedance 2.0 (via OpenRouter)", params: ["duration","aspect_ratio","resolution"], kind: "video" },
    { id: "typesafe/jev-1.13", name: "Jev 1.13", kind: "systemone" },
  ],
  serviceKinds: ["llm","embedding","tts","imageToText","video","systemone"],
  // System One decision API (TypeSafe-compatible): https://openrouter.ai/docs/guides/community/typesafe-sdk
  systemoneConfig: {
    baseUrl: "https://openrouter.ai/api/v1/systemone",
    headers: {"HTTP-Referer":"https://endpoint-proxy.local","X-Title":"Endpoint Proxy"},
  },
  ttsConfig: {
    baseUrl: "https://openrouter.ai/api/v1/chat/completions",
    defaultModel: "openai/gpt-4o-mini-tts",
    headers: {"HTTP-Referer":"https://endpoint-proxy.local","X-Title":"Endpoint Proxy"},
  },
  embeddingConfig: {
    baseUrl: "https://openrouter.ai/api/v1/embeddings",
    authType: "apikey",
    authHeader: "bearer",
    headers: {"HTTP-Referer":"https://endpoint-proxy.local","X-Title":"Endpoint Proxy"},
  },
  imageConfig: {
    baseUrl: "https://openrouter.ai/api/v1/images/generations",
    headers: {"HTTP-Referer":"https://endpoint-proxy.local","X-Title":"Endpoint Proxy"},
  },
  // Async video jobs (POST /videos → { id, status }, GET /videos/{id} polls).
  // Docs: https://openrouter.ai/docs/api/api-reference/videos
  videoConfig: {
    baseUrl: "https://openrouter.ai/api/v1/videos",
    headers: {"HTTP-Referer":"https://endpoint-proxy.local","X-Title":"Endpoint Proxy"},
  },
  modelsFetcher: { url: "https://openrouter.ai/api/v1/models", type: "openrouter-free" },
  passthroughModels: true,
};
