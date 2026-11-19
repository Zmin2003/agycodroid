import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promptTokens, translate } from "../gw/stream.mjs";
import { readSessionPage } from "../gw/transcript.mjs";

// 移植：旧版用 Claude 的 stream_event（message_start / message_delta / assistant）驱动
// translate 里的用量合并与「开头占位暂缓」（atStart）——那套事件和合并逻辑随 Claude 事件
// 格式一起删了。agy 里用量只从 step_update / result 的 usage 来（见 stream.mjs contextUsage），
// 开头不再暂缓、也不跨步合并字段；compact_boundary、cache 期限旗标（cache1h/cache5m）
// 在 agy translate 里不存在，相关用例随之删除。下面按 agy 事件重写保留下来的不变量。
const zero = { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 };
const usage = { input_tokens: 145, cache_read_input_tokens: 101376, cache_creation_input_tokens: 0, output_tokens: 5831 };
const step = (i, u, sub = false) => ({ event: "step_update", conversation_id: "s1",
  step_update: { step_index: i, step_type: "agent_response", usage: u,
    ...(sub ? { subagent_info: { subagents: [{ conversation_id: "agy-sub-1" }] } } : {}) } });
const resultEv = (u) => ({ event: "result", conversation_id: "s1",
  result: { status: "SUCCESS", response: "done", num_turns: 1, usage: u, duration_seconds: 0 } });
// 下面读会话文件的用例仍用 Claude 形状的 assistant 消息：transcript.mjs 读的是落盘的
// 旧会话文件（Claude-jsonl 形状），这部分没变。
const assistant = (u, extra = {}) => ({ type: "assistant", message: { id: "m", model: "test-model", usage: u, content: [{ type: "text", text: "ok" }] }, ...extra });
function replay(events) {
  const flags = {}, out = [];
  for (const ev of events) translate(ev, { flags, sse: (e) => out.push(e), onInit() {}, onResult() {}, provider: {} });
  return { flags, out, contexts: out.filter((e) => e.type === "usage").map((e) => e.contextTokens) };
}

test("step_update 的用量就是上下文占用（input + 缓存命中）", () => {
  const r = replay([step(0, usage)]);
  assert.equal(r.flags.contextTokens, 101521);
  assert.equal(r.flags.mainCtx, 101521);
  assert.deepEqual(r.contexts, [101521]);
});

test("只有 result 时也能补上上下文", () => {
  assert.equal(replay([resultEv(usage)]).flags.contextTokens, 101521);
});

test("缓存命中的输入也是上下文的一部分", () => {
  assert.equal(promptTokens({ input_tokens: 0, cache_read_input_tokens: 100000, cache_creation_input_tokens: 1200 }), 101200);
  assert.equal(replay([step(0, { input_tokens: 0, cache_read_tokens: 100000 })]).flags.contextTokens, 100000);
});

test("下一步的用量不继承上一步的字段：只算当步给的", () => {
  const r = replay([step(0, { input_tokens: 100, cache_read_tokens: 9000 }), step(1, { input_tokens: 1500, output_tokens: 50 })]);
  assert.deepEqual(r.contexts, [9100, 1500]);
});

test("零用量（占位）不清掉已有的真实占用", () => {
  const r = replay([step(0, usage), step(1, zero), resultEv(zero)]);
  assert.equal(r.flags.contextTokens, 101521);
  assert.deepEqual(r.contexts, [101521]);
});

test("子代理步骤的用量不覆盖主会话", () => {
  const r = replay([
    step(0, usage),
    step(1, { input_tokens: 900 }, true),
    step(2, { input_tokens: 950 }, true),
    step(3, { input_tokens: 1100 }),
  ]);
  assert.equal(r.flags.contextTokens, 1100);
  assert.deepEqual(r.contexts, [101521, 1100]);
});

test("result 的用量就是本轮最终的上下文（不再像旧版那样排除 result 的累计输入）", () => {
  const r = replay([step(0, { input_tokens: 100, output_tokens: 5 }), resultEv({ input_tokens: 9000, output_tokens: 50 })]);
  assert.equal(r.flags.contextTokens, 9000);
  assert.deepEqual(r.contexts, [100, 9000]);
});

test("同值用量不重复推送 usage 事件", () => {
  const r = replay([step(0, usage), step(1, usage), resultEv(usage)]);
  assert.deepEqual(r.contexts, [101521]);
});

async function page(events, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "context-usage-"));
  const file = path.join(dir, "session.jsonl");
  try {
    fs.writeFileSync(file, events.map((e) => JSON.stringify(e) + "\n").join(""));
    return await readSessionPage(file, opts);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
const user = (text = "question") => ({ type: "user", message: { content: text } });

test("历史跳过合成、错误及占位零用量消息", async () => {
  const synthetic = assistant(zero);
  synthetic.message.model = "<synthetic>";
  const r = await page([user(), assistant(usage), synthetic, assistant(zero), assistant({ input_tokens: 999 }, { isApiErrorMessage: true })]);
  assert.equal(r.contextTokens, 101521);
});

test("正在实时回放的消息不重复渲染，但用量元数据不能排除", async () => {
  const r = await page([
    { ...user("old"), timestamp: "2026-10-26T12:00:00.000Z" },
    { ...assistant({ input_tokens: 500 }), timestamp: "2026-10-26T12:00:01.000Z" },
    { ...user("live"), timestamp: "2026-10-26T13:00:00.000Z" },
    { ...assistant(usage), timestamp: "2026-10-26T13:00:01.000Z" },
  ], { excludeFrom: Date.parse("2026-10-26T13:00:00.000Z") });
  assert.equal(r.contextTokens, 101521);
  assert.deepEqual(r.items.map((e) => e.text), ["old", "ok"]);
});

test("历史的子代理和元消息不覆盖主会话用量", async () => {
  const r = await page([user(), assistant(usage), assistant({ input_tokens: 100 }, { isSidechain: true }), assistant({ input_tokens: 200 }, { isMeta: true })]);
  assert.equal(r.contextTokens, 101521);
});

test("历史只有占位消息时用量未知，而不是真实的零", async () => {
  assert.equal((await page([user(), assistant(zero)])).contextTokens, null);
});

test("历史压缩边界使用压缩后的用量", async () => {
  const r = await page([user(), assistant(usage), { type: "system", subtype: "compact_boundary", compactMetadata: { postTokens: 12345 } }, assistant(zero)]);
  assert.equal(r.contextTokens, 12345);
});

test("压缩后的用量缺失时不能回退到压缩前的旧值", async () => {
  const r = await page([user(), assistant(usage), { type: "system", subtype: "compact_boundary", compact_metadata: {} }, assistant(zero)]);
  assert.equal(r.contextTokens, null);
});
