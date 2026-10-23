import { existsSync } from "node:fs";
import { join } from "node:path";

// Shared classification for browser-backed executors: distinguishes a missing Playwright
// Chromium binary (`chromium.launch: Executable doesn't exist at ...`) from a transient
// upstream fault. This is a host/config problem, not something a retry loop can fix, so
// executors must NOT surface it as a plain retryable 5xx (which marks the account
// unavailable / trips the provider circuit breaker).
export function isMissingBrowserExecutable(message) {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("executable doesn't exist") ||
    lower.includes("executablenotfound") ||
    lower.includes("playwright install") ||
    (lower.includes("chromium") && lower.includes("download"))
  );
}

/**
 * System Chrome path, or null to let Playwright use its own Chromium.
 * Reusing an installed Chrome avoids the ~360 MB `playwright-core install chromium`.
 */
export function resolveSystemChromeExecutable() {
  const env = process.env;
  const candidates = [
    env.NINEROUTER_BROWSER_BIN,
    env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    ...(env.PROGRAMFILES ? [join(env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")] : []),
    ...(env["PROGRAMFILES(X86)"] ? [join(env["PROGRAMFILES(X86)"], "Google", "Chrome", "Application", "chrome.exe")] : []),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "Google", "Chrome", "Application", "chrome.exe")] : []),
  ];
  return candidates.find((candidate) => Boolean(candidate?.trim() && existsSync(candidate.trim()))) || null;
}

/**
 * Playwright's own Chromium, when it has been installed via
 * `npx playwright-core install chromium`. Returns null when the browser was
 * never downloaded, so callers can fall back to a system Chrome.
 */
export function bundledChromiumPath(chromium) {
  try {
    const path = chromium?.executablePath?.();
    return path && existsSync(path) ? path : null;
  } catch {
    return null;
  }
}

/**
 * Launch Chromium, falling back to Playwright's bundled build when the
 * configured system Chrome exists but cannot start (snap wrapper, stale build).
 */
export async function launchChromiumWithFallback(chromium, options = {}) {
  const executablePath = options.executablePath;
  if (!executablePath) return chromium.launch(options);
  try {
    return await chromium.launch(options);
  } catch (error) {
    console.warn(
      `[browser] ${executablePath} failed to launch (${error?.message || error}) — retrying with Playwright's Chromium`
    );
    const { executablePath: _ignored, ...rest } = options;
    return chromium.launch(rest);
  }
}

// A headed Chromium launched on a host with no X server (Docker image, bare VPS)
// dies at launch. Host/config problem like a missing binary — not a transient upstream fault.
export function isMissingDisplay(message) {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("xserver") ||
    lower.includes("x server") ||
    lower.includes("headed browser without") ||
    lower.includes("$display")
  );
}
