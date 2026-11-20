// 第二份稳定性报告 k 组 BUG-UIFS-004：接口 A 迟到的保存回执清空接口 B 未提交的密钥输入、
// 并把视图/当前卡重画回 A。前端逻辑，VM 抽取实际源码跑（harness 见 fixtures/card-vm.mjs）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadKeyCard, pKeyA } from "./fixtures/card-vm.mjs";

const src09 = fs.readFileSync(new URL("../web/app/09-settings.js", import.meta.url), "utf8");
const src11 = fs.readFileSync(new URL("../web/app/11-usage.js", import.meta.url), "utf8");

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ── 预置厂商的密钥卡（09-settings.js）─────────────────────────────────
test("UIFS-004：A 卡保存还没回来就切到 B，A 的回执不许清掉 B 刚粘的 Key、不许重画 B", async () => {
  const h = loadKeyCard();
  const keyA = { value: "sk-A" };
  h.setCard({ "pc-key": keyA, "pc-endpoint": null, "pc-result": {} });
  h.render(pKeyA());
  const d = deferred();
  h.postImpl = () => d.promise;
  const running = h.run("save");
  // 实际切卡回调：容器 innerHTML 已换成 B 的卡，#pc-key 指向 B 的输入框
  const keyB = { value: "sk-B-未提交" };
  h.setCard({ "pc-key": keyB, "pc-endpoint": null, "pc-result": {} });
  h.setView("B");
  d.resolve({ ok: true });
  await running;
  assert.equal(h.state.provView, "B", "旧回执不许把视图切走");
  assert.equal(keyB.value, "sk-B-未提交", "B 未提交的密钥输入被 A 的旧回执清掉了");
  assert.equal(h.reloadLog.length, 0, "旧回执不许刷新/重画当前卡");
  assert.equal(h.testLog.length, 0, "旧回执不许在当前卡上跑测试");
});

test("UIFS-004：同卡提交后又敲了新内容，回执回来也不许清掉", async () => {
  const h = loadKeyCard();
  const keyA = { value: "sk-A" };
  h.setCard({ "pc-key": keyA, "pc-endpoint": null, "pc-result": {} });
  h.render(pKeyA());
  const d = deferred();
  h.postImpl = () => d.promise;
  const running = h.run("save");
  keyA.value = "sk-A2-新输入";
  d.resolve({ ok: true });
  await running;
  assert.equal(keyA.value, "sk-A2-新输入", "提交后新敲的内容被旧回执清掉了");
  assert.equal(h.reloadLog.length, 0, "有未提交的新输入时不许重画卡片");
  assert.equal(h.toastLog.length, 1);
  assert.equal(h.toastLog[0].m, "已保存");
});

test("UIFS-004：正常保存（没切卡、没新输入）仍然清空输入并刷新", async () => {
  const h = loadKeyCard();
  const keyA = { value: "sk-A" };
  h.setCard({ "pc-key": keyA, "pc-endpoint": null, "pc-result": {} });
  h.render(pKeyA());
  const d = deferred();
  h.postImpl = () => d.promise;
  const running = h.run("save");
  d.resolve({ ok: true });
  await running;
  assert.equal(keyA.value, "", "正常保存后应清空输入框");
  assert.equal(h.reloadLog.length, 1, "正常保存后应刷新接口卡");
  assert.equal(h.reloadLog[0][0], "已保存");
  assert.equal(h.reloadLog[0][1], true);
});

test("UIFS-004：清除 Key 的迟到回执也不许重画已切走的卡", async () => {
  const h = loadKeyCard();
  const keyA = { value: "" };
  h.setCard({ "pc-key": keyA, "pc-endpoint": null, "pc-result": {} });
  h.render(pKeyA());
  const d = deferred();
  h.postImpl = () => d.promise;
  const running = h.run("clear");
  const keyB = { value: "sk-B" };
  h.setCard({ "pc-key": keyB, "pc-endpoint": null, "pc-result": {} });
  h.setView("B");
  d.resolve({ ok: true });
  await running;
  assert.equal(h.reloadLog.length, 0, "A 的清除回执重画了 B");
  assert.equal(keyB.value, "sk-B");
});

// ── 自定义接口卡已删（agy 适配 W1，第 4 项）────────────────────────────
// renderCustomCard 与“＋ 新增自定义接口…”死路一起删了：保存被网关明确拒绝的表单
// 不应再出现在界面上。下面锁住“删干净了”，以及“更多模型”入口搬到内置密钥卡之后，
// 迟到回执的防护（UIFS-004）仍然成立。
test("自定义接口卡已删：11-usage.js 里没有 renderCustomCard，09 里没有 __new__ 入口", () => {
  assert.doesNotMatch(src11, /renderCustomCard/, "renderCustomCard 已删");
  assert.doesNotMatch(src11, /cc-more|cc-label/, "自定义卡的 cc-* 控件已删");
  assert.doesNotMatch(src09, /__new__/, "__new__ 死路选项已删");
  assert.doesNotMatch(src09, /renderCustomCard/, "09 里不再调自定义卡");
});

test("更多模型改过再点保存：随保存一起发 extraModels，保存后重拉模型清单", async () => {
  const h = loadKeyCard();
  const keyA = { value: "sk-A" }, moreA = { value: "m-new 1m\nm-old" };
  h.setCard({ "pc-key": keyA, "pc-more": moreA, "pc-endpoint": null, "pc-result": {} });
  h.render({ ...pKeyA(), extraModels: [{ id: "m-old", contextWindow: 0 }] });
  h.postImpl = () => Promise.resolve({ ok: true });
  await h.run("save");
  assert.equal(h.postCalls.length, 1);
  // VM 里建的对象与主 realm 原型不同，deepStrictEqual 会误判：按 JSON 比
  assert.equal(JSON.stringify(h.postCalls[0].body.extraModels), JSON.stringify([{ id: "m-new", contextWindow: 1048576 }, { id: "m-old", contextWindow: 0 }]));
  assert.equal(h.reloadLog.length, 1, "保存后刷新接口卡");
  assert.equal(h.loadModelsLog.length, 1, "保存后重拉模型清单");
  assert.equal(keyA.value, "", "正常保存后清空 Key 输入");
});

test("更多模型没改过：点保存不重复发 extraModels", async () => {
  const h = loadKeyCard();
  const keyA = { value: "sk-A" }, moreA = { value: "m-old" };
  h.setCard({ "pc-key": keyA, "pc-more": moreA, "pc-endpoint": null, "pc-result": {} });
  h.render({ ...pKeyA(), extraModels: [{ id: "m-old", contextWindow: 0 }] });
  h.postImpl = () => Promise.resolve({ ok: true });
  await h.run("save");
  assert.equal(h.postCalls.length, 1);
  assert.equal("extraModels" in h.postCalls[0].body, false, "没改过就不发");
});
