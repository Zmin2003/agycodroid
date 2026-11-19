// 模型清单（gw/models.mjs）：models.dev 目录解析与补窗口的纯逻辑，不联网
// 移植：buildCatalog / applyCatalog / catalogKeys 随 models.dev 目录一起删了
// （agy 模型是静态目录）；只留 effortLevelsOf 这一条。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test } from "node:test";
import assert from "node:assert/strict";
import { effortLevelsOf } from "../gw/models.mjs";

test("effortLevelsOf：supported_levels 不是数组时回退默认档位，不把对象丢给 .includes", () => {
  assert.deepEqual(effortLevelsOf({ id: "m", effort: { supported_levels: { low: true } } }, { nativeModels: false }), ["low", "medium", "high", "xhigh", "max"]);  // agy 固定 5 档
  assert.deepEqual(effortLevelsOf({ id: "m", effort: { supported_levels: { low: true } } }, { nativeModels: true }), ["low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual(effortLevelsOf({ id: "m", effort: { supported_levels: ["low", "high"] } }, { nativeModels: false }), ["low", "high"]);
});
