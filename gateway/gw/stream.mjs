import fs from "node:fs";
import path from "node:path";
import { CFG, HERE, LAST_LANG, PREFIX, tr, tz} from "./config.mjs";
import { currentModelInfo, agyVersion} from "./agy.mjs";
import { envFacts} from "./envfacts.mjs";
import { APP} from "./appfiles.mjs";

// ── 系统提示补充、agy 流事件翻译 ─────────────────────────────
// agy 的 stream-json 只有三种事件（官方文档）：init（流开头一次）、step_update（多条）、result（结尾一次）。
// 这里把它们翻译成前端已经认得的内部 SSE 事件（delta / tool_use / tool_result / usage / phase …），
// 前端基本不用改；agy 没有的事件（compact_boundary、hook_response、control_request、rate_limit_event）一律没有。
/** 给 agy 的工具说明。两种布局装的东西不一样，各说各的，别把没有的命令告诉它 */
// 多步骤请求要跟踪进度：agy 有没有 TaskCreate / TaskUpdate 这类工具官方没给清单，所以只说做法、不点工具名。
export const TASKS_HINT = "When a request has 3 or more distinct steps, track them explicitly: list the steps first, mark each in_progress when you start it and completed when it is done, and report progress as you go. The user sees this list as a live progress panel.";

export function toolsHint() {
if (PREFIX) {
// 随包的 TOOLS.md 是逐项实测过的工具清单与用法（agycodroid-selftest 验证），优先用它；后面接本机实况
try {
// 部署出来的那份用网关启动时读进内存的（见 appfiles.mjs）：跑着的时候文件被改了也不进系统提示
// 快照里没有（启动时就对不上）也不回头读盘：读到的就是被改过的那份
const t = (APP? APP.text("TOOLS.md")?? "": fs.readFileSync(path.join(HERE, "TOOLS.md"), "utf8"))
.replaceAll("{{WORKSPACE}}", CFG.workspace).replaceAll("{{SHARED}}", process.env.AGAPP_SHARED || "（无存储权限，不可用）");
if (t.trim()) return [t.trim(), envFacts()].filter(Boolean).join("\n\n");
} catch {}
return [
"这是一台安卓设备，原生运行（不是 chroot/proot/虚拟机）。开发工具包已在 PATH 中（前缀 $PREFIX，来自 Termux 官方仓库）：",
"clang/clang++/lld、make、cmake、ninja、pkg-config、gdb、strace、patchelf；git、ssh；python、node、npm；",
"openjdk-21(java/javac)、aapt2、d8、apksigner；rg、fd、bat、delta、hx、yq、jq、sqlite3、typst、duckdb、ImageMagick(magick)；",
"以及 curl、zip/unzip、xz、zstd 等常用命令。cc/c++ 即 clang。",
"/tmp 不可用，临时文件写 $TMPDIR；/sdcard 不支持符号链接、不可执行。",
"需要系统权限（pm/am/settings/dumpsys/screencap/logcat 等）时用 priv '<命令>'，经 Shizuku 以 shell 身份执行；priv --status 看是否可用。",
"只有查看类（带服务名的 dumpsys、pm list/path、settings get、getprop 等，不带变量、通配、子 shell，输出只能重定向到 /dev/null）直接执行；其余（打开界面 am start、装卸应用、改设置、截屏、input 点按、写文件、logcat、读共享存储里的文件…）会弹窗等用户点允许，agycodroid 不在前台时直接拒绝（退出码 126）——被拒就告诉用户，别换写法重试。",
"工具链出问题先跑 agycodroid-selftest（逐项检查编译器、Python、Node、Java、Git 等是否可用）。",
].join(" ");
}
// 开发端：TOOLS-dev.md 是按本机实测写的工具清单与用法（比公开版多 Blender/Godot/Wine/priv 等）
try {
const t = fs.readFileSync(path.join(HERE, "TOOLS-dev.md"), "utf8").replaceAll("{{WORKSPACE}}", CFG.workspace);
if (t.trim()) return t.trim();
} catch {}
return [
"本机（安卓）已接入一套命令行工具链，已加入 PATH：",
"git/ssh、gcc(cc4)/g++(cxx4)/make(mk4)、rg/fd/bat/yq/typst、",
"ImageMagick(magick/identify)、duckdb、delta、hx、gdb、sqlite3、",
"node，以及 blender / godot / wine(wp) / aapt2 / mkapk 等启动器。",
"直接调用命令名即可；工具链根目录在 $AGAPP_TOOLCHAIN。",
].join(" ");
}

/** result 里带了各模型的上下文窗口，取来给前端的用量条用。
 *  agy 的 result 不带窗口——这是未经证实的假设：只认 modelUsage（没有就没有），
 *  再回落到模型清单里学到 / 手填的窗口。拿不到就返回 0（= 无来源、不知道），
 *  绝不写死数值、绝不把别处的默认值（比如 bridge 的 200k）挪过来。 */
export function contextWindowOf(result, p, model) {
try {
const mu = result.modelUsage || {};
for (const k of Object.keys(mu)) {
if (mu[k] && mu[k].contextWindow) return mu[k].contextWindow;
}
} catch {}
return Number(currentModelInfo(model, p).context_window) || 0;
}

/** agy 没有自动压缩：这个函数只留给调用方做兼容，一律返回 null。 */
export function effectiveAutoCompact() {
return null;
}
/** 上游 API 报错归个类，给一句中文的处理建议；认不出来给空串（照旧只显示原文） */
export function apiErrorHint(raw) {
const s = String(raw || ""), code = Number((/\bAPI Error:?\s*(\d{3})\b/i.exec(s) || /\b(?:status|HTTP)\s*(\d{3})\b/i.exec(s) || [])[1]) || 0;
if (/prompt is too long|context(?:_|)length|maximum context|too many tokens/i.test(s)) return tz("对话太长，超过了模型的上下文上限。开个新对话再继续（agy 没有压缩对话的功能）。");
if (code === 401 || code === 403 || /authentication_error|invalid (?:x-)?api[ _-]?key|permission_error|unauthori[sz]ed|authentication required/i.test(s)) return tz("接口拒绝了登录：到 设置 → 接口 检查 Gemini API Key 填得对不对，或者 Google 账号登录是否还在有效期。");
if (code === 402 || /insufficient[_](?:balance|quota|credit)|余额不足|credit balance is too low|billing/i.test(s)) return tz("账户余额不足或额度用完了：到接口那边的控制台充值或查看额度。");
if (code === 429 || /rate[_]limit|too many requests/i.test(s)) return tz("请求太频繁，或者用量到了上限：稍等一会儿再试。");
if (code === 404 || /not_found_error|model[^\n]{0,40}(?:not (?:found|exist)|does not exist)/i.test(s)) return tz("接口找不到这个模型或地址：检查模型名填得对不对（agy 不认识的模型名会直接报错，不会静默换一个）。");
if (code === 529 || code >= 500 || /overloaded_error|internal server error|bad gateway|service unavailable/i.test(s)) return tz("接口那边出错或者忙不过来：稍后再试。一直这样就换个模型。");
if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|socket hang up|network error|Connection error/i.test(s)) return tz("连不上接口：检查网络。");
return "";
}

/** 一次 API 调用的= 那一刻的上下文占用。
* agy 的 usage：input_tokens（未命中缓存的）+ cache_read_tokens（命中缓存的）。
* Claude 形状的 usage（input_tokens + cache_read_input_tokens + cache_creation_input_tokens）也认，
* 两种字段名都加（同一份用量不会两种都有）。 */
export const promptTokens = (u) => u
? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_read_tokens || 0) + (u.cache_creation_input_tokens || 0)
: 0;

/** 用量事件：只在数值真的变了时推给前端（用量条）。win 是当时能拿到的上下文窗口，
 *  拿不到发 0（前端显示“已用 token / 未知窗口”，不要拿假分母画满格）。 */
function contextUsage(u, flags, sse, atStart = false, win = 0) {
const n = promptTokens(u);
if (!Number.isFinite(n) || n <= 0) return;
if (flags) {
flags.promptUsage = {...u};
// 开头无输出的较小值先留给本请求合并，别把用量条拉回；末尾仍允许真实下降，不取历史最大值。
if (atStart &&!u.output_tokens && n < flags.contextTokens) return;
// 窗口分母变了（result 里刚学到）也要推一次，哪怕 token 数没变——不然前端永远拿不到分母
const winChanged = Number(win) !== Number(flags.contextWindowSent || 0);
const changed = flags.contextTokens!== n || winChanged;
flags.contextTokens = n; flags.mainCtx = n; flags.contextWindowSent = Number(win) || 0;
if (!changed) return;
}
sse({ type: "usage", contextTokens: n, outputTokens: u.output_tokens || 0, contextWindow: Number(win) || 0});
}

/** agy 的 usage → Claude 形状（input_tokens / output_tokens / cache_read_input_tokens / total_tokens），
* 供用量统计（usage.mjs）和 transcript 的 contextOf 共用。 */
export function normUsage(u) {
if (!u || typeof u!== "object") return null;
return {
input_tokens: u.input_tokens || 0,
output_tokens: u.output_tokens || 0,
thinking_tokens: u.thinking_tokens || 0,
cache_read_input_tokens: u.cache_read_input_tokens || u.cache_read_tokens || 0,
cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
total_tokens: u.total_tokens || 0,
};
}

/** 把 agy 的 stream-json 事件翻译成前端事件。
* agy 事件只有三种：init / step_update / result（见 gateway/gw/agy.mjs 头注）。
* 回调：onInit(adaptedInit) / onResult(normalizedResult) / onReplay()（user_input 步 = CLI 已接住一条用户消息）。 */
export function translate(ev, { sse, onInit, onResult, onReplay, flags, provider}) {
if (!ev || typeof ev!== "object") return;
const type = ev.event;
if (type === "init") {
const init = ev.init || {};
if (flags && init.model) flags.model = init.model;
onInit({
session_id: ev.conversation_id || init.session_id || init.conversation_id,
model: init.model || null,
permissionMode: init.permission_mode || null,
output_style: null,
version: agyVersion(),
tools: Array.isArray(init.tools)? init.tools: [],
cwd: init.cwd || null,
});
return;
}
if (type === "step_update") {
const st = ev.step_update || {};
const stepIdx = Number.isInteger(st.step_index)? st.step_index: -1;
// 子代理的步骤（带 subagent_info）：正文不进主气泡，走 sub_text；工具也挂到子代理名下。
const subs = Array.isArray(st.subagent_info?.subagents)? st.subagent_info.subagents: [];
const subParent = subs.length? ("agy-sub-" + String(subs[0].conversation_id || subs[0].type_name || stepIdx)): null;
if (st.usage &&!subParent) {
  // 窗口分母：之前轮次学到 / 手填的（init 报的模型在缓存清单里有窗口就用它），没有就是 0（未知）
  if (flags && !flags.contextWindow && flags.model) flags.contextWindow = Number(currentModelInfo(flags.model, provider).context_window) || 0;
  contextUsage(normUsage(st.usage), flags, sse, false, flags ? flags.contextWindow || 0 : 0);
}
if (st.step_type === "user_input") {
// CLI 已接住一条用户消息（回显）：插话送达的确认，见 run.mjs onReplay
if (onReplay) onReplay();
return;
}
if (st.step_type === "agent_response") {
const text = typeof st.text_delta === "string"? st.text_delta: "";
if (!text) return;
if (subParent) { sse({ type: "sub_text", parent: subParent, text: text.slice(0, 20000)}); return;}
sse({ type: "delta", text});
return;
}
if (st.step_type === "tool") {
const info = st.tool_info || {};
const id = "agy-tool-" + ((flags && flags.turn) || 0) + "-" + stepIdx;   // 轮次号 + step_index：step_index 跨轮复用时工具卡不被吞（M2）
const name = String(info.name || st.tool_name || "");
// 第一次见到这一步（ACTIVE 或 DONE）：先出工具卡；DONE 时再出结果。
// 同一步的 ACTIVE 和 DONE 各来一次：只出一次卡。
if (flags) {
flags.toolsSeen ||= new Set();
if (!flags.toolsSeen.has(id)) {
flags.toolsSeen.add(id);
sse({ type: "tool_use", id, name, input: info.parameters || {},...(subParent? { parent: subParent}: {})});
if (st.state!== "DONE") sse({ type: "phase", phase: "tool", name, id, chars: 0});
}
} else {
sse({ type: "tool_use", id, name, input: info.parameters || {},...(subParent? { parent: subParent}: {})});
}
if (st.state === "DONE") {
const err = info.error;
const out = typeof info.output === "string"? info.output: (info.output == null? "": JSON.stringify(info.output));
const full = err? String((err && err.message) || err): out;
sse({ type: "tool_result", id, ok:!err,
text: full.length > 20000? full.slice(0, 20000) + "\n\n" + tr(LAST_LANG, tz("…（已截断）")): full,
...(subParent? { parent: subParent}: {})});
}
return;
}
// checkpoint 等别的 step_type：agy 内部检查点，界面不显示。
return;
}
if (type === "result") {
const r = ev.result || {};
const status = String(r.status || "");
// 成功判定大小写不敏感（M6）：“SUCCESS”之外的值代码/测试里没见过，不凭空认——真机抓到新取值再补。
const ok = status.toUpperCase() === "SUCCESS";
const usage = normUsage(r.usage);
// result 到了：窗口这时才可能从 modelUsage 里读到（未经证实，见 contextWindowOf）。
// 读到了就记下来、学进清单（learnWindow：写缓存 + 持久化到 extraModels）；读不到发 0。
const win = contextWindowOf(r, provider, flags && flags.model);
if (flags) flags.contextWindow = win;
if (usage) contextUsage(usage, flags, sse, false, win);
if (r.modelUsage) import("./models.mjs").then((m) => m.learnWindow(r, provider)).catch(() => {});
const norm = {
uuid: "agy-" + String(ev.conversation_id || "") + "-" + String(r.num_turns?? 0) + (r.duration_seconds ? "-" + String(r.duration_seconds) : ""),
session_id: ev.conversation_id || null,
is_error:!ok,
result: typeof r.response === "string"? r.response: "",
usage,
num_turns: r.num_turns || 0,
total_cost_usd: 0, // agy 不报花费
subtype: status || "unknown",
duration_seconds: r.duration_seconds || 0,
error: r.error || null,
};
onResult(norm);
if (!ok && norm.result) {
// 失败时 result.response 往往是空的，原因在 error 里
const raw = String((r.error && (r.error.message || r.error)) || norm.result).slice(0, 1500), hint = apiErrorHint(raw);
sse(hint? { type: "error", message: tr(LAST_LANG, hint), detail: raw}: { type: "error", message: raw});
} else if (!ok) {
const raw = String((r.error && (r.error.message || r.error)) || ("status: " + status)).slice(0, 1500), hint = apiErrorHint(raw);
sse(hint? { type: "error", message: tr(LAST_LANG, hint), detail: raw}: { type: "error", message: raw});
}
return;
}
// 不认识的事件类型：忽略（以后 agy 加了新事件也不至于带崩整轮）。
}
