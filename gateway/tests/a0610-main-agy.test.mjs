// 起 agy 的环境（gw/agy.mjs）：extraEnv 不能借道改密钥/端点、也不能把旧的 Claude 变量漏过去；
// agy 的 stream-json 样例（fixtures/agy-stream-sample.jsonl）按官方事件翻译成前端的 delta/tool_use/tool_result。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { agyEnv } from "../gw/agy.mjs";

const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const HERE = path.dirname(fileURLToPath(import.meta.url));

test("extraEnv 拒密钥、端点与执行类变量；超时、代理这类照旧放行；Claude 变量一个都不留", () => {
  const src = fs.readFileSync(path.join(GW, "gw/agy.mjs"), "utf8");
  const re = new RegExp(/const EXTRA_ENV_DENY = (\/.*\/);/.exec(src)[1].slice(1, -1));
  for (const k of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS",
    "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "CLASSPATH", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS",
    "LD_PRELOAD", "PATH", "HOME"]) assert.ok(re.test(k), k);
  for (const k of ["API_TIMEOUT_MS", "TZ", "HTTP_PROXY"]) assert.ok(!re.test(k), k);
  // agyEnv 行为：继承来的 CLAUDE_CODE_*/ANTHROPIC_* 一律清掉
  process.env.ANTHROPIC_API_KEY = "<redacted>";
  process.env.CLAUDE_CODE_MAX_RETRIES = "3";
  const env = agyEnv({ provider: { id: "gemini", extraEnv: { API_TIMEOUT_MS: "300000" } } });
  assert.equal(env.API_TIMEOUT_MS, "300000", "extraEnv 写的超时照旧透传");
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_MAX_RETRIES, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined, "gemini 没配 Key 就不注入");
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_MAX_RETRIES;
});

// U.6 的旧版（预置第三方厂商走流式补尾）已删：agy 只有 google/gemini，没有第三方厂商，
// agyEnv 里也没有 ANTHROPIC_BASE_URL / 流式补尾路由。

test("agy stream-json 样例：init → delta → tool_use/tool_result → result，全程按官方事件走", async () => {
  const { translate } = await import("../gw/stream.mjs");
  const lines = fs.readFileSync(path.join(HERE, "fixtures/agy-stream-sample.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const out = [], inits = [], results = [];
  const flags = {};
  for (const ev of lines) translate(ev, { flags, sse: (e) => out.push(e), onInit: (i) => inits.push(i), onResult: (r) => results.push(r), provider: {} });
  assert.equal(inits.length, 1);
  assert.equal(inits[0].session_id, "agy-sample-0001");
  assert.equal(inits[0].model, "gemini-3.8-flash-medium");
  assert.deepEqual(inits[0].tools.map((t) => t.name), ["Read", "Bash"]);
  assert.equal(out.filter((e) => e.type === "delta").map((e) => e.text).join(""), "先看一下这个文件。文件里写着 hello agy。");
  const use = out.find((e) => e.type === "tool_use");
  // 工具 id 是 G1 本轮定的 "agy-tool-<轮次>-<step_index>"：样例里工具步骤 step_index=1、第 0 轮。
  assert.deepEqual([use.id, use.name, use.input], ["agy-tool-0-1", "Read", { file_path: "/tmp/agy-sample-ws/a.txt" }]);
  const res = out.find((e) => e.type === "tool_result");
  assert.deepEqual([res.id, res.ok, res.text], ["agy-tool-0-1", true, "hello agy\n"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].uuid, "agy-agy-sample-0001-1-3.5", "G1 M6：去重 uuid 带上 duration_seconds（样例 result 里是 3.5）");
  assert.equal(results[0].subtype, "SUCCESS");
  assert.equal(results[0].result, "文件里写着 hello agy。");
  assert.equal(results[0].total_cost_usd, 0, "agy 不报花费");
  assert.equal(results[0].usage.cache_read_input_tokens, 800, "cache_read_tokens 归一化成 cache_read_input_tokens");
});
