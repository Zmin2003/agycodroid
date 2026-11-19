// 设置的存取单独成模块，只依赖 config.mjs：各模块都从这里拿 SETTINGS，
// 不再经 settings.mjs ↔ providers.mjs 的环（审查 10-30 v0.5.12 低5：单独导入 providers 会撞暂时性死区，重排 server.mjs 的 import 就可能启动即崩）
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PATHS, PERM_MODES, log } from "./config.mjs";
import { readSmallFile } from "./saferead.mjs";
import { isObj, loadState, writeAtomic } from "./statefile.mjs";

// ── 设置（模型 / 权限模式 / 目录 …）──────────────────────────────────
export const SETTINGS = {
  // 不预填：留空 = 用接口自己的默认模型
  model: null,
  // agy 的 toolPermission：默认 request-review。headless 下没有逐条审批：没预先放行的工具会被软拒绝
  // （不是“逐项确认”），见 README；界面给一条可关的提示（H3）
  permissionMode: "request-review",
  // agy 的 agentMode：""（默认）/ accept-edits / auto / plan
  agentMode: "",
  addDirs: [],
  outputStyle: null,
  effort: null,
  allowedTools: null,
  disallowedTools: null,
  // 生效接口（agyapp-providers.json 里的 id）。留空 = 用配置文件里的 active。
  provider: null,
  // 内存管家（cc-mem）：默认关。开了才允许停别的应用；白名单是用户额外保护的包名
  memGuard: { enabled: false, whitelist: [] },
  // 存储的自动清理（D10，见 storage.mjs）：默认开、每周；只清缓存、7 天前的临时文件、30 天前的临时文件，会话永不自动删
  autoClean: { enabled: true, every: "week" },
  // 最多同时跑几个会话（1 = 和以前一样一次只跑一轮）
  maxParallel: 3,
  // 工作岛：把 Antigravity 的工作状态送到 ColorOS 16 灵动岛（可选，默认关；见 gw/work-island.mjs）
  workIsland: false,
  // 自动起名用的型号（#60）：null = 跟对话同一型号；"off" = 不自动起；其他 = 全局那家清单里的某个型号（见 autotitle.mjs）
  titleModel: null,
  // 不在输入栏模型选单里显示的接口（只是不显示，配置照留；正在用的、全局默认的那家照样显示）
  hiddenProviders: [],
};

/** 字符串数组：只留字符串，条数、每条长度、总长（字）都有上限 */
export function capList(a, n, len, total = Infinity) {
  const out = [];
  let sum = 0;
  for (const x of Array.isArray(a) ? a : []) {
    if (typeof x !== "string" || x.length > len) continue;
    if (out.length >= n || sum + x.length > total) break;
    out.push(x); sum += x.length;
  }
  return out;
}
// 盘上那份最后是什么样（网关自己读进来 / 写出去时记下）：跑着的时候被别人改了，起下一轮前写回内存里的（见 settingsDiskCheck）
let DISK_H = null;
const hashOf = (s) => crypto.createHash("sha256").update(s).digest("hex");
function loadSettings() {
  // 读坏了（语法错、不是对象、太大）原文件留底成 .bad-*：以前静默回落默认，下一次保存就把模型、附加目录、权限模式这些全盖掉（0.6.9 审计 195-Z.1 / Y.7）
  const st = loadState(PATHS.settings, { shape: (j) => (isObj(j) ? j : undefined), max: 4 << 20 });
  const had = !st.missing && !st.bad;
  if (had) {
    Object.assign(SETTINGS, st.data);
    try { DISK_H = hashOf(readSmallFile(PATHS.settings, 4 << 20)); } catch {}
  }
  // 旧版没限过：已经存进去的超长列表在这里截住，别让它每一轮把 claude 的命令行撑爆（审查 v0513b 低-3）
  // 条数、每条长度之外还要管总长：64×4096 加上工具名单能超过 ARG_MAX（128 KB），每轮 spawn 都 E2BIG（10-31 复核）
  const cap = (a, n, len, total) => (Array.isArray(a) ? capList(a, n, len, total) : []);   // 不是数组（手改设置写错形状）按空处理，别让字符串被逐字拆成规则
  SETTINGS.addDirs = cap(SETTINGS.addDirs, 64, 4096, 16384) || [];
  SETTINGS.hiddenProviders = Array.isArray(SETTINGS.hiddenProviders) ? capList(SETTINGS.hiddenProviders, 64, 64) : [];
  if (SETTINGS.allowedTools) SETTINGS.allowedTools = cap(SETTINGS.allowedTools, 200, 512, 8192);
  if (SETTINGS.disallowedTools) SETTINGS.disallowedTools = cap(SETTINGS.disallowedTools, 200, 512, 8192);
  // model 也原样进命令行：旧版存进去的超长值在这里丢掉（v0514 审查低-3）
  for (const k of ["model", "outputStyle", "effort", "titleModel"]) if (SETTINGS[k] != null && (typeof SETTINGS[k] !== "string" || SETTINGS[k].length > 200)) SETTINGS[k] = null;
  // 权限模式一次性迁移：Claude Code 那套模式（default / acceptEdits / plan / bypassPermissions / manual）
  // 在 agy 里不存在。旧设置里存着它们的，一律改回 request-review（最安全的逐项确认），
  // 之后再选别的就尊重用户。bypassPermissions 当年可能是默认值，分不清是不是用户选的——同样改回。
  if (!SETTINGS.permMigrated) {
    if (had && (!SETTINGS.permissionMode || ["default", "acceptEdits", "plan", "auto", "dontAsk", "bypassPermissions", "manual"].includes(SETTINGS.permissionMode))) {
      if (SETTINGS.permissionMode === "bypassPermissions") SETTINGS.permNotice = true;
      SETTINGS.permissionMode = "request-review";
    }
    SETTINGS.permMigrated = 1;
    if (had) setImmediate(saveSettings);
  }
  if (!PERM_MODES.includes(SETTINGS.permissionMode)) SETTINGS.permissionMode = "request-review";
  // agy 没有 agentMode 之外的模式：旧设置里存的怪值清掉
  if (SETTINGS.agentMode != null && !["", "accept-edits", "auto", "plan"].includes(SETTINGS.agentMode)) SETTINGS.agentMode = "";
  // 旧版面板存的是小写 explanatory / 不存在的 concise —— 只认 Explanatory、Learning 两种内置风格
  if (SETTINGS.outputStyle === "explanatory") SETTINGS.outputStyle = "Explanatory";
  if (SETTINGS.outputStyle === "concise") SETTINGS.outputStyle = null;
  // 以前有个界面上没有入口、只能经接口写的 appendSystemPrompt，每轮接在系统提示后面：
  // agy 没有 --append-system-prompt-file，旧值清掉
  if ("appendSystemPrompt" in SETTINGS) { delete SETTINGS.appendSystemPrompt; setImmediate(saveSettings); }
  // 旧设置里留下的 Claude 专属字段：guard（PreToolUse 钩子）、autoCompactWindow（/compact）、
  // staticCompat（seccomp 包装）、idleCompaction（空闲压缩）、localMode（端侧小模型）——agy 里都没有，清掉
  for (const k of ["guard", "autoCompactWindow", "staticCompat", "idleCompaction", "localMode"]) if (k in SETTINGS) { delete SETTINGS[k]; setImmediate(saveSettings); }
}

/** 写盘成功返回 true；失败记日志并返回 false（调用方要如实告诉用户，别报「已保存」——#122-3） */
export function saveSettings() {
  try {
    fs.mkdirSync(path.dirname(PATHS.settings), { recursive: true });
    // 先写临时文件再换名：写到一半被杀，下次读到半个 JSON 会回落默认，下一次保存就把密钥覆盖没了（审查 中1）
    const out = JSON.stringify(SETTINGS, null, 2);
    if (!writeAtomic(PATHS.settings, out)) return false;    // fsync 后再换名，失败已记日志
    DISK_H = hashOf(out);
    return true;
  } catch (e) {
    log(`保存设置失败: ${e.message}`);
    return false;
  }
}
loadSettings();

/** 网关跑着时设置以内存为准、只有网关写盘：盘上那份和最后读写的对不上，就是别人改的 —— 写回去，返回 true（调用方记留痕） */
export function settingsDiskCheck() {
  if (DISK_H == null) return false;
  const raw = readSmallFile(PATHS.settings, 4 << 20);
  if (raw != null && hashOf(raw) === DISK_H) return false;
  return saveSettings();
}

/** agy 认的输出风格：只有 Explanatory、Learning 两种内置。
 *  自定义风格（~/.claude/output-styles）没有了：agy 没有这个机制，旧目录里的 .md 不再列出。 */
export function outputStyles() {
  return [
    { id: "Explanatory", desc: "边做边解释实现取舍" },
    { id: "Learning", desc: "留 TODO 让你亲手写一部分" },
  ];
}
