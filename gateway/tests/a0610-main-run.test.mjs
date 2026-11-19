// 0.6.9 审计：运行链路 P1-6（事件处理 / 收尾抛错）、195-T.1（子孙攥着管道 close 不来）
// 用假 CLI（sh 脚本按 agy stream-json 吐事件）驱动真实 startRun，写法同 run0520.test.mjs
// 移植说明：删了 P1-4（control_request 逐条审批，agy 没有）、195-W.3（idle 进程复用，
// agy 每轮结束就 closeInput）、199（guard 逐目标批准，同上）、200-7-07（起进程前等模型清单，
// fetchModels 现在是静态的）、200-7-08（beginBridgeSwitch，桥的概念没了）。
// 厂商夹具也简化了：自定义厂商配置现在被生产代码忽略（生效的永远是 google），
// 计费账本按实际跑的那家记，所以 O.1 读 google 的账。
import { PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const home = process.env.AGAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "a0610-run-"));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const SLEEP = ["/system/bin/sleep", "/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));
if (!SLEEP) throw new Error("找不到 sleep");
function script(steps, code = 0) {
  const body = steps.map((s) => s.raw ? s.raw : s.sleep ? `${SLEEP} ${s.sleep}` : `printf '%s\\n' ${JSON.stringify(JSON.stringify(s)).replace(/\$/g, "\\$")}`).join("\n");
  fs.writeFileSync(cli, `#!${sh}\n${body}\nexit ${code}\n`, { mode: 0o700 });
}
const previousPaths = { agy: PATHS.agy };
PATHS.agy = cli;
const { startRun } = await import("../gw/run.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const events = [];
const off = onPublish((ev) => events.push(ev));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not send a request"); };
after(() => {
  off();
  globalThis.fetch = originalFetch;
  Object.assign(PATHS, previousPaths);
  fs.rmSync(root, { recursive: true, force: true });
});
const endOf = (id) => events.find((e) => e.type === "run_end" && e.runId === id);
async function until(f, ms = 15000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }
const init = (s) => ({ event: "init", conversation_id: s, init: { model: "fixture-model", tools: [], permission_mode: "default" } });
const result = (s) => ({ event: "result", conversation_id: s, result: { status: "SUCCESS", response: "done", num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, duration_seconds: 0 } });

test("P1-6：一条事件处理时抛错（null 事件）→ 只跳过这条，这一轮照常答完", async () => {
  const s = crypto.randomUUID();
  script([init(s), { raw: "printf 'null\\n'" }, result(s)], 0);
  await startRun({ id: "a0610-null", message: "fixture", cwd: root });
  await until(() => endOf("a0610-null"));
  const e = endOf("a0610-null");
  assert.equal(!!e.failed, false, JSON.stringify(e));
  assert.equal(e.subtype, "SUCCESS");
});

test("200-S-10：提醒没送到模型（没答完就退出）放回去，下一轮再带；定时任务不取不分会话的提醒；答完才算交出去", async () => {
  const { tamperNote, tamperRecord } = await import("../gw/tamper.mjs");
  const { putPathNote, takePathNote } = await import("../gw/pathnote.mjs");
  tamperNote();                                      // 清掉别的测试留下的
  tamperRecord("runtime", ["s10-probe.json"]);
  const sid = crypto.randomUUID();
  putPathNote(sid, "Path note: s10");
  script([init(sid)], 1);                            // 起来了、没出 result 就退出
  await startRun({ id: "a0610-s10a", message: "fixture", cwd: root, sessionId: sid });
  await until(() => endOf("a0610-s10a"));
  assert.equal(endOf("a0610-s10a").failed, true);
  script([init(sid), result(sid)], 0);
  await startRun({ id: "a0610-s10b", message: "fixture", cwd: root, sessionId: sid, unattended: true });
  await until(() => endOf("a0610-s10b"));
  assert.equal(takePathNote(sid), "", "同一会话的路径提醒：定时任务那轮答完就交出去了");
  assert.match(tamperNote(), /s10-probe\.json/, "失败那轮放回来了，定时任务那轮没取");
});

test("195-K.1：指定的工作目录不在了 → 这一轮不跑、报出来，不悄悄换到工作区", async () => {
  script([{ raw: `: > ${root}/ran-k1` }, init(crypto.randomUUID()), result(crypto.randomUUID())], 0);
  await startRun({ id: "a0610-k1", message: "fixture", cwd: path.join(root, "gone-dir") });
  await until(() => endOf("a0610-k1"));
  assert.equal(endOf("a0610-k1").failed, true);
  assert.ok(events.some((e) => e.type === "error" && /gone-dir/.test(e.message || "")));
  assert.equal(fs.existsSync(path.join(root, "ran-k1")), false);
});

test("LG-15：已知没登录 Google 时不启动 agy，直接回友好提示", async () => {
  const { noteLoggedIn } = await import("../gw/models.mjs");
  noteLoggedIn(false);   // 模拟设置页探过、明确没登录（login.mjs 的 authStatus 会这样写）
  try {
    script([{ raw: `: > ${root}/ran-lg15` }, init(crypto.randomUUID()), result(crypto.randomUUID())], 0);
    await startRun({ id: "a0610-lg15", message: "fixture", cwd: root });
    await until(() => endOf("a0610-lg15"));
    assert.equal(endOf("a0610-lg15").failed, true);
    assert.ok(events.some((e) => e.type === "error" && /还没登录/.test(e.message || "")),
      JSON.stringify(events.filter((e) => e.type === "error")));
    assert.equal(fs.existsSync(path.join(root, "ran-lg15")), false, "假 CLI 没跑起来：没起 agy");
  } finally { noteLoggedIn(null); }   // 复位：null = 还没问过，后面的轮次照常跑
});

test("195-O.1/O.4：接口账本跟着运行中的计量记——没出 result 就被结束的那轮、子代理的都记上", async () => {
  const P = await import("../gw/providers.mjs");
  const tok = () => P._billForTest.billOf("google").tok.reduce((a, r) => [a[0] + r[1], a[1] + r[2], a[2] + r[3]], [0, 0, 0]);
  const t0 = tok();
  const sid = crypto.randomUUID();
  const step = (i, usage, sub) => ({ event: "step_update", conversation_id: sid,
    step_update: { step_index: i, step_type: "agent_response", usage, ...(sub ? { subagent_info: { subagents: [{ conversation_id: "agy-sub-1" }] } } : {}) } });
  // feed() 先经 normUsage 归一化再记：agy 的 cache_read_tokens 按步记进缓存列（input 列只记
  // input_tokens，不含缓存命中——见 usage.mjs bump 的 i/c 分列），不再等 result() 对账才补。
  // 另注意 agy 按步加总：step 0 的 output 1 加 step 1 的 output 29 = 主会话 30，再加子代理 5 = 35
  script([init(sid),
    step(0, { input_tokens: 100, cache_read_tokens: 40, output_tokens: 1 }),
    step(1, { output_tokens: 29 }),
    step(2, { input_tokens: 7, output_tokens: 5 }, true)], 1);   // 没出 result 就退出
  await startRun({ id: "a0610-o1", message: "fixture", cwd: root });
  await until(() => endOf("a0610-o1"));
  assert.equal(endOf("a0610-o1").failed, true, "没出 result 就退出：这一轮算失败，但账已经记了");
  const t1 = tok();
  assert.deepEqual([t1[0] - t0[0], t1[1] - t0[1], t1[2] - t0[2]], [107, 35, 40]);
});

test("195-R.1：「继续」那轮没答出来 → 中断记录留着（卡片还在）；答出来了才撤", async () => {
  const Q = await import("../gw/queue.mjs");
  const sid = crypto.randomUUID();
  Q.setInterrupted([{ id: "r1-intr", sessionId: sid, text: "x", startedAt: 1 }]);
  script([init(sid)], 1);
  await startRun({ id: "a0610-r1a", message: "fixture", cwd: root, sessionId: sid });
  await until(() => endOf("a0610-r1a"));
  assert.ok(Q.INTERRUPTED.some((e) => e.id === "r1-intr"), "没答出来：留着");
  script([init(sid), result(sid)], 0);
  await startRun({ id: "a0610-r1b", message: "fixture", cwd: root, sessionId: sid });
  await until(() => endOf("a0610-r1b"));
  assert.ok(!Q.INTERRUPTED.some((e) => e.id === "r1-intr"), "答出来了：撤掉");
});

// 放最后：它留下的后台 sleep 30 还活着时，后面的轮次会先弹「用户配置」确认卡
test("F6：首字前分段——起进程发「启动中」，agy init 后发「连接中」(from init)，只发一次；没有 wait 段", async () => {
  const sid = crypto.randomUUID();
  script([{ sleep: "0.2" }, init(sid), init(sid), result(sid)], 0);
  await startRun({ id: "a0610-phase", message: "fixture", cwd: root });
  await until(() => endOf("a0610-phase"));
  const ph = events.filter((e) => e.runId === "a0610-phase" && e.type === "phase").map((e) => e.phase + (e.from ? "@" + e.from : ""));
  assert.deepEqual(ph, ["boot", "connect@init"]);
  assert.equal(ph.filter((p) => p === "connect@init").length, 1, "第二次 init 不再发");
  const run = events.findIndex((e) => e.runId === "a0610-phase" && e.type === "run_start"), boot = events.findIndex((e) => e.runId === "a0610-phase" && e.phase === "boot");
  assert.ok(run >= 0 && boot > run, "run_start 在前，boot 在后");
});

// 放最后：它留下的后台 sleep 会让之后的轮次起进程前先弹「留下的进程」确认卡，没人答就一直等
test("195-T.1：agy 退出了、后台子孙还攥着输出管道 → 5 秒后自己收尾，不永远「生成中」", async () => {
  const s = crypto.randomUUID();
  script([init(s), result(s), { raw: `${SLEEP} 30 &` }], 0);
  const t0 = Date.now();
  await startRun({ id: "a0610-held", message: "fixture", cwd: root });
  await until(() => endOf("a0610-held"), 12000);
  assert.ok(Date.now() - t0 < 12000);
  assert.equal(endOf("a0610-held").subtype, "SUCCESS");
});
