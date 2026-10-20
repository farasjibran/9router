import { describe, expect, it } from "vitest";

import { OpenCodeZenExecutor } from "open-sse/executors/opencode-zen.js";
import { translateRequest } from "open-sse/translator/index.js";

// 2026-10-20: opencode-zen + glm-5.3-flash-free answered
//   400 [unknown_parameter] invalid request body: json: unknown field "thinking"
// because the zai `thinking` object leaked onto OpenCode's chat-completions
// wire. Upstream also validates the effort enum strictly
// (none|minimal|low|medium|high|xhigh|max) — "auto" is rejected too.
describe("opencode-zen GLM free lane", () => {
  it("never sends a zai thinking object upstream", () => {
    const body = {
      model: "glm-5.3-flash-free",
      messages: [{ role: "user", content: "hi" }],
      thinking: { type: "enabled" },
    };
    const translated = translateRequest("openai", "openai", "glm-5.3-flash-free", body, true, null, "opencode-zen");
    expect(translated.thinking).toBeUndefined();
    expect(translated.enable_thinking).toBeUndefined();

    const wire = new OpenCodeZenExecutor().transformRequest("glm-5.3-flash-free", translated, true, null);
    expect(wire.thinking).toBeUndefined();
    expect(wire.reasoning_effort).not.toBe("auto");
  });

  it("drops an effort-less (auto) intent on the chat wire", () => {
    const executor = new OpenCodeZenExecutor();
    const out = executor.transformRequest(
      "glm-5.3-flash-free",
      { model: "glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }], reasoning_effort: "auto" },
      true,
      null,
    );
    expect(out.reasoning_effort).toBeUndefined();
  });

  it("keeps a concrete effort", () => {
    const executor = new OpenCodeZenExecutor();
    const out = executor.transformRequest(
      "glm-5.3-flash-free",
      { model: "glm-5.3-flash-free", messages: [{ role: "user", content: "hi" }], reasoning_effort: "high" },
      true,
      null,
    );
    expect(out.reasoning_effort).toBe("high");
  });

  it("drops an auto effort on the responses wire", () => {
    const executor = new OpenCodeZenExecutor();
    const out = executor.transformRequest(
      "muse-spark-1.3-contributor-free",
      { model: "muse-spark-1.3-contributor-free", input: [], reasoning_effort: "auto" },
      true,
      null,
    );
    expect(out.reasoning?.effort).toBeUndefined();
    expect(out.reasoning?.summary).toBe("auto");
  });
});
