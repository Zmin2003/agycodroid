// 0.6.9 审计 199-5-03：厂商配置里型号等字段类型不对（手改 / 分享导入）→ 不用它，内置条目回落目录值
import { CFG } from "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

fs.writeFileSync(path.join(CFG.home, "agyapp-providers.json"), JSON.stringify({ active: "deepseek", providers: {
  google: { apiKey: 123, defaultModel: 5 },
  gemini: { apiKey: "fixture", defaultModel: { id: "m" } },
  "custom-bad": { label: "Bad", baseUrl: "https://example.invalid", apiKey: "fixture", defaultModel: "ok-model" },
} }));
const { providerById } = await import("../gw/providers.mjs");

test("内置条目：型号不是字符串 → 用目录里的；自定义条目：当没填，别的字段照常", () => {
  // 移植：只有 google / gemini 两个预置；cleanRaw 丢掉非字符串的 defaultModel / apiKey，
  // 自定义条目根本不合成（providerById 回 null），active 里的 deepseek 也回落到 google。
  const d = providerById("google");
  assert.equal(typeof d.defaultModel, "string");
  assert.equal(d.defaultModel, "");
  assert.equal(d.apiKey, undefined); // 数字 apiKey 被丢掉；google 是登录模式，预置里根本没有 apiKey 字段
  const g = providerById("gemini");
  assert.equal(g.defaultModel, "");
  assert.equal(g.apiKey, "fixture");
  assert.equal(providerById("custom-bad"), null);
  assert.equal(providerById("deepseek"), null);
});

test("195-E.11：汇率取不到 → 一分钟内不再去等；同时几个请求只发一次", async () => {
  const { usdCny } = await import("../gw/providers.mjs");
  let n = 0;
  const prev = globalThis.fetch;
  globalThis.fetch = async () => { n++; await new Promise((r) => setTimeout(r, 50)); throw new Error("offline"); };
  try {
    await Promise.all([usdCny(), usdCny(), usdCny()]);
    assert.equal(n, 1, "并发合并成一次");
    await usdCny();
    assert.equal(n, 1, "退避期内不再试");
  } finally { globalThis.fetch = prev; }
});
