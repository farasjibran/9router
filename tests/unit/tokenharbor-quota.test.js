/**
 * Token Harbor quota tracker.
 *
 * Token Harbor exposes no API-key quota endpoint (the dashboard's
 * /api/me/free-tier is Supabase-session-cookie authenticated and answers 401 to
 * a thk_live_ key). Quota therefore comes off the provider's own response
 * headers, captured passively and re-probed only on an explicit refresh.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(),
}));

vi.mock("@/lib/localDb.js", () => ({
  getProviderConnectionById: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

import { proxyAwareFetch } from "../../open-sse/utils/proxyFetch.js";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb.js";
import { getUsageForProvider } from "../../open-sse/services/usage.js";
import {
  parseFreeQuotaHeaders,
  buildUsagePayload,
  captureTokenHarborQuota,
} from "../../open-sse/services/usage/tokenharbor.js";
import { captureQuotaFromResponse } from "../../open-sse/services/usage/capture.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";
import {
  USAGE_SUPPORTED_PROVIDERS,
  USAGE_APIKEY_PROVIDERS,
} from "../../src/shared/constants/providers.js";
import { parseQuotaData } from "../../src/app/(dashboard)/dashboard/usage/components/ProviderLimits/utils.js";

const CHAT_URL = "https://tokenharbor.ai/v1/chat/completions";
const MODELS_URL = "https://tokenharbor.ai/v1/models";
const RESETS = "2026-11-03T06:49:08.976558+00:00";

function quotaResponse({ status = 200, body = { ok: true }, pct, resets = RESETS, plan = "free" } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (pct !== undefined) headers["x-th-free-used-pct"] = String(pct);
  if (resets !== null) headers["x-th-free-resets"] = resets;
  if (plan !== null) headers["x-th-plan"] = plan;
  return new Response(JSON.stringify(body), { status, headers });
}

function headersOf(pairs) {
  return new Headers(pairs);
}

describe("tokenharbor registry usage flags", () => {
  it("is listed for the apikey quota dashboard", () => {
    expect(USAGE_SUPPORTED_PROVIDERS).toContain("tokenharbor");
    expect(USAGE_APIKEY_PROVIDERS).toContain("tokenharbor");
  });

  it("probes only :free models, so a refresh never bills the wallet", () => {
    const probes = PROVIDERS.tokenharbor.usage.probeModels;
    expect(probes.length).toBeGreaterThan(0);
    expect(probes.every((id) => id.endsWith(":free"))).toBe(true);
  });
});

describe("parseFreeQuotaHeaders", () => {
  it("reads the used pct, reset and plan", () => {
    const parsed = parseFreeQuotaHeaders(
      headersOf({ "x-th-free-used-pct": "19", "x-th-free-resets": RESETS, "x-th-plan": "free" }),
    );
    expect(parsed.usedPct).toBe(19);
    expect(parsed.plan).toBe("free");
    expect(parsed.resetsAt).toBe("2026-11-03T06:49:08.976Z");
  });

  it("returns null when the response carries no quota signal", () => {
    expect(parseFreeQuotaHeaders(headersOf({ "content-type": "application/json" }))).toBeNull();
    expect(parseFreeQuotaHeaders(undefined)).toBeNull();
    expect(parseFreeQuotaHeaders({})).toBeNull();
  });

  it("keeps the plan when a paid key reports no free allowance", () => {
    const parsed = parseFreeQuotaHeaders(headersOf({ "x-th-plan": "agent" }));
    expect(parsed).toMatchObject({ plan: "agent", usedPct: null, resetsAt: null });
  });

  it("treats a missing pct as unknown rather than 0% used", () => {
    // Number(null) is 0 — a naive parse would report a healthy "0% used" quota.
    expect(parseFreeQuotaHeaders(headersOf({ "x-th-plan": "free" })).usedPct).toBeNull();
    expect(
      parseFreeQuotaHeaders(headersOf({ "x-th-free-used-pct": "abc", "x-th-plan": "free" })).usedPct,
    ).toBeNull();
    // Nothing usable at all — not a quota response.
    expect(parseFreeQuotaHeaders(headersOf({ "x-th-free-used-pct": "" }))).toBeNull();
    expect(parseFreeQuotaHeaders(headersOf({ "x-th-free-used-pct": "abc" }))).toBeNull();
  });

  it("clamps the percentage into 0-100", () => {
    expect(parseFreeQuotaHeaders(headersOf({ "x-th-free-used-pct": "140" })).usedPct).toBe(100);
    expect(parseFreeQuotaHeaders(headersOf({ "x-th-free-used-pct": "-5" })).usedPct).toBe(0);
  });
});

describe("buildUsagePayload", () => {
  const captured = { usedPct: 15, resetsAt: "2026-11-03T06:49:08.976Z", plan: "free" };

  it("shapes the free allowance as a percent window", () => {
    const payload = buildUsagePayload(captured);
    expect(payload.plan).toBe("Free tier");
    expect(payload.quotas["Free allowance (7d)"]).toMatchObject({
      used: 15,
      total: 100,
      remaining: 85,
      remainingPercentage: 85,
      resetAt: "2026-11-03T06:49:08.976Z",
      unlimited: false,
    });
  });

  it("flags an exhausted allowance in the plan label", () => {
    expect(buildUsagePayload({ ...captured, usedPct: 100 }).plan).toBe("Free tier (exhausted)");
  });

  it("reports a plan-only message when no allowance is tracked", () => {
    const payload = buildUsagePayload({ usedPct: null, resetsAt: null, plan: "agent" });
    expect(payload.quotas).toBeUndefined();
    expect(payload.plan).toBe("Agent");
    expect(payload.message).toMatch(/No free allowance/);
  });

  it("returns null for an empty snapshot", () => {
    expect(buildUsagePayload(null)).toBeNull();
  });

  it("survives the dashboard's generic quota parser", () => {
    const rows = parseQuotaData("tokenharbor", buildUsagePayload(captured));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Free allowance (7d)", used: 15, total: 100 });
  });
});

describe("getUsageForProvider(tokenharbor)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    updateProviderConnection.mockResolvedValue({});
    getProviderConnectionById.mockResolvedValue({ id: "conn-1", providerSpecificData: {} });
  });

  const connection = (providerSpecificData = {}, id = "conn-1") => ({
    id,
    provider: "tokenharbor",
    apiKey: "thk_live_test",
    providerSpecificData,
  });

  const snapshot = (usedPct, resetsAt) => ({ tokenHarborQuota: { usedPct, resetsAt, plan: "free" } });
  const inHours = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();

  it("replays the cached snapshot without spending a request", async () => {
    const usage = await getUsageForProvider(
      connection(snapshot(42, inHours(6))),
      null,
    );

    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(usage.quotas["Free allowance (7d)"].used).toBe(42);
  });

  it("probes automatically on the first read, so the card works without a manual refresh", async () => {
    proxyAwareFetch.mockResolvedValueOnce(quotaResponse({ pct: 19 }));

    const usage = await getUsageForProvider(connection({}, "conn-first"), null);

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(usage.quotas["Free allowance (7d)"].used).toBe(19);
  });

  it("re-probes once the cached window has ended, instead of showing an obsolete percentage", async () => {
    proxyAwareFetch.mockResolvedValueOnce(quotaResponse({ pct: 3 }));

    const usage = await getUsageForProvider(
      // Window already reset: the old "exhausted" reading is wrong, not old.
      connection(snapshot(100, inHours(-1)), "conn-window"),
      null,
    );

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(usage.quotas["Free allowance (7d)"].used).toBe(3);
  });

  it("backs a failing probe off instead of draining the allowance on every re-read", async () => {
    // The dashboard re-reads quota every 60s without force.
    proxyAwareFetch.mockResolvedValue(new Response("{}", { status: 429 }));

    const first = await getUsageForProvider(connection({}, "conn-backoff"), null);
    expect(first.message).toMatch(/429/);

    proxyAwareFetch.mockClear();
    const second = await getUsageForProvider(connection({}, "conn-backoff"), null);

    expect(proxyAwareFetch).not.toHaveBeenCalled();
    expect(second.message).toMatch(/retries by itself/);
  });

  it("lets an explicit refresh bypass the backoff", async () => {
    proxyAwareFetch.mockResolvedValue(new Response("{}", { status: 429 }));
    await getUsageForProvider(connection({}, "conn-forced"), null);

    proxyAwareFetch.mockClear();
    proxyAwareFetch.mockResolvedValueOnce(quotaResponse({ pct: 7 }));
    const usage = await getUsageForProvider(connection({}, "conn-forced"), null, { force: true });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(usage.quotas["Free allowance (7d)"].used).toBe(7);
  });

  it("clears the backoff once a probe succeeds", async () => {
    proxyAwareFetch.mockResolvedValue(new Response("{}", { status: 429 }));
    await getUsageForProvider(connection({}, "conn-recover"), null);

    proxyAwareFetch.mockResolvedValueOnce(quotaResponse({ pct: 11 }));
    await getUsageForProvider(connection({}, "conn-recover"), null, { force: true });

    proxyAwareFetch.mockClear();
    proxyAwareFetch.mockResolvedValueOnce(quotaResponse({ pct: 12 }));
    // Still nothing cached here, so a plain re-read proves the backoff is gone.
    const usage = await getUsageForProvider(connection({}, "conn-recover"), null);

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(usage.quotas["Free allowance (7d)"].used).toBe(12);
  });

  it("probes with one :free request on force and caches the result", async () => {
    proxyAwareFetch.mockResolvedValueOnce(quotaResponse({ pct: 19 }));

    const usage = await getUsageForProvider(connection(), null, { force: true });

    const [url, options] = proxyAwareFetch.mock.calls[0];
    expect(url).toBe(CHAT_URL);
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer thk_live_test");

    const body = JSON.parse(options.body);
    expect(body.max_tokens).toBe(1);
    expect(body.stream).toBe(false);
    expect(body.model).toBe(PROVIDERS.tokenharbor.usage.probeModels[0]);

    expect(usage.quotas["Free allowance (7d)"]).toMatchObject({ used: 19, total: 100 });
    expect(updateProviderConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({
        providerSpecificData: expect.objectContaining({
          tokenHarborQuota: expect.objectContaining({ usedPct: 19, plan: "free" }),
        }),
      }),
    );
  });

  it("preserves the rest of providerSpecificData when caching", async () => {
    proxyAwareFetch.mockResolvedValueOnce(quotaResponse({ pct: 5 }));
    getProviderConnectionById.mockResolvedValue({
      id: "conn-1",
      providerSpecificData: { baseUrl: "https://custom.example/v1", keepMe: true },
    });

    await getUsageForProvider(connection(), null, { force: true });

    const update = updateProviderConnection.mock.calls[0][1];
    expect(update.providerSpecificData).toMatchObject({
      baseUrl: "https://custom.example/v1",
      keepMe: true,
    });
    expect(update.providerSpecificData.tokenHarborQuota.usedPct).toBe(5);
  });

  it("reports an invalid key as fatal without burning the other probes", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response("{}", { status: 401 }));

    const usage = await getUsageForProvider(connection(), null, { force: true });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(usage.message).toMatch(/authentication failed/);
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("falls back to the live catalogue when every seeded :free id was retired", async () => {
    for (let i = 0; i < PROVIDERS.tokenharbor.usage.probeModels.length; i++) {
      proxyAwareFetch.mockResolvedValueOnce(new Response("{}", { status: 404 }));
    }
    proxyAwareFetch.mockResolvedValueOnce(
      quotaResponse({ body: { data: [{ id: "rotated-v9:free" }] } }),
    );
    proxyAwareFetch.mockResolvedValueOnce(quotaResponse({ pct: 100 }));

    const usage = await getUsageForProvider(connection(), null, { force: true });

    const [modelsUrl, modelsOptions] = proxyAwareFetch.mock.calls[PROVIDERS.tokenharbor.usage.probeModels.length];
    expect(modelsUrl).toBe(MODELS_URL);
    expect(modelsOptions.headers.Authorization).toBe("Bearer thk_live_test");
    expect(JSON.parse(proxyAwareFetch.mock.calls.at(-1)[1].body).model).toBe("rotated-v9:free");
    expect(usage.plan).toBe("Free tier (exhausted)");
    expect(usage.quotas["Free allowance (7d)"].used).toBe(100);
  });

  it("reports a rate-limited probe instead of silently showing stale data", async () => {
    proxyAwareFetch.mockResolvedValueOnce(new Response("{}", { status: 429 }));

    const usage = await getUsageForProvider(connection(), null, { force: true });

    expect(usage.message).toMatch(/429/);
    // A 429 is account-level: do not walk the remaining seed models.
    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
  });

  it("asks for a key when none is stored", async () => {
    const usage = await getUsageForProvider(
      { id: "conn-1", provider: "tokenharbor", providerSpecificData: {} },
      null,
      { force: true },
    );

    expect(usage.message).toMatch(/API key not available/);
    expect(proxyAwareFetch).not.toHaveBeenCalled();
  });
});

describe("passive quota capture", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    updateProviderConnection.mockResolvedValue({});
    getProviderConnectionById.mockResolvedValue({ id: "conn-1", providerSpecificData: {} });
  });

  it("stores the headers of a response that carries them", async () => {
    await captureTokenHarborQuota("conn-1", quotaResponse({ pct: 33 }));

    expect(updateProviderConnection).toHaveBeenCalledWith(
      "conn-1",
      expect.objectContaining({
        providerSpecificData: {
          tokenHarborQuota: expect.objectContaining({ usedPct: 33, plan: "free" }),
        },
      }),
    );
  });

  it("does nothing for a streamed response (no quota headers)", async () => {
    await captureTokenHarborQuota(
      "conn-1",
      new Response("data: {}\n\n", { headers: { "Content-Type": "text/event-stream" } }),
    );

    expect(updateProviderConnection).not.toHaveBeenCalled();
  });

  it("never throws when the cache write fails", async () => {
    updateProviderConnection.mockRejectedValue(new Error("db down"));

    await expect(captureTokenHarborQuota("conn-1", quotaResponse({ pct: 33 }))).resolves.toBeUndefined();
  });

  it("dispatches only for providers with a capturer, and without awaiting the caller", () => {
    expect(() =>
      captureQuotaFromResponse({
        provider: "deepseek",
        connectionId: "conn-1",
        response: quotaResponse({ pct: 33 }),
      }),
    ).not.toThrow();

    captureQuotaFromResponse({
      provider: "tokenharbor",
      connectionId: "conn-1",
      response: quotaResponse({ pct: 33 }),
    });

    // Detached: the request path must not wait on the DB write.
    expect(updateProviderConnection).not.toHaveBeenCalled();
  });
});
