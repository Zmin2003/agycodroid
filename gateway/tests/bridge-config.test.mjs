import "../gw/config.mjs";
// 桥配置测试（OpenAI 兼容本地协议桥）：
// 2026-11-19 移植时删掉了 42 条依赖「桥保存成功建出 custom-N 接口」的用例——
// agy 只有 google/gemini 两家，upsertProvider 拒掉 custom-N，saveProvider 一律报
// provider_save_failed，桥的保存/修复/多 API/卸载重装等流程都建立不起来。
// 删掉的不是「测错了」，是被测功能在生产代码里已不存在；留下的 12 条是不要成功保存
// 也能验的（校验、冲突、只读检查），外加 1 条改写过的多模型用例，断言保存失败后的新行为。
// 生产缺口已定（2026-11-19）：桥的「接进聊天」入口下掉了——扩展页点「配置」直接提示不支持，
// 不再打开配置面板（面板的保存必然报 provider_save_failed）；custom-N 接口继续拒掉，
// 直接调保存接口仍是 400 provider_save_failed（见下「同一桥保存多个模型」用例）。
// 组件本身仍可安装/停用/卸载（给其它工具当本地 OpenAI 兼容服务用），只是不能当聊天接口。
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { performance } from "node:perf_hooks";
import crypto from "node:crypto";
import { registryFlockFixture, guardRegistryFlock } from "./fixtures/registry-flock.mjs";
import { routeComponents } from "../gw/components.mjs";
import { normalizeBridgeEndpoint, saveBridgeConfig } from "../gw/bridge-config.mjs";
import { PROVIDER, PROVIDERS_CFG, upsertProvider } from "../gw/providers.mjs";
import { SETTINGS } from "../gw/settings-store.mjs";
import { RUNS } from "../gw/runs.mjs";
import { cachedModels, fetchModels } from "../gw/models.mjs";
import { agyEnv } from "../gw/agy.mjs";

const home = process.env.AGAPP_HOME, prefix = process.env.AGAPP_PREFIX;
const root = fs.mkdtempSync(path.join(process.env.AGAPP_WORKSPACE, "bridge-config-"));
const target = path.join(home, ".local/share/ccr-bridge-kit");
const registration = path.join(home, ".agycodroid/services/openai-bridge.json");
const record = path.join(path.dirname(prefix), "components/openai-bridge.json");
const component = path.join(prefix, "lib/openai-bridge/component.cjs");
const marker = path.join(root, "calls");
const stateFile = path.join(root, "state");
const modeFile = path.join(root, "mode");
const upstreamSecret = "fixture-upstream-key-NOT-FOR-OUTPUT";
const localSecret = "a".repeat(48), freshLocalSecret = "d".repeat(48);
const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); };
const source = `const fs=require('node:fs'),path=require('node:path');
const marker=${JSON.stringify(marker)},stateFile=${JSON.stringify(stateFile)},modeFile=${JSON.stringify(modeFile)},target=${JSON.stringify(target)},reg=${JSON.stringify(registration)};
let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
 const command=process.argv[2],mode=fs.readFileSync(modeFile,'utf8');
 fs.appendFileSync(marker,JSON.stringify({args:process.argv.slice(2),hasUpstreamEnv:!!process.env.ANTHROPIC_API_KEY||!!process.env.OPENAI_API_KEY,hasAppEnv:!!process.env.AGAPP_RUN,fields:input?Object.keys(JSON.parse(input)):[],input:input?JSON.parse(input):null})+'\\n');
 const write=(p,v)=>{fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,JSON.stringify(v),{mode:0o600});};
 if(mode==='conflict'){console.error(JSON.stringify({schema:1,id:'openai-bridge',error:{code:'RUNTIME_CONFLICT',check:'APP_PROVIDER',detail:${JSON.stringify(upstreamSecret)},message:'must not forward '+${JSON.stringify(upstreamSecret)}}}));process.exitCode=1;return;}
 let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null;
 const view=()=>({schema:1,id:'openai-bridge',configured:!!state,endpoint:state?.endpoint||'',model:state?.model||'',...(state?.models?{models:state.models}:{}),...(mode.startsWith('multi')?{capabilities:{multiUpstream:true},...(state?.upstreams?{upstreams:state.upstreams.map((u,i)=>({...u,hasKey:true,keyTail:'LEAK',connectionPath:'/untrusted/path',...(mode==='multi-mismatch'&&i===0?{models:u.models.map((p,j)=>({...p,model:j===0?'changed-raw-model':p.model}))}:{})}))}:{})}:{}),hasKey:!!state,localReady:!!state&&mode!=='not-ready',...(mode.startsWith('local:')?{localError:mode.slice(6)}:{}),apiKey:${JSON.stringify(upstreamSecret)},keyTail:'LEAK',connectionPath:'/untrusted/path'});
 if(command==='gui-status'){const output=()=>console.log(JSON.stringify(view()));if(mode==='delay')setTimeout(output,200);else output();return;}
 if(command==='uninstall'){fs.rmSync(reg,{force:true});return;}
 if(command!=='gui-configure'){process.exitCode=2;return;}
 const body=JSON.parse(input);
 if(body.upstreams){
  const previous=state;
  const upstreams=body.upstreams.map(u=>({...u,apiKey:u.apiKey||previous?.upstreams?.find(p=>p.name===u.name)?.apiKey||${JSON.stringify(upstreamSecret)}}));
  state={...body,apiKey:previous?.apiKey||${JSON.stringify(upstreamSecret)},upstreams};
 }
 else if(body.apiKey)state={...body};else state={...body,apiKey:state.apiKey};
 write(stateFile,state);write(path.join(target,'.ccr-bridge-kit.json'),{id:'ccr-bridge-kit',target,guiManaged:true,service:{schema:1,home:process.env.HOME,instanceId:'b'.repeat(32)},settings:path.join(process.env.HOME,'.claude/settings.json'),componentEntry:process.argv[1]});write(path.join(target,'connection.json'),{baseUrl:'http://127.0.0.1:34597',apiKey:mode==='fresh'?${JSON.stringify(freshLocalSecret)}:${JSON.stringify(localSecret)},model:state.model});
 write(reg,{schema:1,id:'openai-bridge',endpoint:'http://127.0.0.1:34597',runtimeDir:target,instanceId:'b'.repeat(32)});
 fs.mkdirSync(path.join(target,'runtime-home/.claude-code-router'),{recursive:true,mode:0o700});
 write(path.join(target,'runtime-home/.claude-code-router/config.json'),{fixture:true,model:state.model,models:state.models||[state.model]});
 const output=()=>console.log(JSON.stringify(view()));
 if(mode==='delay')setTimeout(output,200);else output();
});`;
function fixture() {
  fs.mkdirSync(path.dirname(component), { recursive: true }); fs.writeFileSync(component, source);
  put(record, { id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs"] });
  fs.writeFileSync(modeFile, "ok");
}
function calls() { try { return fs.readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse); } catch { return []; } }
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  Promise.resolve(routeComponents(req, res, url, url.pathname)).catch(() => { res.writeHead(500); res.end("{}"); });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
async function request(body, endpoint = "/api/components/openai-bridge/config") {
  const response = await fetch(origin + endpoint, { method: body === undefined ? "GET" : "POST", headers: { "content-type": "application/json", "x-cc-lang": "zh" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  assert.equal(text.includes(upstreamSecret), false); assert.equal(text.includes(localSecret), false); assert.equal(text.includes(freshLocalSecret), false); assert.equal(text.includes("keyTail"), false);
  return { status: response.status, body: JSON.parse(text) };
}
const input = (more = {}) => ({ endpoint: "https://api.example.invalid/v1", apiKey: upstreamSecret, model: "fixture-model", consent: true, ...more });
const providerTempWrite = (name) => {
  try {
    const file = typeof name === "number" ? fs.readlinkSync(`/proc/self/fd/${name}`) : String(name);
    return file.startsWith(path.join(home, "agyapp-providers.json") + ".") && file.endsWith(".tmp");
  } catch { return false; }
};
beforeEach(() => {
  for (const file of [marker, stateFile, registration, record, component, path.join(path.dirname(registration), "openai-bridge-app.json")]) fs.rmSync(file, { force: true });
  fs.rmSync(target, { recursive: true, force: true });
  fixture();
});
after(async () => {
  server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  for (const file of [registration, record, component]) fs.rmSync(file, { force: true });
  fs.rmSync(target, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true });
});

test("地址只补全标准根/v1，完整chat completions原样使用，不猜私有路径", () => {
  for (const value of ["https://api.example.invalid", "https://api.example.invalid/", "https://api.example.invalid/v1/"])
    assert.equal(normalizeBridgeEndpoint(value), "https://api.example.invalid/v1/chat/completions");
  assert.equal(normalizeBridgeEndpoint("https://api.example.invalid/private/chat/completions"), "https://api.example.invalid/private/chat/completions");
  for (const value of ["http://api.example.invalid", "https://x.invalid/private", "https://x.invalid/v1/responses", "https://user:pass@x.invalid", "https://x.invalid/v1?key=fake", "https://x.invalid/v1#fragment", "https://x.invalid\\v1"])
    assert.throws(() => normalizeBridgeEndpoint(value));
});

test("GET只调用固定gui-status并且不返回任何密钥或路径", async () => {
  const result = await request();
  assert.equal(result.status, 200); assert.equal(result.body.installed, true); assert.equal(result.body.configured, false);
  assert.deepEqual(calls().map((call) => call.args), [["gui-status"]]);
  assert.equal("connectionPath" in result.body, false);
});

test("保存必须明确consent且拒绝dir/port/命令等额外字段，不执行组件", async () => {
  for (const body of [input({ consent: false }), input({ consent: undefined }), input({ dir: "/untrusted" }), input({ port: 12345 }), input({ command: "uninstall" })])
    assert.equal((await request(body)).status, 400);
  assert.equal(calls().length, 0);
});

test("provider写入失败与组件配置落盘分开报告，不泄露底层路径", async () => {
  const state = path.join(path.dirname(registration), "openai-bridge-app.json");
  fs.mkdirSync(state, { recursive: true });
  try {
    const result = await request(input());
    assert.equal(result.status, 409); assert.equal(result.body.saved, true); assert.equal(result.body.code, "RUNTIME_CONFLICT");
    assert.equal(JSON.stringify(result.body).includes(home), false);
    assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).model, "fixture-model");
  } finally { fs.rmdirSync(state); }
});

// 「本地错误…在状态和连续保存中保留」6 条已删：同上，保存本身已报 provider_save_failed，
// 状态里留本地错误的前提（保存成功）不存在。

test("已有同版手工实例没有GUI标记时不接管或调用configure", async () => {
  await request(input());
  const manifest = path.join(target, ".ccr-bridge-kit.json");
  put(manifest, { id: "ccr-bridge-kit", target });
  const before = calls().filter((call) => call.args[0] === "gui-configure").length;
  const result = await request(input({ model: "do-not-save" }));
  assert.equal(result.status, 409); assert.equal(result.body.code, "RUNTIME_CONFLICT");
  assert.equal(calls().filter((call) => call.args[0] === "gui-configure").length, before);
  assert.deepEqual(JSON.parse(fs.readFileSync(manifest, "utf8")), { id: "ccr-bridge-kit", target });
});

test("组件统一冲突只报告检查环节，不猜测旧安装或透传私密诊断", async () => {
  fs.writeFileSync(modeFile, "conflict");
  const result = await request(input());
  assert.equal(result.status, 409); assert.equal(result.body.code, "RUNTIME_CONFLICT"); assert.equal(result.body.saved, false);
  assert.equal(result.body.check, "COMPONENT");
  assert.match(result.body.message, /一致性检查未通过/); assert.equal(result.body.message.includes("请先备份"), false);
  assert.deepEqual(calls().map((call) => call.args), [["gui-status"]]);
});

test("旧记录写的是另一种路径写法（同一目录的别名）照样认；相对路径不认", async () => {
  // 真机上是 /data/data/<包名> 和 /data/user/0/<包名> 绑定挂载；测试里用软链造一个指向同一目录的别名
  await request(input());
  const alias = path.join(root, "home-alias");
  fs.rmSync(alias, { force: true }); fs.symlinkSync(home, alias);
  const aliasTarget = path.join(alias, ".local/share/ccr-bridge-kit");
  const manifestFile = path.join(target, ".ccr-bridge-kit.json"), manifest = fs.readFileSync(manifestFile), reg = fs.readFileSync(registration);
  const m = JSON.parse(manifest), r = JSON.parse(reg);
  put(manifestFile, { ...m, target: aliasTarget, service: { ...m.service, home: alias } });
  put(registration, { ...r, runtimeDir: aliasTarget });
  const ok = await request();
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  put(manifestFile, { ...m, target: ".local/share/ccr-bridge-kit" });
  const bad = await request();
  assert.equal(bad.status, 409); assert.equal(bad.body.check, "OWNERSHIP");
  fs.writeFileSync(manifestFile, manifest); fs.writeFileSync(registration, reg); fs.rmSync(alias, { force: true });
});

const repairRequest = body => request(body, "/api/components/openai-bridge/repair");
const inspectRepair = () => repairRequest({ action: "inspect", consent: true });
const applyRepair = ticket => repairRequest({ action: "apply", consent: true, ticket });

test("不健康record或软链入口不执行固定组件", async () => {
  put(record, { id: "openai-bridge", state: "ok", files: ["lib/openai-bridge/component.cjs", "../escape"] });
  assert.equal((await request(input())).status, 409); assert.equal(calls().length, 0);
  fixture(); const target = path.join(root, "private-component.cjs"); fs.renameSync(component, target); fs.symlinkSync(target, component);
  assert.equal((await request(input())).status, 409); assert.equal(calls().length, 0);
});

test("同一桥保存多个模型：桥想建 custom 接口存不下来（agy 只有 google/gemini），保存报 provider_save_failed、清单仍是静态的", async () => {
  // 桥（OpenAI 兼容本地协议桥）要建 custom-N 接口才能把多模型 + 窗口存下来；移植后 upsertProvider
  // 只认 google/gemini，saveProvider 拿不到接口号就报 provider_save_failed（400）。组件自己的
  // 状态照常写了（saved:true），但网关这一侧没有建出接口，模型清单仍是静态的。
  const active = PROVIDER.id, setting = SETTINGS.provider;
  const models = [{ id: "large-model", contextWindow: 1048576 }, { id: "gpt-4o-audio-preview", contextWindow: 128000 }, { id: "image-aware-chat" }];
  const before = Object.keys(PROVIDERS_CFG.providers);
  const result = await request(input({ model: "large-model", models }));
  assert.equal(result.status, 400, JSON.stringify(result.body));
  assert.equal(result.body.code, "provider_save_failed");
  assert.equal(result.body.saved, true, "组件自己的状态照常写了，只是接口没建出来");
  assert.deepEqual(Object.keys(PROVIDERS_CFG.providers), before, "没建出新接口");
  const probe = { id: "gemini", extraModels: [] };
  assert.deepEqual((await fetchModels(true, probe)).map((m) => m.id), ["gemini-3.8-flash-medium"], "清单仍是静态的，不进桥的模型");
  assert.deepEqual(cachedModels(probe).map((m) => m.id), ["gemini-3.8-flash-medium"]);
  const env = agyEnv({ model: "large-model", provider: probe });
  assert.equal(env.ANTHROPIC_MODEL, undefined);
  assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, undefined);
  assert.equal(PROVIDER.id, active); assert.equal(SETTINGS.provider, setting);
  assert.deepEqual(calls().find((call) => call.args[0] === "gui-configure").fields.sort(), ["apiKey", "endpoint", "model", "models"]);
});

test("多模型请求校验默认项/重复/数量/控制字符/上下文，失败不调用组件", async () => {
  for (const models of [[], ["fixture-model"], [{ id: "other" }], [{ id: "fixture-model" }, { id: "fixture-model" }],
    [{ id: "fixture-model", url: "https://untrusted.invalid" }], [{ id: "fixture-model", contextWindow: 12.5 }],
    [{ id: "fixture-model" }, { id: "bad\u0085model" }], Array.from({ length: 101 }, (_, i) => ({ id: i ? "m" + i : "fixture-model" }))]) {
    assert.equal((await request(input({ models }))).status, 400);
  }
  assert.deepEqual(calls(), []);
});

const multiInput = () => ({ endpoint: "https://one.example.invalid/v1", apiKey: "", consent: true, model: "relay-2/shared",
  models: [{ id: "relay/shared", contextWindow: 512000 }, { id: "relay-2/shared", contextWindow: 128000 }],
  upstreams: [
    { name: "relay", endpoint: "https://one.example.invalid/v1", apiKey: upstreamSecret, models: [{ id: "relay/shared", model: "shared" }] },
    { name: "relay-2", endpoint: "https://two.example.invalid/v1", apiKey: upstreamSecret, models: [{ id: "relay-2/shared", model: "shared" }] },
  ] });
const normalizedTopology = (body) => body.upstreams.map(({ name, endpoint, models }) => ({ name, endpoint: normalizeBridgeEndpoint(endpoint), hasKey: true, models }));
const configureCount = () => calls().filter(call => call.args[0] === "gui-configure").length;

test("多API拒绝非法名称、raw重复、visible冲突、拓扑漏项/顺序/default、超限和额外控制字段", async () => {
  const mutations = [
    body => { body.upstreams = []; },
    body => { body.upstreams[1].name = "relay"; },
    body => { body.upstreams[1].name = "Relay"; },
    body => { body.upstreams[1].name = "a".repeat(33); },
    body => { body.upstreams[1].models = []; },
    body => { body.upstreams[1].models.push({ id: "other", model: "shared" }); },
    body => { body.upstreams[1].models[0].id = "relay/shared"; },
    body => { body.upstreams[1].models[0].model = "two,models"; },
    body => { body.upstreams[1].models[0].model = "x".repeat(201); },
    body => { body.upstreams[1].models[0].model = "line\u0085break"; },
    body => { body.models.reverse(); },
    body => { body.models.pop(); body.model = body.models[0].id; },
    body => { body.model = "missing-default"; },
    body => { body.endpoint = body.upstreams[1].endpoint; },
    body => { body.upstreams[0].dir = "/arbitrary"; },
    body => { body.upstreams[0].models[0].contextWindow = 1024; },
    body => { body.apiKey = upstreamSecret; },
    body => { body.upstreams = Array.from({ length: 17 }, (_, i) => ({ ...body.upstreams[0], name: "relay-" + i })); },
  ];
  for (const mutate of mutations) {
    const body = multiInput(); mutate(body);
    assert.equal((await request(body)).status, 400);
  }
  assert.equal(calls().length, 0, "所有格式错误均在组件执行前拒绝");
});

test("组件返回raw拓扑不同即部分保存失败，不更新App provider，不能只比较top visible list", async () => {
  fs.writeFileSync(modeFile, "multi"); const first = await request(multiInput());
  const previous = structuredClone(PROVIDERS_CFG.providers[first.body.providerId]);
  fs.writeFileSync(modeFile, "multi-mismatch");
  const result = await request(multiInput());
  assert.equal(result.status, 400); assert.equal(result.body.saved, true); assert.equal(result.body.code, "component_response");
  assert.deepEqual(PROVIDERS_CFG.providers[first.body.providerId], previous);
});

test("组件status拓扑必须规范且精确覆盖top list/default，不能透传畸形清单", async () => {
  fs.writeFileSync(modeFile, "multi"); const original = multiInput(); await request(original);
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  for (const change of [
    value => { value.upstreams[1].name = "relay"; },
    value => { value.upstreams[1].endpoint = "https://two.example.invalid/v1"; },
    value => { value.upstreams[1].models[0].id = "missing-visible"; },
    value => { value.upstreams = undefined; },
    value => { value.upstreams[0].models = []; },
  ]) {
    const bad = structuredClone(state); change(bad); put(stateFile, bad);
    const result = await request(); assert.equal(result.status, 400); assert.equal(result.body.code, "component_response");
  }
});

