// #203 的旧版（自定义厂商默认带 API_TIMEOUT_MS / 重试）已不存在：
// agy 只有 google/gemini 两家，没有自定义厂商；agyEnv 不再给任何厂商补超时/重试默认值，
// 用户在接口卡 extraEnv 里写的变量照旧透传（代理、超时这类），被 EXTRA_ENV_DENY 拦的除外。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";

test("#203 agy 版：不补超时/重试默认值；extraEnv 写了的照旧透传；没有的厂商是 null", async () => {
  const { agyEnv } = await import("../gw/agy.mjs");
  const { providerById } = await import("../gw/providers.mjs");
  delete process.env.API_TIMEOUT_MS;
  const e1 = agyEnv({ provider: providerById("gemini") });
  assert.equal(e1.API_TIMEOUT_MS, undefined, "不补默认超时");
  assert.equal(e1.CLAUDE_CODE_MAX_RETRIES, undefined, "不补默认重试；CLAUDE_CODE_* 一律清掉");
  const e2 = agyEnv({ provider: { id: "gemini", extraEnv: { API_TIMEOUT_MS: "300000" } } });
  assert.equal(e2.API_TIMEOUT_MS, "300000", "用户写的盖过（这里是没有默认可盖的，写了就透传）");
  assert.equal(e2.CLAUDE_CODE_MAX_RETRIES, undefined);
  const e3 = agyEnv({ provider: { id: "gemini", extraEnv: { API_TIMEOUT_MS: "300000", GEMINI_API_KEY: "nope" } } });
  assert.equal(e3.GEMINI_API_KEY, undefined, "extraEnv 借道改密钥不许");
  assert.equal(providerById("deepseek"), null, "第三方厂商预设已删");
  assert.equal(providerById("anthropic"), null);
});
