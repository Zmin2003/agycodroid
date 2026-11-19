import { PATHS } from "../gw/config.mjs"; // scripts/test.mjs 先隔离 HOME / fake PREFIX。
import "./fixtures/uc-baseline.mjs";   // 共用 home 里前面测试留下的 ~/.claude 改动先认下，免得真起一轮时卡在确认卡片
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { performance } from "node:perf_hooks";

// 即使意外走到 CLI，也只会得到可丢弃的假凭据和假入口。
// 移植：托管桥（ensureManagedBridge）只对 custom 厂商生效（providerEndpoint 要求
// p.custom），agy 只有 google / gemini 内置厂商，桥再也不会被 startRun 等到——
// 6 条桥门控用例（startRun 桥失败、abortRun 停 readiness、双 run 共享 ensure、
// 配置 success/failure 在途 gate、配置→卸载→重装换 key）随之删除。
// 留下的 3 条不依赖桥：run_start 同步取消、配置请求体校验。
process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";
const home = process.env.AGAPP_HOME, prefix = process.env.AGAPP_PREFIX;
const root = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "managed-run-"));
const reg = path.join(home, ".agycodroid/services/openai-bridge.json");
const record = path.join(path.dirname(prefix), "components/openai-bridge.json");
const component = path.join(prefix, "lib/openai-bridge/component.cjs");
const providerFile = path.join(home, "agyapp-providers.json");
const cli = path.join(root, "fake-loader.cjs"), cliMarker = path.join(root, "cli-called");
fs.mkdirSync(path.dirname(component), { recursive: true });
fs.mkdirSync(path.dirname(reg), { recursive: true });
fs.mkdirSync(path.dirname(record), { recursive: true });
fs.writeFileSync(component, `const fs=require('node:fs'),path=require('node:path');
const args=process.argv.slice(2),dir=args[args.indexOf('--dir')+1];
fs.appendFileSync(path.join(dir,'calls'),args[0]+'\\n');
fs.writeFileSync(path.join(dir,'launcher.pid'),String(process.pid));
setTimeout(()=>{process.exitCode=1;},300);
`);
// 假 loader 用 sh：claude 的环境变量清掉了 LD_LIBRARY_PATH，有的机器上 node 离了它起不来（缺 libz），假 CLI 根本跑不到
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
fs.writeFileSync(cli, `#!${sh}\necho called > ${JSON.stringify(cliMarker)}\nexit 97\n`, { mode: 0o700 });
const endpoint = "http://127.0.0.1:34592";
// 只使用自身临时配置；KEY 检查需要非空假值，不导入活 App 的 providers。
fs.writeFileSync(providerFile, JSON.stringify({ active: "custom-managed-test", providers: {
  "custom-managed-test": { label: "Fake bridge", baseUrl: endpoint, apiKey: "fixture-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
  "custom-managed-other": { label: "Other fixture provider", baseUrl: "https://other-fixture.example.invalid", apiKey: "fixture-other-only", authStyle: "bearer", defaultModel: "fixture-model", fallbackModels: [{ id: "fixture-model" }] },
} }));
const previousPaths = { claude: PATHS.claude, loader: PATHS.loader, claudeLoader: PATHS.claudeLoader };
PATHS.claude = process.execPath;
PATHS.loader = PATHS.claudeLoader = cli;
const { startRun } = await import("../gw/run.mjs");
const { abortRun } = await import("../gw/queue.mjs");
const { RUNS } = await import("../gw/runs.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const { ensureManagedBridge } = await import("../gw/managed-bridge.mjs");
const { routeComponents } = await import("../gw/components.mjs");
const { routeProviders } = await import("../gw/providers.mjs");
const events = [], requests = [];
const off = onPublish((ev) => events.push(ev));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...args) => { requests.push(String(args[0])); throw new Error("fixture must not send a model request"); };
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, ms = 3000) {
  const start = performance.now();
  while (!check()) { assert.ok(performance.now() - start < ms, "假组件 ensure 未开始"); await delay(10); }
}
function fixture() {
  const dir = fs.mkdtempSync(path.join(root, "instance-"));
  fs.writeFileSync(reg, JSON.stringify({ schema: 1, id: "openai-bridge", endpoint, runtimeDir: dir, instanceId: crypto.randomBytes(16).toString("hex") }));
  fs.writeFileSync(record, JSON.stringify({ id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs"] }));
  return { dir, calls: () => { try { return fs.readFileSync(path.join(dir, "calls"), "utf8").trim().split("\n"); } catch { return []; } } };
}
function ended(id, { failed = false, aborted = false } = {}) {
  assert.equal(RUNS.has(id), false);
  const mine = events.filter((e) => e.runId === id), ends = mine.filter((e) => e.type === "run_end");
  assert.equal(ends.length, 1);
  assert.equal(!!ends[0].failed, failed);
  assert.equal(!!ends[0].aborted, aborted);
  assert.equal(mine.some((e) => e.type === "init"), false);
  assert.equal(fs.existsSync(cliMarker), false, "readiness 之前不能执行 CLI");
  assert.equal(requests.length, 0, "readiness 之前不能发模型/模型列表请求");
  return mine;
}
after(() => {
  off();
  globalThis.fetch = originalFetch;
  Object.assign(PATHS, previousPaths);
  for (const p of [reg, record, component, providerFile]) fs.rmSync(p, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("run_start 时同步取消，readyAbort 尚未创建也必须结束且不 spawn ensure", async () => {
  const f = fixture();
  let cancelled = false, beforeReady = false;
  const unsubscribe = onPublish((ev) => {
    if (ev.type !== "run_start" || ev.runId !== "managed-early-cancel") return;
    const run = RUNS.get(ev.runId);
    beforeReady = !!run && run.readyAbort == null && run.child === null;
    cancelled = abortRun(run);
  });
  try { await startRun({ id: "managed-early-cancel", message: "fixture message", cwd: root }); }
  finally { unsubscribe(); }
  assert.equal(beforeReady, true, "取消必须确实发生在 readyAbort 创建之前");
  assert.equal(cancelled, true);
  assert.deepEqual(f.calls(), [], "已取消 run 不能再启动 readiness");
  const mine = ended("managed-early-cancel", { aborted: true });
  assert.equal(mine.some((e) => e.type === "error"), false);
});

const guiTarget = path.join(home, ".local/share/ccr-bridge-kit");
const guiState = path.join(home, ".cccodroid/services/openai-bridge-app.json");
// 下面两条用例只测「无效 body 在组件命令之前就被拒」，组件脚本本身不会被执行，
// 所以这里只留一个占位脚本（原来那份很长的 gui 假组件随桥门控用例一起删了）。
const guiSource = `process.exitCode = 2;\n`;
function configGateFixture(mode, { resetMapping = true, localKey = "c".repeat(48) } = {}) {
  fs.mkdirSync(guiTarget, { recursive: true });
  fs.mkdirSync(path.dirname(component), { recursive: true });
  for (const file of ["calls", "configuring", "release"]) fs.rmSync(path.join(guiTarget, file), { force: true });
  if (resetMapping) fs.rmSync(guiState, { force: true });
  fs.writeFileSync(path.join(guiTarget, "mode"), mode);
  fs.writeFileSync(path.join(guiTarget, ".ccr-bridge-kit.json"), JSON.stringify({ id: "ccr-bridge-kit", target: guiTarget, guiManaged: true }), { mode: 0o600 });
  fs.writeFileSync(path.join(guiTarget, "connection.json"), JSON.stringify({ baseUrl: endpoint, apiKey: localKey, model: "fixture-model" }), { mode: 0o600 });
  fs.writeFileSync(component, guiSource);
  fs.writeFileSync(reg, JSON.stringify({ schema: 1, id: "openai-bridge", endpoint, runtimeDir: guiTarget, instanceId: crypto.randomBytes(16).toString("hex") }));
  fs.writeFileSync(record, JSON.stringify({ id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs"] }));
  return { calls: () => { try { return fs.readFileSync(path.join(guiTarget, "calls"), "utf8").trim().split("\n"); } catch { return []; } } };
}

for (const mode of ["signature-mismatch", "overlong"]) test(`真实配置请求 ${mode}：拒绝无效 body，组件命令零调用`, async () => {
  const f = configGateFixture("success");
  const registration = fs.readFileSync(reg, "utf8");
  let routeDone;
  const completed = new Promise((resolve) => { routeDone = resolve; });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (mode === "signature-mismatch") req.ccBodySha = "0".repeat(64);
    Promise.resolve(routeComponents(req, res, url, url.pathname)).then(routeDone, (e) => {
      if (!res.headersSent && !res.destroyed) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: e.message })); }
      routeDone();
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const body = { endpoint: "https://fixture-upstream.example.invalid/v1", apiKey: "fixture-upstream-key", model: "fixture-model", consent: true };
    // 额外JSON空白使语义上仍是同一份合法输入；只有字节上限能挡住，不能靠字段校验冒充通过。
    const raw = JSON.stringify(body) + (mode === "overlong" ? " ".repeat(512 * 1024 + 1) : "");
    const outcome = await new Promise((resolve) => {
      const request = http.request(`http://127.0.0.1:${server.address().port}/api/components/openai-bridge/config`, { method: "POST", headers: { "content-type": "application/json" } }, (response) => {
        let text = ""; response.setEncoding("utf8"); response.on("data", (chunk) => { text += chunk; });
        response.on("end", () => resolve({ status: response.statusCode, text }));
      });
      request.on("error", (error) => resolve({ error }));
      request.setTimeout(3000, () => request.destroy(new Error("invalid body fixture timed out")));
      request.end(raw);
    });
    await completed;
    if (outcome.error) {
      assert.equal(mode, "overlong", "摘要不匹配应该是正常JSON拒绝，不应意外断连");
      assert.equal(outcome.error.code, "ECONNRESET", "仅接受readBodyBuf主动destroy造成的断连");
    } else {
      assert.equal(outcome.status, 400);
      assert.equal(JSON.parse(outcome.text).code, "invalid_input");
    }
    assert.deepEqual(f.calls(), [], "无效请求不能启动gui-status/gui-configure/ensure");
    assert.equal(fs.existsSync(path.join(guiTarget, "configuring")), false);
    assert.equal(fs.readFileSync(reg, "utf8"), registration);
    assert.equal(fs.existsSync(guiState), false);
  } finally {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    fs.rmSync(guiTarget, { recursive: true, force: true });
  }
});
