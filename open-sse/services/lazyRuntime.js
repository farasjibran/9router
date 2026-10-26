// Lazy loader for heavy optional runtime deps (playwright-core, wreq-js).
//
// They are devDependencies only, so end-user installs stay small. On first
// use the package is downloaded into <DATA_DIR>/runtime (same pattern as
// cli/hooks/sqliteRuntime.js) and imported from there. Resolution order:
// app node_modules (dev / traced standalone) → runtime dir → npm install.
//
// Never throws at import time of THIS module — failures surface from
// loadRuntimeDep() with a manual-install hint.

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { getWritableDataDir } from "../utils/writableDataDir.js";

// Keep in sync with package.json devDependencies.
const LAZY_DEP_VERSIONS = {
  "playwright-core": "^1.62.1",
  "wreq-js": "^3.2.0",
};

/**
 * `createRequire` bound to `basePath`, fetched through a dynamic import.
 *
 * A static `import { createRequire } from "node:module"` is understood by
 * webpack: it rewrites the resulting calls into `require(<expression>)`, which it
 * cannot resolve at build time and can only report as "Critical dependency: the
 * request of a dependency is an expression". Going through a runtime import
 * keeps the call opaque to the bundler with identical runtime behaviour, so
 * `next build` stays warning-free.
 */
async function createRequireFrom(basePath) {
  const { createRequire } = await import(/* webpackIgnore: true */ "node:module");
  return createRequire(basePath);
}

function getRuntimeDir() {
  return path.join(getWritableDataDir(), "runtime");
}

function isModuleMissing(error) {
  const code = String(error?.code || "");
  return code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND";
}

function npmInstall(pkg, version) {
  const cwd = getRuntimeDir();
  fs.mkdirSync(cwd, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const args = ["install", "--no-audit", "--no-fund", "--prefer-online", `${pkg}@${version}`];
  return new Promise((resolve) => {
    const child = spawn(npm, args, { cwd, stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => resolve({ ok: false, stderr: String(error.message || error) }));
    child.on("close", (status) => resolve({ ok: status === 0, stderr }));
  });
}

const inflight = new Map();

/**
 * Import an absolute file URL without letting webpack see the specifier.
 *
 * A plain `import(<expression>)` is rewritten into `__webpack_require__(...)`,
 * which cannot resolve a path that only exists at runtime and is reported as
 * "Critical dependency: the request of a dependency is an expression". It would
 * also never reach the module actually installed in the runtime dir.
 */
async function importFromPath(fileUrl) {
  return import(/* webpackIgnore: true */ fileUrl);
}

async function load(pkg) {
  // 1) Resolvable from the app install (dev machine / traced standalone).
  try {
    return await import(/* webpackIgnore: true */ pkg);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  // 2) Already present in the runtime dir from a previous install.
  const runtimeDir = getRuntimeDir();
  const runtimePackageJson = path.join(runtimeDir, "package.json");
  let runtimeRequire;
  try {
    runtimeRequire = await createRequireFrom(runtimePackageJson);
  } catch (error) {
    if (!isModuleMissing(error)) throw error;
  }
  if (runtimeRequire) {
    try {
      return await importFromPath(pathToFileURL(runtimeRequire.resolve(pkg)).href);
    } catch (error) {
      if (!isModuleMissing(error)) throw error;
    }
  }
  // 3) Download on demand, then import from the runtime dir.
  const version = LAZY_DEP_VERSIONS[pkg] || "latest";
  const res = await npmInstall(pkg, version);
  if (!res.ok) {
    const reason = (res.stderr.match(/npm ERR! ?(.+)/) || [])[1] || res.stderr.split("\n").filter(Boolean).pop() || "unknown npm error";
    throw new Error(
      `${pkg} is missing and the on-demand install failed (${String(reason).slice(0, 160)}) — ` +
      `install it manually: cd "${runtimeDir}" && npm install ${pkg}@${version}`
    );
  }
  const finalRequire = await createRequireFrom(path.join(runtimeDir, "package.json"));
  return importFromPath(pathToFileURL(finalRequire.resolve(pkg)).href);
}

export function loadRuntimeDep(pkg) {
  if (!inflight.has(pkg)) {
    inflight.set(pkg, load(pkg).finally(() => inflight.delete(pkg)));
  }
  return inflight.get(pkg);
}
