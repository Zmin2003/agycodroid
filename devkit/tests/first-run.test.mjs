// devkit first-run.sh 生成（H1/H2/M6，1.0.2）：
//   - compileall 串行（无 -j 0）、输出进固定日志、失败只警告不决定脚本退出码
//   - 每个 postinst 的 rc 记入 first-run-summary，脚本末尾 exit 累计 rc
//   - cd $HOME 失败要警告；无 python3 时明说跳过；stdlib 解析失败单独警告
// 跑法：node --test devkit/tests/first-run.test.mjs
//   （直接 import devkit.mjs 会触发顶层 await loadIndex（约 5 秒、走网络），
//    所以纯生成逻辑在 ../first-run.mjs 里，devkit.mjs 只 import 它。）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { buildFirstRunScript } from "../first-run.mjs";

const PREFIX = "/data/data/cc.agyroid/";
const LIBEXEC = "usr/libexec/devkit";
// 1.0.1 发布版 base 块实际的 postinst 清单（devkit-base-cc.agyroid.tar.gz 里看到的）
const PKGS = ["android-tools", "npm", "openssh", "python", "python-pip", "termux-exec"];

function script(pkgs = PKGS, extras = true) {
  return buildFirstRunScript({ prefix: PREFIX, libexec: LIBEXEC, pkgs, extras });
}

// ── 生成文本层 ─────────────────────────────────────────────────────────

test("H1：compileall 串行，无 -j 0、无并行开关", () => {
  const s = script();
  assert.ok(s.includes("-m compileall -q"), "应有串行 compileall");
  assert.ok(!s.includes("-j 0"), "不能有 -j 0");
  assert.ok(!/compileall[^\n]*-j/.test(s), "compileall 行上不能带 -j");
});

test("H1：compileall 输出不丢：无 >/dev/null，写进固定日志文件", () => {
  const s = script();
  assert.ok(!s.includes(">/dev/null"), "生成脚本里不能出现 >/dev/null 丢输出");
  assert.ok(!s.includes("/dev/null"), "生成脚本里不能出现 /dev/null");
  assert.ok(s.includes("$PREFIX/tmp/first-run-compileall.log"), "compileall 输出应进 $PREFIX/tmp/first-run-compileall.log");
});

test("H1：compileall 失败不决定脚本退出码（脚本末行是 exit 累计 rc）", () => {
  const s = script();
  const last = s.trim().split("\n").pop();
  assert.equal(last, 'exit "$FR_RC"', "脚本末行应是 exit 累计 rc，不是 compileall");
  assert.ok(s.includes("预编译 Python 失败"), "compileall 失败应 echo 警告");
  assert.ok(s.includes("tail -n 20"), "失败时应 echo 日志最后若干行");
});

test("H2：每个 postinst 的 rc 记入 first-run-summary（stdout + 汇总文件）", () => {
  const s = script();
  assert.ok(s.includes("first-run-summary:"), "末尾应 echo 一行 first-run-summary:");
  assert.ok(s.includes("first-run-summary.txt"), "应同时写汇总文件");
  for (const p of PKGS) assert.ok(s.includes(`${p}=\${_rc}`), `${p} 的 rc 应记入汇总`);
});

test("M6：cd $HOME 失败要警告，不静默", () => {
  const s = script();
  assert.ok(s.includes('cd "$HOME" || echo'), "cd $HOME 失败应 echo 警告");
  assert.ok(!/^cd "\$HOME" 2>\/dev\/null$/m.test(s), "不能再是静默的 cd 2>/dev/null");
});

test("M6：无 python3 时明说跳过预编译", () => {
  assert.ok(script().includes("跳过预编译：无 python3"));
});

test("H1：内层 stdlib 路径解析失败时单独警告，不静默产生空路径", () => {
  const s = script();
  assert.ok(s.includes("取 Python stdlib 路径失败"), "stdlib 取不到应单独 echo 警告");
  assert.ok(s.includes("sysconfig"), "仍用 sysconfig 取 stdlib 路径");
});

test("extras=false（非基础块/组件）：无 compileall，但仍有汇总与累计 exit", () => {
  const s = script(PKGS, false);
  assert.ok(!s.includes("compileall"), "非基础块不应有 compileall 段");
  assert.ok(s.includes("first-run-summary:"), "仍应有汇总行");
  assert.equal(s.trim().split("\n").pop(), 'exit "$FR_RC"');
});

test("空 postinst 列表也能生成合法脚本", () => {
  const s = script([], true);
  assert.ok(s.startsWith("#!"), "应有 shebang");
  assert.equal(s.trim().split("\n").pop(), 'exit "$FR_RC"');
  assert.ok(s.includes("first-run-summary:"));
});

// ── shell 层模拟：用桩跑生成的脚本 ─────────────────────────────────────

function makeTree(t, { pythonRc = 0, postinstRc = {}, withPython = true, home = null }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "firstrun-"));
  const usr = path.join(root, "files", "usr");
  const binDir = path.join(usr, "bin");
  const postDir = path.join(usr, "libexec", "devkit", "postinst");
  for (const d of [binDir, postDir, path.join(usr, "tmp")]) fs.mkdirSync(d, { recursive: true });
  const homeDir = home || fs.mkdtempSync(path.join(os.tmpdir(), "firstrun-home-"));
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), "firstrun-mark-"));
  t.after(() => {
    for (const d of [root, homeDir, markerDir]) fs.rmSync(d, { recursive: true, force: true });
  });
  // python3 桩：-c 打印 stdlib 路径；-m compileall 按配置退出；每次调用都记 argv
  if (withPython) {
    fs.writeFileSync(path.join(binDir, "python3"), `#!/bin/sh
echo "$@" >> "${path.join(root, "python-argv.log")}"
if [ "$1" = "-c" ]; then echo "$PREFIX/lib/python3.14"; exit 0; fi
exit ${pythonRc}
`, { mode: 0o755 });
  }
  const pkgs = Object.keys(postinstRc).length ? Object.keys(postinstRc) : PKGS;
  for (const pkg of pkgs) {
    const rc = postinstRc[pkg] ?? 0;
    fs.writeFileSync(path.join(postDir, pkg), `#!/bin/sh
echo ran > "${path.join(markerDir, pkg + ".ran")}"
exit ${rc}
`, { mode: 0o755 });
  }
  const text = buildFirstRunScript({ prefix: root + "/", libexec: LIBEXEC, pkgs, extras: true });
  const scriptPath = path.join(root, "first-run.sh");
  fs.writeFileSync(scriptPath, text, { mode: 0o755 });
  return { root, usr, homeDir, markerDir, scriptPath, pkgs };
}

function runTree(tr, extraEnv = {}) {
  return spawnSync("bash", [tr.scriptPath], {
    encoding: "utf8",
    env: { ...process.env, PREFIX: tr.usr, HOME: tr.homeDir, ...extraEnv },
  });
}

test("shell：桩 python3 返回 1（复现 1.0.1 的 forkserver 建池失败）→ 脚本 exit 0、警告出现、日志写出", (t) => {
  const tr = makeTree(t, { pythonRc: 1 });
  const r = runTree(tr);
  assert.equal(r.status, 0, `脚本不应被 compileall 拖死，stderr=${r.stderr}`);
  assert.match(r.stdout, /预编译 Python 失败，rc=1/);
  assert.match(r.stdout, /first-run-summary:/);
  assert.ok(fs.existsSync(path.join(tr.usr, "tmp", "first-run-compileall.log")), "日志文件应写出");
  const argvLog = fs.readFileSync(path.join(tr.root, "python-argv.log"), "utf8");
  const compileLine = argvLog.split("\n").find((l) => l.includes("compileall"));
  assert.ok(compileLine, "应调过 compileall");
  assert.ok(!compileLine.includes("-j"), `compileall 调用不能带 -j，实得：${compileLine}`);
  const summary = fs.readFileSync(path.join(tr.usr, "tmp", "first-run-summary.txt"), "utf8");
  for (const p of PKGS) assert.ok(summary.includes(`${p}=0`), `汇总应记 ${p}=0`);
});

test("shell：桩 python3 成功 → 无警告、exit 0", (t) => {
  const tr = makeTree(t, { pythonRc: 0 });
  const r = runTree(tr);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!r.stdout.includes("预编译 Python 失败"), "成功时不应有失败警告");
  assert.ok(fs.existsSync(path.join(tr.usr, "tmp", "first-run-compileall.log")));
});

test("shell：某 postinst 失败 → exit 累计 rc、后续步骤照跑、汇总记 rc", (t) => {
  const tr = makeTree(t, { postinstRc: { "android-tools": 0, npm: 0, openssh: 3, python: 0, "python-pip": 0, "termux-exec": 0 } });
  const r = runTree(tr);
  assert.equal(r.status, 3, `应 exit 第一个非零 postinst rc=3，stdout=${r.stdout}`);
  assert.match(r.stdout, /openssh 的 postinst 失败，rc=3/);
  assert.ok(fs.existsSync(path.join(tr.markerDir, "python.ran")), "失败后后续 postinst 仍应跑（无 set -e）");
  assert.ok(fs.existsSync(path.join(tr.markerDir, "termux-exec.ran")));
  const summary = fs.readFileSync(path.join(tr.usr, "tmp", "first-run-summary.txt"), "utf8");
  assert.match(summary, /openssh=3/);
  assert.match(summary, /python=0/);
});

test("shell：无 python3 → 明说跳过、exit 0、一次也没调 python", (t) => {
  const tr = makeTree(t, { withPython: false });
  const r = runTree(tr);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /跳过预编译：无 python3/);
  assert.ok(!fs.existsSync(path.join(tr.root, "python-argv.log")), "无 python3 时不应调 python");
});

test("shell：cd $HOME 失败 → 警告、继续跑、exit 0", (t) => {
  const tr = makeTree(t, { home: "/nonexistent-dir-firstrun-test" });
  const r = runTree(tr, { HOME: "/nonexistent-dir-firstrun-test" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cd .*失败，rc=/);
});
