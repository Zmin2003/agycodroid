// 权限模式别名（B5-Q01）：前端发 toolPermission（agy 的 settings.json 里就叫这个），
// 后端以前只认 permissionMode：VIEW_KEYS 没这个键，GET 读回也没有，切换假成功。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { CFG, PATHS } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";

async function serve(route) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if ((await route(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return {
    srv,
    call: async (p, body) => {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    },
  };
}

test("权限模式：前端发 toolPermission 能存住，GET 读回一致，agy settings.json 落盘一致（B5-Q01）", async (t) => {
  const had = fs.existsSync(PATHS.settings);
  const before = had ? fs.readFileSync(PATHS.settings, "utf8") : null;
  const agyFile = path.join(CFG.home, ".gemini", "antigravity-cli", "settings.json");
  const agyHad = fs.existsSync(agyFile);
  const agyBefore = agyHad ? fs.readFileSync(agyFile, "utf8") : null;
  fs.mkdirSync(path.dirname(PATHS.settings), { recursive: true });
  fs.writeFileSync(PATHS.settings, JSON.stringify({ permissionMode: "strict", agentMode: "", permMigrated: 1 }, null, 2));
  // 写完旧文件再加载：loadSettings 只在模块导入时读一次
  const { routeSettings } = await import("../gw/settings.mjs");
  const { SETTINGS } = await import("../gw/settings-store.mjs");
  const { writeAgySettings } = await import("../gw/agy.mjs");
  const prevPerm = SETTINGS.permissionMode, prevAgent = SETTINGS.agentMode;
  const { srv, call } = await serve(routeSettings);
  t.after(() => srv.close());
  try {
    // 前端发 toolPermission + agentMode（03-perm-status.js:477）
    const r = await call("/api/settings", { toolPermission: "always-proceed", agentMode: "auto" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.settings.toolPermission, "always-proceed");
    assert.equal(r.body.settings.agentMode, "auto");
    assert.equal(r.body.settings.permissionMode, "always-proceed");
    // GET 读回一致（GET 是平铺的 settingsView）
    const g = await call("/api/settings");
    assert.equal(g.body.toolPermission, "always-proceed");
    assert.equal(g.body.permissionMode, "always-proceed");
    assert.equal(g.body.agentMode, "auto");
    // agy settings.json 落盘一致：网关按 SETTINGS.permissionMode 写 agy 的 toolPermission
    writeAgySettings();
    const agy = JSON.parse(fs.readFileSync(agyFile, "utf8"));
    assert.equal(agy.toolPermission, "always-proceed");
    assert.equal(agy.agentMode, "auto");
    // 旧名 permissionMode 也认
    const r2 = await call("/api/settings", { permissionMode: "strict" });
    assert.equal(r2.status, 200, JSON.stringify(r2.body));
    assert.equal(r2.body.settings.toolPermission, "strict");
    // 非法值：400，不改内存、不改磁盘（Q-06）
    const bad = await call("/api/settings", { toolPermission: "nope" });
    assert.equal(bad.status, 400, JSON.stringify(bad.body));
    assert.equal(bad.body.error, "bad permissionMode");
    assert.equal(SETTINGS.permissionMode, "strict");
    assert.equal(JSON.parse(fs.readFileSync(PATHS.settings, "utf8")).permissionMode, "strict");
  } finally {
    // 同一轮测试共用临时 HOME：把自己写进去的设置恢复/删掉，别影响后面的用例
    SETTINGS.permissionMode = prevPerm;
    SETTINGS.agentMode = prevAgent;
    if (had) fs.writeFileSync(PATHS.settings, before); else fs.rmSync(PATHS.settings, { force: true });
    if (agyHad) fs.writeFileSync(agyFile, agyBefore); else fs.rmSync(agyFile, { force: true });
  }
});
