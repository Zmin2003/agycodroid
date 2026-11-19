// 11-05 安全审查的回归：这些路径都是「同 uid 可写的配置/安装目录」，不能把网关带崩或把密钥交出去。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CFG } from "../gw/config.mjs";
import { readHeadFile, readSmallFile } from "../gw/saferead.mjs";
import { digestSummary } from "../gw/backfill.mjs";
import { sealPrepare } from "../gw/seal.mjs";
import { sealArgv, _setSealed } from "../gw/edition.mjs";

test("digestSummary：全角空格也能定位「当前工作」", () => {
  const s = "Summary:\n" + "前言".repeat(1000) + "\n\u30001. 当前工作\n" + "内容".repeat(1000);
  assert.ok(digestSummary(s).includes("当前工作"));
});

test("readSmallFile：FIFO 立即返回 null，不会阻塞事件循环", () => {
  const f = path.join(CFG.home, "fifo-probe");
  try { fs.rmSync(f, { force: true }); } catch {}
  try { execFileSync("mkfifo", [f]); } catch { return; }   // 平台没有 mkfifo 就跳过
  const t = Date.now();
  assert.equal(readSmallFile(f, 1024), null);
  assert.ok(Date.now() - t < 1000);
  fs.rmSync(f, { force: true });
});

test("readHeadFile：大文件返回前 max 字节，不因超限整份读不到", () => {
  const f = path.join(CFG.home, "head-probe");
  fs.writeFileSync(f, "x".repeat(5000) + "TAIL");
  assert.equal((readHeadFile(f, 4000) || "").length, 4000);
  fs.rmSync(f, { force: true });
});

test("digestSummary：长空白不再平方回溯", () => {
  const s = "Summary:\n" + "\n".repeat(40000) + "1. Current Work\n内容";
  const t = Date.now();
  digestSummary(s);
  assert.ok(Date.now() - t < 1000, `${Date.now() - t}ms`);
});

test("封口的 @ 导入不展开凭据文件", () => {
  _setSealed(true);
  const cwd = path.join(CFG.home, "workspace", "proj");
  fs.mkdirSync(cwd, { recursive: true });
  const secret = "sk-SECRET-PRIVATE-067";
  fs.writeFileSync(path.join(CFG.home, "agyapp-providers.json"), JSON.stringify({ providers: [{ apiKey: secret }] }));
  fs.writeFileSync(path.join(cwd, "CLAUDE.md"), "@~/agyapp-providers.json\n");
  try {
    const prep = sealPrepare({ cwd, runId: "test-private" });
    const i = prep.args.indexOf("--append-system-prompt-file");
    assert.ok(i >= 0, "说明文件应该被回填");
    const text = fs.readFileSync(prep.args[i + 1], "utf8");
    assert.equal(text.includes(secret), false, "凭据不能进系统提示");
  } finally {
    fs.rmSync(path.join(cwd, "CLAUDE.md"), { force: true });
    fs.rmSync(path.join(CFG.home, "agyapp-providers.json"), { force: true });
    _setSealed(false);   // 开发版默认不封口
  }
});

test("封口：CLAUDE.md 是软链时不读它指向的凭据", () => {
  _setSealed(true);
  const cwd = path.join(CFG.home, "workspace", "symlink-proj");
  fs.mkdirSync(cwd, { recursive: true });
  const secret = "sk-SYMLINK-SECRET-067";
  const target = path.join(CFG.home, "provider-secret.md");
  fs.writeFileSync(target, secret);
  try { fs.unlinkSync(path.join(cwd, "CLAUDE.md")); } catch {}
  fs.symlinkSync(target, path.join(cwd, "CLAUDE.md"));
  try {
    const prep = sealPrepare({ cwd, runId: "test-symlink" });
    const i = prep.args.indexOf("--append-system-prompt-file");
    if (i >= 0) assert.equal(fs.readFileSync(prep.args[i + 1], "utf8").includes(secret), false);
  } finally {
    fs.rmSync(path.join(cwd, "CLAUDE.md"), { force: true });
    fs.rmSync(target, { force: true });
    _setSealed(false);
  }
});

test("终端封口（agy）：sealArgv 不拼旗标——agy 没有 --setting-sources 这类开关，封口在 writeAgySettings 里做", () => {
  _setSealed(true);
  try {
    assert.deepEqual(sealArgv(["-p", "mcp"]), ["-p", "mcp"]);
    assert.deepEqual(sealArgv(["-p", "--", "hello"]), ["-p", "--", "hello"]);
    assert.deepEqual(sealArgv(["--", "mcp"]), ["--", "mcp"]);
    assert.deepEqual(sealArgv(["--settings={}", "mcp", "list"]), ["--settings={}", "mcp", "list"]);
  } finally { _setSealed(false); }
});
