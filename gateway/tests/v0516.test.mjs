// v0.5.16（agy 版）：#66（组件环境）、#67（容量声明、压缩线）
// 旧版 #66 第 5 项（清单为空时列配置的默认/快速模型，withConfigured）和 #67 的窗口声明、
// 压缩线取小都已不存在：清单是静态的（文档示例 + 用户自加的 slug），agy 不报窗口、没有 /compact，
// compactLineOf / defaultCompactLine 恒为 null，contextWindow 不再是接口配置项。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { componentEnv } from "../gw/component-env.mjs";
import { compactLineOf, defaultCompactLine, cachedModels } from "../gw/models.mjs";
import { agyEnv, currentModelInfo } from "../gw/agy.mjs";

test("组件环境：留下加载器要的变量，别的不带（#66 第 3 项）", () => {
  const src = {
    LANG: "C.UTF-8", LD_PRELOAD: "/a/lib/exec-shim-bionic.so:/u/lib/libtermux-exec-linker-ld-preload.so",
    TERMUX_APP__DATA_DIR: "/data/user/0/cc.agyroid", TERMUX_APP__LEGACY_DATA_DIR: "/data/data/cc.agyroid",
    TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE: "force", NODE_OPTIONS: "--require=/data/user/0/cc.agyroid/files/app/lib/execpath.cjs",
    ANTHROPIC_API_KEY: "<redacted>",
  };
  const env = componentEnv("/h", "/u", src);
  for (const k of ["TERMUX_APP__DATA_DIR", "TERMUX_APP__LEGACY_DATA_DIR", "TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE", "NODE_OPTIONS", "LD_PRELOAD", "LANG"]) assert.equal(env[k], src[k], k);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.AGAPP_TOKEN, undefined);
  assert.equal(env.HOME, "/h");
  assert.equal(env.PATH, "/u/bin:/system/bin:/system/xbin");
  // 别的 NODE_OPTIONS（能让组件跑任意代码）不放
  for (const bad of ["--require=/tmp/x.cjs", "--require=/a/lib/execpath.cjs --inspect", "--inspect"]) assert.equal(componentEnv("/h", "/u", { NODE_OPTIONS: bad }).NODE_OPTIONS, undefined, bad);
});

const P = (o) => ({ id: "custom-v0516", custom: true, baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only", defaultModel: "m-big", fastModel: "m-big", ...o });

test("静态清单不认窗口声明：agy 不报窗口，上下文窗口一律不知道（#67）", () => {
  const p = P({ contextWindow: 1048576, extraModels: [{ id: "m-big", contextWindow: 1048576 }] });
  assert.equal(cachedModels(p).length, 2, "文档示例 + 自加的");
  assert.equal(currentModelInfo("m-big", p).context_window, 1048576, "自加型号写明的窗口照留");
  assert.deepEqual(currentModelInfo("m-other", p), {}, "清单里没有的型号不借别人的窗口");
  const env = agyEnv({ model: "m-big", provider: p });
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined, "agy 环境里没有窗口变量");
});

test("压缩线恒为 null：agy 没有 /compact、也不报窗口（#67）", () => {
  for (const [set, win] of [[528000, 0], [528000, 1048576], [100000, 0], [null, 200000]]) assert.equal(compactLineOf(set, win, P()), null, `${set}/${win}`);
  for (const win of [0, 200000, 1048576]) assert.equal(defaultCompactLine(win, P()), null, String(win));
});

test("接口设置：更多模型里的窗口照旧校验，顶层的 contextWindow 不再是配置项（#67）", async () => {
  const http = await import("node:http");
  const { routeProviders } = await import("../gw/providers.mjs");
  const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); await routeProviders(req, res, u, u.pathname); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const post = async (p, body) => (await fetch(`http://127.0.0.1:${srv.address().port}${p}`, { method: "POST", body: JSON.stringify(body) })).json();
  try {
    // 顶层 contextWindow 不再存：agy 不认这个字段
    const r = await post("/api/providers/save", { id: "gemini", apiKey: "fixture-only", defaultModel: "m", contextWindow: 1048576 });
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.provider.contextWindow, 0);
    // 更多模型里的坏窗口照旧拒收
    for (const bad of [1024.5, 100, 99999999, "abc"])
      assert.ok((await post("/api/providers/save", { id: "gemini", extraModels: [{ id: "m", contextWindow: bad }] })).error, String(bad));
    const r2 = await post("/api/providers/save", { id: "gemini", extraModels: [{ id: "m", contextWindow: 1048576 }] });
    assert.ok(r2.ok, JSON.stringify(r2));
    assert.deepEqual(r2.provider.extraModels, [{ id: "m", contextWindow: 1048576 }]);
    const r3 = await post("/api/providers/save", { id: "gemini", extraModels: [] });
    assert.ok(r3.ok, JSON.stringify(r3));
    assert.equal(r3.provider.extraModels.length, 0);
    await post("/api/providers/delete", { id: "gemini" });
  } finally { srv.close(); }
});

test("手改配置塞的怪窗口不认", async () => {
  const { extraModelsOf } = await import("../gw/models.mjs");
  for (const v of [99999999, 12.5, -1, "1m"]) assert.deepEqual(extraModelsOf({ extraModels: [{ id: "m", contextWindow: v }] }), [{ id: "m", contextWindow: 0 }], String(v));
});
