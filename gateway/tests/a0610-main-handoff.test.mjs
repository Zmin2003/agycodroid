// 0.6.10 第二轮车道移交给主会话的后端：中文名技能可删（195-J.5）、队列快照带 sched（197-5.4）
// 「订阅额度换算（197-5.7）」和「分模型周额度」两条已删：RATE_LIMITS 随 Claude 的 rate_limit_event 一起没了，
// agy 的 stream 只有 init/step_update/result，没有额度事件，网关不再算订阅额度。
import "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { NEXT } from "../gw/http.mjs";

const { SKILLS_DIR, routeExtensions } = await import("../gw/extensions.mjs");
const { QUEUE, RUN_LANE, enqueue, snapshot } = await import("../gw/queue.mjs");
const { RUNS, maxParallel } = await import("../gw/runs.mjs");

const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeExtensions(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());
const del = async (dir) => (await fetch(`http://127.0.0.1:${srv.address().port}/api/ext/skills/delete`, { method: "POST", body: JSON.stringify({ dir }) })).json();

test("技能：Claude Code 专属，Antigravity CLI 没有——删除接口直接拒绝，目录原样不动", async () => {
  const name = "我的 技能-" + crypto.randomBytes(3).toString("hex");
  const d = path.join(SKILLS_DIR, name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "SKILL.md"), `---\nname: x\ndescription: y\n---\n`);
  try {
    const r = await del(name);
    assert.equal(r.ok, false, JSON.stringify(r));
    assert.match(r.error, /Claude Code 专属/);
    assert.ok(fs.existsSync(d), "拒绝删除：目录还在");
    assert.equal((await del("不存在的技能")).ok, false);
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

test("队列快照：定时任务条目带 sched，普通消息不带", () => {
  // 并行位先占满，两条才会排着（不然 enqueue 当场就发走了）
  const fake = [];
  while (RUNS.size < maxParallel()) { const id = "a0610h-busy" + fake.length; fake.push(id); RUNS.set(id, { id, text: "", startedAt: Date.now(), log: [], idle: false, ended: false, lane: "x:" + id }); }
  const sid = crypto.randomUUID();
  const a = enqueue({ message: "任务", sessionId: sid, internal: true, sched: { taskId: "t1", name: "x" } });
  const b = enqueue({ message: "普通", sessionId: sid });
  try {
    const q = snapshot().queue;
    const qa = q.find((x) => x.id === a.id), qb = q.find((x) => x.id === b.id);
    assert.ok(qa && qb, "两条都排着");
    assert.equal(qa.sched, true);
    assert.equal(qb.sched, undefined);
  } finally {
    for (const id of fake) { RUNS.delete(id); RUN_LANE.delete(id); } for (const it of [a, b]) { const i = QUEUE.indexOf(it); if (i >= 0) QUEUE.splice(i, 1); } }
});

test("前端跟上：第三方不计花费提示、线路失配 / 明文 http 警告、定时任务排队标签", () => {
  const src = (f) => fs.readFileSync(new URL("../web/app/" + f, import.meta.url), "utf8");
  const s14 = src("14-projects-sched.js"), s09 = src("09-settings.js"), s11 = src("11-usage.js"), s04 = src("04-session-flow.js");
  assert.match(s14, /id="t-costnote"/);
  assert.match(s14, /pv\.nativeModels/, "按任务实际用的那家判断");
  assert.match(s09, /p\.endpointLost \?/);
  assert.match(s09, /else if \(p\.endpointLost\) body\.endpoint = p\.endpoint/, "只剩一条线路也要把线路存下");
  assert.match(s09, /r\.keyCleared/);
  assert.match(s09, /p\.plainHttp \?/, "明文 http 警告（内置密钥卡上）");
  assert.match(s09, /r\.warning/, "Key 样子不对只提醒不拦");
  assert.doesNotMatch(s11, /p\.plainHttp/, "自定义卡已删（agy 适配 W1），其明文警告随卡一起走");
  assert.doesNotMatch(s11, /renderCustomCard/, "自定义卡已删");
  assert.match(s04, /it\.sched \? t\("定时任务"\)/);
});

