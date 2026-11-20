import "../gw/config.mjs";
// E13 最小验证 (c)：本机 Gemini 桩端点（见 gw/gemini-stub.mjs）。
// 只测桩本身 + agyEnv 接线 + writeAgySettings 在该路径下的行为；
// 旧桥的保存/修复/托管三组模块与路由一律不动。
import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { CFG } from "../gw/config.mjs";
import { TOKEN } from "../gw/access.mjs";
import { NEXT } from "../gw/http.mjs";
import { routeGeminiStub, stubBaseUrl, stubEnabled, stubEnv, stubLogFile } from "../gw/gemini-stub.mjs";
import { SETTINGS } from "../gw/settings-store.mjs";
import { agyEnv, agySettingsPath, writeAgySettings } from "../gw/agy.mjs";

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  Promise.resolve(routeGeminiStub(req, res, url, url.pathname)).then((r) => {
    if (r === NEXT) { res.writeHead(404, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "not found" })); }
  }).catch(() => { if (!res.headersSent) { res.writeHead(500); res.end("{}"); } });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(() => server.close());

async function req(method, p, { headers = {}, body } = {}) {
  const r = await fetch(origin + p, {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) }),
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, headers: r.headers, text, json };
}
const keyHeader = { "x-goog-api-key": TOKEN };
const geminiBody = { contents: [{ role: "user", parts: [{ text: "ping" }] }], generationConfig: { thinkingConfig: { thinkingLevel: "low" } } };
const lastLog = () => { try { const lines = fs.readFileSync(stubLogFile(), "utf8").trim().split("\n"); return JSON.parse(lines[lines.length - 1]); } catch { return null; } };
const logText = () => { try { return fs.readFileSync(stubLogFile(), "utf8"); } catch { return ""; } };
const setStub = (on) => { SETTINGS.geminiStub = on; };
beforeEach(() => { setStub(false); try { fs.unlinkSync(stubLogFile()); } catch {} });

// ── 门 ──────────────────────────────────────────────────────────────
test("门关着：桩端点不存在（404），连 401 都不回", async () => {
  setStub(false);
  const r = await req("POST", "/v1beta/models/fake/m1:generateContent", { headers: keyHeader, body: geminiBody });
  assert.equal(r.status, 404);
  assert.equal(fs.existsSync(stubLogFile()), false);   // 没开门就不记日志
});

test("门只认严格 true：字符串 'true' 也不开", async () => {
  SETTINGS.geminiStub = "true";
  const r = await req("POST", "/v1beta/models/fake/m1:generateContent", { headers: keyHeader, body: geminiBody });
  assert.equal(r.status, 404);
  assert.equal(stubEnabled(), false);
});

test("开关 API：GET 查 / POST 开关，写盘后重读仍在", async () => {
  let r = await req("GET", "/api/gemini-stub");
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, false);
  assert.equal(r.json.baseUrl, stubBaseUrl());
  assert.equal(r.json.logFile, stubLogFile());
  r = await req("POST", "/api/gemini-stub", { body: { enabled: true } });
  assert.equal(r.json.enabled, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(CFG.home, "agyapp-settings.json"), "utf8")).geminiStub, true);
  r = await req("POST", "/api/gemini-stub", { body: { enabled: false } });
  assert.equal(r.json.enabled, false);
});

test("开关 API：POST 体不是 JSON → 400，不 500；开关状态不变", async () => {
  const r = await req("POST", "/api/gemini-stub", { body: "{bad json" });
  assert.equal(r.status, 400);
  const g = await req("GET", "/api/gemini-stub");
  assert.equal(g.json.enabled, false);
});

// ── 非流式 ──────────────────────────────────────────────────────────
test("非流式：正确 token（x-goog-api-key）→ 200 固定 Gemini 形状，模型名原样回显", async () => {
  setStub(true);
  const r = await req("POST", "/v1beta/models/fake/m1:generateContent", { headers: keyHeader, body: geminiBody });
  assert.equal(r.status, 200);
  assert.equal(r.json.candidates[0].content.parts[0].text, "ok");
  assert.equal(r.json.candidates[0].content.role, "model");
  assert.equal(r.json.candidates[0].finishReason, "STOP");
  assert.equal(r.json.modelVersion, "fake/m1");
  assert.ok(r.json.usageMetadata);
  const e = lastLog();
  assert.equal(e.status, 200);
  assert.equal(e.model, "fake/m1");
  assert.equal(e.stream, false);
  assert.equal(e.auth, "x-goog-api-key");
  assert.equal(e.body.contents, undefined);   // 日志里的 body 是截断后的 JSON 字符串（有界），不是对象
  assert.equal(JSON.parse(e.body).contents[0].parts[0].text, "ping");   // 请求体记下来了，供真机核对 agy 发了什么
  assert.ok(!logText().includes(TOKEN));                    // 令牌值绝不进日志
});

test("非流式：正确 token 经 ?key= → 200；查询串不进日志", async () => {
  setStub(true);
  const r = await req("POST", `/v1beta/models/fake/m1:generateContent?key=${TOKEN}`, { body: geminiBody });
  assert.equal(r.status, 200);
  assert.equal(lastLog().auth, "key");
  assert.ok(!logText().includes(TOKEN));
  assert.ok(!logText().includes("?key="));
});

test("无 token → 401 UNAUTHENTICATED，日志记 auth=none", async () => {
  setStub(true);
  const r = await req("POST", "/v1beta/models/fake/m1:generateContent", { body: geminiBody });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.status, "UNAUTHENTICATED");
  assert.equal(lastLog().status, 401);
  assert.equal(lastLog().auth, "none");
});

test("错 token → 401，错的值不进日志", async () => {
  setStub(true);
  const r = await req("POST", "/v1beta/models/fake/m1:generateContent", { headers: { "x-goog-api-key": "wrong-token-123" }, body: geminiBody });
  assert.equal(r.status, 401);
  assert.equal(lastLog().auth, "bad-key");
  assert.ok(!logText().includes("wrong-token-123"));
});

test("Bearer 不认：只认 x-goog-api-key / ?key=（magpie 也收 Bearer，这里按任务只开两条）", async () => {
  setStub(true);
  const r = await req("POST", "/v1beta/models/fake/m1:generateContent", { headers: { authorization: `Bearer ${TOKEN}` }, body: geminiBody });
  assert.equal(r.status, 401);
});

test("体不是 JSON 也不 500：照常回固定响应，日志记 bodyParse=invalid", async () => {
  setStub(true);
  const r = await req("POST", "/v1beta/models/fake/m1:generateContent", { headers: keyHeader, body: "{not json" });
  assert.equal(r.status, 200);
  assert.equal(r.json.candidates[0].content.parts[0].text, "ok");
  assert.equal(lastLog().bodyParse, "invalid");
});

// ── 流式 ────────────────────────────────────────────────────────────
test("流式：SSE 两块——内容块 + STOP 收尾块（含 usage）", async () => {
  setStub(true);
  const r = await req("POST", "/v1beta/models/fake/m1:streamGenerateContent", { headers: keyHeader, body: geminiBody });
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/event-stream/);
  const chunks = r.text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => JSON.parse(l.slice(6)));
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].candidates[0].content.parts[0].text, "ok");
  assert.equal(chunks[0].candidates[0].finishReason, undefined);
  assert.equal(chunks[1].candidates[0].finishReason, "STOP");
  assert.ok(chunks[1].usageMetadata);
  assert.equal(lastLog().stream, true);
  assert.equal(lastLog().status, 200);
});

// ── 不认领的 ────────────────────────────────────────────────────────
test("只认 POST：GET 桩端点 → NEXT（404）", async () => {
  setStub(true);
  const r = await req("GET", "/v1beta/models/fake/m1:generateContent");
  assert.equal(r.status, 404);
});
test(":countTokens 不在验证范围 → NEXT（404）", async () => {
  setStub(true);
  const r = await req("POST", "/v1beta/models/fake/m1:countTokens", { headers: keyHeader, body: geminiBody });
  assert.equal(r.status, 404);
});

// ── agyEnv 接线 ─────────────────────────────────────────────────────
const geminiP = { id: "gemini", apiKey: "AIzaFakeUserKey000000000000000000000" };
const googleP = { id: "google", login: true };
test("stubEnv：只在 gemini + 开门时给值，其余 null", () => {
  setStub(true);
  assert.deepEqual(stubEnv(geminiP), { GOOGLE_GEMINI_BASE_URL: stubBaseUrl(), GEMINI_API_KEY: TOKEN });
  assert.equal(stubEnv(googleP), null);
  setStub(false);
  assert.equal(stubEnv(geminiP), null);
});

test("agyEnv 开门 + gemini：BASE_URL 指本机网关，GEMINI_API_KEY 是网关令牌（不是用户 key）", () => {
  setStub(true);
  const env = agyEnv({ provider: geminiP });
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, `http://127.0.0.1:${CFG.port}`);
  assert.equal(env.GEMINI_API_KEY, TOKEN);
  assert.notEqual(env.GEMINI_API_KEY, geminiP.apiKey);
});

test("agyEnv 开门 + google：Google 登录路径纹丝不动（无 BASE_URL、无 GEMINI_API_KEY）", () => {
  setStub(true);
  const env = agyEnv({ provider: googleP });
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, undefined);
  assert.equal(env.GEMINI_API_KEY, undefined);
});

test("agyEnv 门关着 + gemini：走原来的用户 key，不指桩", () => {
  setStub(false);
  const env = agyEnv({ provider: geminiP });
  assert.equal(env.GEMINI_API_KEY, geminiP.apiKey);
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, undefined);
});

test("agyEnv 门关着：父进程继承来的 GOOGLE_GEMINI_BASE_URL 也删掉（防外来变量拐走请求）", () => {
  const prev = process.env.GOOGLE_GEMINI_BASE_URL;
  process.env.GOOGLE_GEMINI_BASE_URL = "https://evil.example";
  try {
    setStub(false);
    assert.equal(agyEnv({ provider: geminiP }).GOOGLE_GEMINI_BASE_URL, undefined);
    assert.equal(agyEnv({ provider: googleP }).GOOGLE_GEMINI_BASE_URL, undefined);
  } finally {
    if (prev === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL; else process.env.GOOGLE_GEMINI_BASE_URL = prev;
  }
});

test("agyEnv 开门 + gemini：父进程的 BASE_URL 被桩地址盖掉，不漏出去", () => {
  const prev = process.env.GOOGLE_GEMINI_BASE_URL;
  process.env.GOOGLE_GEMINI_BASE_URL = "https://evil.example";
  try {
    setStub(true);
    assert.equal(agyEnv({ provider: geminiP }).GOOGLE_GEMINI_BASE_URL, `http://127.0.0.1:${CFG.port}`);
  } finally {
    if (prev === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL; else process.env.GOOGLE_GEMINI_BASE_URL = prev;
  }
});

test("厂商 extraEnv 借道设 GOOGLE_GEMINI_BASE_URL 被拦（EXTRA_ENV_DENY）", () => {
  setStub(false);
  const env = agyEnv({ provider: { ...geminiP, extraEnv: { GOOGLE_GEMINI_BASE_URL: "https://evil.example", FOO_BAR: "1" } } });
  assert.equal(env.GOOGLE_GEMINI_BASE_URL, undefined);
  assert.equal(env.FOO_BAR, "1");   // 无害的照常放行
});

// ── writeAgySettings ────────────────────────────────────────────────
// 先读清的结论：它本来就按 p.id 写 modelProvider（gemini → "gemini"，其余 → ""），
// 桩路径不需要改它 —— 这几条把“桩路径下 modelProvider 是 gemini”锁住。
test("writeAgySettings：桩路径（gemini + 开门）写 modelProvider=gemini", () => {
  setStub(true);
  assert.equal(writeAgySettings(geminiP), true);
  assert.equal(JSON.parse(fs.readFileSync(agySettingsPath(), "utf8")).modelProvider, "gemini");
});
test("writeAgySettings：Google 登录路径（开门也不影响）写 modelProvider='' ", () => {
  setStub(true);
  assert.equal(writeAgySettings(googleP), true);
  assert.equal(JSON.parse(fs.readFileSync(agySettingsPath(), "utf8")).modelProvider, "");
});
test("writeAgySettings：门关着 + gemini 也一样写 gemini（写键逻辑与门无关，未改）", () => {
  setStub(false);
  assert.equal(writeAgySettings(geminiP), true);
  assert.equal(JSON.parse(fs.readFileSync(agySettingsPath(), "utf8")).modelProvider, "gemini");
});
