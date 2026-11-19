// v0.5.14（agy 版）：#57 清单是静态的（文档示例 + 用户自加的 slug）、独立审查（低-4 原型链）
// 旧版 #57 的内嵌清单（data: URL 的 /models 响应）已不存在：agy 没有 /models 可拉，
// 清单不发请求，inlineModels、modelsUrl 都没有了；窗口一律不知道，不借第一项的。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cachedModels, fetchModels } from "../gw/models.mjs";
import { agyEnv, currentModelInfo } from "../gw/agy.mjs";

const P = (o) => ({ id: "custom-v0514", custom: true, explicit: true, baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only", ...o });

test("静态清单：不发请求，冷缓存就拿得到（#57）", async () => {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("no network in test"); };
  try {
    const p = P({ extraModels: [{ id: "big", contextWindow: 1048576 }] });
    const list = await fetchModels(true, p);
    assert.deepEqual(list.map((m) => m.id), ["gemini-3.8-flash-medium", "big"]);
    assert.equal(currentModelInfo("big", p).context_window, 1048576);
    assert.equal(cachedModels(p).length, 2);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = real; }
});

test("清单里没有的型号不借第一项的窗口（#57）；agy 环境里没有上下文窗口变量", () => {
  const p = P({ extraModels: [{ id: "big", contextWindow: 1048576 }] });
  assert.deepEqual(currentModelInfo("other", p), {});
  const env = agyEnv({ model: "other", provider: p });
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.equal(env.ANTHROPIC_MODEL, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined, "不是 gemini 那家就不注 key");
});

test("厂商 id 不从原型链上认（低-4）", async () => {
  const { providerById } = await import("../gw/providers.mjs");
  for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.equal(providerById(id), null, id);
});
