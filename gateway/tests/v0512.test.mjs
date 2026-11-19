// v0.5.12 之后（agy 版）：独立审查（低1 列目录、低3 环境变量、低5 循环依赖）
// 旧版中1（模型清单地址 modelsUrlOk）已不存在：agy 没有 /models 可拉，没有第三方清单地址可核。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CFG } from "../gw/config.mjs";
import { routeFiles } from "../gw/files.mjs";

const GW = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("agy 子进程不继承 CLASSPATH / 证书注入变量 / 密钥变量", () => {
  const src = fs.readFileSync(path.join(GW, "gw/agy.mjs"), "utf8");
  const re = new RegExp(/const EXTRA_ENV_DENY = (\/.*\/);/.exec(src)[1].slice(1, -1));
  for (const k of ["CLASSPATH", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "LD_PRELOAD", "PATH", "HOME"]) assert.ok(re.test(k), k);
  assert.ok(!re.test("LANG"));
});

test("extraEnv 拒单补证书注入与登录令牌（红队 11-07 探针 18→15）；旧的 Claude 变量一律清掉", async () => {
  const src = fs.readFileSync(path.join(GW, "gw/agy.mjs"), "utf8");
  const re = new RegExp(/const EXTRA_ENV_DENY = (\/.*\/);/.exec(src)[1].slice(1, -1));
  for (const k of ["REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_APPLICATION_CREDENTIALS"]) assert.ok(re.test(k), k);
  // 设计放行的照旧
  for (const k of ["API_TIMEOUT_MS", "TZ", "HTTP_PROXY"]) assert.ok(!re.test(k), k);
  // 继承来的 Claude 变量不进 agy 进程（agy.mjs 的 agyEnv 开头就清）
  const { agyEnv } = await import("../gw/agy.mjs");
  process.env.CLAUDE_CODE_MAX_RETRIES = "3";
  process.env.ANTHROPIC_API_KEY = "<redacted>";
  try {
    const env = agyEnv({});
    assert.equal(env.CLAUDE_CODE_MAX_RETRIES, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
  } finally { delete process.env.CLAUDE_CODE_MAX_RETRIES; delete process.env.ANTHROPIC_API_KEY; }
});

function fakeRes() {
  const r = { code: 0, body: null, writeHead(c) { r.code = c; }, end(b) { r.body = b ? JSON.parse(String(b)) : null; } };
  return r;
}
async function list(dir) {
  const res = fakeRes();
  await routeFiles({ method: "GET", headers: {} }, res, new URL(`http://x/api/files?path=${encodeURIComponent(dir)}&hidden=1`), "/api/files");
  return res;
}

test("列目录：home 根拒绝，工作区照常，凭据文件名不出现", async () => {
  fs.mkdirSync(CFG.workspace, { recursive: true });
  fs.writeFileSync(path.join(CFG.workspace, "a.txt"), "x");
  fs.writeFileSync(path.join(CFG.workspace, "id_ed25519"), "k");
  const h = await list(CFG.home);
  assert.equal(h.code, 403);
  assert.equal((h.body.entries || []).length, 0);
  const w = await list(CFG.workspace);
  assert.notEqual(w.code, 403);
  const names = w.body.entries.map((e) => e.name);
  assert.ok(names.includes("a.txt"));
  assert.ok(!names.includes("id_ed25519"));
  fs.rmSync(path.join(CFG.workspace, "id_ed25519"));
  fs.mkdirSync(path.join(CFG.workspace, ".ssh"), { recursive: true });
  assert.equal((await list(path.join(CFG.workspace, ".ssh"))).code, 403);
});

test("各网关模块单独导入都不崩（不靠 server.mjs 的导入顺序）", async () => {
  for (const m of ["providers", "settings", "models", "queue", "run", "agy"]) {
    const r = await new Promise((done) => execFile(process.execPath, ["-e", `import(${JSON.stringify(path.join(GW, "gw", m + ".mjs"))}).then(()=>process.exit(0),e=>{console.error(e.message);process.exit(1)})`], { env: process.env, timeout: 60000 }, (e, out, err) => done({ code: e ? e.code : 0, err })));
    assert.equal(r.code, 0, m + ": " + r.err);
  }
});
