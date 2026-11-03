import { describe, expect, it } from "vitest";
import REGISTRY from "../../open-sse/providers/registry/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import { DefaultExecutor } from "../../open-sse/executors/default.js";
import { parseModel } from "../../open-sse/services/model.js";

describe("ZRO provider", () => {
  it("registers models and routes requests with bearer authentication", () => {
    expect(REGISTRY.find((entry) => entry.id === "zro")?.category).toBe("apikey");
    expect(PROVIDERS.zro.validateUrl).toBe("https://zro.moonmath.ai/v1/models");
    expect(PROVIDER_MODELS.zro.map((model) => model.id)).toEqual([
      "auto", "deepseek-v4.1-flash", "glm-5.3", "glm-5.3-flash", "dolly1-security", "dolly2-security",
    ]);
    expect(parseModel("zro/glm-5.3")).toMatchObject({ provider: "zro", model: "glm-5.3" });

    const executor = new DefaultExecutor("zro");
    expect(executor.buildUrl("glm-5.3", true)).toBe("https://zro.moonmath.ai/v1/chat/completions");
    expect(executor.buildHeaders({ apiKey: "test-key" }).Authorization).toBe("Bearer test-key");
  });
});
