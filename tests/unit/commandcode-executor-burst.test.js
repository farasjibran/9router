import { describe, it, expect } from "vitest";
import { inspectAndWrapCommandCodeResponse } from "../../open-sse/executors/commandcode.js";

function ndjsonResponse(events) {
  const body = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  return new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(body));
        c.close();
      },
    }),
    { status: 200 }
  );
}

async function collectSSE(wrapped) {
  const text = await wrapped.text();
  return text
    .split("\n\n")
    .filter((l) => l.startsWith("data: ") && !l.includes("[DONE]"))
    .map((l) => JSON.parse(l.slice(6)));
}

describe("inspectAndWrapCommandCodeResponse: burst after first text-delta", () => {
  it("keeps all events that arrive in the same TCP chunk as the first text-delta", async () => {
    const wrapped = await inspectAndWrapCommandCodeResponse(
      ndjsonResponse([
        { type: "start" },
        { type: "text-start", id: "t0" },
        { type: "text-delta", text: "Hello " },
        { type: "text-delta", text: "world" },
        { type: "text-delta", text: "!" },
        { type: "finish", finishReason: "stop" },
      ]),
      "test-model"
    );

    const chunks = await collectSSE(wrapped);
    const content = chunks.map((c) => c.choices?.[0]?.delta?.content || "").join("");
    const finished = chunks.some((c) => c.choices?.[0]?.finish_reason === "stop");

    expect(content).toBe("Hello world!");
    expect(finished).toBe(true);
  });
});
