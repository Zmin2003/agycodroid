// run.mjs 收尾学窗口：result 带 modelUsage.contextWindow 时，
// 除了 stream.mjs translate() 的流式调用点，run.mjs 的 finish() 也要再学一次
// （非流式/回放路径的兜底；translate 交出来的 lastResult 是归一化过的，里面没有 modelUsage）。
// 用假 CLI（sh 脚本按 stream-json 吐事件）驱动真实 startRun，run0520.test.mjs 同款路数。
import { PATHS, CFG } from "../gw/config.mjs"; // scripts/test.mjs 先隔离 HOME / fake PREFIX
import "./fixtures/uc-baseline.mjs";   // 共用 home 里前面测试留下的 ~/.claude 改动先认下，免得真起一轮时卡在确认卡片
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
process.env.ANTHROPIC_AUTH_TOKEN = "fixture-only-do-not-forward";
const home = process.env.AGAPP_HOME;
const root = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "run-learn-window-"));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
function script(steps, code = 0) {
  const body = steps.map((s) => `printf '%s\\n' ${JSON.stringify(JSON.stringify(s)).replace(/\$/g, "\\$")}`).join("\n");
  fs.writeFileSync(cli, `#!${sh}\n${body}\nexit ${code}\n`, { mode: 0o700 });
}
const previousPaths = { agy: PATHS.agy };
PATHS.agy = cli;
const { startRun } = await import("../gw/run.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const { providerById } = await import("../gw/providers.mjs");
const events = [];
const off = onPublish((ev) => events.push(ev));
after(() => {
  off();
  Object.assign(PATHS, previousPaths);
  fs.rmSync(root, { recursive: true, force: true });
});
const endOf = (id) => events.find((e) => e.type === "run_end" && e.runId === id);
async function until(f, ms = 8000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sid = () => crypto.randomUUID();
const init = (s) => ({ event: "init", conversation_id: s, init: { model: "gemini-3.8-flash-medium", tools: [], permission_mode: "default" } });
const result = (s, modelUsage) => ({ event: "result", result: { conversation_id: s, num_turns: 1, status: "SUCCESS", response: "done", usage: { input_tokens: 100, output_tokens: 10 }, ...(modelUsage ? { modelUsage } : {}) } });
const extraOf = () => providerById("google").extraModels || [];
const learned = () => extraOf().find((e) => e.id === "gemini-3.8-flash-medium");

test("run.mjs 里接了 learnWindow 调用点（收尾用原始 result 学窗口）", () => {
  const src = fs.readFileSync(new URL("../gw/run.mjs", import.meta.url), "utf8");
  assert.match(src, /lastRawResult = ev\.result/, "feed 里留住带 modelUsage 的原始 result");
  assert.match(src, /learnWindow\(lastRawResult, P\)/, "finish 里用原始 result 调 learnWindow");
});

test("学到：result 带 modelUsage.contextWindow → 写进 google 的 extraModels", async () => {
  const s = sid();
  script([init(s), result(s, { "gemini-3.8-flash-medium": { contextWindow: 1000000 } })], 0);
  await startRun({ id: "r-learn-ok", message: "fixture", cwd: root });
  await until(() => endOf("r-learn-ok"));
  assert.equal(!!endOf("r-learn-ok").failed, false, JSON.stringify(endOf("r-learn-ok")));
  await until(() => learned() && learned().contextWindow === 1000000);
  assert.deepEqual(learned(), { id: "gemini-3.8-flash-medium", contextWindow: 1000000 });
});

test("学不到：result 不带 modelUsage → extraModels 不变", async () => {
  const before = JSON.stringify(extraOf());
  const s = sid();
  script([init(s), result(s, null)], 0);
  await startRun({ id: "r-learn-none", message: "fixture", cwd: root });
  await until(() => endOf("r-learn-none"));
  await sleep(1500);   // 给 fire-and-forget 的 learn 留足时间：真学了这里一定能看见
  assert.equal(JSON.stringify(extraOf()), before);
});

test("学不到：窗口校验不过（100 < 1024）→ 不覆盖已学到的窗口", async () => {
  const s = sid();
  script([init(s), result(s, { "gemini-3.8-flash-medium": { contextWindow: 100 } })], 0);
  await startRun({ id: "r-learn-badwin", message: "fixture", cwd: root });
  await until(() => endOf("r-learn-badwin"));
  await sleep(1500);
  assert.equal(learned().contextWindow, 1000000, "100 没通过 okWindow，不能把 1000000 盖掉");
});

test("学不到：模型不在清单里 → 不写进 extraModels", async () => {
  const s = sid();
  script([init(s), result(s, { "never-seen-model-xyz": { contextWindow: 1000000 } })], 0);
  await startRun({ id: "r-learn-unknown", message: "fixture", cwd: root });
  await until(() => endOf("r-learn-unknown"));
  await sleep(1500);
  assert.equal(extraOf().find((e) => e.id === "never-seen-model-xyz"), undefined);
});
