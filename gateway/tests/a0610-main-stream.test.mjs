// 流事件翻译（gw/stream.mjs translate）：子代理的增量不打乱主会话的 delta（0.6.9 审计 195-U.1 的 agy 版）
// 移植：旧版测的是 Claude 的 message_start / content_block_delta / assistant 全文重发时的
// 「已逐字推过不再重复」——那套 laneFlags / contentBlocks 机制随 Claude 事件格式一起删了，
// agy 只有 step_update 的 text_delta，用例 1、2 随之删除。剩下这条测 agy 的等价不变量：
// 子代理的 text_delta 只走 sub_text，主会话的 delta 不丢、不重复。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { translate } from "../gw/stream.mjs";

function run(events) {
  const out = [], flags = {};
  for (const ev of events) translate(ev, { flags, sse: (e) => out.push(e), onInit() {}, onResult() {}, provider: {} });
  return out;
}
const step = (i, type, extra) => ({ event: "step_update", conversation_id: "s1", step_update: { step_index: i, step_type: type, ...extra } });

test("主会话逐字推过、中间子代理开了一条消息 → 主会话的 delta 不丢，子代理的只走 sub_text", () => {
  const out = run([
    step(0, "agent_response", { text_delta: "你好" }),
    step(1, "agent_response", { text_delta: "子代理在说", subagent_info: { subagents: [{ conversation_id: "agy-sub-9" }] } }),
    step(2, "agent_response", { text_delta: "继续" }),
  ]);
  assert.equal(out.filter((e) => e.type === "delta").map((e) => e.text).join(""), "你好继续");
  assert.equal(out.filter((e) => e.type === "sub_text").map((e) => e.text).join(""), "子代理在说");
  assert.equal(out.some((e) => e.type === "discard_partial"), false, "agy 没有 discard_partial 这种事件");
});
