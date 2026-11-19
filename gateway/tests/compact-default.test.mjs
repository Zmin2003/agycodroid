// agy 没有 /compact、也不报窗口：压缩线恒为 null（models.mjs 的 defaultCompactLine/compactLineOf）
// agyEnv 也不再下发 CLAUDE_CODE_AUTO_COMPACT_WINDOW / CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { defaultCompactLine, compactLineOf } from "../gw/models.mjs";
import { agyEnv } from "../gw/agy.mjs";

const saved = process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, saved2 = process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT;
after(() => {
  if (saved === undefined) delete process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW; else process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = saved;
  if (saved2 === undefined) delete process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT; else process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = saved2;
});

test("压缩线恒为 null：不管窗口多大、哪家接口、有没有设置", () => {
  for (const win of [1048576, 200000, 160000, 128000, 2000000, 0, undefined]) {
    assert.equal(defaultCompactLine(win, { id: "gemini" }), null, "窗口 " + win);
    assert.equal(defaultCompactLine(win, { id: "google" }), null);
    assert.equal(compactLineOf(null, win, { id: "gemini" }), null);
    assert.equal(compactLineOf(500000, win, { id: "gemini" }), null, "手动设了也一样是 null");
  }
});

test("agyEnv：不下发压缩线相关的变量；继承来的值也不漏过去", () => {
  process.env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = "400000";     // 网关从别的会话里起时会带着
  process.env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT = "1";
  const env = agyEnv({ model: "gemini-3.8-flash-medium" });
  assert.equal(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
  assert.equal(env.CLAUDE_CODE_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT, undefined);
});
