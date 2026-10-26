import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchFreeLane,
  isOpencodeFreeUrl,
  resetOpenCodeTransportForTests,
} from "../../open-sse/utils/opencodeTransport.js";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const freeUrl = "https://opencode.ai/inference/v1/chat/completions";
const paidUrl = "https://opencode.ai/zen/v1/chat/completions";
const gateRejection = {
  type: "error",
  error: { type: "FreeUsageLimitError", message: "Free usage limit reached." },
};

beforeEach(() => {
  resetOpenCodeTransportForTests();
});

describe("isOpencodeFreeUrl", () => {
  it("matches only the inference lane on opencode.ai", () => {
    expect(isOpencodeFreeUrl(freeUrl)).toBe(true);
    expect(isOpencodeFreeUrl("https://opencode.ai/inference/v1/responses")).toBe(true);
    expect(isOpencodeFreeUrl(paidUrl)).toBe(false);
    expect(isOpencodeFreeUrl("https://example.com/inference/v1/chat/completions")).toBe(false);
    expect(isOpencodeFreeUrl("not a url")).toBe(false);
  });
});

describe("fetchFreeLane", () => {
  it("uses the direct fetch when the transport is disabled", async () => {
    const direct = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const viaTransport = vi.fn();

    const response = await fetchFreeLane(freeUrl, {}, null, direct, { enabled: false, viaTransport });

    expect(response.status).toBe(200);
    expect(direct).toHaveBeenCalledTimes(1);
    expect(viaTransport).not.toHaveBeenCalled();
  });

  it("keeps paid-lane traffic on the direct fetch", async () => {
    const direct = vi.fn().mockResolvedValue(jsonResponse(429, gateRejection));
    const viaTransport = vi.fn();

    const response = await fetchFreeLane(paidUrl, {}, null, direct, { enabled: true, viaTransport });

    expect(response.status).toBe(429);
    expect(viaTransport).not.toHaveBeenCalled();
  });

  it("does not touch the transport when the direct request succeeds", async () => {
    const direct = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    const viaTransport = vi.fn();

    const response = await fetchFreeLane(freeUrl, {}, null, direct, { enabled: true, viaTransport });

    expect(response.status).toBe(200);
    expect(viaTransport).not.toHaveBeenCalled();
  });

  it("replays a FreeUsageLimitError through the transport", async () => {
    const direct = vi.fn().mockResolvedValue(jsonResponse(429, gateRejection));
    const viaTransport = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));

    const response = await fetchFreeLane(freeUrl, {}, null, direct, { enabled: true, viaTransport });

    expect(response.status).toBe(200);
    expect(viaTransport).toHaveBeenCalledTimes(1);

    // Once Bun is proven, the next request skips the doomed direct attempt.
    const directAgain = vi.fn();
    const replayAgain = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));
    await fetchFreeLane(freeUrl, {}, null, directAgain, { enabled: true, viaTransport: replayAgain });
    expect(directAgain).not.toHaveBeenCalled();
    expect(replayAgain).toHaveBeenCalledTimes(1);
  });

  it("also replays a FreeTierError rejection", async () => {
    const direct = vi.fn().mockResolvedValue(jsonResponse(403, {
      type: "error",
      error: { type: "FreeTierError", message: "only from within OpenCode" },
    }));
    const viaTransport = vi.fn().mockResolvedValue(jsonResponse(200, { ok: true }));

    const response = await fetchFreeLane(freeUrl, {}, null, direct, { enabled: true, viaTransport });

    expect(response.status).toBe(200);
    expect(viaTransport).toHaveBeenCalledTimes(1);
  });

  it("returns the original rejection when the transport cannot run", async () => {
    const direct = vi.fn().mockResolvedValue(jsonResponse(429, gateRejection));
    const viaTransport = vi.fn().mockResolvedValue(null);

    const response = await fetchFreeLane(freeUrl, {}, null, direct, { enabled: true, viaTransport });

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(gateRejection);
  });

  it("passes non-gate errors through untouched", async () => {
    const direct = vi.fn().mockResolvedValue(jsonResponse(500, { error: "boom" }));
    const viaTransport = vi.fn();

    const response = await fetchFreeLane(freeUrl, {}, null, direct, { enabled: true, viaTransport });

    expect(response.status).toBe(500);
    expect(viaTransport).not.toHaveBeenCalled();
  });
});
