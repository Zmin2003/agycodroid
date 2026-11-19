// v0.6.3 日常使用审查（#142–#147）里网关侧的几项
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import { NEXT } from "../gw/http.mjs";
import { routeProviders } from "../gw/providers.mjs";
import { sessModel, setSessModel } from "../gw/sessmodel.mjs";
import { handleLocalCommand } from "../gw/modelcmd.mjs";

async function serve(...routes) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    try {
      for (const r of routes) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
      res.writeHead(404).end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  return (p, init) => fetch(`http://127.0.0.1:${srv.address().port}${p}`, init);
}
const go = await serve(routeProviders);
const post = async (p, b, method = "POST") => (await go(p, { method, body: JSON.stringify(b) })).json();

test("/model 等清单时点了停止：迟到的清单不再改型号（#142-1）", async () => {
  // 移植：fetchModels 现在是静态清单（不联网），没有迟到的远程清单；
  // 但 modelcmd.mjs:22 的 stopped() 检查还在——直接用已停止的回调测它。
  await post("/api/providers/save", { id: "google", extraModels: [{ id: "s2" }] });
  const sid = crypto.randomUUID();
  setSessModel(sid, { provider: "google", model: "gemini-3.8-flash-medium", effort: "" });
  let out = "";
  await handleLocalCommand("model", "s2", (t) => { out = t; }, sid, () => true);
  assert.match(out, /已停止/);
  assert.equal(sessModel(sid).model, "gemini-3.8-flash-medium", "停止后的命令不能再落盘");
  // 没停的照常生效
  await handleLocalCommand("model", "s2", (t) => { out = t; }, sid, () => false);
  assert.equal(sessModel(sid).model, "s2");
  await post("/api/providers/save", { id: "google", extraModels: [] });
});
