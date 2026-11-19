// D10 第 1 步（11-09）：会话保留期。claude 缺省 30 天就删会话（连同附属数据，不进回收站），项目设置写个小数字还会压过用户级的。
// 网关启动时给用户级设置补上永久保留（写过的不动、写坏的文件不碰、不弹配置改动卡片）；每轮 --settings 带上核过的值；
// 发行版回填不再照搬用户写的原值。agy 没有 --settings，终端包装脚本也不再传保留期。
import { CFG } from "../gw/config.mjs";
import "./fixtures/uc-baseline.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { _setSealed } from "../gw/edition.mjs";
import { RETENTION_DAYS, sessionRetention } from "../gw/retention.mjs";
import { ensureSessionRetention } from "../gw/extensions.mjs";
import { sealPrepare, sealCleanup } from "../gw/seal.mjs";
import { ucPending } from "../gw/userconf.mjs";

const F = path.join(CFG.home, ".claude", "settings.json");
const had = fs.existsSync(F) ? fs.readFileSync(F) : null;
const put = (s) => { fs.mkdirSync(path.dirname(F), { recursive: true }); fs.writeFileSync(F, s); };
const read = () => JSON.parse(fs.readFileSync(F, "utf8"));
const pendingSettings = () => (ucPending()?.rels || []).includes(".claude/settings.json");
after(() => {
  _setSealed(true);
  if (had) fs.writeFileSync(F, had); else fs.rmSync(F, { force: true });
  fs.rmSync(F + ".bak", { force: true });
  fs.rmSync(path.join(CFG.home, "sealproj-d10"), { recursive: true, force: true });
});

test("读保留期：没写、写坏、不是正整数都按永久；合法的照用户的", () => {
  fs.rmSync(F, { force: true });
  assert.deepEqual(sessionRetention(), { days: RETENTION_DAYS, own: false });
  for (const bad of ['{"cleanupPeriodDays":0}', '{"cleanupPeriodDays":-3}', '{"cleanupPeriodDays":"90"}', '{"cleanupPeriodDays":1.5}', "{oops", "[]"]) {
    put(bad);
    assert.equal(sessionRetention().days, RETENTION_DAYS, bad);
  }
  put('{"cleanupPeriodDays":90}');
  assert.deepEqual(sessionRetention(), { days: 90, own: true });
});

test("启动补写：没有文件就新建；有别的键照留并留 .bak；用户写过的（含写坏的值）不动；整份坏了不碰", async () => {
  fs.rmSync(F, { force: true });
  let r = await ensureSessionRetention();
  assert.equal(r.changed, true);
  assert.deepEqual(read(), { cleanupPeriodDays: RETENTION_DAYS });
  assert.equal(pendingSettings(), false, "应用自己补的不弹「用户级配置改了」");

  put(JSON.stringify({ model: "x", hooks: { Stop: [] } }, null, 2));
  ucPending(); // 当前样子先让卡片看见（hooks 是要问的键），再认下，模拟用户已确认过
  const { ucKeep } = await import("../gw/userconf.mjs");
  ucKeep([".claude/settings.json"]);
  r = await ensureSessionRetention();
  assert.equal(r.changed, true);
  assert.deepEqual(read(), { model: "x", hooks: { Stop: [] }, cleanupPeriodDays: RETENTION_DAYS });
  assert.deepEqual(JSON.parse(fs.readFileSync(F + ".bak", "utf8")), { model: "x", hooks: { Stop: [] } });
  assert.equal(pendingSettings(), false);

  for (const own of ['{"cleanupPeriodDays":90}', '{"cleanupPeriodDays":0}']) {
    put(own);
    r = await ensureSessionRetention();
    assert.equal(r.changed, false, own);
    assert.equal(fs.readFileSync(F, "utf8"), own);
  }
  put("{oops");
  await assert.rejects(ensureSessionRetention());
  assert.equal(fs.readFileSync(F, "utf8"), "{oops");
});

// 「每轮 --settings 带核过的保留期」已删：agy 没有 --settings，网关不再每轮给 CLI 传保留期。

test("发行版回填不再照搬用户写的 cleanupPeriodDays", () => {
  put('{"cleanupPeriodDays":0,"includeCoAuthoredBy":false}');
  _setSealed(true);
  fs.mkdirSync(path.join(CFG.home, "sealproj-d10"), { recursive: true });
  const p = sealPrepare({ cwd: path.join(CFG.home, "sealproj-d10"), runId: 1010 });
  assert.equal(p.block, null);
  assert.equal(p.settings.cleanupPeriodDays, undefined);
  assert.equal(p.settings.includeCoAuthoredBy, false, "别的照搬键不受影响");
  sealCleanup(1010);
});

// 「终端包装脚本」已删：android/assets/bin/claude 已改名 agy，且不再传 --settings/cleanupPeriodDays。
