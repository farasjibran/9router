import { describe, expect, it } from "vitest";
import { getExecutor } from "../../open-sse/executors/index.js";
import { OPENCODE_SESSION_RE } from "../../open-sse/executors/opencode-zen.js";

function zenExecutor() {
  const executor = getExecutor("opencode-zen");
  expect(executor.constructor.name).toBe("OpenCodeZenExecutor");
  return executor;
}

describe("OpenCode Zen free-tier routing (same v2 gate as oc/*)", () => {
  it("sends *-free models to /inference/v1", () => {
    const executor = zenExecutor();
    expect(executor.buildUrl("mimo-v2.6-flash-free")).toContain("/inference/v1/");
    expect(executor.buildUrl("muse-spark-1.3-contributor-free")).toBe(
      "https://opencode.ai/inference/v1/responses",
    );
  });

  it("keeps paid models on /zen/v1", () => {
    const executor = zenExecutor();
    expect(executor.buildUrl("gpt-5.4")).toContain("/zen/v1/");
    expect(executor.buildUrl("muse-spark-1.3")).toBe(
      "https://opencode.ai/zen/v1/responses",
    );
  });

  it("treats thinking-suffixed free models as free", () => {
    const executor = zenExecutor();
    expect(executor.buildUrl("mimo-v2.6-flash-free(high)")).toContain("/inference/v1/");
  });
});

describe("OpenCode Zen v2 headers", () => {
  it("defaults User-Agent to the v2 CLI form and replaces v1 UAs", () => {
    const executor = zenExecutor();
    expect(executor.buildHeaders({})["User-Agent"]).toBe("opencode/latest/2.0.26/cli");
    expect(
      executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/1.18.31" } })["User-Agent"],
    ).toBe("opencode/latest/2.0.26/cli");
    expect(
      executor.buildHeaders({ rawHeaders: { "user-agent": "opencode/latest/2.0.29/desktop" } })[
        "User-Agent"
      ],
    ).toBe("opencode/latest/2.0.29/desktop");
  });

  it("sends the session trio with identical values and keeps the user key", () => {
    const executor = zenExecutor();
    const headers = executor.buildHeaders({ apiKey: "zen-key-1", rawHeaders: {} });
    const session = headers["x-opencode-session"];
    expect(session).toMatch(OPENCODE_SESSION_RE);
    expect(headers["x-opencode-session-id"]).toBe(session);
    expect(headers["x-session-affinity"]).toBe(session);
    expect(headers["x-session-id"]).toBe(session);
    expect(headers["x-opencode-project"]).toBe("global");
    expect(headers["Authorization"]).toContain("zen-key-1");
    expect("x-opencode-request" in headers).toBe(false);
  });
});

describe("OpenCode Zen canonical fingerprint", () => {
  it("appends read/shell on chat and never sets tool_choice none", () => {
    const executor = zenExecutor();
    const out = executor.transformRequest("mimo-v2.6-flash-free", {
      messages: [{ role: "user", content: "hi" }],
    });
    expect(out.stream).toBe(true);
    expect(out.tool_choice).toBeUndefined();
    expect(out.tools.map((t) => t.function?.name)).toEqual(["read", "shell"]);
  });

  it("aliases caller tools that clash with fingerprint names", () => {
    const executor = zenExecutor();
    const out = executor.transformRequest("mimo-v2.6-flash-free", {
      messages: [{ role: "user", content: "hi" }],
      tools: [{ type: "function", function: { name: "shell", description: "mine" } }],
    });
    expect(out.tools.map((t) => t.function?.name)).toEqual(["shell_client", "read", "shell"]);
  });

  it("appends read/shell on responses with tool_choice auto", () => {
    const executor = zenExecutor();
    const out = executor.transformRequest(
      "muse-spark-1.3-contributor-free",
      { input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }] },
      true,
      {},
    );
    expect(out.stream).toBe(true);
    expect(out.tool_choice).toBe("auto");
    expect(out.tools.map((t) => t.name)).toEqual(["read", "shell"]);
  });
});
