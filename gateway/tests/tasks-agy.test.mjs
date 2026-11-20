// E05 任务清单接 agy（方案 A，分叉防御式）：网关从清单类工具调用实时累积清单。
// - goal.mjs：applyTaskToolCall / noteTaskTools / tasksOf（内存 + JSONL 反推）/ tasksUnsupportedOf
// - run.mjs：recordStep 在工具 DONE 时拦截清单调用（子代理的不并入）；onInit 登记 init.tools
// - sessions.mjs + 04-session-flow.js：同步路径补 tasksUnsupported（A-N1）
// V6 未验证：agy 有没有 TodoWrite / TaskCreate / TaskUpdate 这类工具本地无法证实；
// 这里只认这组名字（待真机实测扩充），形状对不上直接忽略，绝不从正文解析、绝不冒充清单。
import "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { applyTaskToolCall, noteTaskTools, tasksCheck, tasksOf, tasksUnsupportedOf } from "../gw/goal.mjs";
import { onPublish } from "../gw/bus.mjs";
import { appendSessionRecord } from "../gw/sessions.mjs";

const ws = process.env.AGAPP_WORKSPACE;
const sid = () => crypto.randomUUID();
const seen = [];
const off = onPublish((ev) => { if (ev && ev.type === "tasks") seen.push(ev); });
after(() => off());
const tasksEvents = (id) => seen.filter((e) => e.sessionId === id);
const lastTasksEvent = (id) => tasksEvents(id).at(-1);

const TODOS = { todos: [
  { content: "列出 txt 文件", status: "completed" },
  { content: "数行数", status: "in_progress", activeForm: "正在数行数" },
  { content: "汇总成表", status: "pending" },
] };
const EXPECTED = [
  { id: "1", subject: "列出 txt 文件", status: "completed", blocked: [] },
  { id: "2", subject: "数行数", status: "in_progress", active: "正在数行数", blocked: [] },
  { id: "3", subject: "汇总成表", status: "pending", blocked: [] },
];

test("TodoWrite 全量替换 → 立即发带真实清单的 tasks 事件（tasksUnsupported:false），tasksOf 读到它", () => {
  const id = sid();
  const n0 = tasksEvents(id).length;
  applyTaskToolCall(id, "TodoWrite", TODOS);
  assert.equal(tasksEvents(id).length, n0 + 1, "清单变化立即发事件，不等轮末");
  const ev = lastTasksEvent(id);
  assert.equal(ev.tasksUnsupported, false);
  assert.deepEqual(ev.tasks, EXPECTED);
  assert.deepEqual(tasksOf(id), EXPECTED);
  assert.equal(tasksUnsupportedOf(id), false);
});

test("TaskCreate 追加、TaskUpdate 改状态/改名；TaskList 只标记有工具，不改清单", () => {
  const id = sid();
  applyTaskToolCall(id, "TodoWrite", TODOS);
  applyTaskToolCall(id, "TaskCreate", { subject: "再补一个", status: "pending" });
  assert.equal(tasksOf(id).length, 4);
  assert.equal(tasksOf(id)[3].subject, "再补一个");
  assert.equal(tasksOf(id)[3].id, "4");
  applyTaskToolCall(id, "TaskUpdate", { taskId: "2", status: "completed" });
  assert.equal(tasksOf(id)[1].status, "completed");
  applyTaskToolCall(id, "TaskUpdate", { id: "3", subject: "汇总成一张表" });
  assert.equal(tasksOf(id)[2].subject, "汇总成一张表");
  const n0 = tasksEvents(id).length;
  applyTaskToolCall(id, "TaskList", {});
  assert.equal(tasksEvents(id).length, n0, "只读调用不重复发事件");
  assert.equal(tasksOf(id).length, 4);
});

test("fail-safe：形状对不上的调用直接忽略，清单与事件都不变", () => {
  const id = sid();
  applyTaskToolCall(id, "TodoWrite", TODOS);
  const before = tasksOf(id), n0 = tasksEvents(id).length;
  // todos 不是数组 / 条目没有 subject / 状态值乱写（单条脏数据不污染整份清单）
  assert.equal(applyTaskToolCall(id, "TodoWrite", { todos: "不是数组" }), null);
  assert.equal(applyTaskToolCall(id, "TodoWrite", { todos: [{ status: "completed" }] }), null);
  assert.equal(applyTaskToolCall(id, "TodoWrite", { todos: [{ content: "  " }] }), null);
  assert.equal(applyTaskToolCall(id, "TodoWrite", null), null);
  assert.equal(applyTaskToolCall(id, "TodoWrite", { todos: [{ content: "脏", status: "weird" }] }).length, 1, "未知状态值按 pending 收，不丢整条");
  // 未知工具名、TaskUpdate 指不存在的 id、TaskCreate 无标题
  assert.equal(applyTaskToolCall(id, "run_command", { command: "ls" }), null);
  assert.equal(applyTaskToolCall(id, "update_todos", TODOS), null, "没在映射表里的名字不认，不猜");
  assert.equal(applyTaskToolCall(id, "TaskUpdate", { taskId: "99", status: "completed" }), null);
  assert.equal(applyTaskToolCall(id, "TaskCreate", { subject: "" }), null);
  assert.equal(tasksEvents(id).length, n0 + 1, "只有那条可收的 TodoWrite 多发了一次");
  assert.equal(tasksOf(id).length, 1, "上一条把清单换成了 1 项的合法 TodoWrite");
  assert.equal(tasksOf(id)[0].status, "pending");
});

test("子代理的清单调用不并入主清单", () => {
  const id = sid();
  assert.equal(applyTaskToolCall(id, "TodoWrite", TODOS, { subagent: true }), null);
  assert.equal(tasksOf(id), null, "子代理的清单没进内存，tasksOf 仍是 null");
  assert.equal(tasksEvents(id).length, 0);
});

test("noteTaskTools：有清单工具但还没调用 → tasks:[] + unsupported:false；没有 → null + true；拿掉工具 → 自动退回", () => {
  const a = sid(), b = sid(), c = sid();
  noteTaskTools(a, ["run_command", "TodoWrite", "read"]);
  tasksCheck(a);
  assert.deepEqual(lastTasksEvent(a).tasks, []);
  assert.equal(lastTasksEvent(a).tasksUnsupported, false);
  assert.deepEqual(tasksOf(a), []);
  noteTaskTools(b, ["run_command", "read"]);
  tasksCheck(b);
  assert.equal(lastTasksEvent(b).tasks, null);
  assert.equal(lastTasksEvent(b).tasksUnsupported, true);
  // 某版 agy 拿掉清单工具：旧清单不再展示，退回不支持态
  applyTaskToolCall(c, "TodoWrite", TODOS);
  assert.equal(tasksOf(c).length, 3);
  noteTaskTools(c, ["run_command"]);
  assert.equal(tasksOf(c), null);
  assert.equal(tasksUnsupportedOf(c), true);
  assert.equal(lastTasksEvent(c).tasks, null);
  assert.equal(lastTasksEvent(c).tasksUnsupported, true);
  // init 没报 tools（空数组）不降级：不是“拿掉了”，是“没报”
  noteTaskTools(a, []);
  assert.deepEqual(tasksOf(a), []);
});

test("tasksCheck 去重：同一份清单第二轮不重复发", () => {
  const id = sid();
  applyTaskToolCall(id, "TodoWrite", TODOS);
  const n0 = tasksEvents(id).length;
  tasksCheck(id);
  tasksCheck(id);
  assert.equal(tasksEvents(id).length, n0, "applyTaskToolCall 已发过，轮末不再重复");
});

// ── JSONL 反推（打开旧会话 / 网关重启后重建清单）──
const cwd = fs.mkdtempSync(path.join(ws, "e05-jsonl-"));
after(() => fs.rmSync(cwd, { recursive: true, force: true }));
const toolUse = (id, name, input, n) => ({ type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: "t" + n, name, input }] },
  uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd, sessionId: id });

test("JSONL 反推：TodoWrite + 后续 TaskUpdate → 重建出最新清单；不支持标记为 false", () => {
  const id = sid();
  appendSessionRecord(id, cwd, toolUse(id, "TodoWrite", TODOS, 1));
  appendSessionRecord(id, cwd, toolUse(id, "TaskUpdate", { taskId: "2", status: "completed" }, 2));
  appendSessionRecord(id, cwd, toolUse(id, "run_command", { command: "ls" }, 3));
  assert.deepEqual(tasksOf(id), [
    { id: "1", subject: "列出 txt 文件", status: "completed", blocked: [] },
    { id: "2", subject: "数行数", status: "completed", blocked: [] },
    { id: "3", subject: "汇总成表", status: "pending", blocked: [] },
  ]);
  assert.equal(tasksUnsupportedOf(id), false);
});

test("JSONL 反推：只有 TaskUpdate、没有 TodoWrite 基线 → tasks:[]（知道有工具，拼不出清单，不编造）", () => {
  const id = sid();
  appendSessionRecord(id, cwd, toolUse(id, "TaskUpdate", { taskId: "1", status: "completed" }, 1));
  assert.deepEqual(tasksOf(id), []);
  assert.equal(tasksUnsupportedOf(id), false);
});

test("JSONL 反推：没有任何清单工具记录 → null + true；且不读 ~/.claude/tasks", () => {
  const id = sid();
  appendSessionRecord(id, cwd, toolUse(id, "run_command", { command: "ls" }, 1));
  assert.equal(tasksOf(id), null);
  assert.equal(tasksUnsupportedOf(id), true);
  assert.equal(tasksOf("not-a-real-session"), null);
});

test("B1：init 明确报无清单工具时，无内存清单的旧会话也不许从 JSONL 复活（网关重启后首轮）", () => {
  const id = sid();
  appendSessionRecord(id, cwd, toolUse(id, "TodoWrite", TODOS, 1));
  // 不经过任何内存累积：模拟网关重启后、旧会话从未打开过、首轮直接开跑（或定时任务会话）
  noteTaskTools(id, ["run_command", "read"]);
  assert.equal(tasksOf(id), null, "init 已报无清单工具，旧清单不许复活");
  assert.equal(tasksUnsupportedOf(id), true);
  assert.equal(tasksEvents(id).length, 0, "原来就没有内存清单，不多发一次事件");
});

// ── 真轮次：假 CLI 驱动 startRun（写法同 a0610-main-run.test.mjs）──
const root = fs.mkdtempSync(path.join(ws, "e05-run-"));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const SLEEP = ["/system/bin/sleep", "/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));
if (!SLEEP) throw new Error("找不到 sleep");
function script(steps, code = 0) {
  const body = steps.map((s) => s.raw ? s.raw : s.sleep ? `${SLEEP} ${s.sleep}` : `printf '%s\\n' ${JSON.stringify(JSON.stringify(s)).replace(/\$/g, "\\$")}`).join("\n");
  fs.writeFileSync(cli, `#!${sh}\n${body}\nexit ${code}\n`, { mode: 0o700 });
}
import { PATHS } from "../gw/config.mjs";
const previousPaths = { agy: PATHS.agy };
PATHS.agy = cli;
const { startRun } = await import("../gw/run.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const events = [];
const off2 = onPublish((ev) => events.push(ev));
after(() => {
  off2();
  Object.assign(PATHS, previousPaths);
  fs.rmSync(root, { recursive: true, force: true });
});
const endOf = (id) => events.find((e) => e.type === "run_end" && e.runId === id);
async function until(f, ms = 15000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }
const initEv = (s, tools) => ({ event: "init", conversation_id: s, init: { model: "fixture-model", tools, permission_mode: "default" } });
const resultEv = (s) => ({ event: "result", conversation_id: s, result: { status: "SUCCESS", response: "done", num_turns: 1, usage: { input_tokens: 1, output_tokens: 1 }, duration_seconds: 0 } });
const toolEv = (s, idx, name, input, sub) => ({ event: "step_update", conversation_id: s,
  step_update: { step_index: idx, step_type: "tool", state: "DONE", tool_info: { name, parameters: input },
    ...(sub ? { subagent_info: { subagents: [{ conversation_id: "sub-1", type_name: "sub" }] } } : {}) } });
const toolActiveEv = (s, idx, name, input, sub) => ({ event: "step_update", conversation_id: s,
  step_update: { step_index: idx, step_type: "tool", state: "ACTIVE", tool_info: { name, parameters: input },
    ...(sub ? { subagent_info: { subagents: [{ conversation_id: "sub-1", type_name: "sub" }] } } : {}) } });

test("真轮次：init.tools 含 TodoWrite + TodoWrite DONE → 收到带真实清单的 tasks 事件", async () => {
  const s = sid();
  script([initEv(s, ["TodoWrite", "run_command"]), toolEv(s, 0, "TodoWrite", TODOS), resultEv(s)], 0);
  await startRun({ id: "e05-live", message: "fixture", cwd: root });
  await until(() => endOf("e05-live"));
  const evs = events.filter((e) => e.type === "tasks" && e.sessionId === s);
  assert.ok(evs.length >= 1, "至少收到一次 tasks 事件");
  assert.deepEqual(evs[0].tasks, EXPECTED);
  assert.equal(evs[0].tasksUnsupported, false);
  assert.deepEqual(tasksOf(s), EXPECTED, "内存清单与事件一致");
});

test("真轮次：init.tools 无清单工具 → 轮末仍是 null + tasksUnsupported:true", async () => {
  const s = sid();
  script([initEv(s, ["run_command"]), resultEv(s)], 0);
  await startRun({ id: "e05-notools", message: "fixture", cwd: root });
  await until(() => endOf("e05-notools"));
  const evs = events.filter((e) => e.type === "tasks" && e.sessionId === s);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].tasks, null);
  assert.equal(evs[0].tasksUnsupported, true);
});

test("真轮次：子代理的 TodoWrite 不进主清单", async () => {
  const s = sid();
  script([initEv(s, ["TodoWrite"]), toolEv(s, 0, "TodoWrite", TODOS, true), resultEv(s)], 0);
  await startRun({ id: "e05-sub", message: "fixture", cwd: root });
  await until(() => endOf("e05-sub"));
  const evs = events.filter((e) => e.type === "tasks" && e.sessionId === s);
  assert.ok(!evs.some((e) => Array.isArray(e.tasks) && e.tasks.some((t) => t.subject === "列出 txt 文件")), "子代理的清单项绝不能出现在主清单事件里");
});

test("真轮次 B2：子代理标记只在 ACTIVE 步上、DONE 步不带时，子代理的 TodoWrite 也不进主清单", async () => {
  const s = sid();
  script([initEv(s, ["TodoWrite"]), toolActiveEv(s, 0, "TodoWrite", TODOS, true), toolEv(s, 0, "TodoWrite", TODOS), resultEv(s)], 0);
  await startRun({ id: "e05-sub-active", message: "fixture", cwd: root });
  await until(() => endOf("e05-sub-active"));
  const evs = events.filter((e) => e.type === "tasks" && e.sessionId === s);
  assert.ok(!evs.some((e) => Array.isArray(e.tasks) && e.tasks.some((t) => t.subject === "列出 txt 文件")), "标记只在 ACTIVE 步上时，子代理的清单项也不许进主清单事件");
});
