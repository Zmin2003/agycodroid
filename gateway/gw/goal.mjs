import fs from "node:fs";
import { LIVE } from "./config.mjs";
import { findSessionFile } from "./sessions.mjs";
import { RUNS } from "./runs.mjs";
import { publish } from "./bus.mjs";

// ── /goal 目标（上游 2.1.x：设一个完成条件，Antigravity 跨轮一直干到满足为止）──
// -p 模式下目标状态不进事件流，只记在会话记录里：attachment.type === "goal_status"
//   设定 → {met:false, sentinel:true, condition}；没达成 → {met:false, condition, reason}；
//   达成 → {met:true, iterations, durationMs, tokens}；做不到 → {failed:true, reason}
// 「/goal clear」（stop/off/reset/none/cancel 同义）只留一条命令记录，没有 goal_status，要自己认。
const GOAL_CLEAR = new Set(["clear", "stop", "off", "reset", "none", "cancel"]);
// 以前只读最后 512KB：中间夹一个大的工具输出，目标那条就被挤出窗口，读成 null——没人清目标，界面却收到「目标没了」（0.6.9 审计 #190）。
// 现在从尾往前一块块读，读到能下结论为止（最多 GOAL_SCAN_MAX）；结果按文件记住，之后只看新追加的那段：
// 新的一段里连 goal 这个词都没有，结论不会变，直接沿用，不用每 4 秒把大文件重扫一遍
const GOAL_CHUNK = 1 << 20, GOAL_SCAN_MAX = 64 << 20, GOAL_TAIL_MAX = 4 << 20;
const GOAL_CACHE = new Map();   // 文件 → { ino, size, g }
export function goalStateOf(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const c = GOAL_CACHE.get(file);
  if (c && c.ino === st.ino && st.size >= c.size) {
    if (st.size === c.size) return c.g;
    if (st.size - c.size <= GOAL_TAIL_MAX) {
      const add = readRange(file, c.size, st.size - c.size);
      if (add != null && !add.includes("goal")) { c.size = st.size; return c.g; }
    }
  }
  let g = scanGoal(file, st.size);
  if (g === undefined) g = c && c.ino === st.ino ? c.g : null;   // 读满上限也没找到：有上次的结论就沿用，别读成「没有目标」
  GOAL_CACHE.delete(file); GOAL_CACHE.set(file, { ino: st.ino, size: st.size, g });
  if (GOAL_CACHE.size > 200) GOAL_CACHE.delete(GOAL_CACHE.keys().next().value);
  return g;
}
function readRange(file, pos, n) {
  try {
    const fd = fs.openSync(file, "r");
    try { const b = Buffer.alloc(n); const got = fs.readSync(fd, b, 0, n, pos); return b.subarray(0, got).toString("latin1"); } finally { fs.closeSync(fd); }
  } catch { return null; }
}
/** 从尾往前找目标状态。返回状态 / null（没有目标、或最近一次是清除）/ undefined（读满上限还没下结论） */
function scanGoal(file, size) {
  let last = null, lastAt = 0, setAt = null, checks = 0, done = false, cleared = false;
  const step = (l) => {
    if (!l.includes("goal")) return false;
    let e; try { e = JSON.parse(l); } catch { return false; }
    if (!last && e.type === "user" && typeof e.message?.content === "string") {
      const m = e.message.content.match(/<command-name>\/goal<\/command-name>[\s\S]*?<command-args>([\s\S]*?)<\/command-args>/);
      if (m && GOAL_CLEAR.has(m[1].trim().toLowerCase())) { cleared = true; return true; }   // 最近一次是清除
    }
    const a = e.type === "attachment" && e.attachment?.type === "goal_status" ? e.attachment : null;
    if (!a) return false;
    if (!last) { last = a; lastAt = Date.parse(e.timestamp) || 0; if (a.met || a.failed) return true; }
    if (a.condition !== last.condition) return true;
    if (a.sentinel) { setAt = Date.parse(e.timestamp) || null; return true; }
    if (!a.met) checks++;
    return false;
  };
  let fd; try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    let pos = size, carry = Buffer.alloc(0), read = 0;
    while (pos > 0 && !done) {
      if (read >= GOAL_SCAN_MAX) break;
      const n = Math.min(GOAL_CHUNK, pos); pos -= n; read += n;
      const b = Buffer.alloc(n); fs.readSync(fd, b, 0, n, pos);
      const buf = carry.length ? Buffer.concat([b, carry]) : b;
      // 按字节找换行再解码：一块的开头可能切在多字节字符中间，留到下一块拼上
      let end = buf.length;
      for (let k = buf.length - 1; k >= 0 && !done; k--) {
        if (buf[k] !== 10) continue;
        if (step(buf.toString("utf8", k + 1, end))) done = true;
        end = k;
      }
      carry = buf.subarray(0, end);
    }
    if (!done && pos === 0 && carry.length && step(carry.toString("utf8"))) done = true;
    if (!done && pos > 0) return last ? result() : undefined;   // 没读到头
  } catch { return null; } finally { try { fs.closeSync(fd); } catch {} }
  return cleared || !last ? null : result();
  function result() {
    const base = { condition: String(last.condition || "").slice(0, 600), at: lastAt };
    if (last.met || last.failed) return { ...base, done: true, met: !!last.met, failed: !!last.failed, reason: String(last.reason || "").slice(0, 600),
      iterations: last.iterations ?? null, durationMs: last.durationMs ?? null, tokens: last.tokens ?? null };
    return { ...base, active: true, setAt, checks, reason: last.sentinel ? "" : String(last.reason || "").slice(0, 600) };
  }
}
// 跑着的时候每 4 秒看一眼（只看有会话号的轮），变了才推；每轮结束再补看一次（见 endRun），最后那次达成不会漏
const GOAL_SEEN = new Map();   // 会话号 → 上次推出去的 JSON
export function goalCheck(sid) {
  const f = sid && findSessionFile(sid);
  if (!f) return;
  const g = goalStateOf(f.file), j = JSON.stringify(g);
  if (GOAL_SEEN.get(sid) === j) return;
  GOAL_SEEN.set(sid, j);
  if (GOAL_SEEN.size > 200) GOAL_SEEN.delete(GOAL_SEEN.keys().next().value);
  publish({ type: "goal", sessionId: sid, goal: g });
}
if (LIVE) setInterval(() => { for (const r of RUNS.values()) { goalCheck(r.sessionId); } }, 4000).unref?.();

// 任务清单（E05 方案 A，分叉防御式）：agy 不发任务列表事件（stream-json 只有
// init / step_update / result），唯一可接的数据源是工具调用本身——如果 agy 的
// init.tools 里有 TodoWrite / TaskCreate / TaskUpdate / TaskList / TaskGet 这类
// 清单工具，网关就从 step_update 的 tool 步骤实时累积每会话一份清单（拦截点在
// run.mjs 的 recordStep，工具 DONE 时确认）；没有就保持惰性，照旧发 tasksUnsupported。
// V6 未验证：agy 到底有没有这些工具、入参形状是不是 Claude 侧的约定，本地无法
// 证实——下面的名字与形状只是按 Claude 侧约定列的映射表，真机实测后扩充；
// 形状对不上的调用直接忽略（fail-safe），绝不从模型正文解析步骤、绝不把工具
// 调用序列冒充任务清单。任务项形状沿用旧 tasksOf 的：{id, subject, status, active, blocked}，
// status 取 completed / in_progress / pending；上限 60 项沿用旧值。
// 三档空态（网关 → 前端）：有清单 → tasks:[…] + unsupported:false（面板）；
// 有工具无清单 → tasks:[] + unsupported:false（中性“暂无任务”）；
// 无工具 → tasks:null + unsupported:true（“Antigravity 不上报任务列表”）。
export const TASK_TOOL_NAMES = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet"]);
const TASKS_MAX = 60;
const TASK_LISTS = new Map();   // 会话号 → { items: [...], hasTools: true }（只记确认有清单工具的会话）
const TASKS_DROPPED = new Set();   // init 明确报过“没有清单工具”的会话：JSONL 反推也不许把旧清单复活
const copyTasks = (items) => (items || []).map((x) => ({ ...x }));
const maxTaskId = (items) => items.reduce((m, x) => { const n = parseInt(x.id, 10); return Number.isFinite(n) ? Math.max(m, n) : m; }, 0);
function normStatus(s) {
  const v = String(s || "").trim().toLowerCase().replace(/-/g, "_").replace(/\s+/g, "_");
  return v === "completed" || v === "complete" ? "completed" : v === "in_progress" ? "in_progress" : "pending";
}
function pickSubject(raw) {
  if (!raw || typeof raw !== "object") return "";
  for (const k of ["content", "subject", "description"]) {
    if (typeof raw[k] === "string" && raw[k].trim()) return raw[k].trim().slice(0, 600);
  }
  return "";
}
function activeFormOf(raw) {
  return raw && typeof raw.activeForm === "string" && raw.activeForm.trim() ? raw.activeForm.trim().slice(0, 200) : "";
}
function parseTodoItem(raw, idx) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const subject = pickSubject(raw);
  if (!subject) return null;
  const status = normStatus(raw.status);
  const item = { id: String(idx + 1), subject, status, blocked: [] };
  if (status === "in_progress") { const a = activeFormOf(raw); if (a) item.active = a; }
  return item;
}
/** 解析一次清单工具调用。返回 null = 形状对不上，当次调用直接忽略（不发事件、不改清单）。 */
function parseTaskToolCall(name, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (name === "TodoWrite") {
    if (!Array.isArray(input.todos)) return null;
    const items = [];
    for (const raw of input.todos) { const it = parseTodoItem(raw, items.length); if (it) items.push(it); }
    // 非空 todos 但一条都认不出来：当次调用忽略，别拿空清单盖掉一份好的
    if (input.todos.length && !items.length) return null;
    return { kind: "replace", items };
  }
  if (name === "TaskCreate") {
    const subject = pickSubject(input);
    if (!subject) return null;
    const item = { subject, status: normStatus(input.status), blocked: [] };
    const wantId = input.id ?? input.taskId;
    if (wantId !== undefined && wantId !== null && String(wantId).trim()) item.id = String(wantId).trim().slice(0, 64);
    if (item.status === "in_progress") { const a = activeFormOf(input); if (a) item.active = a; }
    return { kind: "create", item };
  }
  if (name === "TaskUpdate") {
    const rawId = input.taskId ?? input.id;
    if (rawId === undefined || rawId === null || !String(rawId).trim()) return null;
    const patch = {};
    if (typeof input.status === "string" && input.status.trim()) patch.status = normStatus(input.status);
    const subject = pickSubject(input);
    if (subject) patch.subject = subject;
    if (patch.status === "in_progress") { const a = activeFormOf(input); if (a) patch.active = a; }
    if (!Object.keys(patch).length) return null;
    return { kind: "update", id: String(rawId).trim().slice(0, 64), patch };
  }
  if (name === "TaskList" || name === "TaskGet") return { kind: "mark" };   // 只读：只证明工具有，不动清单
  return null;
}
/** 对一份清单应用一次解析好的调用；没变返回原数组。 */
function replayOp(items, op) {
  if (op.kind === "replace") return op.items;
  if (op.kind === "create") {
    const item = { ...op.item };
    if (!item.id) item.id = String(maxTaskId(items) + 1);
    else if (items.some((x) => x.id === item.id)) return items;   // id 已存在：不重复加
    const next = [...items, item];
    while (next.length > TASKS_MAX) { const ci = next.findIndex((x) => x.status === "completed"); next.splice(ci >= 0 ? ci : 0, 1); }
    return next;
  }
  if (op.kind === "update") {
    const i = items.findIndex((x) => x.id === op.id);
    if (i < 0) return items;
    const patched = { ...items[i], ...op.patch };
    if (patched.status !== "in_progress") delete patched.active;   // 不再进行中：“正在做”不残留
    if (JSON.stringify(patched) === JSON.stringify(items[i])) return items;
    const next = items.slice(); next[i] = patched; return next;
  }
  return items;   // mark
}
/** run.mjs 在工具 DONE 时调：累积一次清单调用。清单变了（或刚确认有工具）就立即发
 *  tasks 事件，不等轮末；形状不对 / 子代理的调用返回 null，什么都不做。 */
export function applyTaskToolCall(sid, name, input, opts = {}) {
  if (!sid || typeof sid !== "string" || !TASK_TOOL_NAMES.has(name) || opts.subagent) return null;
  const parsed = parseTaskToolCall(name, input);
  if (!parsed) return null;
  const prev = TASK_LISTS.get(sid);
  const hadTools = !!prev?.hasTools;
  const items = prev ? prev.items : [];
  const next = replayOp(items, parsed);
  const changed = JSON.stringify(next) !== JSON.stringify(items);
  if (!changed && hadTools) return null;
  TASKS_DROPPED.delete(sid);
  TASK_LISTS.set(sid, { items: next, hasTools: true });
  if (TASK_LISTS.size > 200) TASK_LISTS.delete(TASK_LISTS.keys().next().value);
  if (changed || !hadTools) publishTasks(sid, copyTasks(next), false);
  return changed ? copyTasks(next) : null;
}
/** run.mjs 在 init 时调：登记这台 agy 报的工具里有没有清单工具。
 *  tools 为空数组（init 没报）不降级——那是“没报”，不是“拿掉了”。
 *  明确报了、里面没有：某版 agy 拿掉了清单工具，自动退回不支持态，旧清单不再展示
 *  （不是删数据——JSONL 里还有调用记录，只是模型再也不会更新它；TASKS_DROPPED
 *  拦住 tasksOf 的 JSONL 反推，不许把旧清单复活）。 */
export function noteTaskTools(sid, tools) {
  if (!sid || typeof sid !== "string" || !Array.isArray(tools) || !tools.length) return;
  if (tools.some((t) => TASK_TOOL_NAMES.has(String(t)))) {
    TASKS_DROPPED.delete(sid);
    const mem = TASK_LISTS.get(sid);
    if (!mem) TASK_LISTS.set(sid, { items: [], hasTools: true });
    else mem.hasTools = true;
    return;
  }
  // 无内存清单也要记 TASKS_DROPPED：否则 tasksOf 会从 JSONL 把旧清单复活
  // （网关重启后、旧会话从未打开过、首轮直接开跑时内存里没有清单——B1）。
  // publishTasks 只在原来有内存清单时发：无清单会话本来就没展示过旧清单，不多发一次事件。
  TASKS_DROPPED.add(sid);
  if (TASK_LISTS.has(sid)) { TASK_LISTS.delete(sid); publishTasks(sid, null, true); }
}
const TASKS_SEEN = new Map();
function publishTasks(sid, tasks, unsupported) {
  const j = JSON.stringify([tasks, unsupported]);
  if (TASKS_SEEN.get(sid) === j) return false;
  TASKS_SEEN.set(sid, j);
  if (TASKS_SEEN.size > 200) TASKS_SEEN.delete(TASKS_SEEN.keys().next().value);
  publish({ type: "tasks", sessionId: sid, tasks, tasksUnsupported: unsupported });
  return true;
}
/** 内存清单优先；没有就从会话 JSONL 反推（打开旧会话 / 网关重启后重建）。
 *  有工具无清单 → []（中性空态）；没有任何清单工具证据 → null（不支持态）。
 *  从不读 ~/.claude/tasks——那是另一个工具的旧数据，会话号也不对应 agy 的会话号。 */
export function tasksOf(sid) {
  if (!sid || typeof sid !== "string" || TASKS_DROPPED.has(sid)) return null;
  const mem = TASK_LISTS.get(sid);
  if (mem) return copyTasks(mem.items);
  const found = findSessionFile(sid);
  if (!found) return null;
  const scanned = scanTasksFile(found.file);
  if (!scanned || !scanned.hasTools) return null;
  TASK_LISTS.set(sid, { items: scanned.items, hasTools: true });
  if (TASK_LISTS.size > 200) TASK_LISTS.delete(TASK_LISTS.keys().next().value);
  return copyTasks(scanned.items);
}
/** 不支持态 = tasksOf 拿不到任何清单工具证据（null）；[] 与真实清单都是“有工具”。 */
export function tasksUnsupportedOf(sid) {
  return tasksOf(sid) === null;
}
const TASKS_SCAN_MAX = 8 << 20;
const TASKS_JSONL_CACHE = new Map();   // 文件 → { ino, size, scanned }
function scanTasksFile(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const c = TASKS_JSONL_CACHE.get(file);
  if (c && c.ino === st.ino && c.size === st.size) return c.scanned;
  const scanned = scanTasksTail(file, st.size);
  TASKS_JSONL_CACHE.set(file, { ino: st.ino, size: st.size, scanned });
  if (TASKS_JSONL_CACHE.size > 200) TASKS_JSONL_CACHE.delete(TASKS_JSONL_CACHE.keys().next().value);
  return scanned;
}
/** 从尾往前扫最多 8MB：找最近一次 TodoWrite 当基线，再按时间正序重放它之后的
 *  TaskCreate / TaskUpdate。扫满上限仍无 TodoWrite、但见过清单工具调用 →
 *  { items: [], hasTools: true }（知道有工具，拼不出清单，不编造）。
 *  什么都没见过 → null。
 *  已知局限：子代理的清单调用在记录里没有标记（recordStep 照常记进主记录），
 *  反推时分不出来——重建的清单可能含子代理的项。只在“打开旧会话”时影响显示，
 *  跑动中的实时清单不受影响（那条路子代理的调用已被 applyTaskToolCall 拦掉）。 */
function scanTasksTail(file, size) {
  let fd; try { fd = fs.openSync(file, "r"); } catch { return null; }
  try {
    const n = Math.min(TASKS_SCAN_MAX, size);
    const buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    const lines = buf.toString("utf8").split("\n");
    const ops = [];   // 从新到旧收集
    let done = false;
    for (let i = lines.length - 1; i >= 0 && !done; i--) {
      const line = lines[i];
      if (!line.includes("tool_use")) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      const blocks = ev.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (let j = blocks.length - 1; j >= 0; j--) {   // 同一条记录里多个 tool_use：从新到旧收
        const b = blocks[j];
        if (!b || b.type !== "tool_use" || !TASK_TOOL_NAMES.has(b.name)) continue;
        const parsed = parseTaskToolCall(b.name, b.input);
        if (!parsed) continue;   // 形状对不上：跳过这条，不影响别的
        ops.push(parsed);
        if (parsed.kind === "replace") done = true;   // 找到最近的基线：更早的调用都被它盖掉了
        if (done) break;
      }
    }
    if (!ops.length) return null;
    let items = [];
    for (const op of ops.reverse()) items = replayOp(items, op);   // 正序重放：基线 + 之后的增量
    return { items, hasTools: true };
  } catch { return null; } finally { try { fs.closeSync(fd); } catch {} }
}
export function tasksCheck(sid) {
  if (!sid) return;
  const t = tasksOf(sid);
  // 去重和 goalCheck 同款：只认“上次发过的值”，且把 tasks 与 tasksUnsupported 一起算——
  // tasks 还是 null、标记却从 true 翻成 false 时也得重发（Review-A B2 的守卫修的是首轮不发，这里防的是翻态漏发）。
  publishTasks(sid, t, t === null);
}
