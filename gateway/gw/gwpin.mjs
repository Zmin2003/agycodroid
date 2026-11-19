// 网关起 claude 用的运行库（files/gw，安全 4 第 2 层）：每次起 claude 前按安装包钉的哈希再核一遍。
// 应用（GwRuntime.java）起网关前核过、写好，钉子经 AGAPP_GW_GLIBC_PIN（glibc 组，files/gw/glibc，32 个文件）
// 和 AGAPP_GW_PIN（gw 组，files/gw 下的 node、libz、libssl 等 13 个文件，gateway M7）交过来（文件名 → sha256）；
// 网关跑着的这段时间里同 uid 的进程能改 files/gw，这里不核的话 claude 加载的就是改过的 libc。
// 文件没动过（大小、修改时间、ctime、inode 都没变）就用上次的结论，32 个文件 lstat 一遍。
// 对不上：这一轮不起，留痕，等空闲时重启网关，应用重拉前按钉子重新写好（appfiles.mjs 的 APP.restart）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PATHS, log, tz } from "./config.mjs";
import { APP } from "./appfiles.mjs";

let PIN = null;
try { const o = JSON.parse(process.env.AGAPP_GW_GLIBC_PIN || "null"); if (o && typeof o === "object" && Object.keys(o).length) PIN = o; } catch {}
delete process.env.AGAPP_GW_GLIBC_PIN;
const DIR = process.env.AGAPP_GW_GLIBC_LIB || "";
// gateway M7：gw 组钉子，和 glibc 组同一形状（文件名 → sha256），Java 侧由 GwRuntime.gwPin() 算、
// GatewayService 在 AGAPP_GW_PIN 非 null 时才传。Java 侧拿不到有效钉子（gwpin.json 坏了）时是 null，
// 那就和 glibc 组一样 fail-closed（见 gwRuntimeBlocked 的 L2 分支）：钉子没法现算，重启网关修不好，
// 只拦不重启。测试环境 DIR 为空，走不到这里。
let GWPIN = null;
try { const o = JSON.parse(process.env.AGAPP_GW_PIN || "null"); if (o && typeof o === "object" && Object.keys(o).length) GWPIN = o; } catch {}
delete process.env.AGAPP_GW_PIN;
const GWDIR = DIR ? path.dirname(DIR) : "";   // files/gw（DIR 是它下面的 glibc）
const seen = new Map();          // 文件 → [指纹, sha256]

function sha256(f) {
  const h = crypto.createHash("sha256"), fd = fs.openSync(f, "r"), b = Buffer.alloc(1 << 20);
  try { let n; while ((n = fs.readSync(fd, b, 0, b.length)) > 0) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

/** 按一份钉子核一个目录：对不上的文件名列表。
 *  skipDir：这组目录里要放过的子目录名（gw 组要放过 glibc 子目录，它是另一组的地方，Java 的 prune 也一样放过它） */
function pinBad(pin, dir, skipDir) {
  const bad = [];
  for (const [name, want] of Object.entries(pin)) {
    const f = path.join(dir, name);
    try {
      const st = fs.lstatSync(f);
      if (!st.isFile()) { bad.push(name); continue; }
      const fp = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
      const c = seen.get(f);
      // 刚改过的不信缓存：时间戳有粒度，同一刻里写两遍、大小不变，指纹就一样
      const got = c && c[0] === fp && Date.now() - st.ctimeMs > 2000 ? c[1] : sha256(f);
      seen.set(f, [fp, got]);
      if (got !== want) bad.push(name);
    } catch { bad.push(name); }
  }
  // 多出来的也算：ld.so 按 --library-path 找库，往这里塞一个钉子里没有的同名库就能被加载
  try {
    for (const n of fs.readdirSync(dir)) {
      if (skipDir && n === skipDir) { try { if (fs.lstatSync(path.join(dir, n)).isDirectory()) continue; } catch {} }
      if (!Object.hasOwn(pin, n)) bad.push(n);
    }
  } catch { bad.push("."); }
  return bad;
}

/** 对不上的文件名列表；没有钉子（开发布局、开发版退回 $PREFIX 时）返回 [] */
export function gwGlibcBad({ pin = PIN, dir = DIR } = {}) {
  if (!pin || !dir || PATHS.gwGlibcLib !== dir) return [];
  return pinBad(pin, dir);
}

/** gw 组（files/gw 下的 node、libz 等）对不上的文件名列表；没有钉子返回 [] */
export function gwGwBad({ pin = GWPIN, dir = GWDIR } = {}) {
  if (!pin || !dir) return [];
  return pinBad(pin, dir, "glibc");
}

/** 起 claude 前调：对不上返回给人看的原因（这一轮别起），并要求空闲时重启网关、由应用重新写好；能起返回 "" */
export function gwRuntimeBlocked() {
  // gateway L2：应用布局（DIR 有值）却没有有效钉子：fail-closed，拒绝启动 agy。
  // Java 侧的约定（GatewayService.java:430）：glibcPin() 拿不到有效钉子返回 null、干脆不传这个环境变量，
  // 永远不要传 ""（"" 在这里会被当成“没有钉子、直接放行”，和以前一样）。
  // 重启网关修不好这个（Java 那边算出来还是 null），所以不调 APP.restart，让用户重启应用或重装。
  // 测试环境 DIR 为空，走不到这里
  if (DIR && !PIN) {
    log(`⚠️ [网关运行库] 应用布局下没有有效的 glibc 钉子（AGAPP_GW_GLIBC_PIN 没传或解析失败），这一轮不起 Antigravity CLI`);
    return tz("网关自己的运行库没有有效的安装包钉子，这一轮没有启动 Antigravity CLI。请重启应用（或重装）后再试。");
  }
  const bad = gwGlibcBad();
  if (bad.length) {
    log(`⚠️ [网关运行库] files/gw/glibc 和安装包对不上：${bad.slice(0, 6).join(", ")}`);
    APP?.restart(`gw/glibc/${bad[0]}（网关运行库和安装包对不上）`);
    return tz("网关自己的运行库被改过，这一轮没有启动 Antigravity CLI。网关会在空闲时重启、按安装包还原，稍后再发送。");
  }
  // gateway M7 补漏：gw 组缺钉子也 fail-closed（与上面 glibc 组 L2 同一条路）：Java 侧 gwPin()
  // 拿不到有效钉子返回 null、干脆不传 AGAPP_GW_PIN，钉子没法现算，重启网关修不好，只会空转，
  // 所以不调 APP.restart，让用户重启应用或重装。测试环境 DIR 为空，走不到这里。
  if (DIR && !GWPIN) {
    log(`⚠️ [网关运行库] 应用布局下没有有效的 gw 组钉子（AGAPP_GW_PIN 没传或解析失败），这一轮不起 Antigravity CLI`);
    return tz("网关自己的运行库没有有效的安装包钉子，这一轮没有启动 Antigravity CLI。请重启应用（或重装）后再试。");
  }
  const gwBad = gwGwBad();
  if (gwBad.length) {
    log(`⚠️ [网关运行库] files/gw 和安装包对不上：${gwBad.slice(0, 6).join(", ")}`);
    APP?.restart(`gw/${gwBad[0]}（网关运行库和安装包对不上）`);
    return tz("网关自己的运行库被改过，这一轮没有启动 Antigravity CLI。网关会在空闲时重启、按安装包还原，稍后再发送。");
  }
  return "";
}
