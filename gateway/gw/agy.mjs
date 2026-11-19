import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CFG, PATHS, PREFIX, log, tz } from "./config.mjs";
import { SETTINGS } from "./settings-store.mjs";
import { PROVIDER, keyOf } from "./providers.mjs";
import { cachedModels } from "./models.mjs";
import { sealEnv } from "./edition.mjs";
import { agySeal } from "./agyseal.mjs";
import { gwRuntimeBlocked } from "./gwpin.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";

// ── 给 agy 造一个它认得的 shell ────────────────────────────────────
// 安卓既没有 /bin/sh 也没有 bash：agy 跑命令要调 shell，
// 它认 SHELL 环境变量 —— 于是造个名叫 bash 的包装转发给 mksh。
let SHELL_PATH = null;
let SHELL_REAL = null;      // 包装当前指到的真 shell（terminal M1：缓存的包装可能过期）
let SHELL_FALLBACK = false; // 配好的真 bash 文件不在，已回落到系统 sh
// 非安卓环境（CI 的 Linux）没有 /system/bin/sh：包装脚本的 shebang 和最终 exec 都要回落到 /bin/sh
const SYS_SH = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
export function ensureShell() {
  // 开发端（旧布局）没有 AGAPP_SHELL：有 files/cbash/bash（glibc 版真 bash）就用它。
  const cbash = path.join(CFG.runtime, "..", "cbash", "bash");
  const want = process.env.AGAPP_SHELL || (!PREFIX && fs.existsSync(cbash) ? cbash : "");
  const real = want && fs.existsSync(want) ? want : SYS_SH;
  // terminal M1：以前 SHELL_PATH 一旦算出来就再也不校验——工具包卸了/换了，包装还指着不存在的 bash，
  // 终端起不来还静默。每次都校验一次包装和它指到的真 shell，变了就重造
  if (SHELL_PATH && SHELL_REAL === real && fs.existsSync(SHELL_PATH)) return SHELL_PATH;
  if (want && !fs.existsSync(want)) log(`[shell] 配好的 shell 不在（${want}），已回落到系统 sh`);
  SHELL_FALLBACK = !!want && !fs.existsSync(want);

  const dir = PREFIX ? path.join(CFG.home, ".cache", "agyapp-shell") : path.join(CFG.runtime, "bin");
  const sh = path.join(dir, "bash");
  try {
    fs.mkdirSync(dir, { recursive: true });
    // 前缀布局再加一层：termux-exec。安卓没有 /usr/bin/env、/bin/bash，
    // 凡是 #!/usr/bin/env node|python3、#!/bin/bash 的脚本（npm 装的命令行、./configure、用户自己写的）
    // 直接执行都是 bad interpreter。termux-exec 在 execve 时把这些解释器改指到 $PREFIX/bin。
    // 必须在 bash 启动前就设上 —— 已经在跑的 bash 后来再 export 也救不了它自己的 exec（实测）。
    const tx = process.env.AGAPP_BIONIC_PRELOAD || (PREFIX ? path.join(PREFIX, "lib", "libtermux-exec-ld-preload.so") : "");
    const pre = tx && fs.existsSync(tx) ? 'export LD_PRELOAD="' + tx + '"\n' : "";
    const body = '#!' + SYS_SH + '\n' + pre + 'exec "' + real + '" "$@"\n';
    let need = true;
    try { need = fs.readFileSync(sh, "utf8") !== body; } catch {}
    if (need) fs.writeFileSync(sh, body, { mode: 0o755 });
    fs.chmodSync(sh, 0o755);
    SHELL_PATH = sh;
    SHELL_REAL = real;
  } catch (e) {
    log(`造 shell 包装失败: ${e.message}`);
    SHELL_PATH = SYS_SH;
    SHELL_REAL = SYS_SH;
    SHELL_FALLBACK = !!want;   // 包装造不出来也一样回落到了系统 sh
  }
  return SHELL_PATH;
}
/** 上次 ensureShell 是不是回落到了系统 sh（配好的 bash 不在，或包装造不出来）。
 *  终端拿它决定首屏要不要提示、标题写 bash 还是 sh（terminal M1） */
export function shellIsFallback() { return SHELL_FALLBACK; }

// ── agy 进程 ────────────────────────────────────────────────────────
/** 某个模型（缺省 = 全局设置里的）在某家（缺省 = 当前生效的）那边的真实参数。
 *  agy 的模型窗口官方没给表，这里一律返回 {}（不知道窗口就别编一个）：
 *  调用方按“不知道”处理（用量条只显示已用 token，不按窗口画满格）。 */
export function currentModelInfo(id = SETTINGS.model, p = PROVIDER) {
  const list = cachedModels(p);
  if (!Array.isArray(list) || !list.length) return {};
  const want = id || p.defaultModel;
  if (!want) return list[0] || {};
  return list.find((m) => m.id === want) || {};
}

/** agy 的 settings.json（CLI 自己的位置）。网关每次起 agy 之前都按界面上的设置重写这份文件
 *  （保留用户自己写的别的键，但 modelProvider / toolPermission / agentMode / permissions / model
 *  这几个管理键以网关为准，见 edition.mjs）。密钥不在这里：GEMINI_API_KEY 只进起进程时的环境变量。 */
export const agySettingsPath = () => path.join(CFG.home, ".gemini", "antigravity-cli", "settings.json");
/** 写 agy 的 settings.json：先读现有的（用户自己写的别的键留着），再盖上网关管理的几个键。
 *  safe 模式：toolPermission 强制 request-review，agentMode 强制 ""，permissions 强制空（不预先放行），model 不写。 */
export function writeAgySettings(p = PROVIDER, { safe = false, extraAllow = [], extraDeny = [] } = {}) {
  const file = agySettingsPath();
  let cur = {};
  try { cur = JSON.parse(fs.readFileSync(file, "utf8")) || {}; } catch {}
  if (!cur || typeof cur !== "object" || Array.isArray(cur)) cur = {};
  const next = { ...cur };
  // modelProvider：Gemini API Key 方式才写 "gemini"，OAuth 方式写 ""（默认，CLI 走 keyring / 浏览器）。
  next.modelProvider = p.id === "gemini" ? "gemini" : "";
  next.toolPermission = safe ? "request-review" : (SETTINGS.permissionMode || "request-review");
  next.agentMode = safe ? "" : (SETTINGS.agentMode || "");
  // 预先放行的规则：界面设置里的允许 / 禁用工具 + 附加目录（写成 write_file(<目录>)）+ 这一轮单独带的。
  // agy 的规则是 action(target) 字符串；官方文档只确认了“deny 规则在所有模式下生效”。
  const allow = new Set(), deny = new Set();
  for (const t of SETTINGS.allowedTools || []) allow.add(String(t));
  for (const t of SETTINGS.disallowedTools || []) deny.add(String(t));
  for (const d of SETTINGS.addDirs || []) if (typeof d === "string" && d) allow.add(`write_file(${d})`);
  for (const t of extraAllow || []) allow.add(String(t));
  for (const t of extraDeny || []) deny.add(String(t));
  next.permissions = safe ? { allow: [], ask: [], deny: [] }
    : { allow: [...allow], ask: [], deny: [...deny] };
  if (!safe && SETTINGS.model) next.model = SETTINGS.model;
  else if (safe) delete next.model;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    log(`写 agy settings.json 失败: ${e.message}`);
    return false;
  }
}

/** o.model：这一轮用的模型（会话自己的、定时任务 / 项目指定的）；不给就按全局设置。
 *  o.provider：这一轮用的那家（会话钉在别家时）；不给就是全局生效的。 */
export function agyEnv(o = {}) {
  const p = o.provider || PROVIDER;
  const key = keyOf(p);
  const env = {
    ...process.env,
    HOME: CFG.home,
    // 显式钉死临时目录。安卓上 /tmp 写不进（shell 属主 + SELinux），而工具链是从
    // Termux 搬来的，很多二进制里编译期写死了 /data/data/com.termux/files/usr/tmp
    // —— 那个目录在这台设备上根本不存在，回落过去就是一句 ENOENT。
    TMPDIR: PREFIX ? (fs.mkdirSync(path.join(PREFIX, "tmp"), { recursive: true }), path.join(PREFIX, "tmp")) : CFG.home,
    // 同理：把 ncurses 的 terminal database 指到我们自己的 prefix。
    TERMINFO_DIRS: PREFIX ? path.join(PREFIX, "share", "terminfo") : path.join(PATHS.toolchain, "dshtc", "prefix", "share", "terminfo"),
    // 工具链在前：这样 agy 调 git/gcc/rg/magick… 命中的是我们搬过来的包装脚本。
    PATH: PREFIX ? [process.env.AGAPP_BIN && path.join(process.env.AGAPP_BIN, "..", "pre"), path.join(PREFIX, "bin"), path.join(CFG.home, ".agycodroid", "bin"), process.env.AGAPP_BIN, "/system/bin", "/system/xbin"].filter(Boolean).join(":") : [
      path.join(PATHS.toolchain, "payload", "bin"),
      path.join(CFG.runtime, "..", "devbin"),
      path.join(CFG.runtime, "node"),
      "/system/bin", "/system/xbin",
    ].join(":"),
    AGAPP_TOOLCHAIN: PATHS.toolchain,
    AGAPP_PROVIDER: p.id,
    // 标记：这棵进程树是网关拉起的 agy 运行（子孙都继承）。网关重启时据此认出上一任留下的孤儿，见 reapOrphans
    AGAPP_RUN: "1",
    SHELL: ensureShell(),
    CI: "1",
    TERM: "dumb",
    NO_COLOR: "1",
  };
  // agy 是 bionic 程序：LD_PRELOAD 里挂着的 termux-exec（bionic 库）它能用，留着
  // （agy 拉起的子进程靠它把 #!/usr/bin/env 这类解释器改指到 $PREFIX/bin）。
  // 但 AGAPP_SELF_EXE（exec-shim 的记号，glibc 那边的）对它没意义，清掉。
  delete env.AGAPP_SELF_EXE;

  // 认证：Gemini API Key 方式时，key 只进这一轮子进程的环境变量（官方文档：CLI 只从
  // GEMINI_API_KEY 环境变量读 key，settings.json 里配 modelProvider:"gemini" 只是开关）。
  // 这是本仓库“密钥不进环境变量”规则的例外——agy 不认 apiKeyHelper 那套，不这样它就拿不到 key。
  // 只在确实是 API Key 方式时才注入；不是就把继承来的清干净，别让网关自己身上的 key 漏进某一轮。
  // OAuth 方式（Google 账号）不注入：CLI 自己读 keyring 里的登录态。
  if (p.id === "gemini" && key) env.GEMINI_API_KEY = key;
  else delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;   // agy 不认 GOOGLE_API_KEY，别让它干扰
  // 旧的 Claude 变量一个都不能留：网关自己要是被一个带着这些变量的进程拉起来，
  // 它们会一路传进 agy 及其子进程（没用，还可能在日志里泄漏）。
  for (const k of Object.keys(env)) if (k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_CODE_") || k === "CLAUDE_CONFIG_DIR") delete env[k];
  delete env.AGAPP_TOKEN_FILE;   // 网关令牌文件的位置不交给 agy
  // 厂商配置里的额外变量（代理、超时这类）：只收字符串，且不许借道改密钥、端点，
  // 也不许碰「执行什么、加载什么」的变量。
  for (const [k, v] of Object.entries(p.extraEnv || {})) {
    if (/^[A-Z_][A-Z0-9_]*$/.test(k) && !EXTRA_ENV_DENY.test(k)) env[k] = String(v);
  }
  sealEnv(env);
  return env;
}

const EXTRA_ENV_DENY = /^(GEMINI_API_KEY|GOOGLE_API_KEY|GOOGLE_APPLICATION_CREDENTIALS|LD_\w*|DYLD_\w*|NODE_\w*|BUN_\w*|PYTHON\w*|PERL5?\w*|RUBY\w*|GIT_\w*|SSL_\w*|REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE|PATH|HOME|SHELL|BASH_ENV|ENV|PREFIX|TMPDIR|AGAPP_\w*|PROMPT_COMMAND|PS4|IFS|CDPATH|SHELLOPTS|BASHOPTS|HOSTALIASES|GLIBC_TUNABLES|RES_OPTIONS|LOCALDOMAIN|MALLOC_\w*|CLASSPATH|TERMINFO|TERMINFO_DIRS|SSH_\w*|GNUPG\w*|NPM_CONFIG_\w*|JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS|TERMUX_\w*|EDITOR|VISUAL|PAGER|MANPAGER)$/;

/** agy 是官方 bionic 构建，直接跑：不用 glibc 加载器、不用 --preload、不用 seccomp 监督器。
 *  返回 [程序, 参数数组]：五个调用方（run/backfill/login/extensions/runAntigravity）
 *  都按 const [cmd, args] = agyCmd(...) 解构。 */
export function agyCmd(extra) {
  return [PATHS.agy, [...extra]];
}

/** 装着的 agy 版本（版本目录名，认不出返回 ""） */
export function agyVersion() {
  try { return path.basename(path.dirname(fs.realpathSync(PATHS.agy))); } catch { return ""; }
}

/** 连 agy 带它拉起的整棵进程树一起杀。
 *
 *  为什么不能用 child.kill()：SIGKILL 不往下传。agy 起了 bash、bash 起了
 *  sleep/blender/godot…，只杀 agy 的话那些会被 init（PID 1）收养、继续跑 ——
 *  实测按 ⏹ 中断后，巡检循环的 shell 照样在后台转，PPID 变成 1。
 *
 *  所以 spawn 时加了 detached:true，让 agy 当进程组长；这里对负 pid 下刀，
 *  一次带走整组。取不到组就退回杀单进程，别什么都不做。 */
export function killTree(child) {
  if (!child || !child.pid) return;
  // 光杀组不够：agy 的 run_command 工具会给子 shell 另开进程组（setsid），实测中断后
  // `sh -c … sleep 60` 留下来被 init 收养。所以先顺着 /proc 的父子关系把整棵树
  // 摘出来（得在杀之前摘，杀完父子关系就断了），再逐个连组带进程一起杀。
  const tree = descendants(child.pid);
  // agy 是 bionic 程序，/proc 里看得见它，不用像以前那样经监督器报 pid
  if (child.agyPid > 0 && child.agyPid !== child.pid) for (const p of [child.agyPid, ...descendants(child.agyPid)]) if (!tree.includes(p)) tree.push(p);
  try { process.kill(-child.pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch {} }
  for (const p of tree) {
    try { process.kill(-p, "SIGKILL"); } catch {}
    try { process.kill(p, "SIGKILL"); } catch {}
  }
}

/** 进程启动时刻（开机后的滴答，/proc/<pid>/stat 第 22 项）；读不到 null */
function startTicks(pid, st) {
  try { st ??= fs.readFileSync("/proc/" + pid + "/stat", "utf8"); return +st.slice(st.lastIndexOf(")") + 2).split(" ")[19]; } catch { return null; }
}

/** 显式取消一轮时，清掉这一轮用 setsid / nohup 双 fork 脱出去、已经不在进程树里的后代（FIND-044）。
 *  killTree 顺着 /proc 的父子关系和进程组走，脱出去的被 init 收养、又另开了进程组，两头都够不着。
 *  认法：本 uid、环境里带 AGAPP_RUN_ID=<这一轮>、启动时刻不早于这一轮的 agy（编号同 uid 谁读得到 /proc 都能抄）。
 *  自己和祖先链不碰：开发端从某个 agy 会话里另起的网关，环境里也带着那轮的编号。
 *  环境里已经没有 AGAPP_RUN=1 的不碰：去掉它是「这不是 agy 运行，是要常驻的服务」的约定（终端、openai-bridge 的
 *  start-bridge.sh 都这么做，reapOrphans 也按它认）。只认编号的话，用户让 Antigravity 起的桥 / 服务器一停这一轮就被杀。
 *  只在显式取消这条路上调；网关重启时那一套仍是 reapOrphans（用户还没定，别动）。返回清掉的进程数。 */
export function killRunProcs(runId, sinceTicks = null) {
  if (runId == null || runId === "") return 0;
  const uid = process.getuid?.();
  if (uid == null) return 0;
  const ppidOf = (pid) => {
    try { const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8"); return +s.slice(s.lastIndexOf(")") + 2).split(" ")[1]; } catch { return 0; }
  };
  const self = new Set();
  for (let p = process.pid, i = 0; p > 1 && i < 64; i++) { self.add(p); p = ppidOf(p); }
  let names = [];
  try { names = fs.readdirSync("/proc"); } catch { return 0; }
  const victims = [];
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    const pid = +n;
    if (self.has(pid)) continue;
    try {
      if (fs.statSync("/proc/" + n).uid !== uid) continue;
      const env = "\0" + fs.readFileSync(`/proc/${n}/environ`, "latin1");
      if (!env.includes("\0AGAPP_RUN_ID=" + runId + "\0") || !env.includes("\0AGAPP_RUN=1\0")) continue;
      const st = fs.readFileSync(`/proc/${n}/stat`, "utf8");
      const t = startTicks(pid, st);
      if (sinceTicks != null && t != null && t < +sinceTicks) continue;
      victims.push(pid);
    } catch {}
  }
  for (const pid of victims) {
    // 脱出去的可能又起了自己的子孙（都带着编号，多半已在名单里；这里按父子关系再摘一遍防漏）
    const tree = descendants(pid);
    try { process.kill(pid, "SIGKILL"); } catch {}
    for (const p of tree) { try { process.kill(p, "SIGKILL"); } catch {} }
  }
  return victims.length;
}

/** 网关启动时清掉上一任留下的孤儿（v0.2.0 设计 A3）。
 *  上一任网关被杀 / 崩溃时，它拉起的 agy 和 agy 另开进程组的子 shell 会被 init 收养（PPID=1），
 *  没人读它们的输出却还在干活：推提交、跑构建、占内存。新网关接不回它们，只能清掉。
 *  认法：本 uid、PPID=1，且环境里带 AGAPP_RUN=1（agyEnv 打的标记，子孙都继承），
 *  或命令行就是我们的 agy。连子孙一起、按进程组杀（同 killTree）。
 *  环境里的 AGAPP_GW_PID（run.mjs）指向的网关还活着、且比它起得早的不收：那是活网关名下用 setsid 脱出去的，不是上一任留下的。
 *  只在 agycodroid 做：开发端换网关（gw-swap.sh）时上一任的运行还要接着用。 */
export function reapOrphans() {
  if (!PREFIX) return;
  const uid = process.getuid(), victims = [];
  let names = [];
  try { names = fs.readdirSync("/proc"); } catch { return; }
  for (const n of names) {
    if (!/^\d+$/.test(n) || +n === process.pid) continue;
    try {
      if (fs.statSync("/proc/" + n).uid !== uid) continue;
      const st = fs.readFileSync("/proc/" + n + "/stat", "utf8");
      if (+st.slice(st.lastIndexOf(")") + 2).split(" ")[1] !== 1) continue;
      const env = "\0" + fs.readFileSync("/proc/" + n + "/environ", "latin1");
      const cmd = fs.readFileSync("/proc/" + n + "/cmdline", "utf8");
      if (!(env.includes("\0AGAPP_RUN=1\0") || cmd.includes(PATHS.agy))) continue;
      // 起它的网关还活着（setsid 脱出去的后台任务，或者测试里另起的网关碰上了真网关的运行）：不是孤儿，不收。
      // 那个 pid 若被别的进程复用，启动时刻会晚于它，照收
      const gw = +(/\0AGAPP_GW_PID=(\d+)\0/.exec(env) || [])[1], t0 = gw && gw !== process.pid ? startTicks(gw) : null;
      if (t0 != null && t0 <= startTicks(+n, st)) continue;
      victims.push([+n, cmd.replace(/\0/g, " ").trim().slice(0, 80)]);
    } catch {}
  }
  for (const [pid, cmd] of victims) {
    const tree = descendants(pid);
    try { process.kill(-pid, "SIGKILL"); } catch {}
    try { process.kill(pid, "SIGKILL"); } catch {}
    for (const p of tree) {
      try { process.kill(-p, "SIGKILL"); } catch {}
      try { process.kill(p, "SIGKILL"); } catch {}
    }
    log(`  清掉上一任留下的孤儿 pid=${pid}（连子孙 ${tree.length} 个）：${cmd}`);
  }
}

/** pid 的直接子进程，按 /proc/<pid>/task/<tid>/children 列（看得见 pid 才读得到；列出来的子进程本身看不见也照样列） */
export function childrenOf(pid) {
  const out = [];
  let tids = [];
  try { tids = fs.readdirSync(`/proc/${pid}/task`); } catch { return out; }
  for (const t of tids) {
    try { for (const x of fs.readFileSync(`/proc/${pid}/task/${t}/children`, "utf8").split(/\s+/)) if (/^\d+$/.test(x)) out.push(+x); } catch {}
  }
  return out;
}

/** root 的全部子孙 pid（读 /proc/<pid>/stat 的第 4 列 ppid）。 */
export function descendants(root) {
  const kids = new Map();
  let names = [];
  try { names = fs.readdirSync("/proc"); } catch { return []; }
  for (const n of names) {
    if (!/^\d+$/.test(n)) continue;
    let st;
    try { st = fs.readFileSync(`/proc/${n}/stat`, "utf8"); } catch { continue; }
    // comm 可能含空格和括号，从最后一个 ")" 往后数
    const f = st.slice(st.lastIndexOf(")") + 2).split(" ");
    const ppid = +f[1];
    if (!kids.has(ppid)) kids.set(ppid, []);
    kids.get(ppid).push(+n);
  }
  const out = [], stack = [root], seen = new Set([root]);
  while (stack.length) {
    const p = stack.pop();
    for (const k of [...(kids.get(p) || []), ...childrenOf(p)]) if (!seen.has(k)) { seen.add(k); out.push(k); stack.push(k); }
  }
  return out;
}

/** 安全模式：配置弄坏了（agy 的 settings.json、权限规则…）跑不起来时，用最小配置起：
 *  toolPermission 强制 request-review，不预先放行任何工具，model 不指定。
 *  不挪、不改任何文件，关掉就恢复原样。
 *  开关是一个标记文件 —— 界面打不开时，安卓壳的启动页也能直接写它。 */
const SAFE_FILE = path.join(CFG.home, ".agyapp-safe-mode");
export const safeMode = () => fs.existsSync(SAFE_FILE);
/** 安全模式下不问人的权限模式（always-proceed）退回 request-review */
export const safeModePerm = (mode) => safeMode() && mode === "always-proceed" ? "request-review" : mode;
function setSafeMode(on) {
  if (on) fs.writeFileSync(SAFE_FILE, String(Date.now()));
  else try { fs.unlinkSync(SAFE_FILE); } catch {}
  ledger("safe-mode", true, on ? "进入安全模式（界面开启）" : "退出安全模式");
  log(on ? "进入安全模式" : "退出安全模式");
}

/** 修复账本（安卓壳记安装 / 校验 / 修复，网关记安全模式），一行一条 JSON。没给路径就不记 */
export function ledger(kind, ok, msg, detail) {
  const f = process.env.AGAPP_LEDGER;
  if (!f) return;
  try { fs.appendFileSync(f, JSON.stringify({ at: Date.now(), kind, ok, msg, ...(detail ? { detail } : {}) }) + "\n"); } catch {}
}
export function readLedger(n = 100) {
  const f = process.env.AGAPP_LEDGER;
  if (!f) return null;
  try {
    return fs.readFileSync(f, "utf8").trim().split("\n").reverse().slice(0, n)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) { if (e.code === "ENOENT") return []; throw e; }   // 还没记过账才是空；读不了要报错，别装成「没有记录」（审查 #52 D-07）
}

/** 起 agy 之前核程序本身（agyseal.mjs）：对不上返回给人看的原因，能起返回 ""。
 *  开会话以外的路也要核：mcp list、doctor、登录、回退文件都会执行它（审查 11-05 第 16 组 1）。
 *  agy 没有 PGP 签名清单：核的是安装时存下的 manifest 副本 + 程序本身的 sha512（见 agyseal.mjs）。 */
export async function agyBlocked() {
  const gw = gwRuntimeBlocked();
  if (gw) return gw;
  const s = await agySeal().catch((e) => ({ ok: false, why: e.message }));
  if (s.ok !== false) return "";
  return s.why === "no manifest" || s.why === "no binary checksum (reinstall agy to store one)"
    ? tz("这个版本的 Antigravity CLI 还没有安装时存下的核验记录，这一轮没有启动。到 设置 → 更新 里重新安装一次就能拿到记录。")
    : tz("Antigravity CLI 程序核验没过，这次没有运行：{why}", { why: String(s.why || "") });
}

/** 跑一次 agy 并收集全部 stdout（用于取 CLI 状态类输出）。
 *  一次性调用走 -p + --output-format json（单次模式，跑完即退）；管理子命令（mcp list / doctor / auth status / --version）
 *  直接传，不加 -p。调用前先写一遍网关管理的 settings.json（和开会话同一份）。
 *  o.provider：指定用哪家跑（默认全局生效那家）。不认就等于没传——providers.mjs 的
 *  testProvider 传了 provider 却一直被忽略，测的其实是全局那家（登录 M1 连带修掉）；login.mjs
 *  的 authStatus 靠它按 google / gemini 分开探。每次调用都先按这家重写 settings 再起进程，
 *  所以探针写一次不会污染下一轮（run.mjs 起 agy 前也会按本轮那家重写）。 */
export async function runAntigravity(args, { cwd, timeoutMs = 60000, provider } = {}) {
  const blocked = await agyBlocked();
  if (blocked) return { out: "", err: blocked, error: true };
  const p = provider || PROVIDER;
  try { writeAgySettings(p, { safe: safeMode() }); } catch {}
  return new Promise((resolve) => {
    let out = "", err = "", done = false;
    const [cmd0, args0] = agyCmd([...args]);
    const child = spawn(cmd0, args0, {
      cwd: cwd || (fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home),
      env: agyEnv({ provider: p }),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,          // 当进程组长，中断时好整组带走（见 killTree）
    });
    const timer = setTimeout(() => {
      if (!done) { done = true; killTree(child); resolve({ out, err, timeout: true }); }
    }, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
    child.stdout.on("data", (d) => { out += d.toString("utf8"); });
    child.stderr.on("data", (d) => { err += d.toString("utf8"); });
    child.on("error", (e) => {
      if (done) return;
      done = true; clearTimeout(timer); resolve({ out, err: err + e.message, error: true });
    });
    child.on("close", (code, signal) => {
      if (done) return;
      // 被信号杀掉时 code 是 null：把信号名带出去，不然调用方只看到一片空白
      done = true; clearTimeout(timer); resolve({ out, err: err + (signal ? `（agy 被信号 ${signal} 终止）` : ""), code, signal });
    });
  });
}

// ── 路由：/api/safe-mode ──
export async function routeAntigravity(req, res, u, p) {
  if (req.method === "POST" && p === "/api/safe-mode") {
    const b = JSON.parse((await readBody(req)) || "{}");
    setSafeMode(!!b.on);
    return sendJson(res, 200, { ok: true, safeMode: safeMode() });
  }
  return NEXT;
}
