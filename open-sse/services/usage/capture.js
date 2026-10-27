/**
 * Passive quota capture.
 *
 * The sibling of USAGE_HANDLERS in services/usage.js: some providers expose no
 * pullable quota endpoint and instead stamp quota onto the responses they
 * return. A capturer inspects the upstream response of a live request and
 * persists whatever quota signal it carries, so that provider's usage card can
 * still fill in.
 *
 * Capturers run detached from the request path and must never throw — quota
 * bookkeeping is never allowed to affect the response the client receives.
 */

import { captureTokenHarborQuota } from "./tokenharbor.js";

// provider id → (connectionId, response) => Promise<void>
const CAPTURERS = {
  tokenharbor: captureTokenHarborQuota,
};

/**
 * Fire-and-forget capture for one upstream response. No-op for providers
 * without a capturer, and for responses carrying no quota signal.
 *
 * @param {{provider: string, connectionId?: string|null, response?: Response}} params
 */
export function captureQuotaFromResponse({ provider, connectionId, response }) {
  const capture = CAPTURERS[provider];
  if (!capture || !connectionId || !response) return;
  capture(connectionId, response).catch(() => {});
}
