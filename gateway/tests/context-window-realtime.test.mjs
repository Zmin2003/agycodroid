// 04 实时用量消费 SSE 的 contextWindow 字段（W1 在 stream.mjs 的 contextUsage 里发，
// 04:1049 回放路径已读它，只差实时路径）：带字段时用量条的分母更新成新窗口，
// 没字段 / 字段为 0 时沿用已有的 state.ctxTotal，绝不拿 0 当分母。
// 切片做法见 hello-draft-v062.test.mjs：把真实的 liveCtx/updateCtx 与 onBus 切出来跑。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
const take = (start, end) => {
  const a = src.indexOf(start), b = src.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return src.slice(a, b);
};

function box() {
  const ctxEl = { textContent: "" };
  const b = {
    view: { sessionId: "s1", ctxAt: 0 },
    state: { ctxUsed: 0, ctxTotal: 0, compactAt: 0 },
    runViews: new Map([["r1", { av: {} }]]),
    runSid: new Map(),
    busReplay: false,
    ctxEl,
    ctxFill: { style: {} },
    ctxBar: { classList: { add() {}, remove() {}, contains: () => false }, style: { setProperty() {} } },
    $: (id) => (id === "ctxctx" ? ctxEl : { textContent: "" }),
    saveUiState() {},
    t: (s, o) => String(s).replace(/\{(\w+)\}/g, (_, n) => o?.[n] ?? ""),
    setInterval: () => 1,
    clearInterval() {},
  };
  vm.runInNewContext(
    take("  function fmtTok(n) {", "  // ── 会话切换") +
    take("  function onBus(ev) {", "  function onHello(ev) {") +
    "\nglobalThis.bus = onBus;",
    b,
  );
  return b;
}
const usage = (extra) => ({ type: "usage", runId: "r1", contextTokens: 5000, ...extra });

test("实时 usage 带 contextWindow → 用量条分母更新成新窗口", () => {
  const b = box();
  b.bus(usage({ contextWindow: 1000000 }));
  assert.equal(b.state.ctxTotal, 1000000);
  assert.equal(b.state.ctxUsed, 5000);
  assert.match(b.ctxEl.textContent, /1\.00M/, "分母按 1000000 显示");
});

test("实时 usage 没带 contextWindow → 沿用已有的分母", () => {
  const b = box();
  b.state.ctxTotal = 200000;
  b.bus(usage({}));
  assert.equal(b.state.ctxTotal, 200000);
  assert.match(b.ctxEl.textContent, /200k/, "分母仍是旧的 200000");
});

test("实时 usage 的 contextWindow 是 0 → 不拿 0 当分母，沿用旧值", () => {
  const b = box();
  b.state.ctxTotal = 200000;
  b.bus(usage({ contextWindow: 0 }));
  assert.equal(b.state.ctxTotal, 200000);
});

test("实时 usage 先学到窗口、再来一条没带字段的 → 分母不被旧值盖回去", () => {
  const b = box();
  b.bus(usage({ contextWindow: 1000000 }));
  b.bus(usage({}));
  assert.equal(b.state.ctxTotal, 1000000);
});
