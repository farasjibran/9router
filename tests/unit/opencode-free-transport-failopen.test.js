// The free lane needs a TLS ClientHello the upstream accepts. Two layers cover
// it: services/opencodeTlsClient.js (wreq-js, impersonating cipher list) on the
// direct path, and a Bun sidecar replay in utils/opencodeTransport.js for the
// case the upstream still answers 429/403.
//
// Both layers must be fail-open: a missing optional dependency or a missing Bun
// binary degrades to native fetch instead of breaking the request outright.
// These tests pin that wiring without touching the network.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { tlsFetchMock, freeLaneMock } = vi.hoisted(() => ({
  tlsFetchMock: vi.fn(),
  freeLaneMock: vi.fn(),
}));

vi.mock("../../open-sse/services/opencodeTlsClient.js", async () => {
  const actual = await vi.importActual("../../open-sse/services/opencodeTlsClient.js");
  return { ...actual, opencodeTlsFetch: tlsFetchMock };
});

vi.mock("../../open-sse/utils/opencodeTransport.js", async () => {
  const actual = await vi.importActual("../../open-sse/utils/opencodeTransport.js");
  return { ...actual, fetchFreeLane: freeLaneMock };
});

const { OpenCodeExecutor } = await import("../../open-sse/executors/opencode.js");
const { OpencodeTlsUnavailableError } = await import("../../open-sse/services/opencodeTlsClient.js");

/** Capture the `directFetch` the executor hands to BaseExecutor.execute. */
function captureDirectFetch(executor) {
  let captured = null;
  const superExecute = vi
    .spyOn(Object.getPrototypeOf(OpenCodeExecutor.prototype), "execute")
    .mockImplementation(async (args) => {
      captured = args.directFetch;
      return { response: new Response("ok"), url: "https://opencode.ai/x", headers: {}, transformedBody: {} };
    });
  return { run: () => executor.execute({ model: "x", body: {}, credentials: {} }), get: () => captured, superExecute };
}

describe("OpenCode free-lane transport fail-open", () => {
  beforeEach(() => {
    tlsFetchMock.mockReset();
    freeLaneMock.mockReset();
  });

  it("falls back to native fetch when wreq-js is unavailable", async () => {
    const executor = new OpenCodeExecutor();
    const { run, get, superExecute } = captureDirectFetch(executor);
    try {
      await run();
      const directFetch = get();
      expect(typeof directFetch).toBe("function");

      tlsFetchMock.mockRejectedValue(new OpencodeTlsUnavailableError("wreq-js unavailable"));
      const nativeFetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("native"));

      const response = await directFetch("https://opencode.ai/inference/v1/chat/completions", {
        method: "POST",
        headers: {},
        body: "{}",
      });

      expect(nativeFetch).toHaveBeenCalledTimes(1);
      expect(await response.text()).toBe("native");
      nativeFetch.mockRestore();
    } finally {
      superExecute.mockRestore();
    }
  });

  it("does not swallow unrelated TLS client errors", async () => {
    const executor = new OpenCodeExecutor();
    const { run, get, superExecute } = captureDirectFetch(executor);
    try {
      await run();
      const directFetch = get();
      tlsFetchMock.mockRejectedValue(new Error("boom"));

      await expect(directFetch("https://opencode.ai/x", { method: "POST" })).rejects.toThrow("boom");
    } finally {
      superExecute.mockRestore();
    }
  });

  it("routes the free lane through the Bun sidecar replay hook", async () => {
    const executor = new OpenCodeExecutor();
    freeLaneMock.mockResolvedValue(new Response("replayed"));

    const response = await executor.fetchUpstream("https://opencode.ai/inference/v1/chat/completions", {}, null);

    // fetchFreeLane is the seam; the executor must not bypass it with a plain fetch.
    expect(freeLaneMock).toHaveBeenCalledTimes(1);
    const [, , , directArg] = freeLaneMock.mock.calls[0];
    expect(typeof directArg).toBe("function");
    expect(await response.text()).toBe("replayed");
  });
});
