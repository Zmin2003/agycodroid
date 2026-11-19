// 切全局权限模式（gw/queue.mjs setPermMode）：安全模式下回实际生效的模式、写盘失败如实回（0.6.9 审计 195-A.6）
import { CFG, PATHS } from "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const { setPermMode } = await import("../gw/queue.mjs");
const { SETTINGS } = await import("../gw/settings-store.mjs");
const SAFE = path.join(CFG.home, ".agyapp-safe-mode");
const prev = SETTINGS.permissionMode, prevPath = PATHS.settings;
after(() => { fs.rmSync(SAFE, { force: true }); PATHS.settings = prevPath; SETTINGS.permissionMode = prev; });

test("模式不认识 → false", () => assert.equal(setPermMode("nope"), false));

test("安全模式下切「全部放行」→ 回的是实际生效的 request-review，用户选的照存", () => {
  fs.writeFileSync(SAFE, "1");
  const r = setPermMode("always-proceed");
  assert.deepEqual(r, { mode: "request-review", saved: true });
  assert.equal(SETTINGS.permissionMode, "always-proceed");
  fs.rmSync(SAFE, { force: true });
  assert.equal(setPermMode("always-proceed").mode, "always-proceed");
});

test("设置写不进去 → saved:false", () => {
  const dir = fs.mkdtempSync(path.join(CFG.home, "a0610-pm-"));
  fs.mkdirSync(path.join(dir, "s.json"));            // 目标是个目录：换名必失败
  PATHS.settings = path.join(dir, "s.json");
  assert.equal(setPermMode("request-review").saved, false);
  PATHS.settings = prevPath;
  fs.rmSync(dir, { recursive: true, force: true });
});
