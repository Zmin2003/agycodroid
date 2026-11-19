// stab2-h 运行级用例共用的装配：假 CLI（sh 脚本按 agy stream-json 吐事件）驱动真实 startRun。
// 三个 test 文件各用各的进程（node --test 逐文件跑），这里只管把它们共用的准备和工具放一份。
// agy 版：假 CLI 直接挂在 PATHS.agy 上（没有 loader/加载器那套）；init/result 一律 agy 形状
//（event + conversation_id + init/result）；自定义厂商文件已删——agy 只有 google/gemini，
// 起轮默认走 Google 登录，不用 Key。
import { PATHS } from "../../gw/config.mjs"; // scripts/test.mjs 先隔离 HOME / fake PREFIX
import "./uc-baseline.mjs";                   // 共用 home 里前面测试留下的 ~/.claude 改动先认下，免得真起一轮时卡在确认卡片
import { after } from "node:test";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

process.env.AGAPP_IDLE_CLOSE_MS = "200";   // 空闲收尾定时器别把测试进程拖住 2 分钟（只给测试用的开关）
const home = process.env.AGAPP_HOME; // 只在夹具内部用（usageTotals 读 agyapp-usage.json）；没有测试 import 它
export const root = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "stab2h-"));
const cli = path.join(root, "fake-cli.sh");
const sh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
const SLEEP = ["/system/bin/sleep", "/bin/sleep", "/usr/bin/sleep"].find((p) => fs.existsSync(p));
if (!SLEEP) throw new Error("找不到 sleep，假 CLI 的等待会失效");
/** 假 CLI：按顺序吐事件；{sleep: 秒} 停一会儿；最后 exit code */
export function script(steps, code = 0) {
  const body = steps.map((s) => s.sleep ? `${SLEEP} ${s.sleep}` : `printf '%s\\n' ${JSON.stringify(JSON.stringify(s)).replace(/\$/g, "\\$")}`).join("\n");
  fs.writeFileSync(cli, `#!${sh}\n${body}\nexit ${code}\n`, { mode: 0o700 });
}
const previousPaths = { agy: PATHS.agy };
PATHS.agy = cli;
const { startRun } = await import("../../gw/run.mjs");
const { onPublish } = await import("../../gw/bus.mjs");
const { flushUsage } = await import("../../gw/usage.mjs");
export { startRun, flushUsage };

export const events = [];
const off = onPublish((ev) => events.push(ev));
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("fixture must not send a request"); };
after(() => {
  off();
  globalThis.fetch = originalFetch;
  Object.assign(PATHS, previousPaths);
  fs.rmSync(root, { recursive: true, force: true });
});

export const endOf = (id) => events.find((e) => e.type === "run_end" && e.runId === id);
export async function until(f, ms = 8000) { const t = Date.now(); while (!f()) { if (Date.now() - t > ms) throw new Error("等不到"); await new Promise((r) => setTimeout(r, 30)); } }

export const sid = () => crypto.randomUUID();
export const init = (s) => ({ event: "init", conversation_id: s, init: { model: "fixture-model", tools: [], permission_mode: "default" } });
// agy 的 result：身份就是 conversation_id + num_turns（run.mjs 按 uuid "agy-<cid>-<turns>" 去重）。
export const result = (i, o, { cid = null, turns = 1, status = "SUCCESS", response = "done" } = {}) => ({
  event: "result", conversation_id: cid, result: { status, response, num_turns: turns, usage: { input_tokens: i, output_tokens: o }, duration_seconds: 0 },
});
export const resp = (idx, text, extra = {}) => ({ event: "step_update", step_update: { step_index: idx, step_type: "agent_response", text_delta: text, ...extra } });

/** 起一轮、等它结束，返回 run_end 事件 */
export async function runWith(id, steps, code = 0) {
  script(steps, code);
  await startRun({ id, message: "fixture", cwd: root });
  await until(() => endOf(id));
  return endOf(id);
}
/** 使用统计里当前累计（按小时桶求和）：先 flushUsage 立即落盘再读 */
export const usageTotals = () => {
  const j = JSON.parse(fs.readFileSync(path.join(home, "agyapp-usage.json"), "utf8"));
  const sum = { t: 0, i: 0, o: 0 };
  for (const b of [...Object.values(j.hours || {}), ...Object.values(j.quarters || {})]) { sum.t += b.t || 0; sum.i += b.i || 0; sum.o += b.o || 0; }
  return sum;
};
