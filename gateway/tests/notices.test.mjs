// NT-14：notices.mjs 的 cmpVer 与 Updater.java 的 cmpVer 同一规则，semver §11
//（先比数字核心；带预发布后缀的低于同一核心无后缀的版本；后缀按 `.` 分段比；`+` 构建元数据不参与）。
// 以前只比数字核心、后缀直接丢掉，0.2.0-rc1 和 0.2.0 算相等。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cmpVer } from "../gw/notices.mjs";

test("数字核心按数值比，不按字典序", () => {
  assert.ok(cmpVer("1.2.10", "1.2.9") > 0);
  assert.ok(cmpVer("2.0.0", "10.0.0") < 0);
  assert.equal(cmpVer("1.0", "1.0.0"), 0);
  assert.equal(cmpVer("1.02.0", "1.2.0"), 0);
});

test("预发布后缀低于同一核心的正式版（Java 注释里的回归：rc 用户要能收到正式版）", () => {
  assert.ok(cmpVer("0.2.0-rc1", "0.2.0") < 0);
  assert.ok(cmpVer("0.2.0", "0.2.0-rc1") > 0);
  assert.ok(cmpVer("1.0.1-preview", "1.0.1") < 0);
  assert.ok(cmpVer("1.0.1-rc1", "1.0.0") > 0, "核心不同时先比核心，后缀不参与");
});

test("两边都带后缀时按后缀数字段比", () => {
  assert.ok(cmpVer("1.0.0-rc1", "1.0.0-rc2") < 0);
  assert.ok(cmpVer("1.0.0-rc2", "1.0.0-rc1") > 0);
  assert.equal(cmpVer("1.0.0-rc1", "1.0.0-rc1"), 0);
  assert.equal(cmpVer("1.0.0-alpha", "1.0.0-alpha"), 0);
});

test("超长数字段不丢精度（按长度再按字典序，与 Java cmpNums 一致）", () => {
  assert.ok(cmpVer("1.0.99999999999999999999", "1.0.100000000000000000000") < 0);
});

test("后缀按 semver §11 分段比，与 Java UpdaterCmpVerTest 同一用例集", () => {
  // 字母段严格字典序：rc10 < rc2（不要按嵌的数字比，否则与 Java 侧不一致）
  assert.ok(cmpVer("1.0.0-rc10", "1.0.0-rc2") < 0);
  assert.ok(cmpVer("1.0.0-rc2", "1.0.0-rc10") > 0);
  // 字母段之间按字典序，不是相等
  assert.ok(cmpVer("1.0.0-alpha", "1.0.0-beta") < 0);
  assert.ok(cmpVer("1.0.0-beta", "1.0.0-alpha") > 0);
  // 纯数字段小于字母段
  assert.ok(cmpVer("1.0.0-alpha.1", "1.0.0-alpha.beta") < 0);
  assert.ok(cmpVer("1.0.0-alpha.beta", "1.0.0-beta") < 0);
  // 数字段按数值：beta.2 < beta.11
  assert.ok(cmpVer("1.0.0-beta.2", "1.0.0-beta.11") < 0);
  // 段少的小
  assert.ok(cmpVer("1.0.0-alpha", "1.0.0-alpha.1") < 0);
  // semver §11 规范链全序
  const chain = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
  for (let i = 0; i < chain.length - 1; i++) assert.ok(cmpVer(chain[i], chain[i + 1]) < 0, `${chain[i]} < ${chain[i + 1]}`);
  // `+` 构建元数据不参与比较
  assert.equal(cmpVer("1.0.1+build", "1.0.1"), 0);
  assert.equal(cmpVer("1.0.1-alpha+build", "1.0.1-alpha"), 0);
  assert.equal(cmpVer("1.0.1+b1", "1.0.1+b2"), 0);
});
