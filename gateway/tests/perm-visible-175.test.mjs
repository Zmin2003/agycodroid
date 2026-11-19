// 等确认的可见性与过期按钮（#175）：跑界面里真正的函数，DOM 用最小的桩
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../web/app/03-perm-status.js", import.meta.url), "utf8");
const flow = fs.readFileSync(new URL("../web/app/04-session-flow.js", import.meta.url), "utf8");
const take = (s, start, end) => { const a = s.indexOf(start), b = s.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return s.slice(a, b); };
const T = (k, o) => k.replace(/\{(\w+)\}/g, (_, n) => (o || {})[n]);

test("整页盖着时来了确认请求：提醒一次，点「查看」打开那个会话；没开整页不打扰", () => {
  const acts = [], opened = [];
  const box = { Set, srv: { runs: [{ id: "r1", sessionId: "B" }] }, view: { sessionId: "A" }, curPage: "settings", t: T,
    toastAct: (m, b, fn) => acts.push([m, fn]), openSession: (id) => opened.push(id), closePage() {} };
  vm.runInNewContext("let curPage = globalThis.curPage;" + take(src, "  const ASK_SEEN = new Set();", "  function pendingPerms()") + "\nglobalThis.f = askNotice;", box);
  box.f([{ id: "p1", runId: "r1" }]);
  box.f([{ id: "p1", runId: "r1" }]);
  assert.equal(acts.length, 1, "同一个请求只提醒一次");
  assert.equal(acts[0][0], "Antigravity 在等你确认");
  acts[0][1]();
  assert.deepEqual(opened, ["B"]);
});

test("perm_mode 事件：在跑轮次的模式快照跟着改，并重排等着的计划卡", () => {
  const body = take(flow, '      case "perm_mode":', '      case "perm_request":');
  let refreshed = 0;
  const box = { state: { settings: {} }, setPermChip() {}, $: () => null, srv: { runs: [{ permMode: "request-review" }, { permMode: null }] }, refreshPlanActs: () => refreshed++ };
  vm.runInNewContext(`globalThis.f = (ev) => { switch (ev.type) { ${body} } };`, box);
  box.f({ type: "perm_mode", mode: "always-proceed" });
  assert.equal(box.srv.runs[0].permMode, "always-proceed");
  assert.equal(box.srv.runs[1].permMode, null);
  assert.equal(refreshed, 1);
  // 移植：agy 没有 PreToolUse 钩子 / plan 模式，确认卡只有「允许 / 拒绝」，
  // 不再按模式生成「按当前模式执行」这类按钮
  const b2 = { t: T };
  vm.runInNewContext(take(src, "  // agy 没有 PreToolUse 钩子", "  function PermCard(") + "\nglobalThis.f = permActions;", b2);
  const html = b2.f({ tool: "Bash" }, "r");
  assert.match(html, /允许/);
  assert.match(html, /拒绝/);
  assert.doesNotMatch(html, /data-mode=/);
});

test("权限卡已填的内容：读出来、重建后填回去", () => {
  // 移植：卡片里只剩勾选项 + 拒绝理由（补充回答的 perm-other 输入已随旧卡片删掉，
  // permFormRead 的 ot 恒为 []）
  const mk = (props) => ({ ...props, classList: { _h: true, contains(c) { return c === "hidden" && this._h; }, toggle(c, v) { this._h = v; } } });
  const make = () => {
    const ins = [{ checked: false }, { checked: false }], ta = { value: "" }, deny = mk({ querySelector: () => ta });
    return { ins, ta, deny, el: { querySelectorAll: () => ins, querySelector: (q) => q === ".perm-deny" ? deny : ta } };
  };
  const box = {};
  vm.runInNewContext(take(src, "  function permFormRead(", "  function onPermRequest(") + "\nglobalThis.f = { permFormRead, permFormRestore };", box);
  const a = make();
  a.ins[1].checked = true; a.ta.value = "理由"; a.deny.classList._h = false;
  const form = box.f.permFormRead(a.el);
  assert.equal(form.ot.length, 0, "补充回答输入已删，ot 恒为空");
  const b = make();
  box.f.permFormRestore(b.el, form);
  assert.deepEqual(b.ins.map((x) => x.checked), [false, true]);
  assert.equal(b.ta.value, "理由");
  assert.equal(b.deny.classList._h, false);
});
