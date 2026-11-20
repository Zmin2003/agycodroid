// agy 模型拉取（gw/models.mjs）：`agy models` TSV/JSON 解析、失败分级、缓存与强制刷新、
// 事后学窗口（learnWindow）。假 agy 脚本走 PATHS.agy（audit0520 / audit1101 同款路数）。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { parseAgyModels, fetchModels, cachedModels, modelsMeta, learnWindow, noteLoggedIn, dropModelCache, expireModelCache } from "../gw/models.mjs";
import { providerById, upsertProvider } from "../gw/providers.mjs";

const SH = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const TSV = "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\nclaude-sonnet-4-6\tClaude Sonnet 4.6\n";

async function fakeAgy(t, body) {
  const fake = path.join(CFG.home, "fake-agy-models-" + Math.random().toString(36).slice(2) + ".sh");
  fs.writeFileSync(fake, `#!${SH}\n${body}\n`, { mode: 0o700 });
  const prev = PATHS.agy;
  PATHS.agy = fake;
  t.after(() => { PATHS.agy = prev; fs.rmSync(fake, { force: true }); });
  return fake;
}

test("parseAgyModels：TSV 取第一个 tab 字段，裸 slug 行也认", () => {
  const r = parseAgyModels("gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\nclaude-sonnet-4-6\n");
  assert.deepEqual(r.list.map((m) => [m.id, m.name]),
    [["gemini-3.8-flash-medium", "Gemini 3.8 Flash (Medium)"], ["claude-sonnet-4-6", "claude-sonnet-4-6"]]);
  assert.equal(r.defaultId, null);
});

test("parseAgyModels：空行与脏行丢掉", () => {
  const r = parseAgyModels("\n" + TSV + "带空格 不行\t标签\n\n   \n progress 50%\n");
  assert.deepEqual(r.list.map((m) => m.id), ["gemini-3.8-flash-medium", "claude-sonnet-4-6"]);
});

test("parseAgyModels：表头行与单字进度行不当模型（Review-A B1）", () => {
  // 表头（MODEL / Model）与只有单词的脏行（Loading / Fetching... / Downloading）
  // 都不是模型：真实的 agy slug 都带 - 或数字。裸 slug 行仍要认。
  const r = parseAgyModels("MODEL\tLABEL\nModel\tName\ngemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)\nLoading\nFetching...\nDownloading\nclaude-sonnet-4-6\n");
  assert.deepEqual(r.list.map((m) => m.id), ["gemini-3.8-flash-medium", "claude-sonnet-4-6"]);
});

test("parseAgyModels：JSON 数组也认（1.5.13 若支持 --output-format json 时用）", () => {
  const r = parseAgyModels(JSON.stringify([{ model: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash" }, { id: "claude-sonnet-4-6", default: true }]));
  assert.deepEqual(r.list.map((m) => m.id), ["gemini-3.8-flash-medium", "claude-sonnet-4-6"]);
  assert.equal(r.defaultId, "claude-sonnet-4-6");
});

test("parseAgyModels：JSON 对象包一层 models 也认；解析不出回空", () => {
  assert.deepEqual(parseAgyModels(JSON.stringify({ models: [{ slug: "m-a" }] })).list.map((m) => m.id), ["m-a"]);
  assert.deepEqual(parseAgyModels("").list, []);
  assert.deepEqual(parseAgyModels("not json at all {{{").list, []);
});

test("fetchModels live：已登录时调 agy models，TSV 进清单，不再是写死的示例", async (t) => {
  const mark = path.join(CFG.home, "models-calls.log");
  await fakeAgy(t, `echo "$@" >> "${mark}"\nif [ "$1" = "models" ] && [ "$2" = "--help" ]; then echo "Usage: agy models"; exit 0; fi\nif [ "$1" = "models" ]; then printf '%b' "${TSV.replaceAll("\n", "\\n")}"; exit 0; fi\nexit 1\n`);
  t.after(() => { fs.rmSync(mark, { force: true }); dropModelCache(); noteLoggedIn(null); });
  noteLoggedIn(true);
  dropModelCache();
  const p = providerById("google");
  const list = await fetchModels(true, p, { guess: true });
  assert.deepEqual(list.map((m) => m.id), ["gemini-3.8-flash-medium", "claude-sonnet-4-6"]);
  assert.equal(modelsMeta(p).source, "live");
  assert.ok(fs.readFileSync(mark, "utf8").includes("models"), "应真的调过 agy models");
});

test("fetchModels：--help 里有 --output-format 就先试 JSON，JSON 不可用回落 TSV", async (t) => {
  const mark = path.join(CFG.home, "models-calls2.log");
  await fakeAgy(t, `echo "$@" >> "${mark}"\nif [ "$1" = "models" ] && [ "$2" = "--help" ]; then echo "Flags: --output-format string"; exit 0; fi\nif [ "$2" = "--output-format" ]; then echo "flags provided but not defined: -output-format" >&2; exit 1; fi\nif [ "$1" = "models" ]; then printf 'gemini-3.8-flash-medium\\tGemini 3.8 Flash\\n'; exit 0; fi\nexit 1\n`);
  t.after(() => { fs.rmSync(mark, { force: true }); dropModelCache(); noteLoggedIn(null); });
  noteLoggedIn(true);
  dropModelCache();
  const list = await fetchModels(true, providerById("google"), { guess: true });
  assert.deepEqual(list.map((m) => m.id), ["gemini-3.8-flash-medium"]);
  assert.equal(modelsMeta(providerById("google")).source, "live");
});

test("fetchModels 失败分级：authentication required → 未登录，回静态清单标 static", async (t) => {
  await fakeAgy(t, `if [ "$1" = "models" ] && [ "$2" = "--help" ]; then exit 0; fi\necho "Error: authentication required. Run 'agy' to log in." >&2\nexit 1\n`);
  t.after(() => { dropModelCache(); noteLoggedIn(null); });
  noteLoggedIn(true);
  dropModelCache();
  const list = await fetchModels(true, providerById("google"), { guess: true });
  assert.deepEqual(list.map((m) => m.id), ["gemini-3.8-flash-medium"]);
  assert.equal(modelsMeta(providerById("google")).source, "static");
  assert.equal(modelsMeta(providerById("google")).note, "not_logged_in");
});

test("fetchModels 失败分级：no model configuration → 回空 + live，不静默回落静态示例", async (t) => {
  await fakeAgy(t, `if [ "$1" = "models" ] && [ "$2" = "--help" ]; then exit 0; fi\necho "no model configuration is available for this account" >&2\nexit 1\n`);
  t.after(() => { dropModelCache(); noteLoggedIn(null); });
  noteLoggedIn(true);
  dropModelCache();
  const list = await fetchModels(true, providerById("google"), { guess: true });
  assert.deepEqual(list, []);
  assert.equal(modelsMeta(providerById("google")).source, "live");
  assert.equal(modelsMeta(providerById("google")).note, "no_models_for_account");
});

test("fetchModels 失败分级：超时 / 非 0 / 空输出 → 保留旧缓存标 stale", async (t) => {
  const mark = path.join(CFG.home, "models-calls3.log");
  await fakeAgy(t, `echo "$@" >> "${mark}"\nif [ "$1" = "models" ] && [ "$2" = "--help" ]; then exit 0; fi\nsleep 2\nexit 0\n`);
  t.after(() => { fs.rmSync(mark, { force: true }); dropModelCache(); noteLoggedIn(null); });
  noteLoggedIn(true);
  dropModelCache();
  // 先用好输出建一份缓存
  const good = path.join(CFG.home, "fake-agy-models-good.sh");
  const prev = PATHS.agy;
  fs.writeFileSync(good, `#!${SH}\nif [ "$1" = "models" ] && [ "$2" = "--help" ]; then exit 0; fi\nprintf 'gemini-3.8-flash-medium\\tGemini\\n'\nexit 0\n`, { mode: 0o700 });
  PATHS.agy = good;
  const p = providerById("google");
  assert.deepEqual((await fetchModels(true, p, { guess: true })).map((m) => m.id), ["gemini-3.8-flash-medium"]);
  PATHS.agy = prev;   // 换回会超时的假 agy
  const list = await fetchModels(true, p, { guess: true, timeoutMs: 100 });
  assert.deepEqual(list.map((m) => m.id), ["gemini-3.8-flash-medium"]);
  assert.equal(modelsMeta(p).source, "stale");
  fs.rmSync(good, { force: true });
});

test("fetchModels 缓存：10 分钟内不重跑，force 重跑，过期重跑", async (t) => {
  const mark = path.join(CFG.home, "models-calls4.log");
  await fakeAgy(t, `echo "$@" >> "${mark}"\nif [ "$1" = "models" ] && [ "$2" = "--help" ]; then exit 0; fi\nprintf 'gemini-3.8-flash-medium\\tGemini\\n'\nexit 0\n`);
  t.after(() => { fs.rmSync(mark, { force: true }); dropModelCache(); noteLoggedIn(null); });
  noteLoggedIn(true);
  dropModelCache();
  const p = providerById("google");
  const count = () => (fs.existsSync(mark) ? fs.readFileSync(mark, "utf8").trim().split("\n").filter((l) => l === "models").length : 0);
  await fetchModels(true, p, { guess: true });
  assert.equal(count(), 1);
  await fetchModels(false, p, { guess: true });
  assert.equal(count(), 1, "缓存新鲜时不重跑");
  await fetchModels(true, p, { guess: true });
  assert.equal(count(), 2, "force=true 重跑");
  expireModelCache();
  await fetchModels(false, p, { guess: true });
  assert.equal(count(), 3, "缓存过期重跑");
});

test("fetchModels：未登录时不跑 agy，回静态清单标 static", async (t) => {
  const mark = path.join(CFG.home, "models-calls5.log");
  await fakeAgy(t, `echo models >> "${mark}"\nprintf 'gemini-3.8-flash-medium\\tGemini\\n'\nexit 0\n`);
  t.after(() => { fs.rmSync(mark, { force: true }); dropModelCache(); noteLoggedIn(null); });
  noteLoggedIn(false);
  dropModelCache();
  const list = await fetchModels(true, providerById("google"), { guess: true });
  assert.deepEqual(list.map((m) => m.id), ["gemini-3.8-flash-medium"]);
  assert.equal(modelsMeta(providerById("google")).source, "static");
  assert.equal(fs.existsSync(mark), false, "未登录时不调 agy");
});

test("upsertProvider 写 extraModels 后 fetchModels 返回新增项（静态兜底）", async (t) => {
  t.after(() => { upsertProvider("gemini", { extraModels: [] }); dropModelCache(); noteLoggedIn(null); });
  noteLoggedIn(false);
  dropModelCache();
  const r = upsertProvider("gemini", { extraModels: [{ id: "m-new", contextWindow: 256000 }] });
  assert.ok(r.ok, JSON.stringify(r));
  const p = providerById("gemini");
  assert.deepEqual((await fetchModels(true, p)).map((m) => m.id), ["gemini-3.8-flash-medium", "m-new"]);
  assert.equal(cachedModels(p).find((m) => m.id === "m-new").context_window, 256000);
});

test("learnWindow：result.modelUsage 读到窗口 → 写进缓存并持久化到 extraModels", async (t) => {
  t.after(() => { upsertProvider("gemini", { extraModels: [] }); dropModelCache(); noteLoggedIn(null); });
  noteLoggedIn(false);
  dropModelCache();
  const p = providerById("gemini");
  await fetchModels(true, p);   // 先建静态缓存（含示例 slug）
  const ok = await learnWindow({ modelUsage: { "gemini-3.8-flash-medium": { contextWindow: 1000000 } } }, providerById("gemini"));
  assert.equal(ok, true);
  assert.equal(cachedModels(providerById("gemini")).find((m) => m.id === "gemini-3.8-flash-medium").context_window, 1000000);
  assert.deepEqual(providerById("gemini").extraModels, [{ id: "gemini-3.8-flash-medium", contextWindow: 1000000 }]);
});

test("stream：result 带 modelUsage.contextWindow 时 SSE 用量事件带 contextWindow；没有发 0", async () => {
  const { translate } = await import("../gw/stream.mjs");
  const flags = {}, out = [];
  const opts = { sse: (e) => out.push(e), flags, onInit() {}, onResult() {}, onReplay() {}, provider: {} };
  translate({ event: "init", conversation_id: "s1", init: { model: "gemini-3.8-flash-medium" } }, opts);
  translate({ event: "step_update", conversation_id: "s1", step_update: { step_index: 0, step_type: "agent_response", text_delta: "hi", usage: { input_tokens: 100, output_tokens: 0 } } }, opts);
  translate({ event: "result", conversation_id: "s1", result: { status: "SUCCESS", response: "done", num_turns: 1, usage: { input_tokens: 100, output_tokens: 10 }, modelUsage: { "gemini-3.8-flash-medium": { contextWindow: 1000000 } } } }, opts);
  const usages = out.filter((e) => e.type === "usage");
  assert.ok(usages.length >= 1);
  assert.equal(usages[0].contextWindow, 0, "step_update 时窗口还不知道，发 0");
  assert.equal(usages[usages.length - 1].contextWindow, 1000000, "result 读到窗口后 SSE 带上分母");
});

test("stream：result 不带 modelUsage 时 SSE 用量事件的 contextWindow 是 0（无来源，不编）", async () => {
  const { translate } = await import("../gw/stream.mjs");
  const flags = {}, out = [];
  const opts = { sse: (e) => out.push(e), flags, onInit() {}, onResult() {}, onReplay() {}, provider: {} };
  translate({ event: "result", conversation_id: "s1", result: { status: "SUCCESS", response: "done", num_turns: 1, usage: { input_tokens: 100, output_tokens: 10 } } }, opts);
  const usages = out.filter((e) => e.type === "usage");
  assert.equal(usages[usages.length - 1].contextWindow, 0);
});

test("routeModels：回包带 source / resolvedDefault，未登录时是 static + null", async (t) => {
  const http = await import("node:http");
  const { NEXT } = await import("../gw/http.mjs");
  const { routeModels } = await import("../gw/models.mjs");
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if ((await routeModels(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  t.after(() => srv.close());
  noteLoggedIn(false);
  dropModelCache();
  const r = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/models`)).json();
  assert.equal(r.source, "static");
  assert.equal(r.sourceNote, "not_logged_in");
  assert.equal(r.resolvedDefault, null);
  assert.ok(Array.isArray(r.models) && r.models.length >= 1);
});

test("learnWindow：读不到窗口 / 模型不在清单里 → 不写不断言，不抛错", async () => {
  noteLoggedIn(false);
  dropModelCache();
  assert.equal(await learnWindow({ modelUsage: {} }, providerById("gemini")), false);
  assert.equal(await learnWindow({ modelUsage: { "没见过的模型": { contextWindow: 1000000 } } }, providerById("gemini")), false);
  assert.equal(await learnWindow({}, providerById("gemini")), false);
  assert.doesNotThrow(() => learnWindow({ modelUsage: { m1: { contextWindow: 1234 } } }, { nativeModels: true }));
});
