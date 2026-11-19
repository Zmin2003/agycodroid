// 新会话侧栏不显示：记录文件落盘后由网关广播 session_created，前端收到重读列表；
// 续不上的重连（resume=false）也按磁盘重读。这里测两端契约。
// 移植：harness 改成 agy 事件（init / step_update text_delta / result）；
// 行为变化：第 3 条在 agy 下反过来了——网关自己在 init 时就把用户消息落盘
// （flushRecords），所以 init 后文件一定在，session_created 一定会报一次。
import { PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import vm from "node:vm";

const home = process.env.AGAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "session-created-"));
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
const { listSessions } = await import("../gw/sessions.mjs");
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
const createdOf = (id) => events.filter((e) => e.type === "session_created" && e.runId === id);
async function until(f, ms = 15000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }
const init = (s) => ({ event: "init", conversation_id: s, init: { model: "fixture-model", tools: [], permission_mode: "default" } });
const result = (s) => ({ event: "result", result: { conversation_id: s, num_turns: 1, status: "SUCCESS", response: "done", usage: { input_tokens: 1, output_tokens: 1 } } });
const delta = { event: "step_update", step_update: { step_index: 0, agent_response: { type: "text_delta", text: "hi" } } };
// 和 sessions.mjs 的 projEnc 同一算法：临时目录都很短，不会走哈希分支
const projEnc = (p) => { const s = p.replace(/[^a-zA-Z0-9]/g, "-"); return s.length <= 200 ? s : s.slice(0, 200) + "-" + crypto.createHash("sha256").update(p).digest("hex").slice(0, 8); };
const realRoot = (() => { try { return fs.realpathSync(root); } catch { return root; } })();
const proj = path.join(PATHS.projects, projEnc(realRoot));
const transcriptOf = (sid) => path.join(proj, sid + ".jsonl");
const lineFor = (sid) => JSON.stringify({ type: "user", sessionId: sid, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), message: { role: "user", content: "fixture" } });
const writeStep = (sid) => {
  const file = transcriptOf(sid);
  return { raw: `mkdir -p '${proj}' && printf '%s\\n' '${lineFor(sid)}' > '${file}'` };
};

test("新会话：jsonl 落盘后的下一个事件广播 session_created，列表当场能查到；只报一次", async () => {
  const sid = crypto.randomUUID();
  // init 时网关自己的记录还没落盘（flush 在 onInit 里，文件在 init 事件处理中才出现）→
  // 0.15s 后 CLI 写文件 → 下一个 step_update 时已在磁盘（报，且只报一次）
  script([init(sid), { sleep: 0.15 }, writeStep(sid), { sleep: 0.15 }, delta, { sleep: 0.1 }, result(sid)], 0);
  let atCreated = null, createdCount = 0;
  const watch = onPublish((ev) => {
    if (ev.type !== "session_created" || ev.runId !== "a070-created") return;
    createdCount++;
    atCreated = { ev, list: listSessions().map((s) => s.id) };
  });
  try {
    await startRun({ id: "a070-created", message: "fixture", cwd: root });
    await until(() => endOf("a070-created"));
  } finally { watch(); }
  const made = createdOf("a070-created");
  assert.equal(made.length, 1, "同一个新会话只广播一次");
  assert.equal(createdCount, 1);
  assert.equal(made[0].sessionId, sid);
  assert.equal(made[0].cwd, root);
  assert.ok(atCreated, "收到过 session_created");
  assert.ok(atCreated.list.includes(sid), "广播时 /api/sessions 已经能查到这份记录（不是猜时间）");
  const iInit = events.findIndex((e) => e.type === "init" && e.sessionId === sid);
  const iMade = events.findIndex((e) => e.type === "session_created" && e.sessionId === sid);
  const iEnd = events.findIndex((e) => e.type === "run_end" && e.runId === "a070-created");
  assert.ok(iInit >= 0 && iInit < iMade, "init 之后才报");
  assert.ok(iMade < iEnd, "不等这一轮结束：run_end 之前就把会话交给侧栏");
  assert.equal(fs.existsSync(transcriptOf(sid)), true);
});

test("新会话：第一个增量就广播（长回答不必等 assistant / run_end）", async () => {
  const sid = crypto.randomUUID();
  script([
    init(sid), writeStep(sid),
    delta,
    { sleep: 0.1 }, result(sid),
  ], 0);
  await startRun({ id: "a070-stream", message: "fixture", cwd: root });
  await until(() => endOf("a070-stream"));
  const made = createdOf("a070-stream");
  assert.equal(made.length, 1);
  const iMade = events.findIndex((e) => e.type === "session_created" && e.runId === "a070-stream");
  const iEnd = events.findIndex((e) => e.type === "run_end" && e.runId === "a070-stream");
  assert.ok(iMade >= 0 && iMade < iEnd, "结果 / 收尾之前就把会话交给侧栏");
});

test("init 后网关自己的记录就已落盘：就算 CLI 没写文件，session_created 也只报一次", async () => {
  const sid = crypto.randomUUID();
  script([init(sid), { sleep: 0.1 }, delta, result(sid)], 0);
  await startRun({ id: "a070-nofile", message: "fixture", cwd: root });
  await until(() => endOf("a070-nofile"));
  assert.equal(createdOf("a070-nofile").length, 1, "网关在 init 时把用户消息落盘，文件一定在");
});

test("续跑已有会话：文件本来就在，不广播 session_created（那不是新建）", async () => {
  const sid = crypto.randomUUID();
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(transcriptOf(sid), lineFor(sid) + "\n");
  script([init(sid), delta, result(sid)], 0);
  await startRun({ id: "a070-resume", message: "fixture", cwd: root, sessionId: sid });
  await until(() => endOf("a070-resume"));
  assert.equal(createdOf("a070-resume").length, 0);
});

// ── 前端契约：session_created 重读列表；续不上的重连也重读 ──────────────
const sessionSource = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
const take = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end));
const nodes = () => ({ classList: { add() {}, remove() {} }, querySelector() { return null; }, childElementCount: 0, innerHTML: "" });

test("前端：session_created 事件重读会话列表", () => {
  assert.match(sessionSource, /case "session_created": return loadSessions\(\);/);
});

function runHello(helloCount, resume, dropped) {
  const calls = { sessions: 0 };
  const view = { sessionId: "s-a", gen: 0, runIds: new Set(), cids: new Set(), next: null, anchor: "", cursor: null, title: "", pendingMerge: null };
  const box = {
    view, state: { pendingModel: null }, Set, Map, t: (s) => s, uiTag: "synthetic-ui", helloCount, stick: false, busDropped: dropped,
    WROTE: new Map(), TOOL_CARDS: new Map(), TOOL_RESULTS: new Map(), clearToolResults() {}, dropCards() {}, PERMS: new Map(), runViews: new Map(),
    histEl: nodes(), liveEl: nodes(), olderEl: nodes(), statEl: nodes(), statLast: {}, statStop() {},
    stripHidden: () => ({}), paintTitle() {}, renderRunStrip() {}, renderPermBar() {}, agReset() {}, syncWindow() {}, pickViewRun() {}, renderQueue() {}, paintProjChip() {}, syncInterject() {}, saveUiState() {},
    applyState() {}, beginReplay() {}, updateCtx() {}, renderSessions() {}, loadOlder() {}, showWelcome() {}, renderInterrupted() {}, calmStatus() {}, refreshSessModel() {},
    isBusy: () => false, setStatus() {}, intrList: () => [],
    draftSwap() {}, loadSessions: () => { calls.sessions++; },
  };
  vm.runInNewContext(
    take(sessionSource, "  function resetView(", "  /** 打开某个会话") +
    take(sessionSource, "  function onHello(", "  /** 「已连接」") +
    "\nglobalThis.handoff = { onHello };",
    box,
  );
  box.handoff.onHello({ uiTag: "synthetic-ui", resume, interrupted: [], run: null });
  return calls;
}

test("前端：首次连接不重复拉列表（boot 已经拉过）", () => {
  assert.equal(runHello(0, false, false).sessions, 0);
});
test("前端：换视图的主动重放（连接没断过）不重拉列表", () => {
  assert.equal(runHello(3, false, false).sessions, 0);
});
test("前端：断线后还续得上（resume=true）靠补发事件，不重拉列表", () => {
  assert.equal(runHello(1, true, true).sessions, 0);
});
test("前端：断线后续不上（resume=false）的重连按磁盘重读列表", () => {
  assert.equal(runHello(1, false, true).sessions, 1);
});
