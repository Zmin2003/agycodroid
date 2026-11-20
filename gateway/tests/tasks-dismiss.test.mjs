// 任务清单的 ✕：没做完、会话又跑起来时也能收；同一份清单接着做不再冒出来，换了一份才露出来
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const src = fs.readFileSync(new URL("../web/app/03-perm-status.js", import.meta.url), "utf8");
const take = (start, end) => { const a = src.indexOf(start), b = src.indexOf(end, a); assert.ok(a >= 0 && b > a, start); return src.slice(a, b); };

function box() {
  const b = {
    view: { tasks: null, tasksHide: "" }, srv: { run: null },
    localStorage: { getItem: () => null }, esc: (x) => String(x), uiI: (n) => "<" + n + ">", t: (k, o) => k.replace(/\{(\w+)\}/g, (_, n) => o?.[n]),
  };
  vm.runInNewContext(take("  let tasksOpen =", "  function renderRunStrip()") + "\nglobalThis.html = tasksHtml; globalThis.sig = tasksSig;", b);
  return b;
}
const L = (...st) => st.map((s, i) => ({ id: String(i + 1), subject: "t" + i, status: s }));

test("做到一半：收起后继续会话，清单在跑时露出来也有 ✕，叉掉后进度再变也不冒出来", () => {
  const b = box();
  b.view.tasks = L("completed", "pending", "pending");
  assert.match(b.html(), /rs-tx/, "没在跑：有 ✕");
  b.view.tasksHide = b.sig(b.view.tasks);
  assert.equal(b.html(), "");
  // 继续会话：跑起来了，同一份清单进度变了
  b.srv.run = { id: "r1" };
  b.view.tasks = L("completed", "in_progress", "pending");
  assert.equal(b.html(), "", "同一份清单接着做，不再冒出来");
  // claude 另加了一项：换了一份清单，露出来，而且在跑时也有 ✕（以前这里叉不掉）
  b.view.tasks = L("completed", "in_progress", "pending", "pending");
  assert.match(b.html(), /rs-tx/);
  b.view.tasksHide = b.sig(b.view.tasks);
  assert.equal(b.html(), "", "第二次也叉得掉");
});

test("旧版存下的「编号:状态」指纹照样认", () => {
  const b = box();
  b.view.tasks = L("completed", "pending");
  b.view.tasksHide = "1:completed,2:pending";
  assert.equal(b.html(), "");
});

test("tasks 为空 + tasksUnsupported：显示 agy 不上报任务列表的空态，而不是空字符串", () => {
  const b = box();
  b.view.sessionId = "s1";
  b.view.tasksUnsupported = true;
  assert.match(b.html(), /Antigravity 不上报任务列表/);
});

test("tasks 为空 + tasksUnsupported，但没有会话：新对话页不顶出空态", () => {
  const b = box();
  b.view.tasksUnsupported = true;
  assert.equal(b.html(), "");
});

test("tasks 为空、没有 tasksUnsupported 标记：仍返回空字符串（旧行为）", () => {
  const b = box();
  b.view.sessionId = "s1";
  assert.equal(b.html(), "");
});

test("有真实任务时不显示空态文案", () => {
  const b = box();
  b.view.sessionId = "s1";
  b.view.tasksUnsupported = true;
  b.view.tasks = L("pending");
  assert.match(b.html(), /t0/);
  assert.doesNotMatch(b.html(), /Antigravity 不上报任务列表/);
});

test("有清单工具、但还没建清单（tasks 为空数组 + 标记为假）：显示中性“暂无任务”，不是“不上报”", () => {
  const b = box();
  b.view.sessionId = "s1";
  b.view.tasks = [];
  b.view.tasksUnsupported = false;
  assert.match(b.html(), /暂无任务/);
  assert.doesNotMatch(b.html(), /Antigravity 不上报任务列表/);
});

test("tasks 为空数组 + tasksUnsupported 为真：仍显示“不上报”（不支持优先）", () => {
  const b = box();
  b.view.sessionId = "s1";
  b.view.tasks = [];
  b.view.tasksUnsupported = true;
  assert.match(b.html(), /Antigravity 不上报任务列表/);
  assert.doesNotMatch(b.html(), /暂无任务/);
});

test("tasks 为空数组、没有会话：新对话页不顶出“暂无任务”", () => {
  const b = box();
  b.view.tasks = [];
  b.view.tasksUnsupported = false;
  assert.equal(b.html(), "");
});

// ── renderRunStrip 折叠：空态文案不参与折叠 ──
function stripBox() {
  const strip = { innerHTML: "", _key: "", _html: "", classList: { toggle() {} }, querySelector() { return null; } };
  const b = {
    view: { tasks: null, tasksHide: "", tasksUnsupported: false, sessionId: "s1", goal: null, goalHide: 0 },
    srv: { run: null },
    localStorage: { getItem: () => null },
    esc: (x) => String(x), uiI: (n) => "<" + n + ">", t: (k, o) => k.replace(/\{(\w+)\}/g, (_, n) => o?.[n]),
    fmtDur: () => "1分",
    setInterval: () => 1, clearInterval() {},
    strip,
    $: () => strip,
  };
  vm.runInNewContext(take("  const runStrip =", "  // 点 ✕ 收起的清单") + "\nglobalThis.render = renderRunStrip; globalThis.strip = strip;", b);
  return b;
}

test("空态 + 进行中的目标：目标不被空态收起来（空态不参与折叠）", () => {
  const b = stripBox();
  b.view.tasksUnsupported = true;
  b.view.goal = { active: true, condition: "跑完测试", setAt: Date.now() - 60000, checks: 3 };
  b.render();
  assert.match(b.strip.innerHTML, /Antigravity 不上报任务列表/);
  assert.match(b.strip.innerHTML, /跑完测试/, "目标行不能被空态折叠藏掉");
});

test("真实清单收起时：目标照旧被折叠（原有行为不变）", () => {
  const b = stripBox();
  b.view.tasks = L("completed", "pending");
  b.view.goal = { active: true, condition: "跑完测试", setAt: Date.now() - 60000, checks: 3 };
  b.render();
  assert.match(b.strip.innerHTML, /t1/);
  assert.doesNotMatch(b.strip.innerHTML, /跑完测试/);
});
