// 定时任务的订阅许可门禁（审查 v0.5.20 03-013）：门禁和真跑必须认同一家。
// 项目默认是 Gemini API Key、接着的那个会话钉在 Google 登录账户（OAuth）时，没打开「允许用订阅账户跑」就不能跑
// 旧版这里用的是自定义第三方接口 + anthropic 官方账户；agy 只有 google（登录）和 gemini（API Key）两家。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PATHS } from "../gw/config.mjs";

const { providerById } = await import("../gw/providers.mjs");
const { PROJECTS } = await import("../gw/projects.mjs");
const { setSessModel } = await import("../gw/sessmodel.mjs");
const { isLoginMode } = await import("../gw/models.mjs");
const { _schedForTest: S } = await import("../gw/sched.mjs");
const { QUEUE, START_GUARDS } = await import("../gw/queue.mjs");
const { RUNS, maxParallel } = await import("../gw/runs.mjs");

const dir = path.join(CFG.workspace, "s0520proj"); fs.mkdirSync(dir, { recursive: true });
PROJECTS.push({ id: "s0520p", name: "s0520", path: dir, model: "", effort: "", perm: "", provider: "gemini" });
// 并行占满：入队的条目只留在队列里，不会真起 claude
const fake = [];
for (let i = 0; i < maxParallel(); i++) { const id = "s0520-busy" + i; fake.push(id); RUNS.set(id, { id, text: "", startedAt: Date.now(), log: [], idle: false, ended: false, lane: "x:" + i }); }
const allow0 = S.DB.allowLogin;
after(() => {
  S.DB.allowLogin = allow0;
  for (const id of fake) RUNS.delete(id);
  PROJECTS.splice(PROJECTS.findIndex((p) => p.id === "s0520p"), 1);
});
const mk = (id, sid) => { const t = { id, name: id, prompt: "做事", on: true, freq: { kind: "once" }, nextAt: null, busy: "run", session: "same", lastSid: sid, projectId: "s0520p", perm: "read" }; S.DB.tasks.push(t); return t; };
const drop = (t, it) => { if (it && QUEUE.includes(it)) QUEUE.splice(QUEUE.indexOf(it), 1); S.DB.tasks.splice(S.DB.tasks.indexOf(t), 1); };

test("前提：Google 登录账户没填 Key 是订阅登录，项目默认的 Gemini 不是", () => {
  assert.equal(isLoginMode(providerById("google")), true);
  assert.equal(isLoginMode(providerById("gemini")), false);
});

test("会话钉了 Google 登录账户、项目默认 Gemini：没许可就跳过，许可了才入队", async () => {
  const sid = crypto.randomUUID();
  setSessModel(sid, { provider: "google" });
  S.DB.allowLogin = false;
  const t = mk("s0520-a", sid);
  const it = await S.fire(t, { reason: "due" });
  assert.ok(!it || !QUEUE.includes(it), "没许可不该入队");
  assert.equal(S.runlog().filter((r) => r.taskId === t.id).at(-1)?.st, "skip");
  S.DB.allowLogin = true;
  const it2 = await S.fire(t, { reason: "manual" });
  assert.ok(it2 && QUEUE.includes(it2), "许可了照常入队");
  drop(t, it2);
});

// 接着的会话得真有记录文件：会话不在了的任务开跑前会放下 lastSid、新开一个（#173-3）
const realSid = () => {
  const sid = crypto.randomUUID(), d = path.join(PATHS.projects, "-sched-real");
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, sid + ".jsonl"), JSON.stringify({ type: "user", sessionId: sid, uuid: crypto.randomUUID(), message: { role: "user", content: "hi" } }) + "\n");
  return sid;
};
test("入队后会话被改钉到 Google 登录账户：开跑前再核一次，拦下", async () => {
  const sid = realSid();
  S.DB.allowLogin = false;
  const t = mk("s0520-b", sid);
  const it = await S.fire(t, { reason: "due" });
  assert.ok(it && QUEUE.includes(it), "走项目默认的 Gemini：照常入队");
  assert.equal(START_GUARDS.every((g) => g(it) !== false), true, "没改钉：放行");
  setSessModel(sid, { provider: "google" });
  assert.equal(START_GUARDS.every((g) => g(it) !== false), false, "改钉成订阅：拦下");
  drop(t, it);
});
