// 第二份稳定性报告 k 组 BUG-UIFS-005：删除自定义接口成功后没有结束动作，落穿到下面的
// 公共保存分支——用已删的 id 再保存当前卡；若刷新后当前卡是预置卡，还会因没有 #cc-label 抛异常。
// agy 适配 W1 第 4 项：自定义接口卡（renderCustomCard）与“＋ 新增自定义接口…”死路已删，
// 内置接口删不掉、也没有删除手势——这组回归测试改为锁住“删干净了”，落穿 hazard 随卡一起消失。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src09 = fs.readFileSync(new URL("../web/app/09-settings.js", import.meta.url), "utf8");
const src11 = fs.readFileSync(new URL("../web/app/11-usage.js", import.meta.url), "utf8");

test("UIFS-005：自定义接口卡已删，没有删除手势可落穿到公共保存分支", () => {
  assert.doesNotMatch(src11, /renderCustomCard/, "renderCustomCard 已删");
  assert.doesNotMatch(src11, /data-act="del"/, "自定义卡的删除按钮已删");
  assert.doesNotMatch(src09, /__new__/, "__new__ 死路选项已删");
  assert.doesNotMatch(src09, /renderCustomCard/, "09 里不再调自定义卡");
});

test("UIFS-005：内置密钥卡上没有删除按钮，刷新后是预置卡也不会碰 #cc-label", () => {
  assert.doesNotMatch(src09, /data-act="del"/, "内置卡没有删除手势");
  assert.doesNotMatch(src09, /cc-label/, "09 里没有自定义卡的 #cc-label 引用");
});
