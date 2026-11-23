import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ home: "" }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body, init) => ({ status: init?.status || 200, body }),
  },
}));
vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, homedir: () => state.home };
});

const originalPlatform = process.platform;
let GET;

function createCursorDatabase(folder, rows) {
  const dbPath = path.join(state.home, "Library/Application Support", folder, "User/globalStorage/state.vscdb");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT)");
  const insert = db.prepare("INSERT INTO ItemTable (key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(rows)) insert.run(key, value);
  db.close();
  return dbPath;
}

beforeEach(async () => {
  state.home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-import-"));
  Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  ({ GET } = await import("../../src/app/api/oauth/cursor/auto-import/route.js"));
});

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
  fs.rmSync(state.home, { recursive: true, force: true });
});

describe("GET /api/oauth/cursor/auto-import", () => {
  it("reports the candidate paths when Cursor is not installed", async () => {
    const response = await GET();
    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain("Cursor database not found");
    expect(response.body.error).toContain("Cursor - Insiders");
  });

  it.each(["Cursor", "Cursor - Insiders"])("reads exact token keys from %s", async (folder) => {
    createCursorDatabase(folder, {
      "cursorAuth/accessToken": '"test-token"',
      "storage.serviceMachineId": '"test-machine-id"',
    });
    const response = await GET();
    expect(response.body).toEqual({ found: true, accessToken: "test-token", machineId: "test-machine-id" });
  });

  it("accepts alternate known token and machine ID keys", async () => {
    createCursorDatabase("Cursor", {
      "cursorAuth/token": "alternate-token",
      "telemetry.machineId": "alternate-machine",
    });
    const response = await GET();
    expect(response.body).toEqual({ found: true, accessToken: "alternate-token", machineId: "alternate-machine" });
  });

  it("requests manual import when the database lacks credentials", async () => {
    const dbPath = createCursorDatabase("Cursor", {});
    const response = await GET();
    expect(response.body).toEqual({ found: false, windowsManual: true, dbPath });
  });

  it("checks Linux paths when no database is accessible", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const response = await GET();
    expect(response.body.found).toBe(false);
    expect(response.body.error).toContain(".config/Cursor/User/globalStorage/state.vscdb");
  });
});
