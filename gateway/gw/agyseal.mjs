// 每轮起 agy 前核一遍 agy 程序本身：被等长改过字符串（删掉内置的安全指令之类）的二进制不起。
// 信任锚是安装时存下的两份记录：manifest.json 副本（{version, url, sha512}，运行时从官方端点现读的，
// 它的 sha512 是 tar.gz 的校验和）+ agy.sha512（安装时解包落地后算的程序本身的 sha512）。
// 这里核三件事：manifest 副本的 version 与版本目录一致、agy.sha512 在、程序的 sha512 与 agy.sha512 一致。
// agy 没有 PGP 签名清单：不验签、不编造公钥。这两份记录本身没有签名，
// 同 uid 改得了文件也改得了它们 —— 这一层防的是程序文件被悄悄换掉、记录还在原样，
// 以及版本目录被指到别处；真正防篡改靠应用的 files/app 核对还原与启动时的完整性检查。
// 整个程序算一遍 sha512 不到一秒（骁龙 8+ 有硬件指令），
// 程序文件没动过（大小、修改时间、ctime、inode 都没变）就用上次的结论。
// 没存清单的（旧版本装的、安装时就没存上）核不了：发行版不起，开发版照常起，
// 重装一次 agy 就能拿到清单（install-agy.mjs 每次装都存）。
// 但这几种直接不起：程序不在安装目录的版本子目录里（current 软链被指到别处）、
// 这个网关进程先前核过的版本现在清单没了（删清单再换程序）。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, HERE, log } from "./config.mjs";
import { sealed as editionSealed } from "./edition.mjs";
import { tamperRecord } from "./tamper.mjs";

const isVer = (v) => /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.]{1,40})?$/.test(v || "");
/** 默认起的 agy：环境变量 AGAPP_AGY（Env.java 给的）优先；config 里 PATHS.claude 是旧名，协议层改过来之前先兜底 */
const DEFAULT_BIN = process.env.AGAPP_AGY || path.join(CFG.home, ".local", "share", "agycodroid", "agy", "current", "agy");
let cache = { fp: "", res: null };
const sealed = new Set();          // 这个进程里核过的版本目录
// 部署出来的那份（files/app，有 FILES 清单）才核；仓库里直接跑的开发布局不核。
// 不 import appfiles.mjs：终端里的 bin/agy 经 guard/cc-seal.mjs 也要核，那边不该再起一份文件守护
const DEPLOYED = fs.existsSync(path.join(HERE, "FILES"));
// 发行版布局（应用里的 files/app）：FILES 被删时不能退化成「开发布局、不核」
const APP_LAYOUT = /[\\/]files[\\/]app$/.test(HERE);
let askRecheck = null;
/** 保留给调用方挂补核回调（历史接口：以前没清单时叫补核去取）。现在清单只在安装时存，没有补核机制，不会再触发 */
export const onSealUnknown = (fn) => { askRecheck = fn; };
/** 起进程之后再看一眼：核过之后、真正执行之前程序被换掉了（来回替换卡时间窗），这一轮要停掉 */
export const sealStillValid = (bin0 = DEFAULT_BIN) => {
  if (!cache.res || cache.res.ok !== true) return true;
  try { return fpFor(fs.realpathSync(bin0)) === cache.fp; } catch { return false; }
};

const fpFor = (bin) => { const d = path.dirname(bin); return fpOf(bin, path.join(d, "manifest.json"), path.join(d, "agy.sha512")); };
function fpOf(...files) {
  return files.map((f) => { try { const s = fs.statSync(f); return `${f}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`; } catch { return f + ":-"; } }).join("|");
}
function sha512(f) {
  const h = crypto.createHash("sha512"), fd = fs.openSync(f, "r"), b = Buffer.alloc(4 << 20);
  try { let n; while ((n = fs.readSync(fd, b, 0, b.length)) > 0) h.update(b.subarray(0, n)); } finally { fs.closeSync(fd); }
  return h.digest("hex");
}

/**
 * { ok: true } 核过 / { ok: false, why } 对不上（别起）/ { ok: null, why } 核不了（开发版照常起）。
 * 发行版没有 manifest 副本时是 { ok: false, why }：没有补核机制，重装 agy 才能拿到清单
 */
export async function agySeal(bin0 = DEFAULT_BIN, { force = false, home = CFG.home } = {}) {
  // 发行版不能因为可写的 FILES 被删就退化成「开发布局、不核」：终端新起的进程会直接放行
  if (!DEPLOYED && !force) return editionSealed() && APP_LAYOUT ? { ok: false, why: "FILES missing" } : { ok: null, why: "dev" };
  let bin;
  try { bin = fs.realpathSync(bin0); } catch { return { ok: null, why: "missing" }; }
  const dir = path.dirname(bin), mf = path.join(dir, "manifest.json"), sf = path.join(dir, "agy.sha512");
  const fp = fpFor(bin);
  // 刚改过的不信缓存：时间戳有粒度，同一刻里写两遍、大小不变，指纹就一样（gwpin.mjs 同理）
  let fresh = false;
  try { fresh = Date.now() - fs.statSync(bin).ctimeMs <= 2000; } catch {}
  if (cache.fp === fp && cache.res && !fresh) return cache.res;
  let res;
  const ROOT = path.join(home, ".local", "share", "agycodroid", "agy");
  let m = null, binSha = "", root = ROOT;
  try { root = fs.realpathSync(ROOT); } catch {}
  try { m = fs.readFileSync(mf); } catch {}
  try { binSha = fs.readFileSync(sf, "utf8").trim().toLowerCase(); } catch {}
  if ((path.dirname(dir) !== root || !isVer(path.basename(dir)) || path.basename(bin) !== "agy"))
    res = { ok: false, why: "not an installed version under " + ROOT };
  else if (!m) res = sealed.has(dir) ? { ok: false, why: "manifest removed after it was verified" }
    : editionSealed() ? { ok: false, why: "no manifest (reinstall agy to store one)" } : { ok: null, why: "no manifest" };
  else {
    let j = null;
    try { j = JSON.parse(m.toString("utf8")); } catch {}
    if (!j || !/^[a-f0-9]{128}$/i.test(j.sha512 || "")) res = { ok: false, why: "manifest has no sha512" };
    else if (j.version !== path.basename(dir)) res = { ok: false, why: `manifest is for ${j.version}, directory is ${path.basename(dir)}` };
    else if (!/^[a-f0-9]{128}$/.test(binSha)) res = { ok: false, why: "no binary checksum (reinstall agy to store one)" };
    else if (sha512(bin) !== binSha) res = { ok: false, why: "binary does not match the installed checksum" };
    else { res = { ok: true, version: j.version }; sealed.add(dir); }
  }
  const again = cache.res && cache.res.ok === res.ok && cache.res.why === res.why;
  if (res.ok === false && !(cache.res && cache.res.ok === false && cache.fp === fp)) {
    log(`⚠️ [Antigravity CLI 核验] ${bin}：${res.why}`);
    tamperRecord("claude", [`${path.basename(dir)}/agy: ${res.why}`]);
  } else if (res.ok === null && cache.res?.ok !== null) log(`[Antigravity CLI 核验] 核不了（${res.why}），照常起；重装 agy 会存下 manifest 副本`);
  if (res.why === "no manifest") try { askRecheck?.(); } catch {}
  cache = { fp, res };
  return res;
}
