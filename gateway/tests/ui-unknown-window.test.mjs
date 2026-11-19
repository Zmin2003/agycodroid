// 0.6.17 反馈的界面回归（剩 1 条）：
//  核对记录里「找不到 Antigravity CLI 程序」的绝对路径没有空格，不折行会撑出设置弹窗。
// 另外两条（压缩线控件/回填）已删：agy 没有 /compact，12-model-caps.js 里不再有压缩线控件。
// 这段依赖 WebView，按仓库惯例用源码锚点锁住行为。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const read = (p) => fs.readFileSync(new URL(`../web/${p}`, import.meta.url), "utf8");
const caps = read("app/12-model-caps.js");
const indexHtml = read("index.html");
const css = read("style.css");

test("核对记录里的长路径会折行，不再撑出设置弹窗", () => {
  assert.match(css, /\.item\.ledger \.tiny\.mono\{word-break:break-all\}/);
});
