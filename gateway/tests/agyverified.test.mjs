// Antigravity CLI 真机验证记录（gw/agyverified.mjs）：本地记录制，不下载、不验签
// 记录文件在 home/.cache/agycodroid/agy-verified.json，由本机真机验证写进缓存；
// 格式不对就当没有，不挡更新。旧版（ccverified）是远程拉取 + ed25519 验签，
// fork 没有上游的签名私钥，那套已随 ccverified.mjs 一起删掉。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { refreshVerified, verifiedInfo, VERIFIED_CACHE } from "../gw/agyverified.mjs";

const rec = { at: "2026-10-24", device: "Lenovo TB320FC", android: "15", sdk: 35, targetSdk: 28, app: "0.4.2", devkit: "devkit-2026.10.22.3", sha256: "ab" };
const doc = (updated, extra = {}) => ({ v: 1, updated, versions: { "2.1.300": [rec] }, bad: { "2.1.301": { zh: "终端里粘贴会卡住", en: "Pasting in the terminal hangs", fixed: "2.1.302" } }, ...extra });
const put = (d) => { fs.mkdirSync(path.dirname(VERIFIED_CACHE), { recursive: true }); fs.writeFileSync(VERIFIED_CACHE, typeof d === "string" ? d : JSON.stringify(d)); };
after(() => { fs.rmSync(VERIFIED_CACHE, { force: true }); });

test("本地记录：写进缓存、refreshVerified 重读，选单拿到验证记录和按语言的原因", async () => {
  put(doc("2026-10-24T01:00:00Z"));
  await refreshVerified();
  const zh = await verifiedInfo("zh"), en = await verifiedInfo("en");
  assert.equal(zh.verified["2.1.300"][0].device, "Lenovo TB320FC");
  assert.equal(zh.verified["2.1.300"][0].android, "15");
  assert.equal(zh.verified["2.1.300"][0].sha256, undefined, "选单只要显示用的字段");
  assert.equal(zh.verified["2.1.300"][0].sdk, undefined);
  assert.equal(zh.verified["2.1.300"][0].devkit, undefined);
  assert.equal(zh.verified["2.1.300"][0].targetSdk, 28);
  assert.deepEqual(zh.bad["2.1.301"], { text: "终端里粘贴会卡住", fixed: "2.1.302" });
  assert.equal(en.bad["2.1.301"].text, "Pasting in the terminal hangs");
  assert.equal(zh.verifiedError, "");
});

test("缓存不存在：verified/bad 都是空，不报错", async () => {
  fs.rmSync(VERIFIED_CACHE, { force: true });
  await refreshVerified();
  const r = await verifiedInfo("zh");
  assert.deepEqual(r.verified, {});
  assert.deepEqual(r.bad, {});
});

test("缓存格式不对：不认，当没有", async () => {
  put({ v: 1, updated: "2026-10-27T00:00:00Z" });   // 缺 versions/bad
  await refreshVerified();
  const r = await verifiedInfo("zh");
  assert.deepEqual(r.verified, {});
  assert.deepEqual(r.bad, {});
  put("{not json");
  await refreshVerified();
  assert.deepEqual((await verifiedInfo("zh")).verified, {});
});

test("新的一份：换上，撤掉的「有问题」随之消失", async () => {
  put(doc("2026-10-26T00:00:00Z", { bad: {} }));
  await refreshVerified();
  const r = await verifiedInfo("zh");
  assert.deepEqual(r.bad, {});
  assert.ok(r.verified["2.1.300"]);
});

test("本地记录不验签：磁盘上的记录改了，格式仍对就照认（本机自己写的缓存）", async () => {
  put(doc("2026-10-26T00:00:00Z"));
  await refreshVerified();
  const forged = doc("2099-01-01T00:00:00Z", { bad: { "2.1.300": { zh: "假的", en: "fake" } } });
  put(forged);
  await refreshVerified();
  const r = await verifiedInfo("zh");
  assert.equal(r.bad["2.1.300"].text, "假的", "本地缓存制：只验格式，不验签名");
});
