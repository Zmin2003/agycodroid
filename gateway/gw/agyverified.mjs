// ── Antigravity CLI 真机验证记录：哪些版本在 agycodroid 上验过、哪些有已知问题 ─────────────────────────
//
// 本地记录制，不下载、不验签：fork 没有上游的签名私钥，不新造密钥对。
// 记录文件在 home/.cache/agycodroid/agy-verified.json，由本机真机验证（scripts/verify-agy.mjs 在真机上跑过之后）
// 写进这份缓存；维护者手里的仓库副本（agy/verified.json）由 scripts/agy-verified.mjs 维护，不发给用户。
// 用处：版本选单标「已验证」/ 有问题的原因（/api/claude/versions 带上）；Java 的自动更新读它——渠道走到有问题的版本时先不自动装。
// 缓存是本机自己写的：同 uid 的程序能写这个文件，格式不对就当没有，不挡更新。
import fs from "node:fs";
import path from "node:path";
import { CFG, LIVE, log } from "./config.mjs";

export const VERIFIED_CACHE = path.join(CFG.home, ".cache", "agycodroid", "agy-verified.json");

let data = null, lastError = "";
const load = () => {
  try {
    const j = JSON.parse(fs.readFileSync(VERIFIED_CACHE, "utf8"));
    if (!j || typeof j.versions !== "object" || typeof j.bad !== "object") throw new Error("格式不对");
    data = j; lastError = "";
  } catch (e) {
    if (e.code !== "ENOENT") log(`[agy-verified] 本地记录读不了：${e.message}`);
    data = null;
  }
};
load();

/** 重读一次磁盘上的本地记录（真机验证刚写完时调） */
export function refreshVerified() {
  load();
  return Promise.resolve();
}

/** 给版本选单：{ verified: {版本: [{device, android, at, app}]}, bad: {版本: {text, fixed}} } */
export async function verifiedInfo(lang = "zh") {
  refreshVerified();
  const verified = {}, bad = {};
  for (const [v, recs] of Object.entries(data?.versions || {})) if (Array.isArray(recs) && recs.length)
    verified[v] = recs.map((r) => ({ device: String(r.device || ""), android: String(r.android || ""), at: String(r.at || ""), app: String(r.app || ""), targetSdk: +r.targetSdk || 0 }));
  for (const [v, b] of Object.entries(data?.bad || {})) if (b) bad[v] = { text: String((lang === "zh" ? b.zh : b.en) || b.zh || b.en || ""), fixed: String(b.fixed || "") };
  return { verified, bad, verifiedError: lastError };
}

// 服务起来 15 秒后读一次（Java 的自动更新要用磁盘上那份）
if (LIVE) {
  setTimeout(() => refreshVerified().catch(() => {}), 15000).unref?.();
}
