import fs from "node:fs";
import { CFG, PATHS, PREFIX } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { API_KEY, PROVIDER, providerBrief } from "./providers.mjs";
import { agySettingsPath, runAntigravity, safeMode } from "./agy.mjs";
import { AUTH_CACHE } from "./login.mjs";
import { LAST_SESSION, RUNS } from "./runs.mjs";
import { NEXT, sendJson, uiTag } from "./http.mjs";
import { QUEUE } from "./queue.mjs";
import { cmdDescs } from "./commands.mjs";

// ── 能力清单 ──────────────────────────────────────────────────────────
let LAST_INIT = null;          // 最近一次 init 事件（含 tools / permissionMode / model）
export const setLastInit = (v) => { LAST_INIT = v; };

/** 各斜杠命令的分类与说明（用于 GUI 面板；未列出的按“发给 agy”处理）。
 *  Claude 专属的已经拿掉：context（agy 不报上下文占用）、compact（没有 /compact）、
 *  cost/usage（agy 不报花费、没有订阅用量）、config（agy 的配置走 settings.json 文件）、
 *  fast（没有快速模式）、memory/init（没有 CLAUDE.md）、review/security-review/code-review、
 *  insights（没有使用洞察）、agents（子代理是 agy 自己的，网关不管理）。 */
const COMMAND_META = {
  clear:     { cat: "上下文", desc: "清空当前会话，另起一段", local: true },
  status:    { cat: "状态",   desc: "当前环境与配置状态", local: true },
  doctor:    { cat: "状态",   desc: "检查安装健康状况", local: true },
  model:     { cat: "配置",   desc: "查看或切换模型", local: true },
  effort:    { cat: "配置",   desc: "调整思考强度", local: true },
  mcp:       { cat: "扩展",   desc: "管理 MCP 服务器", local: true },
  rename:    { cat: "会话",   desc: "重命名当前会话", local: true },
  resume:    { cat: "会话",   desc: "恢复历史会话", local: true },
  recap:     { cat: "会话",   desc: "回顾本次会话要点", local: true },
  goal:      { cat: "工作流", desc: "设定长期目标", local: false },
  loop:      { cat: "工作流", desc: "循环执行任务", local: false },
  batch:     { cat: "工作流", desc: "批量处理", local: false },
  verify:    { cat: "工作流", desc: "验证改动", local: false },
  debug:     { cat: "工作流", desc: "调试问题", local: false },
  simplify:  { cat: "工作流", desc: "简化代码", local: false },
  "deep-research": { cat: "工作流", desc: "深度研究", local: false },
  workflow:  { cat: "工作流", desc: "编排多代理工作流", local: false },
};

const FALLBACK_COMMANDS = Object.keys(COMMAND_META);
/** 自带命令的名字（常用指令不许和它们重名） */
export const builtinCommands = () => Object.keys(COMMAND_META);

/** 权限规则（能力页「工具」一节标允许 / 询问 / 拒绝用）：
 *  网关管理的 agy settings.json（~/.gemini/antigravity-cli/settings.json）里的 permissions
 *  + 本应用设置里的允许 / 禁用工具。deny 在所有模式下都生效（官方文档原话）。 */
function permRules() {
  const r = { allow: [], ask: [], deny: [] };
  try {
    const j = JSON.parse(fs.readFileSync(agySettingsPath(), "utf8")).permissions || {};
    for (const k of ["allow", "ask", "deny"]) if (Array.isArray(j[k])) r[k].push(...j[k].map(String));
  } catch {}
  if (Array.isArray(SETTINGS.allowedTools)) r.allow.push(...SETTINGS.allowedTools);
  if (Array.isArray(SETTINGS.disallowedTools)) r.deny.push(...SETTINGS.disallowedTools);
  return r;
}

function capabilities() {
  const init = LAST_INIT || {};
  const cmds = (init.slash_commands || FALLBACK_COMMANDS).filter((c) => !c.startsWith("__"));
  // 常用指令（commands/*.md）：说明从文件头读；刚建好、agy 还没重新报 init 的也先列上
  const mine = cmdDescs();
  for (const n of Object.keys(mine)) if (!cmds.includes(n)) cmds.push(n);
  return {
    ready: !!LAST_INIT,
    model: SETTINGS.model,
    permissionMode: SETTINGS.permissionMode,
    tools: init.tools || [],   // agy 的 init.tools 是字符串清单（run_command、write_to_file……）
    slashCommands: cmds.map((c) => ({
      name: c,
      ...(COMMAND_META[c] || (mine[c] ? { cat: "常用指令", desc: mine[c].desc, hint: mine[c].hint, custom: mine[c].scope, local: false } : { cat: "其他", desc: "", local: false })),
    })),
    // agy 没有向网关确认过的 skills / agents / plugins / MCP 清单：空着，不编
    skills: [],
    agents: [],
    plugins: [],
    mcpServers: [],
    outputStyle: init.output_style || "default",
    version: init.version || "",
    rules: permRules(),
    settings: SETTINGS,
  };
}

// ── 路由：/api/status /api/capabilities /api/cli ──
export async function routeCaps(req, res, u, p) {
  if (req.method === "GET" && p === "/api/status") {
    return sendJson(res, 200, {
      app: "agy-cli",
      product: PREFIX ? "agycodroid" : "Antigravity CLI",   // 界面标题
      pid: process.pid,
      ready: fs.existsSync(PATHS.agy),
      // 登录态接口也算"就绪"：它不用密钥，用的是 agy 自己的 Google 登录
      hasKey: !!API_KEY || !!PROVIDER.login,
      keyMode: API_KEY ? "key" : (PROVIDER.login ? "login" : "none"),
      // 真实的 OAuth 状态（问过才有；unknown 表示问不出，不等于未登录）。界面别只看程序在不在（0.6.9 审计 195-G.3）
      auth: AUTH_CACHE && AUTH_CACHE.v ? {
        loggedIn: !!AUTH_CACHE.v.loggedIn, unknown: !!AUTH_CACHE.v.unknown, stale: !!AUTH_CACHE.v.stale, at: AUTH_CACHE.at,
      } : null,
      // 别家填了 Key 也算接上了：会话可以单独选那家（0.3.16 起），首屏不该再叫人去接模型
      otherKey: providerBrief().some((p) => !p.active && p.keyMode === "key" && !(SETTINGS.hiddenProviders || []).includes(p.id)),
      model: SETTINGS.model || PROVIDER.defaultModel || null,
      provider: PROVIDER.id,
      providerLabel: PROVIDER.label || PROVIDER.id,
      providerLabelEn: PROVIDER.labelEn || "",   // 界面不是中文时用（和设置里选接口那张单子同一规则）
      nativeModels: false,   // agy 没有“原生认识某家模型”这个概念
      workspace: CFG.workspace,
      runtime: CFG.runtime,
      bridge: false,   // 没有本地桥：agy 直连 Google / Gemini
      uptimeMs: Math.round(process.uptime() * 1000),
      version: "3.0.0",
      busy: RUNS.size > 0,
      running: RUNS.size,
      // 挂起的（点了停止、被系统中断的）不会自己发出去，不算「有活要干」：外壳据 queued 判断能不能换工具包
      queued: QUEUE.filter((q) => !q.held).length,
      held: QUEUE.filter((q) => q.held).length,
      safeMode: safeMode(),
      hasLedger: !!process.env.AGAPP_LEDGER,
      uiTag: uiTag(),
      lastSessionId: LAST_SESSION ? LAST_SESSION.id : null,
      lastSessionAt: LAST_SESSION ? LAST_SESSION.at : null,
    });
  }
  // ── 能力清单 ──
  if (req.method === "GET" && p === "/api/capabilities") {
    return sendJson(res, 200, capabilities());
  }
  // ── 运行 CLI 子命令取状态（mcp list / doctor …）──
  // 只放行这几个；子命令本身是不是 agy 真有的，由 CLI 自己报错（未确认的不要编进允许表里充数）。
  if (req.method === "GET" && p === "/api/cli") {
    const sub = (u.searchParams.get("cmd") || "").trim();
    const ALLOW = new Set(["mcp list", "doctor", "auth status", "--version"]);
    if (!ALLOW.has(sub)) return sendJson(res, 400, { error: "command not allowed", cmd: sub });
    const r = await runAntigravity(sub.split(/\s+/), { timeoutMs: 45000 });
    return sendJson(res, 200, {
      cmd: sub,
      out: (r.out || "").slice(0, 30000),
      err: (r.err || "").slice(0, 4000),
      code: r.code ?? null,
      signal: r.signal || null,
      timeout: !!r.timeout,
    });
  }
  return NEXT;
}
