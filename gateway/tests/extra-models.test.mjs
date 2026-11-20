// Gemini 接口卡另加型号（11-07 群友：第三方端口加好之后只有默认那一个型号，想再加几个）
// agy 的模型清单第一来源是 `agy models`（已登录时拉取，见 models.mjs）；未登录 / 拉取失败时
// 回静态兜底：文档示例 gemini-3.8-flash-medium + 接口卡里用户自己加的 extraModels，
// defaultModel 不自动进清单；agyEnv 不再下发 ANTHROPIC_MODEL / CLAUDE_CODE_MAX_CONTEXT_TOKENS。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test } from "node:test";
import assert from "node:assert/strict";
import { extraModelsOf, cachedModels, fetchModels } from "../gw/models.mjs";
import { upsertProvider, providerById } from "../gw/providers.mjs";
import { agyEnv } from "../gw/agy.mjs";

test("另加的型号接在示例后面；同名不重复；没写窗口的按 0", () => {
  const p = { id: "gemini", extraModels: [{ id: "m-b", contextWindow: 256000 }, { id: "m-c" }, { id: "gemini-3.8-flash-medium" }, { id: "m-b" }] };
  assert.deepEqual(cachedModels(p).map((m) => [m.id, m.context_window]),
    [["gemini-3.8-flash-medium", 0], ["m-b", 256000], ["m-c", 0]]);
});

test("配置能分享导入、也能手改：形状不对的丢掉，最多 64 个", () => {
  const bad = [{ id: "ok-1" }, { id: "带空格 不行" }, { id: "" }, { id: 3 }, null, { id: "x".repeat(129) }, { id: "ok-2", contextWindow: 99 }];
  assert.deepEqual(extraModelsOf({ extraModels: bad }), [{ id: "ok-1", contextWindow: 0 }, { id: "ok-2", contextWindow: 0 }]);
  assert.equal(extraModelsOf({ extraModels: Array.from({ length: 80 }, (_, i) => ({ id: "m" + i })) }).length, 64);
  assert.deepEqual(extraModelsOf({ extraModels: "m-a" }), []);
});

test("型号名可以是中文、带方括号；空格 / 逗号 / 控制字符仍拒收", () => {
  const id = "中转的中转:[特价C]gemini-特价";
  assert.deepEqual(extraModelsOf({ extraModels: [{ id }] }), [{ id, contextWindow: 0 }]);
  assert.deepEqual(extraModelsOf({ extraModels: [{ id: "带逗号,不行" }] }), []);
  assert.deepEqual(extraModelsOf({ extraModels: [{ id: "带\n换行" }] }), []);
  const r = upsertProvider("gemini", { defaultModel: id, extraModels: [{ id }] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.provider.extraModels[0].id, id);
  upsertProvider("gemini", { defaultModel: "", extraModels: [] });
});

test("接口卡保存：存进配置、清单里出现、defaultModel 不自动进清单；空数组清掉；坏名字拒收", async () => {
  const r = upsertProvider("gemini", { defaultModel: "m-a", extraModels: [{ id: "m-b", contextWindow: 256000 }, { id: "m-c", contextWindow: 0 }] });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(r.provider.extraModels, [{ id: "m-b", contextWindow: 256000 }, { id: "m-c", contextWindow: 0 }]);
  const p = providerById("gemini");
  assert.deepEqual((await fetchModels(true, p)).map((m) => m.id), ["gemini-3.8-flash-medium", "m-b", "m-c"]);
  assert.deepEqual(cachedModels(p).map((m) => m.id), ["gemini-3.8-flash-medium", "m-b", "m-c"]);
  assert.deepEqual((await fetchModels(true, p)).map((m) => m.context_window), [0, 256000, 0]);
  const env = agyEnv({ model: "m-b", provider: p });
  assert.equal(env.ANTHROPIC_MODEL, undefined);
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.equal(upsertProvider("gemini", { extraModels: [{ id: "a b" }] }).error, "bad_extra_models");
  assert.equal(upsertProvider("gemini", { extraModels: [{ id: "m-d", contextWindow: 5 }] }).error, "bad_context_window");
  assert.ok(upsertProvider("gemini", { extraModels: [] }).ok);
  assert.equal(providerById("gemini").extraModels, undefined);
  assert.deepEqual((await fetchModels(true, providerById("gemini"))).map((m) => m.id), ["gemini-3.8-flash-medium"]);
  upsertProvider("gemini", { defaultModel: "" });
});
