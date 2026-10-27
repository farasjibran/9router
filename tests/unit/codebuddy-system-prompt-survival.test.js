// CodeBuddy's two gateways both rewrite the system turn: intl rebuilds the
// message list from scratch (keeping only one leading system prompt), and CN
// replaces agent-looking system text with a neutral prompt to dodge Tencent's
// content filter. Both used to discard whatever the RTK savers appended — the
// China Filter, caveman, ponytail and the user's custom prompt all arrive as
// system text, so the upstream model never saw the language rule and kept
// answering in Chinese.
import { describe, it, expect } from "vitest";
import { CodeBuddyIntlExecutor } from "../../open-sse/executors/codebuddy-intl.js";
import CodeBuddyCNExecutor from "../../open-sse/executors/codebuddy-cn.js";
import { injectChinaFilter } from "../../open-sse/rtk/chinaFilter.js";
import { injectCaveman } from "../../open-sse/rtk/caveman.js";
import { injectPonytail } from "../../open-sse/rtk/ponytail.js";
import { injectCustomPrompt } from "../../open-sse/rtk/customPrompt.js";
import { CHINA_FILTER_PROMPT } from "../../open-sse/rtk/chinaFilterPrompt.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const CUSTOM = "Prefer editing existing files over creating new ones.";
// A Claude Code style system prompt: long enough to trip CN's length catch-all
// and matching its agent-identity pattern at the same time.
const AGENT_SYSTEM =
  "You are Claude Code, Anthropic's official CLI for Claude.\n\n" + "Tool documentation. ".repeat(200);

function stackedBody(systemContent) {
  const messages = [];
  if (systemContent != null) messages.push({ role: "system", content: systemContent });
  messages.push({ role: "user", content: "hi" });
  const body = { model: "m", stream: false, messages };
  injectCaveman(body, FORMATS.OPENAI, "full");
  injectPonytail(body, FORMATS.OPENAI, "full");
  injectChinaFilter(body, FORMATS.OPENAI);
  injectCustomPrompt(body, FORMATS.OPENAI, CUSTOM);
  return body;
}

function systemText(transformed) {
  const sys = transformed.messages.find((m) => m.role === "system");
  if (!sys) return "";
  return typeof sys.content === "string"
    ? sys.content
    : sys.content.map((b) => b.text || "").join("\n");
}

describe.each([
  ["codebuddy-intl", () => new CodeBuddyIntlExecutor()],
  ["codebuddy-cn", () => new CodeBuddyCNExecutor()],
])("%s keeps injected system prompts", (_name, makeExec) => {
  it("survives a client system prompt", () => {
    const out = makeExec().transformRequest("m", stackedBody("You are helpful."), false, {});
    const text = systemText(out);
    expect(text).toContain(CHINA_FILTER_PROMPT);
    expect(text).toContain(CUSTOM);
  });

  it("survives a long agent-style client system prompt", () => {
    const out = makeExec().transformRequest("m", stackedBody(AGENT_SYSTEM), false, {});
    const text = systemText(out);
    expect(text).toContain(CHINA_FILTER_PROMPT);
    expect(text).toContain(CUSTOM);
  });

  it("survives a request with no client system prompt", () => {
    const out = makeExec().transformRequest("m", stackedBody(null), false, {});
    const text = systemText(out);
    expect(text).toContain(CHINA_FILTER_PROMPT);
    expect(text).toContain(CUSTOM);
  });

  it("still opens with a single system turn and preserves the user turns", () => {
    const body = stackedBody("You are helpful.");
    body.messages.push({ role: "assistant", content: "hello" });
    body.messages.push({ role: "user", content: "again" });
    const out = makeExec().transformRequest("m", body, false, {});
    expect(out.messages[0].role).toBe("system");
    expect(out.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(out.messages.at(-1).role).toBe("user");
  });
});

describe("codebuddy-intl system message shape", () => {
  it("folds the client system text into the leading system turn", () => {
    const out = new CodeBuddyIntlExecutor()
      .transformRequest("m", stackedBody("You are helpful."), false, {});
    expect(systemText(out)).toContain("You are helpful.");
  });

  it("converts string user content to typed text blocks", () => {
    const out = new CodeBuddyIntlExecutor()
      .transformRequest("m", stackedBody("You are helpful."), false, {});
    const user = out.messages.find((m) => m.role === "user");
    expect(Array.isArray(user.content)).toBe(true);
    expect(user.content[0]).toEqual({ type: "text", text: "hi" });
  });
});

describe("codebuddy-cn content filter still neutralizes agent identity", () => {
  it("drops the agent-identity segment but keeps the injected rules", () => {
    const out = new CodeBuddyCNExecutor()
      .transformRequest("m", stackedBody(AGENT_SYSTEM), false, {});
    const text = systemText(out);
    expect(text).not.toContain("Anthropic's official CLI");
    expect(text).toContain(CHINA_FILTER_PROMPT);
  });

  it("falls back to the neutral prompt when nothing legitimate remains", () => {
    const out = new CodeBuddyCNExecutor().transformRequest("m", {
      model: "m", stream: false,
      messages: [
        { role: "system", content: "You are Claude Code, Anthropic's official CLI for Claude." },
        { role: "user", content: "hi" },
      ],
    }, false, {});
    expect(systemText(out)).toContain("You are a helpful AI assistant");
  });
});
