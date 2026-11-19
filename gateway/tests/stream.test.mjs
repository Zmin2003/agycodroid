// stream-json → 前端事件（gw/stream.mjs 的 translate），agy 版。
// 移植：旧版用真机抓的 Claude 事件流（fixtures/stream-*.jsonl：message_start /
// content_block_delta / assistant 全文 / content_block_stop）测「逐字增量发过就不再补
// 整段、工具参数节流、discard_partial」——那套事件和机制随 Claude 一起没了，agy 只有
// init / step_update / result，工具参数一次给全、没有 assistant_text 补发。
// 夹具文件 stream-*.jsonl 本身留着（transcript 读旧会话还用），这里只测 agy 样例。
// 工具卡 / delta 的全流程断言在 a0610-main-agy.test.mjs 里也有。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { translate } from "../gw/stream.mjs";

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name) => fs.readFileSync(path.join(FIX, name), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/** 喂给 translate，按前端的方式拼：delta 往后接，sub_text 不进主气泡 */
function replay(evs) {
  const flags = {}, out = [];
  for (const ev of evs) translate(ev, { sse: (e) => out.push(e), flags, onInit() {}, onResult() {}, onReplay() {}, provider: {} });
  let text = "";
  for (const e of out) if (e.type === "delta") text += e.text;
  return { out, text };
}

test("agy 样例：delta 拼出整段正文，没有 assistant_text 补发", () => {
  const r = replay(load("agy-stream-sample.jsonl"));
  assert.equal(r.text, "先看一下这个文件。文件里写着 hello agy。");
  assert.equal(r.out.filter((e) => e.type === "assistant_text").length, 0);
  assert.ok(r.out.some((e) => e.type === "delta"));
});

test("带工具的一轮：工具卡与结果各出一张，id 对得上", () => {
  const r = replay(load("agy-stream-sample.jsonl"));
  assert.equal(r.out.filter((e) => e.type === "tool_use").length, 1);
  assert.equal(r.out.filter((e) => e.type === "tool_result").length, 1);
  assert.equal(r.out.find((e) => e.type === "tool_use").id, r.out.find((e) => e.type === "tool_result").id);
});
