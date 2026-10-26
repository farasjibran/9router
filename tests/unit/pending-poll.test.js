import { describe, it, expect } from "vitest";

// Pure unit tests with fake device-code providers: no network, no account needed.
// Regression guard for the pending branch in pollForToken(): a device provider
// reports "still waiting" as ok:false + an error code, so that branch must sit
// before the `if (result.ok)` check or `pending: true` is lost.
describe("pollForToken pending contract", () => {
  it("surfaces pending:true when a device provider answers ok:false + authorization_pending", async () => {
    const { PROVIDERS, pollForToken } = await import("@/lib/oauth/providers/index.js");
    const fake = {
      config: {},
      flowType: "device_code",
      pollToken: async () => ({ ok: false, data: { error: "authorization_pending" } }),
    };
    PROVIDERS.__fakepending = fake;
    try {
      const r = await pollForToken("__fakepending", "devcode", null, {});
      expect(r.success).toBe(false);
      expect(r.pending).toBe(true);
      expect(r.error).toBe("authorization_pending");
    } finally {
      delete PROVIDERS.__fakepending;
    }
  }, 60000);

  it("reports slow_down as not-pending (still a wait, but backed off)", async () => {
    const { PROVIDERS, pollForToken } = await import("@/lib/oauth/providers/index.js");
    PROVIDERS.__fakeslow = {
      config: {}, flowType: "device_code",
      pollToken: async () => ({ ok: false, data: { error: "slow_down" } }),
    };
    try {
      const r = await pollForToken("__fakeslow", "devcode", null, {});
      expect(r.success).toBe(false);
      expect(r.pending).toBe(false);
      expect(r.error).toBe("slow_down");
    } finally { delete PROVIDERS.__fakeslow; }
  });

  it("still reports real errors without pending", async () => {
    const { PROVIDERS, pollForToken } = await import("@/lib/oauth/providers/index.js");
    PROVIDERS.__fakeerr = {
      config: {}, flowType: "device_code",
      pollToken: async () => ({ ok: false, data: { error: "expired_token", error_description: "gone" } }),
    };
    try {
      const r = await pollForToken("__fakeerr", "devcode", null, {});
      expect(r.success).toBe(false);
      expect(r.pending).toBeUndefined();
      expect(r.error).toBe("expired_token");
      expect(r.errorDescription).toBe("gone");
    } finally { delete PROVIDERS.__fakeerr; }
  });

  it("still maps a successful grant through mapTokens", async () => {
    const { PROVIDERS, pollForToken } = await import("@/lib/oauth/providers/index.js");
    PROVIDERS.__fakeok = {
      config: {}, flowType: "device_code",
      pollToken: async () => ({ ok: true, data: { access_token: "AT", refresh_token: "RT" } }),
      mapTokens: (t) => ({ accessToken: t.access_token, refreshToken: t.refresh_token }),
    };
    try {
      const r = await pollForToken("__fakeok", "devcode", null, {});
      expect(r.success).toBe(true);
      expect(r.tokens.accessToken).toBe("AT");
    } finally { delete PROVIDERS.__fakeok; }
  });
});
