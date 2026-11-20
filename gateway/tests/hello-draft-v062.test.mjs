// v0.6.2 审查 #120-3：首个 hello 自动跟到别的会话时，草稿要按会话交接，不能把 A 的字/附件带进 B。
// 0.6.9 审计 195-P.7 改了前半句：本地已经记着会话时不再跟到别的轮次（否则覆盖最后查看的会话）；
// 只有本地没有会话号（新对话 / 刚装）时才跟。原「本地有 A、run 在 B 也切过去」的断言随之更新。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const sessionSource = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
const modelSource = fs.readFileSync(new URL("../web/app/12-model-caps.js", import.meta.url), "utf8");
const take = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end));
const nodes = () => ({ classList: { add() {}, remove() {} }, querySelector() { return null; }, childElementCount: 0, innerHTML: "" });

/** 跑一次真实的 resetView + onHello（只给它们要用的环境） */
function hello(viewSid, runSid) {
  const swaps = [];
  const view = { sessionId: viewSid, gen: 0, runIds: new Set(), cids: new Set(), next: null, anchor: "", cursor: null, title: "", pendingMerge: null };
  const state = { pendingModel: null };
  const box = {
    view, state, Set, Map, t: (s) => s, uiTag: "synthetic-ui", helloCount: 0,
    WROTE: new Map(), TOOL_CARDS: new Map(), TOOL_RESULTS: new Map(), clearToolResults() {}, dropCards() {}, PERMS: new Map(), runViews: new Map(),
    histEl: nodes(), liveEl: nodes(), olderEl: nodes(), statEl: nodes(), statLast: {}, statStop() {},
    stripHidden: () => ({}), paintTitle() {}, renderRunStrip() {}, renderPermBar() {}, agReset() {}, syncWindow() {}, pickViewRun() {}, renderQueue() {}, paintProjChip() {}, syncInterject() {}, saveUiState() {},
    applyState() {}, beginReplay() {}, updateCtx() {}, renderSessions() {}, loadOlder() {}, showWelcome() {}, renderInterrupted() {}, calmStatus() {}, refreshSessModel() {},
    isBusy: () => false, setStatus() {}, intrList: () => [],
    draftSwap: (from, to) => swaps.push([from, to]),
  };
  vm.runInNewContext(
    take(sessionSource, "  function resetView(", "  /** 打开某个会话") +
    take(sessionSource, "  function onHello(", "  /** 「已连接」") +
    "\nglobalThis.handoff = { onHello };",
    box,
  );
  box.handoff.onHello({ uiTag: "synthetic-ui", resume: false, interrupted: [], run: { id: "r1", sessionId: runSid, ended: false } });
  return { swaps, view };
}

test("本地记着会话时首次 hello 不跟别的轮次（0.6.9 审计 195-P.7）", () => {
  const { swaps, view } = hello("session-a", "session-b");
  assert.deepEqual(swaps, []);
  assert.equal(view.sessionId, "session-a");
});

test("首次 hello 跟的就是眼前这个会话：不动草稿", () => {
  const { swaps, view } = hello("session-a", "session-a");
  assert.deepEqual(swaps, []);
  assert.equal(view.sessionId, "session-a");
});

test("本地没有会话号时首次 hello 才跟：跟到另一个会话，草稿按会话交接（#120-3）", () => {
  const { swaps, view } = hello(null, "session-b");
  assert.deepEqual(swaps, [[null, "session-b"]]);
  assert.equal(view.sessionId, "session-b");
});

test("本地没有会话号、在跑的轮次也还没拿到会话号：留在新对话页，草稿不用搬", () => {
  const { swaps, view } = hello(null, null);
  assert.deepEqual(swaps, []);
  assert.equal(view.sessionId, null);
});

// 由 bridge-config-ui.test.mjs 移入（旧桥删除，2026-11-20）：钉选是通用行为，与桥无关，
// 只是原来借了桥的 provider id 当例子；这里改成非桥的 synthetic 值。
test("session handoff: real onHello preserves a new-session pin before model refresh, explicit switches still clear it", async () => {
  const modelQueries = [], refreshes = [], state = { pendingModel: null }, view = { sessionId: "existing-session", runIds: new Set(), cids: new Set(), gen: 0 };
  const box = {
    URL, state, view, Set, Map, t: (s) => s, uiTag: "synthetic-ui", helloCount: 1, busReplay: false, welKeep: null,
    WROTE: new Map(), TOOL_CARDS: new Map(), TOOL_RESULTS: new Map(), clearToolResults() {}, dropCards() {}, PERMS: new Map(), runViews: new Map(),
    histEl: nodes(), liveEl: nodes(), olderEl: nodes(), statEl: nodes(),
    stripHidden: () => ({}), paintTitle() {}, renderRunStrip() {}, renderPermBar() {}, agReset() {}, syncWindow() {}, pickViewRun() {}, renderQueue() {}, paintProjChip() {}, syncInterject() {}, saveUiState() {},
    applyState() {}, beginReplay() {}, updateCtx() {}, renderSessions() {}, loadOlder() {}, showWelcome() {}, renderInterrupted() {}, calmStatus() {},
    paintModel() {}, chipName: () => "synthetic-model", loadCtxModel() {}, provChanged() {}, statStop() {}, statLast: {},
    api: async (url) => {
      modelQueries.push(url);
      const u = new URL(url, "https://synthetic.invalid");
      return { provider: u.searchParams.get("provider") || "global-provider", model: u.searchParams.get("model") || "global-model" };
    },
    refreshObserved() { refreshes.push(state.pendingModel && { ...state.pendingModel }); },
  };
  // Run the production query / refresh and hello / reset functions, not a reimplementation of their ordering.
  vm.runInNewContext(
    take(modelSource, "  const sidQ =", "  // 会话用的那家变了") +
    take(sessionSource, "  function resetView(", "  /** 打开某个会话") +
    take(sessionSource, "  function onHello(", "  /** 「已连接」") +
    "\nconst actualRefresh = refreshSessModel; refreshSessModel = () => { refreshObserved(); return actualRefresh(); }; globalThis.handoff = { onHello, resetView };", box,
  );
  box.handoff.resetView(null);
  const pin = { provider: "synthetic-provider", model: "synthetic-pinned-model", effort: "high" };
  state.pendingModel = pin; view.projectId = "synthetic-project"; view.pendingMerge = [{ session: "synthetic-source" }];
  box.handoff.onHello({ uiTag: "synthetic-ui", runs: [], run: null, resume: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.pendingModel, pin, "the selection survives the fresh SSE hello");
  assert.deepEqual(refreshes.at(-1), pin, "refresh sees the pin immediately, never the global default");
  assert.match(modelQueries.at(-1), /provider=synthetic-provider/);
  assert.match(modelQueries.at(-1), /model=synthetic-pinned-model/);
  assert.equal(state.sessEff.provider, "synthetic-provider");
  assert.equal(view.projectId, "synthetic-project");
  assert.deepEqual(view.pendingMerge, [{ session: "synthetic-source" }]);
  box.handoff.onHello({ uiTag: "synthetic-ui", runs: [], resume: false });
  await Promise.resolve();
  assert.equal(state.pendingModel, pin, "a later non-resumable reconnect also keeps the same draft selection");
  box.handoff.resetView(null);
  assert.equal(state.pendingModel, null, "explicitly opening a new conversation starts with a clean selection");
  state.pendingModel = pin;
  box.handoff.resetView("different-session", true);
  assert.equal(state.pendingModel, null, "an existing session can never inherit a new-session pin");
});
