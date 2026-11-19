// v0.5.18（agy 版）：#82 清单外型号不借别人的窗口、#78 项目指定接口按项目那家
// 旧版 #77（旧清单请求不回写已清的缓存）已不存在：清单是静态的（文档示例 + 用户自加的 slug），
// fetchModels 不发请求、不写缓存，根本没有“旧请求晚回来”这回事。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { NEXT } from "../gw/http.mjs";
import { PATHS } from "../gw/config.mjs";
import { routeModels } from "../gw/models.mjs";
import { currentModelInfo } from "../gw/agy.mjs";
import { providerById, routeProviders } from "../gw/providers.mjs";
import { routeProjects } from "../gw/projects.mjs";
import { effectiveModel, setSessModel } from "../gw/sessmodel.mjs";
import { handleLocalCommand, LOCAL_CMD_RE } from "../gw/modelcmd.mjs";

async function serve(...routes) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    for (const r of routes) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  return (p, init) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, init);
}
const go = await serve(routeProviders, routeProjects, routeModels);
const post = async (p, b, method = "POST") => (await go(p, { method, body: JSON.stringify(b) })).json();

test("清单外型号：能力和窗口是不知道，不借默认或第一项的（#82）", async () => {
  const p = { id: "custom-82", custom: true, baseUrl: "https://example.invalid", defaultModel: "listed-large" };
  assert.deepEqual(currentModelInfo("unlisted-small", p), {});
  assert.deepEqual(currentModelInfo("", p), {}, "默认型号不在静态清单里也不借第一项");
  assert.equal(currentModelInfo("", { ...p, defaultModel: undefined }).id, "gemini-3.8-flash-medium", "没默认才是第一项（文档示例）");
  assert.equal(currentModelInfo("", { ...p, defaultModel: undefined }).context_window, 0, "agy 不报窗口");

  const r = await post("/api/providers/save", { id: "gemini", apiKey: "fixture-only",
    defaultModel: "listed-large", extraModels: [{ id: "listed-large", contextWindow: 1048576 }] });
  assert.ok(r.ok, JSON.stringify(r));
  const m = await (await go(`/api/models?provider=${r.id}&model=unlisted-small`)).json();
  assert.equal(m.current, "unlisted-small");
  assert.equal(m.contextWindow, 0);
  assert.equal(m.maxOutputTokens, 0);
  const k = await (await go(`/api/models?provider=${r.id}&model=listed-large`)).json();
  assert.equal(k.contextWindow, 1048576);
  await post("/api/providers/delete", { id: r.id });
});

test("项目指定了接口：/model 按项目那家，选型号也不钉回全局（#78）；/autocompact 没有了", async () => {
  assert.equal(LOCAL_CMD_RE.test("/autocompact"), false, "agy 没有 /compact，/autocompact 不是网关命令");
  const r = await post("/api/providers/save", { id: "gemini", apiKey: "fixture-only",
    defaultModel: "B-small", extraModels: [{ id: "B-small" }, { id: "B-other" }] });
  assert.ok(r.ok, JSON.stringify(r));
  const dir = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "p78-"));
  const proj = (await post("/api/projects", { name: "p78", mode: "dir", path: dir })).project;
  await post("/api/projects/" + proj.id, { provider: r.id, model: "B-small" }, "PATCH");
  const sid = crypto.randomUUID(), sdir = path.join(PATHS.projects, "-p78");
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, sid + ".jsonl"), JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: sid, cwd: dir, message: { role: "user", content: "hi" } }) + "\n");
  assert.equal(effectiveModel(sid).provider, r.id);
  assert.ok(providerById(r.id));

  let out = "";
  await handleLocalCommand("model", "", (t) => { out = t; }, sid);
  assert.match(out, /B-other/);
  await handleLocalCommand("model", "B-other", (t) => { out = t; }, sid);
  const now = effectiveModel(sid);
  assert.equal(now.provider, r.id, "只改型号：接口留在项目那家");
  assert.equal(now.model, "B-other");

  // 输入栏面板只给型号时（pickSessModel 不带 provider）也一样
  const sid2 = crypto.randomUUID();
  fs.writeFileSync(path.join(sdir, sid2 + ".jsonl"), JSON.stringify({ type: "user", uuid: crypto.randomUUID(), sessionId: sid2, cwd: dir, message: { role: "user", content: "hi" } }) + "\n");
  setSessModel(sid2, { model: "B-other" });
  assert.equal(effectiveModel(sid2).provider, r.id);

  // 新会话首条记 pin 时会话文件还没落盘：按项目号定，不钉回全局（复核 M2）
  const sid3 = crypto.randomUUID();
  setSessModel(sid3, { model: "B-other" }, proj.id);
  assert.equal(effectiveModel(sid3).provider, r.id);
  await post("/api/providers/delete", { id: r.id });
});
