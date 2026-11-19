#!/usr/bin/env node
// 核对 cccodroid.net 上的镜像是否跟得上：最新正式版 APK 两条线都在且大小对、agy 官方 manifest 可取且字段齐全、组件包在 dl.cccodroid.net 上都在且大小对。
// 只读，不验签（验签由客户端和生成器负责），用来发版前或出问题时快速看一眼。用法：node scripts/check-mirrors.mjs
import { execFileSync } from "node:child_process";
const get = async (url, method = "GET") => {
  const r = await fetch(url, { method, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
};
let bad = 0;

// APK：GitHub 最新正式版的两个安装包，在 cccodroid.net/dl/ 与 dl.cccodroid.net/dl/ 上都要在、大小一致；固定直链也要指向它
try {
  const rel = await (await get("https://api.github.com/repos/greyoak111/cccodroid/releases/latest")).json();
  for (const a of rel.assets.filter((x) => /^cccodroid(-36)?\.apk$/.test(x.name))) {
    const got = [];
    for (const u of [`https://cccodroid.net/dl/${rel.tag_name}/${a.name}`, `https://dl.cccodroid.net/dl/${rel.tag_name}/${a.name}`, `https://cccodroid.net/dl/${a.name}`, `https://dl.cccodroid.net/dl/${a.name}`])
      got.push(await get(u, "HEAD").then((r) => +r.headers.get("content-length"), () => 0));
    const ok = got.every((n) => n === a.size);
    if (!ok) bad++;
    console.log(`${ok ? "✓" : "✗"} APK ${rel.tag_name} ${a.name}：GitHub ${a.size} / 主站 ${got[0]} / dl ${got[1]} / 主站直链 ${got[2]} / dl 直链 ${got[3]}`);
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

for (const name of ["official", "community"]) {
  let comps;
  try {
    const j = await (await get(`https://cccodroid.net/components/${name}/components.json`)).json();
    comps = Array.isArray(j.components) ? j.components : Object.entries(j.components).map(([id, c]) => ({ id, ...c }));
  } catch (e) { bad++; console.log(`✗ ${name} 索引：${e.message}`); continue; }
  let n = 0, miss = 0;
  for (const c of comps) for (const b of c.builds || []) {
    const asset = b.asset || String(b.url || "").split("/").pop();
    if (!/^https:\/\/github\.com\//.test(b.url || "") || !(b.bytes > 0)) continue;
    n++;
    try {
      const len = +(await get(`https://dl.cccodroid.net/components/${name}/${asset}`, "HEAD")).headers.get("content-length");
      if (len !== b.bytes) throw new Error(`大小 ${len} ≠ ${b.bytes}`);
    } catch (e) { miss++; console.log(`✗ ${name}/${asset}：${e.message}`); }
  }
  if (miss) bad++;
  console.log(`${miss ? "✗" : "✓"} 组件包 ${name}：${n - miss}/${n}`);
}
process.exit(bad ? 1 : 0);
