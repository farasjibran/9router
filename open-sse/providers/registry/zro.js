export default {
  id: "zro",
  alias: "zro",
  category: "apikey",
  display: {
    name: "ZRO",
    icon: "smart_toy",
    color: "#6366F1",
    textIcon: "ZR",
    website: "https://zro.moonmath.ai",
    notice: {
      apiKeyUrl: "https://zro.moonmath.ai/docs/quickstart",
    },
  },
  transport: {
    baseUrl: "https://zro.moonmath.ai/v1/chat/completions",
    validateUrl: "https://zro.moonmath.ai/v1/models",
  },
  models: [
    { id: "auto", name: "Auto" },
    { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
    { id: "glm-5.3", name: "GLM 5.3" },
    { id: "glm-5.3-flash", name: "GLM 5.3 Flash" },
    { id: "dolly1-security", name: "Dolly 1 Security" },
    { id: "dolly2-security", name: "Dolly 2 Security" },
  ],
};
