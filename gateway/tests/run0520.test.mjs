// v0.5.20 审查第 2 批：运行结算与统计。用假 CLI（sh 脚本按 stream-json 吐事件）驱动真实 startRun
// 移植：harness 改成 agy 事件（init / result，conversation_id + num_turns）；
// 自定义厂商夹具已删（agy 只有 google / gemini，账本记在 google 名下）；
// 03-010 单次花费上限已删——agy 的 result 总报 total_cost_usd: 0，costSeen
// 永远到不了上限，限额逻辑在 agy 下是死的。
import { PATHS, CFG } from "../gw/config.mjs"; // scripts/test.mjs 先隔离 HOME / fake PREFIX
import "./fixtures/uc-baseline.mjs";   // 共用 home 里前面测试留下的 ~/.claude 改动先认下，免得真起一轮时卡在确认卡片
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";
const home = process.env.AGAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "run0520-"));
const providerFile = path.join(home, "agyapp-providers.json");
const PID = "custom-run0520";
fs.writeFileSync(providerFile, JSON.stringify({ active: PID, providers: {
  [PID]: { label: "Fixture", baseUrl: "https://fixture.example.invalid", apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
  // 花费上限只对官方价目生效（195-U.3）：那条用例钉到官方 API Key 这家
  "anthropic-key": { apiKey: "fixture-only" },
} }));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
// 假 CLI：按顺序吐事件；{sleep: 秒} 停一会儿；最后 exit code
// 假 CLI 跑在 claude 那套 PATH 里（假 PREFIX/bin、/system/bin），Linux 上找不到 sleep 会悄悄跳过等待：用绝对路径，找不到就直接失败（#113）
const SLEEP = ["/system/bin/sleep", "/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));
if (!SLEEP) throw new Error("找不到 sleep，假 CLI 的等待会失效");
function script(steps, code = 0) {
  const body = steps.map((s) => s.sleep ? `${SLEEP} ${s.sleep}` : `printf '%s\\n' ${JSON.stringify(JSON.stringify(s)).replace(/\$/g, "\\$")}`).join("\n");
  fs.writeFileSync(cli, `#!${sh}\n${body}\nexit ${code}\n`, { mode: 0o700 });
}
const previousPaths = { agy: PATHS.agy };
PATHS.agy = cli;
const { startRun } = await import("../gw/run.mjs");
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
async function until(f, ms = 8000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }

const sid = () => crypto.randomUUID();
const init = (s) => ({ event: "init", conversation_id: s, init: { model: "fixture-model", tools: [], permission_mode: "default" } });
const result = (s, i, o, turns = 1) => ({ event: "result", result: { conversation_id: s, num_turns: turns, status: "SUCCESS", response: "done", usage: { input_tokens: i, output_tokens: o } } });
// 新一轮开工的信号：result 之后又来一个 step_update（agy 没有后台任务事件）
const more = (s) => ({ event: "step_update", step_update: { step_index: 1, agent_response: { type: "text_delta", text: "more" } } });

test("02-002 第一轮已出 result、第二轮刚开工就异常退出：已出的成功照算（agy 没有后台任务回报，exit 码在有成功 result 时忽略）", async () => {
  const s = sid();
  script([init(s), result(s, 10, 1), more(s)], 17);
  await startRun({ id: "r0520-stale", message: "fixture", cwd: root });
  await until(() => endOf("r0520-stale"));
  const e = endOf("r0520-stale");
  assert.equal(!!e.failed, false, JSON.stringify(e));
  assert.equal(e.subtype, "SUCCESS");
});

test("02-002 对照：出 result、正常退出，照旧算成功", async () => {
  const s = sid();
  script([init(s), result(s, 10, 1)], 0);
  await startRun({ id: "r0520-ok", message: "fixture", cwd: root });
  await until(() => endOf("r0520-ok"));
  const e = endOf("r0520-ok");
  assert.equal(!!e.failed, false, JSON.stringify(e));
  assert.equal(e.subtype, "SUCCESS");
});

test("04-008 同一进程出两个 result：接口账本两份都记上", async () => {
  const bill = path.join(home, "agyapp-billing.json");
  // 账本记在 run 的厂商名下：自定义厂商已删，run 回落到 google
  const tok = () => { try { return (JSON.parse(fs.readFileSync(bill, "utf8")).google?.tok || []).reduce((a, x) => [a[0] + x[1], a[1] + x[2]], [0, 0]); } catch { return [0, 0]; } };
  await new Promise((r) => setTimeout(r, 700));   // 前几条测试记的先落盘
  const before = tok();
  const s = sid();
  // 两轮 result 的 num_turns 不同（uuid 不去重），usage.mjs 的 result() 每轮后把 tot 清零，
  // 所以两轮各记各的：(100,10) + (200,20) = (300,30)
  script([init(s), result(s, 100, 10, 1), result(s, 200, 20, 2)], 0);
  await startRun({ id: "r0520-bill", message: "fixture", cwd: root });
  await until(() => endOf("r0520-bill"));
  await new Promise((r) => setTimeout(r, 700));   // saveBill 防抖 500ms
  const now = tok();
  assert.deepEqual([now[0] - before[0], now[1] - before[1]], [300, 30]);
});

test("195-U.3 agy 不报花费：result 的 total_cost_usd 恒为 0，单次上限不触发、不报 costRaw", async () => {
  const s = sid();
  script([init(s), result(s, 10, 1)], 0);
  await startRun({ id: "r0520-cost3", message: "fixture", cwd: root, limitCost: 0.1, sched: { taskId: "t-u3", key: "k-u3" } });
  await until(() => endOf("r0520-cost3"));
  assert.equal(!!endOf("r0520-cost3").aborted, false);
  assert.equal(endOf("r0520-cost3").costRaw || 0, 0);
});
