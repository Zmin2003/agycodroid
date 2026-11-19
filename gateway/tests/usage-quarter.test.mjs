import "../gw/config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { CFG, PATHS } from "../gw/config.mjs";

test("旧整点与新刻钟共存，重复补算和清除跨月边界不重复计数", async () => {
  const since = Date.parse("2001-05-31T18:40:00Z"), hour = Math.floor(since / 3600e3);
  const slot = (iso) => Math.floor(Date.parse(iso) / 900e3);
  const file = path.join(CFG.home, "agyapp-usage.json");
  const backup = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const old = { m: 4, i: 139, xi: { m: 1, i: 9 } };
  fs.mkdirSync(PATHS.projects, { recursive: true });
  const dir = fs.mkdtempSync(path.join(PATHS.projects, "quarter-test-"));
  try {
    // [hour + 1] 的 x 桶模拟「降级到旧版时点过补算」留下的旧式补算：新版 quarters 里有补算后合并视图只信 quarters
    fs.writeFileSync(file, JSON.stringify({ v: 2, since, hours: { [hour]: old, [hour + 1]: { m: 9, x: 1 } } }));
    const { routeUsage, usageAdd, flushUsage } = await import("../gw/usage.mjs");
    const api = async (suffix, body) => {
      const url = new URL("/api/usage" + suffix, "http://localhost");
      const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method: body ? "POST" : "GET" });
      let data;
      await routeUsage(req, {
        writeHead(code) { assert.equal(code, 200); },
        end(json) { data = JSON.parse(json); },
      }, url, url.pathname);
      return data;
    };
    fs.writeFileSync(path.join(dir, "sample.jsonl"), ["18:05", "18:35"].map(time => JSON.stringify({
      timestamp: "2001-05-31T" + time + ":00Z", sessionId: "sample", type: "user",
      message: { role: "user", content: "hello" },
    })).join("\n") + "\n");
    usageAdd({ m: 1, i: 5 }, "live", "demo", Date.parse("2001-05-31T18:41:00Z"));
    usageAdd({ m: 1, i: 11 }, "live", "demo", Date.parse("2001-05-31T18:45:00Z"));
    flushUsage();
    // 还没补算：quarters 里没有 x，旧式补算桶照常展示
    assert.equal((await api("")).hours[hour + 1].m, 9);
    for (let i = 0; i < 2; i++) {
      await api("/import", {});
      const { hours, quarters } = await api("?detail=quarter");
      assert.equal(hours[hour].m, 3);
      assert.equal(quarters[slot("2001-05-31T18:35Z")].m, 2);
      assert.equal(quarters[slot("2001-05-31T18:45Z")].i, 11);
      const total = (await api("")).hours[hour];
      assert.equal(total.m, 7);
      assert.equal(total.i, 146);
      // 新版补算落进 quarters 后，旧式补算桶（带 x）在两个视图里都不再并进来，防止翻倍
      assert.equal((await api("")).hours[hour + 1], undefined);
      assert.equal((await api("?detail=quarter")).hours[hour + 1], undefined);
    }
    // 尼泊尔六月从 UTC 18:15 开始。旧记录横跨边界，18:05 的刻钟全部属于五月。
    await api("/clear", { from: Date.parse("2001-05-31T18:15Z"), to: Date.parse("2001-06-30T18:15Z") });
    const { hours, quarters } = await api("?detail=quarter");
    assert.equal(hours[hour].i, 130);
    assert.equal(quarters[slot("2001-05-31T18:05Z")].m, 1);
    assert.equal(quarters[slot("2001-05-31T18:35Z")], undefined);
    assert.equal(quarters[slot("2001-05-31T18:45Z")], undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (backup) fs.writeFileSync(file, backup); else fs.rmSync(file, { force: true });
  }
});

test("补算：agy 原生 cache_read_tokens 要先归一化再计（Q-03）", async () => {
  // 依赖上一个用例留下的内存状态：USAGE.since 是 2001-05-31T18:40Z，记录用 18:05Z（在 since 之前才进补算）
  const slot = (iso) => Math.floor(Date.parse(iso) / 900e3);
  const file = path.join(CFG.home, "agyapp-usage.json");
  const backup = fs.existsSync(file) ? fs.readFileSync(file) : null;
  fs.mkdirSync(PATHS.projects, { recursive: true });
  const dir = fs.mkdtempSync(path.join(PATHS.projects, "quarter-q03-"));
  try {
    const { routeUsage } = await import("../gw/usage.mjs");
    const api = async (suffix, body) => {
      const url = new URL("/api/usage" + suffix, "http://localhost");
      const req = Object.assign(Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []), { method: body ? "POST" : "GET" });
      let data;
      await routeUsage(req, {
        writeHead(code) { assert.equal(code, 200); },
        end(json) { data = JSON.parse(json); },
      }, url, url.pathname);
      return data;
    };
    // 原始 agy 形状：缓存字段叫 cache_read_tokens，不是 Claude 的 cache_read_input_tokens
    fs.writeFileSync(path.join(dir, "q03.jsonl"), JSON.stringify({
      timestamp: "2001-05-31T18:05:00Z", sessionId: "q03", type: "assistant",
      message: {
        role: "assistant", model: "antigravity", id: "msg-q03",
        content: [{ type: "text", text: "hi" }],
        usage: { input_tokens: 100, cache_read_tokens: 900, cache_creation_input_tokens: 50, output_tokens: 30 },
      },
    }) + "\n");
    await api("/import", {});
    const { quarters } = await api("?detail=quarter");
    const b = quarters[slot("2001-05-31T18:05Z")];
    assert.equal(b.i, 1050);   // 100 + 900 + 50：不归一化就只剩 150
    assert.equal(b.c, 900);
    assert.equal(b.o, 30);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    if (backup) fs.writeFileSync(file, backup); else fs.rmSync(file, { force: true });
  }
});
