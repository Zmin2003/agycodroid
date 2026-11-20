// /goal 目标状态（gw/goal.mjs goalStateOf）：中间夹了大工具输出也不读成「没有目标」（0.6.9 审计 #190）
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { goalStateOf } from "../gw/goal.mjs";

const dir = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "a0610-goal-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const J = (o) => JSON.stringify(o) + "\n";
const T0 = "2026-11-08T01:00:00.000Z";
const sentinel = J({ type: "attachment", timestamp: T0, attachment: { type: "goal_status", met: false, sentinel: true, condition: "测试全过" } });
const check = J({ type: "attachment", timestamp: "2026-11-08T01:05:00.000Z", attachment: { type: "goal_status", met: false, condition: "测试全过", reason: "还差两条" } });
// 大工具输出：中文（多字节，读块的边界会切在字符中间）
const big = (mb) => J({ type: "user", message: { content: [{ type: "tool_result", content: "输出".repeat((mb << 20) / 6) }] } });
const clear = J({ type: "user", message: { content: "<command-name>/goal</command-name>\n<command-args>clear</command-args>" } });
const met = J({ type: "attachment", timestamp: "2026-11-08T02:00:00.000Z", attachment: { type: "goal_status", met: true, condition: "测试全过", iterations: 3 } });
let n = 0;
const file = (...parts) => { const f = path.join(dir, `s${++n}.jsonl`); fs.writeFileSync(f, parts.join("")); return f; };

test("设了目标、后面跟着 3MB 工具输出 → 还是 active，设定时间和检查次数都在", () => {
  const g = goalStateOf(file(sentinel, check, big(3)));
  assert.equal(g.active, true);
  assert.equal(g.setAt, Date.parse(T0));
  assert.equal(g.checks, 1);
  assert.equal(g.reason, "还差两条");
});

test("读过一次之后又追加大输出（走缓存只看新的一段）→ 还是 active；追加了 /goal clear → null；追加达成 → done", () => {
  const f = file(sentinel);
  assert.equal(goalStateOf(f).active, true);
  fs.appendFileSync(f, big(2));
  assert.equal(goalStateOf(f).active, true);
  fs.appendFileSync(f, big(6));                     // 超过只看新段的上限：整份重扫，照样找得到
  assert.equal(goalStateOf(f).active, true);
  fs.appendFileSync(f, clear);
  assert.equal(goalStateOf(f), null);
  fs.appendFileSync(f, sentinel + big(1) + met);
  const g = goalStateOf(f);
  assert.equal(g.done, true); assert.equal(g.met, true); assert.equal(g.iterations, 3);
});

test("从没设过目标 → null；记录读不了 → null", () => {
  assert.equal(goalStateOf(file(big(1), J({ type: "user", message: { content: "goal 这个词出现在正文里" } }))), null);
  assert.equal(goalStateOf(path.join(dir, "nope.jsonl")), null);
});

test("任务清单：~/.claude/tasks 里即使有文件也不读，tasksOf 一律 null（E05，V6 未验证前不编造）", async () => {
  const { CFG } = await import("../gw/config.mjs");
  const { tasksOf } = await import("../gw/goal.mjs");
  const sid = "11111111-2222-3333-4444-555555555555";
  const d = path.join(CFG.home, ".claude", "tasks", sid);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, "1.json"), JSON.stringify({ id: 1, subject: "假任务", status: "in_progress" }));
  try {
    assert.equal(tasksOf(sid), null);
    assert.equal(tasksOf("not-a-sid"), null);
  } finally { fs.rmSync(path.join(CFG.home, ".claude"), { recursive: true, force: true }); }
});

test("任务清单：tasksCheck 首轮结束就发出带 tasksUnsupported 的 tasks 事件（Review-A B2）", async () => {
  const { onPublish } = await import("../gw/bus.mjs");
  const { tasksCheck } = await import("../gw/goal.mjs");
  const sid = "22222222-3333-4444-5555-666666666666";
  const seen = [];
  const off = onPublish((ev) => { if (ev && ev.type === "tasks" && ev.sessionId === sid) seen.push(ev); });
  try {
    tasksCheck(sid);
    tasksCheck(sid);   // 同一会话第二轮不再重复发
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tasks, null);
    assert.equal(seen[0].tasksUnsupported, true);
  } finally { off(); }
});
