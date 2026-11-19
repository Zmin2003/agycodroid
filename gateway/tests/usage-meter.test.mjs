// 使用统计的 token 计量（agy 版）：边跑边记、不重复、result 补差额、中断的一轮也算
// agy 只有三种事件：init / step_update / result。step_update 带 usage（按 step_index 记见过的
// 最大值，涨多少记多少）；result 的 usage 是 translate 归一化过的 Claude 形状
//（cache_read_tokens → cache_read_input_tokens），用来对账补差额。
// 子代理的步骤（带 subagent_info）照样记，但不进 result 对账的主会话累计。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test from "node:test";
import assert from "node:assert/strict";
import { usageMeter } from "../gw/usage.mjs";

function meter() {
  const got = [], sum = { t: 0, i: 0, o: 0, c: 0 }, byModel = {};
  const m = usageMeter({ sid: () => "s1", model: () => "main-model", add: (d, sid, model) => {
    got.push(d);
    for (const k in sum) sum[k] += d[k] || 0;
    byModel[model] = (byModel[model] || 0) + (d.i || 0) + (d.o || 0);
  } });
  return { m, got, sum, byModel };
}
// agy 原生 usage（step_update 里就是这个形状）
const A = (i, c, o) => ({ input_tokens: i, cache_read_tokens: c, output_tokens: o });
// result 的 usage（translate 归一化后的 Claude 形状）
const U = (i, c, o) => ({ input_tokens: i, cache_read_input_tokens: c, cache_creation_input_tokens: 0, output_tokens: o });
const step = (idx, usage, extra = {}) => ({ event: "step_update", step_update: { step_index: idx, step_type: "agent_response", usage, ...extra } });

test("真实流（工具调用两步）：边跑边记，总数和 result 的 usage 一致，不重复算", () => {
  const { m, sum } = meter();
  m.feed(step(0, A(1000, 0, 100)));
  m.feed(step(0, A(1000, 0, 250)));
  m.feed(step(1, A(2000, 0, 50), { step_type: "tool" }));
  assert.deepEqual([sum.i, sum.o, sum.c], [3000, 300, 0], "每步按 step_index 记最大值、只加涨的部分");
  m.result({ usage: U(3000, 500, 300) }, true);
  assert.deepEqual([sum.i, sum.o, sum.c, sum.t], [3500, 300, 500, 1], "result 补上流里没看到的缓存部分");
});

test("同一 step_index 重复报同一份 usage 不重复算；usage 回落不扣回", () => {
  const { m, sum } = meter();
  m.feed(step(0, A(1000, 0, 50)));
  m.feed(step(0, A(1000, 0, 50)));
  m.feed(step(0, A(1000, 0, 40)));
  assert.deepEqual([sum.i, sum.o, sum.c], [1000, 50, 0]);
});

test("中途被打断（没有 result）：已经流过的请求照样记下", () => {
  const { m, sum } = meter();
  m.feed(step(0, A(5000, 0, 300)));
  m.feed(step(1, A(5200, 0, 300)));
  assert.deepEqual([sum.i, sum.o, sum.t], [10200, 600, 0], "每步的用量各自累加");
});

test("子代理的请求照样记，但不进 result 对账的主会话累计；后台任务的第二轮 result 各对各的", () => {
  const { m, sum, byModel } = meter();
  m.feed(step(0, A(1000, 0, 50)));
  m.feed(step(1, A(3000, 0, 200), { subagent_info: { subagents: [{ conversation_id: "sub1" }] } }));
  assert.equal(byModel["main-model"], 1000 + 50 + 3000 + 200, "子代理的 token 也记在这一轮上");
  // result 的 usage 只算主会话：比流里多出来的部分补上，子代理的不抵掉
  m.result({ usage: U(1000, 0, 50 + 80) }, true);
  assert.equal(sum.o, 50 + 200 + 80);
  // 同一进程里后台任务回报又跑了一轮
  m.feed(step(2, A(10, 0, 20)));
  m.result({ usage: U(10, 0, 20) }, true);
  assert.deepEqual([sum.i, sum.o, sum.t], [1000 + 3000 + 10, 350, 2]);
});

test("斜杠命令那轮：token 照记，不算一轮对话", () => {
  const { m, sum } = meter();
  m.result({ usage: U(8000, 0, 600) }, false);
  assert.deepEqual([sum.i, sum.o, sum.t], [8000, 600, 0]);
});

test("init / result 事件和没有 usage 的 step_update 不计", () => {
  const { m, sum } = meter();
  m.feed({ event: "init", conversation_id: "c1", init: { model: "m" } });
  m.feed({ event: "result", conversation_id: "c1", result: { status: "SUCCESS" } });
  m.feed({ event: "step_update", step_update: { step_index: 0, step_type: "agent_response", text_delta: "hi" } });
  m.feed(null);
  assert.deepEqual([sum.i, sum.o, sum.t], [0, 0, 0]);
});
