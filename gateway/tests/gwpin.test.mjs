// 网关起 claude 前按钉子核 files/gw/glibc（gw/gwpin.mjs，安全 4 第 2 层）
import { PATHS } from "../gw/config.mjs"; // scripts/test.mjs 先隔离 HOME / fake PREFIX
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const { gwGlibcBad, gwGwBad, gwRuntimeBlocked } = await import("../gw/gwpin.mjs");
const h = (b) => crypto.createHash("sha256").update(b).digest("hex");

test("gwpin：钉子里的文件都对上才放行；改过、少了、多出来的、换成软链的都算对不上", () => {
  const dir = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "gwglibc-"));
  const prev = PATHS.gwGlibcLib;
  PATHS.gwGlibcLib = dir;
  try {
    fs.writeFileSync(path.join(dir, "libc.so.6"), "libc v1");
    fs.writeFileSync(path.join(dir, "ld-linux-aarch64.so.1"), "ld v1");
    const pin = { "libc.so.6": h("libc v1"), "ld-linux-aarch64.so.1": h("ld v1") };
    assert.deepEqual(gwGlibcBad({ pin, dir }), []);
    assert.deepEqual(gwGlibcBad({ pin, dir }), [], "第二遍走缓存，结论一样");
    // 改内容（同样大小也要认出来：ctime 变了就重算）
    fs.writeFileSync(path.join(dir, "libc.so.6"), "libc v2");
    assert.deepEqual(gwGlibcBad({ pin, dir }), ["libc.so.6"]);
    fs.writeFileSync(path.join(dir, "libc.so.6"), "libc v1");
    assert.deepEqual(gwGlibcBad({ pin, dir }), []);
    // 多塞一个库
    fs.writeFileSync(path.join(dir, "libnss_evil.so.2"), "x");
    assert.deepEqual(gwGlibcBad({ pin, dir }), ["libnss_evil.so.2"]);
    fs.rmSync(path.join(dir, "libnss_evil.so.2"));
    // 删掉一个
    fs.rmSync(path.join(dir, "ld-linux-aarch64.so.1"));
    assert.deepEqual(gwGlibcBad({ pin, dir }), ["ld-linux-aarch64.so.1"]);
    // 换成指向内容相同的文件的软链：也不认（应用只写普通文件）
    const elsewhere = path.join(dir, "..", "ld-copy-" + path.basename(dir));
    fs.writeFileSync(elsewhere, "ld v1");
    fs.symlinkSync(elsewhere, path.join(dir, "ld-linux-aarch64.so.1"));
    assert.deepEqual(gwGlibcBad({ pin, dir }), ["ld-linux-aarch64.so.1"]);
    fs.rmSync(elsewhere);
    // 网关没用自己那份（开发版退回 $PREFIX、开发布局）：不核
    assert.deepEqual(gwGlibcBad({ pin: null, dir }), []);
    PATHS.gwGlibcLib = "/elsewhere";
    assert.deepEqual(gwGlibcBad({ pin, dir }), []);
  } finally { PATHS.gwGlibcLib = prev; fs.rmSync(dir, { recursive: true, force: true }); }
});

test("gwpin：gw 组（node、libz 等）也按钉子核；glibc 子目录不算多出来的文件", () => {
  const dir = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "gw-"));
  try {
    fs.writeFileSync(path.join(dir, "node"), "node v1");
    fs.writeFileSync(path.join(dir, "libz.so.1"), "z v1");
    fs.mkdirSync(path.join(dir, "glibc"));   // 另一组的目录，放过
    const pin = { node: h("node v1"), "libz.so.1": h("z v1") };
    assert.deepEqual(gwGwBad({ pin, dir }), []);
    fs.writeFileSync(path.join(dir, "node"), "node v2");
    assert.deepEqual(gwGwBad({ pin, dir }), ["node"]);
    fs.writeFileSync(path.join(dir, "node"), "node v1");
    fs.writeFileSync(path.join(dir, "libevil.so"), "x");
    assert.deepEqual(gwGwBad({ pin, dir }), ["libevil.so"]);
    fs.rmSync(path.join(dir, "libevil.so"));
    assert.deepEqual(gwGwBad({ pin: null, dir }), [], "钉子没接线时不核");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("gwpin：测试环境没交钉子，起 claude 前的检查放行", () => {
  assert.equal(gwRuntimeBlocked(), "");
});

test("gwpin：gw 组缺钉子也 fail-closed（与 glibc 组同一条路：只拦，不重启）；钉子齐了放行", () => {
  // DIR 是模块级常量，import 时从环境读：子进程里分别测缺钉子 / 钉子齐。
  // glibc 钉子给了真的（文件对得上），这样拦下来的只能是 gw 组缺钉子那支。
  const run = (withGwPin) => {
    const root = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "gwmiss-"));
    const gw = path.join(root, "gw"), glibc = path.join(gw, "glibc");
    fs.mkdirSync(glibc, { recursive: true });
    fs.writeFileSync(path.join(glibc, "libc.so.6"), "libc v1");
    fs.writeFileSync(path.join(gw, "node"), "node v1");
    const env = { ...process.env, AGAPP_GW_GLIBC_LIB: glibc, AGAPP_GW_GLIBC_PIN: JSON.stringify({ "libc.so.6": h("libc v1") }) };
    if (withGwPin) env.AGAPP_GW_PIN = JSON.stringify({ node: h("node v1") });
    else delete env.AGAPP_GW_PIN;
    try {
      const r = spawnSync(process.execPath, ["--input-type=module", "-e",
        `import { gwRuntimeBlocked } from ${JSON.stringify(new URL("../gw/gwpin.mjs", import.meta.url).pathname)}; console.log(JSON.stringify(gwRuntimeBlocked()));`],
        { env, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout.trim());
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  };
  const blocked = run(false);
  assert.notEqual(blocked, "", "gw 组没钉子：这一轮不起 agy");
  assert.ok(blocked.includes("Antigravity CLI"), "拦截文案说清没起哪一个");
  assert.equal(run(true), "", "两组钉子都对上：放行");
});
