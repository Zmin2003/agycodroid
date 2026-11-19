// FIND-022（agy 版）：坏形状的事件（旧 Claude 的 assistant/user 事件、content 不是数组、
// null、数字）进 translate 不能抛错把整条事件丢掉——agy 的 translate 不认识这些事件类型，
// 直接忽略、不抛错；agy 自己的三种事件照常走。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { translate } from "../gw/stream.mjs";

function run(ev) {
  const out = [], flags = {};
  assert.doesNotThrow(() => translate(ev, { sse: (e) => out.push(e), flags, onInit() {}, onResult() {}, onReplay() {}, provider: {} }));
  return out;
}

test("旧 Claude 的 assistant/user 事件（content 不是数组）不抛错，直接忽略", () => {
  assert.deepEqual(run({ type: "assistant", message: { role: "assistant", content: 42 } }), []);
  assert.deepEqual(run({ type: "assistant", message: { role: "assistant", content: "纯文本" } }), []);
  assert.deepEqual(run({ type: "assistant", message: { role: "assistant", content: [null, { type: "text", text: "还活着" }] } }), []);
  assert.deepEqual(run({ type: "assistant", parent_tool_use_id: "t1", message: { role: "assistant", content: 42 } }), []);
  assert.deepEqual(run({ type: "user", message: { role: "user", content: 42 } }), []);
  assert.deepEqual(run({ type: "user", message: { role: "user", content: [null, { type: "tool_result", tool_use_id: "t1", content: [null, { type: "text", text: "结果" }] }] } }), []);
});

test("坏形状的 agy 事件不抛错，好事件照常走", () => {
  assert.deepEqual(run(null), []);
  assert.deepEqual(run({ event: "step_update" }), []);
  assert.deepEqual(run({ event: "step_update", step_update: { step_index: 0, step_type: "agent_response", text_delta: 42 } }), []);
  const out = run({ event: "step_update", step_update: { step_index: 0, step_type: "agent_response", text_delta: "还活着" } });
  assert.deepEqual(out.map((e) => e.text), ["还活着"]);
});
