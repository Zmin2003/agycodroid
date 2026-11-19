#!/usr/bin/env node
// 核对 fork 的发布是否跟得上：GitHub 最新正式版 APK（agycodroid / agycodroid-36）在不在、大小对不对；
// agy 官方 manifest 可取且字段齐全；组件包在 GitHub Release 上都在且大小对。
// fork 目前没有自己的镜像站（没有 cccodroid.net / dl.cccodroid.net 那样的镜像），所以不查任何镜像，只查 GitHub。
// 只读，不验签（验签由客户端和生成器负责），用来发版前或出问题时快速看一眼。用法：node scripts/check-mirrors.mjs
import { execFileSync } from "node:child_process";
const get = async (url, method = "GET") => {
  const r = await fetch(url, { method, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
};
let bad = 0;

// APK：GitHub 最新正式版的两个安装包（agycodroid.apk / agycodroid-36.apk）要在，且大小对；没有镜像站可对照
try {
  const rel = await (await get("https://api.github.com/repos/Zmin2003/agycodroid/releases/latest")).json();
  const apks = rel.assets.filter((x) => /^agycodroid(-36)?\.apk$/.test(x.name));
  if (!apks.length) { bad++; console.log(`✗ APK：${rel.tag_name} 里没有 agycodroid(-36)?.apk`); }
  for (const a of apks) {
    const len = await get(a.browser_download_url, "HEAD").then((r) => +r.headers.get("content-length"), () => 0);
    const ok = len === a.size && a.size > 0;
    if (!ok) bad++;
    console.log(`${ok ? "✓" : "✗"} APK ${rel.tag_name} ${a.name}：GitHub ${a.size} / 直链 HEAD ${len}`);
  }
} catch (e) { bad++; console.log(`✗ APK：${e.message}`); }

// agy：官方 manifest 只有一个（android_arm64），读它的 version / url / sha512 字段；
// 本机装了 agy 就把已装版本和清单版本比一比（没装只报一声，不算错；已装的比清单旧只说明有更新，也不算错）
const AGY_MANIFEST = "https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/android_arm64.json";
try {
  const m = await (await get(AGY_MANIFEST)).json();
  const ver = String(m.version || "").trim();
  if (!ver || typeof m.url !== "string" || !m.url || typeof m.sha512 !== "string" || !m.sha512) throw new Error(`manifest 字段不全：version=${ver || "(空)"} url=${typeof m.url} sha512=${typeof m.sha512}`);
  let installed = "";
  try { installed = execFileSync("agy", ["--version"], { encoding: "utf8", timeout: 15000 }).trim().split(/\s+/).pop(); } catch { installed = ""; }
  if (!installed) console.log(`✓ agy manifest：${ver}（sha512 ${m.sha512.slice(0, 12)}…；本机没装 agy，跳过已装版本比较）`);
  else if (installed === ver) console.log(`✓ agy manifest：${ver}，已装版本一致`);
  else console.log(`✓ agy manifest：${ver}，已装 ${installed}（和清单不一致：装的比清单旧就是有更新，反之是清单还没跟上）`);
} catch (e) { bad++; console.log(`✗ agy manifest：${e.message}`); }

// 组件索引与组件包：都在 fork 的 GitHub Release 上（official 走 Zmin2003/agycodroid 的 components Release；
// community 走 Zmin2003/agycodroid-components 的 index Release，该仓库目前还不存在，对应检查会报 ✗，直到仓库建好并发布索引）。
// 没有镜像站，所以包的存在性直接按索引里的 GitHub 地址（b.url）HEAD 核对，不再经过 dl 镜像。
const INDEX_URL = {
  official: "https://github.com/Zmin2003/agycodroid/releases/download/components/components.json",
  community: "https://github.com/Zmin2003/agycodroid-components/releases/download/index/components.json",
};
for (const name of ["official", "community"]) {
  let comps;
  try {
    const j = await (await get(INDEX_URL[name])).json();
    comps = Array.isArray(j.components) ? j.components : Object.entries(j.components).map(([id, c]) => ({ id, ...c }));
  } catch (e) { bad++; console.log(`✗ ${name} 索引：${e.message}`); continue; }
  let n = 0, miss = 0;
  for (const c of comps) for (const b of c.builds || []) {
    const asset = b.asset || String(b.url || "").split("/").pop();
    if (!/^https:\/\/github\.com\//.test(b.url || "") || !(b.bytes > 0)) continue;
    n++;
    try {
      const len = +(await get(b.url, "HEAD")).headers.get("content-length");
      if (len !== b.bytes) throw new Error(`大小 ${len} ≠ ${b.bytes}`);
    } catch (e) { miss++; console.log(`✗ ${name}/${asset}：${e.message}`); }
  }
  if (miss) bad++;
  console.log(`${miss ? "✗" : "✓"} 组件包 ${name}：${n - miss}/${n}`);
}
process.exit(bad ? 1 : 0);
