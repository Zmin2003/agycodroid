// h 组 7.2 REQ-005（agy 版）：子代理的文本增量不能转成主气泡的逐字 delta。
// agy 的 step_update 里，带 subagent_info 的步骤就是子代理——正文走 sub_text，
// 工具挂到子代理名下；主会话的 agent_response 才出 delta。Claude 那套
// stream_event / parent_tool_use_id / isSidechain 形状已不存在。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { translate } from "../gw/stream.mjs";

function run(events) {
  const out = [], flags = { gotDelta: false };
  let replays = 0;
  for (const ev of events) translate(ev, { flags, sse: (e) => out.push(e), onInit() {}, onResult() {}, onReplay() { replays++; }, provider: {} });
  return { out, replays };
}
const step = (idx, step_type, extra = {}) => ({ event: "step_update", step_update: { step_index: idx, step_type, ...extra } });
const resp = (idx, text, extra = {}) => step(idx, "agent_response", { text_delta: text, ...extra });
const sub = (cid) => ({ subagent_info: { subagents: [{ conversation_id: cid }] } });
const ofType = (out, t) => out.filter((e) => e.type === t).map((e) => e.text).join("");

test("REQ-005：子代理（subagent_info）的文本增量不进主气泡，挂 Agent 卡（sub_text）", () => {
  const { out } = run([
    resp(0, "主会话"),
    resp(1, "子代理增量", sub("sub-1")),
    resp(2, "子代理思考", sub("sub-1")),
  ]);
  assert.equal(ofType(out, "delta"), "主会话", "只有主会话的逐字增量");
  assert.equal(ofType(out, "sub_text"), "子代理增量子代理思考", "子代理的正文都挂到 Agent 卡下");
  assert.equal(out.find((e) => e.type === "sub_text").parent, "agy-sub-sub-1");
});

test("REQ-005 对照：主会话的逐字增量照旧，子代理中途插进来不影响主会话", () => {
  const { out } = run([
    resp(0, "主会话前半"),
    resp(1, "子代理增量", sub("sub-1")),
    resp(2, "主会话后半"),
  ]);
  assert.equal(ofType(out, "delta"), "主会话前半主会话后半");
  assert.equal(ofType(out, "sub_text"), "子代理增量");
});

test("工具步骤：主会话的出 tool_use/tool_result；子代理的工具挂到子代理名下", () => {
  const { out } = run([
    step(0, "tool", { state: "ACTIVE", tool_info: { name: "Read", parameters: { file_path: "/x/a.txt" } } }),
    step(0, "tool", { state: "DONE", tool_info: { name: "Read", parameters: { file_path: "/x/a.txt" }, output: "文件内容" } }),
    step(1, "tool", { state: "DONE", tool_info: { name: "Bash", parameters: { command: "ls" }, output: "ok" }, ...sub("sub-1") }),
  ]);
  const uses = out.filter((e) => e.type === "tool_use");
  assert.deepEqual(uses.map((e) => [e.id, e.name]), [["agy-tool-0", "Read"], ["agy-tool-1", "Bash"]]);
  assert.equal(uses[1].parent, "agy-sub-sub-1");
  const res = out.filter((e) => e.type === "tool_result");
  assert.deepEqual(res.map((e) => [e.id, e.ok, e.text]), [["agy-tool-0", true, "文件内容"], ["agy-tool-1", true, "ok"]]);
  assert.equal(res[1].parent, "agy-sub-sub-1");
});

test("user_input 步骤：不转 delta，只触发 onReplay（插话送达确认）", () => {
  const { out, replays } = run([
    resp(0, "主会话"),
    step(1, "user_input"),
    resp(2, "继续"),
  ]);
  assert.equal(replays, 1);
  assert.equal(ofType(out, "delta"), "主会话继续");
});
