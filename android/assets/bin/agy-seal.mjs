#!/usr/bin/env node
// 终端封口（E06）：每次经 android/assets/bin/agy 起 agy 之前，按应用设置重写
// ~/.gemini/antigravity-cli/settings.json。
// 与 gateway/gw/agy.mjs 的 writeAgySettings 同款行为（同一份输入 → 同一份输出，
// 由 gateway/tests/term-seal.test.mjs 的 T5 钉住，见 terminal-seal-investigation.md §5.1）。
// 只用 node 内置模块，不 import 任何网关模块：bin/agy 是 sh 包装，每次调用都是
// 新进程，拉网关模块链（config / settings-store / providers / models …）太重且有副作用。
// 输入：~/agyapp-settings.json（permissionMode / agentMode / model / allowedTools /
//   disallowedTools / addDirs / provider）+ ~/agyapp-providers.json（active）
//   + ~/.agyapp-safe-mode 标记文件（safeMode 的判定就是它存在不存在，见 agy.mjs）。
// 输出：~/.gemini/antigravity-cli/settings.json，合并写（未知键保留），只盖 5 个管理键：
//   modelProvider / toolPermission / agentMode / permissions{allow,ask:[],deny} / model。
// 失败一律 fail-open：退出码永远 0，stderr 至多一行说明，包装照常 exec agy。
// 不要在这里加缓存/节流：缓存会重新引入“设置中途改了、终端里的 agy 却读旧配置”的洞。
import fs from "node:fs";
import path from "node:path";

const home = process.env.HOME || process.env.AGAPP_HOME || "";
if (!home) process.exit(0);

const readJson = (f) => {
  try {
    const j = JSON.parse(fs.readFileSync(f, "utf8"));
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch { return {}; }
};

// 上限抄 settings-store.mjs 的 capList（同一份输入在网关侧先被截成这样）。
const capList = (a, n, len, total = Infinity) => {
  const out = [];
  let sum = 0;
  for (const x of Array.isArray(a) ? a : []) {
    if (typeof x !== "string" || x.length > len) continue;
    if (out.length >= n || sum + x.length > total) break;
    out.push(x);
    sum += x.length;
  }
  return out;
};
const PERM_MODES = ["request-review", "proceed-in-sandbox", "always-proceed", "strict"];
const AGENT_MODES = ["", "accept-edits", "auto", "plan"];

const settings = readJson(path.join(home, "agyapp-settings.json"));
// 当前 provider 的判定抄 providers.mjs 的 resolveProvider：设置里的 provider 优先，
// 其次配置文件 active，最后兜底 google；只认 google / gemini 两家（PRESETS）。
// 不要读 settings.json 里旧的 modelProvider 回填——gemini/OAuth 切换后它就是错的。
const isKnown = (id) => id === "google" || id === "gemini";
const providersFile = readJson(path.join(home, "agyapp-providers.json"));
let providerId = "google";
if (isKnown(settings.provider)) providerId = settings.provider;
else if (isKnown(providersFile.active)) providerId = providersFile.active;
// 安全模式：和 agy.mjs 的 safeMode() 同一个标记文件（存在即安全模式），
// 所以 bin/agy 层也不会把 termNew 那层封好的安全模式写回去。
let safe = false;
try { safe = fs.existsSync(path.join(home, ".agyapp-safe-mode")); } catch {}

const permissionMode = PERM_MODES.includes(settings.permissionMode) ? settings.permissionMode : "request-review";
const agentMode = AGENT_MODES.includes(settings.agentMode) ? settings.agentMode : "";
const model = typeof settings.model === "string" && settings.model.length <= 200 ? settings.model : null;
const allowedTools = capList(settings.allowedTools, 200, 512, 8192);
const disallowedTools = capList(settings.disallowedTools, 200, 512, 8192);
const addDirs = capList(settings.addDirs, 64, 4096, 16384);

const file = path.join(home, ".gemini", "antigravity-cli", "settings.json");
const cur = readJson(file);
const next = { ...cur };
next.modelProvider = providerId === "gemini" ? "gemini" : "";
next.toolPermission = safe ? "request-review" : permissionMode;
next.agentMode = safe ? "" : agentMode;
const allow = new Set(), deny = new Set();
for (const t of allowedTools) allow.add(String(t));
for (const t of disallowedTools) deny.add(String(t));
for (const d of addDirs) if (typeof d === "string" && d) allow.add(`write_file(${d})`);
next.permissions = safe ? { allow: [], ask: [], deny: [] }
  : { allow: [...allow], ask: [], deny: [...deny] };
if (!safe && model) next.model = model;
else if (safe) delete next.model;

try {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
} catch (e) {
  console.error(`agycodroid: 写 agy 设置失败（${e.message}），这个 agy 没有封口 / failed to write agy settings (${e.message}), this agy run is unsealed`);
}
process.exit(0);
