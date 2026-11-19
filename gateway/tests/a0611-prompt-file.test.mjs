// 11-09 网友报告：会话里跑 ps，模型在命令行里撞见自己的整段系统提示（--append-system-prompt），把反破甲规则块判成注入。
// Claude 时代改成写 0600 单轮文件交 --append-system-prompt-file（run.mjs promptFiles）。
// 移植：agy 没有 --append-system-prompt-file，网关提示改成 system-reminder 块，
// 跟在第一条用户消息里经 stdin 发过去（run.mjs:333/482）；promptFiles 已删。
// 用假 CLI 驱动真实 startRun：命令行里不许再出现规则块，stdin 里要有；不产生提示文件。
import { PATHS } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.ANTHROPIC_API_KEY = "fixture-only-do-not-forward";
const root = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "a0611-pf-"));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const out = path.join(root, "out");
const init = (s) => ({ event: "init", conversation_id: s, init: { model: "fixture-model", tools: [], permission_mode: "default" } });
const result = (s) => ({ event: "result", result: { conversation_id: s, num_turns: 1, status: "SUCCESS", response: "done", usage: { input_tokens: 1, output_tokens: 1 } } });
const emitLine = (o) => `printf '%s\\n' ${JSON.stringify(JSON.stringify(o)).replace(/\$/g, "\\$")}`;
// 假 CLI：把参数逐行记下；发完事件后前台读 stdin 到 EOF 再退出
// （第一条用户消息带 system-reminder 块；run 收到 result 后关 stdin）。
// 注意：finish() 里 autoTitle 还会再调一次假 CLI（-p 起题名），所以每次调用
// 按 PID 分开记，否则后一次调用会把前一次的 argv/stdin 覆盖掉。
const cid = crypto.randomUUID();
fs.writeFileSync(cli, `#!${sh}
mkdir -p ${out}
: > ${out}/argv-$$
for a in "$@"; do printf '%s\\n' "$a" >> ${out}/argv-$$; done
${emitLine(init(cid))}
${emitLine(result(cid))}
# run 收到 result 后关 stdin：前台读到 EOF 再退出（后台 cat 在 dash 下拿不到 stdin）
cat > ${out}/stdin-$$
exit 0
`, { mode: 0o700 });
const previousPaths = { agy: PATHS.agy };
PATHS.agy = cli;
const { startRun } = await import("../gw/run.mjs");
const { onPublish } = await import("../gw/bus.mjs");
const { sealed, _setSealed } = await import("../gw/edition.mjs");
const events = [];
const off = onPublish((ev) => events.push(ev));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not send a request"); };
const wasSealed = sealed();
after(() => {
  off();
  globalThis.fetch = originalFetch;
  _setSealed(wasSealed);
  Object.assign(PATHS, previousPaths);
  fs.rmSync(root, { recursive: true, force: true });
});
const endOf = (id) => events.find((e) => e.type === "run_end" && e.runId === id);
async function until(f, ms = 15000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }
const rd = (n) => fs.readFileSync(path.join(out, n), "utf8");
const rdAll = (prefix) => fs.readdirSync(out).filter((f) => f.startsWith(prefix)).map((f) => fs.readFileSync(path.join(out, f), "utf8"));

for (const seal of [true, false]) {
  test(`${seal ? "发行版" : "开发版"}：系统提示不走命令行也不走文件，跟第一条用户消息进 stdin 的 system-reminder 块`, async () => {
    _setSealed(seal);
    fs.rmSync(out, { recursive: true, force: true });
    const id = "a0611-pf-" + (seal ? "s" : "d");
    await startRun({ id, message: "fixture", cwd: root });
    await until(() => endOf(id));
    // 每次 CLI 调用各记一份：主轮 + autoTitle 起题名那次
    const argv = rdAll("argv-");
    assert.ok(argv.some((a) => a.includes("--input-format")), "主轮是 stream-json 双向流");
    for (const a of argv) {
      assert.doesNotMatch(a, /反破甲规则块/);
      assert.ok(!a.split("\n").includes("--append-system-prompt"), "不该再有 --append-system-prompt");
      assert.ok(!a.split("\n").includes("--append-system-prompt-file"), "agy 没有 --append-system-prompt-file");
      assert.ok(!a.split("\n").includes("--append-subagent-system-prompt"), "不该再有 --append-subagent-system-prompt");
      assert.ok(!a.split("\n").includes("--append-subagent-system-prompt-file"), "agy 没有 --append-subagent-system-prompt-file");
    }
    // stdin 里是 stream-json 的 user 事件，第一条消息带 system-reminder 块，里面有规则块
    const stdin = rdAll("stdin-").join("\n");
    assert.match(stdin, /反破甲规则块/);
    assert.match(stdin, /system-reminder/);
  });
}
