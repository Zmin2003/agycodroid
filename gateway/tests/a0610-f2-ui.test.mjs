// 0.6.10 审计 f2 车道：设置 / 型号 / 项目 / 脉络前端（195-E.3/E.5/E.9/E.10/E.12、K.2/K.6/K.7/K.8、M.8、N.7、O.8、O.9、BB.4）
// 这些是纯界面改动的关键路径：把「失败要说话、异步要串行、晚到的数据要补上」固定住，避免以后顺手改回去。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const src = (f) => fs.readFileSync(new URL(`../web/app/${f}`, import.meta.url), "utf8");
const has = (text, re, label) => assert.match(text, re, label);

test("195-O.9 退出登录成功后刷新状态与额度；登录状态查询失败不清掉已显示的额度", () => {
  const s = src("09-settings.js");
  has(s, /if \(r\.ok\) \{ (localStorage\.removeItem\("agy-ever-google-login"\); )?refreshStatus\(\); qbLoad\(\); loadQuota\(\)\.catch/, "退出成功要撤额度");
  has(s, /if \(failed && QB\.cur && QB\.cur\.id === cur\.id\) return QB\.cur;/, "查询失败保留旧额度");
  has(s, /try \{ st = await api\("\/api\/login\/status"\); \} catch \{ failed = true; \}/, "区分失败与未登录");
});

test("登录 M1/M2 Google 卡片按自己这家问登录态、按这家退出：authMethod 不对不显示已登录，退出带 provider", () => {
  const s = src("09-settings.js");
  has(s, /api\("\/api\/login\/status\?provider=" \+ encodeURIComponent\(p\.id\)\)/, "登录卡按卡片那家问登录态");
  has(s, /const loggedInHere = st\.loggedIn && \(!st\.authMethod \|\| st\.authMethod === p\.id\);/, "已登录只认这张卡那家的 authMethod");
  has(s, /post\("\/api\/login\/logout", \{ provider: p\.id \}\)/, "退出登录带上卡片那家");
});

test("195-N.7/M.8/O.8 原生跳转失败回 200+ok:false 要提示；更新状态取不到要显示重试；电池电流一律换算 mA", () => {
  const s = src("10-settings-device.js");
  has(s, /const appPost = async \(url, body\) => \{[\s\S]*?r\.ok === false[\s\S]*?toast\(t\("操作失败：\{msg\}"/, "appPost 检查 ok:false");
  has(s, /if \(act === "appsettings"\) appPost\("\/api\/app\/open_app_settings"\);/, "打开系统设置走 appPost");
  has(s, /function updFailed\(msg\)[\s\S]*?if \(!lastUpd\.items\)[\s\S]*?取不到更新状态：\{msg\}[\s\S]*?upd-retry/, "首次失败就要给重试");
  has(s, /\} else if \(!\$\("upd-retry"\)\)[\s\S]*?upd-retry/, "有旧结果时也补重试");
  has(s, /if \(r && r\.ok === false\) toast\(r\.message \|\| t\("检查更新失败"\)/, "检查更新检查 ok:false");
  has(s, /Math\.abs\(b\.currentUa\) \/ 1000/, "电流按微安换算");
  assert.doesNotMatch(s, /> 20000 \? 1000 : 1/, "旧的按阈值猜单位已移除");
});

test("195-E.3/E.9 接口改动后重拉型号；内置接口卡可单独清除 Key（自定义接口卡已删，见 agy 适配 W1）", () => {
  const s = src("09-settings.js");
  has(s, /data-act="clear"[\s\S]*?清除 Key/, "清除 Key 按钮（内置密钥卡上）");
  has(s, /post\("\/api\/providers\/save", \{ id: p\.id, clearKey: true \}\)/, "按 id 清 Key");
  has(s, /if \(id === state\.providerActive\) await loadModels\(true\);/, "改了正在用的接口后重拉型号");
  const u = src("11-usage.js");
  assert.doesNotMatch(u, /renderCustomCard/, "自定义接口卡已删");
  assert.doesNotMatch(s, /__new__/, "“＋ 新增自定义接口…”死路已删");
});

test("195-E.8 每次打开设置页重取设置，不只吃启动时那一次", () => {
  const s = src("15-pages.js");
  has(s, /function openSettings\(cat\)[\s\S]*?refreshSettings\(false\);/, "打开设置页重载（只读基础设置，不拉厂商/型号清单）");
  assert.doesNotMatch(s, /openSettings[\s\S]{0,800}?loadProviders\(\); loadModels\(\);/, "不再绕过 loadSettings 单独拉");
});

test("195-E.5/E.10/E.12 跟随默认看会话/项目默认；窗口未知只报已用量不画进度（agy 没有压缩线）；附加目录增删串行", () => {
  const s = src("12-model-caps.js");
  has(s, /const followEff = \(\) => \{[\s\S]*?state\.sessEff/, "跟随默认取有效默认");
  has(s, /const to = followEff\(\)\.prov;/, "改回默认的确认按有效接口");
  // E.10 旧断言「窗口未知仍显示已设压缩线」已删：agy 没有压缩线（compactLineOf 恒为 null），
  // 窗口未知时界面只报已用量、不画进度
  const flow = src("04-session-flow.js");
  has(flow, /上下文 \{used\} · 容量未知/, "窗口未知只报已用量");
  has(flow, /第三方接口不报窗口、也没设压缩线：没刻度就只报已用量，不画进度/, "没刻度不画进度");
  has(s, /let dirQ = Promise\.resolve\(\);[\s\S]*?dirQ = dirQ\.then/, "目录增删排队");
  has(s, /const r = await api\("\/api\/settings"\); if \(r && Array\.isArray\(r\.addDirs\)\) base = r\.addDirs;/, "以服务端当前值为底");
  has(s, /updateDirs\(\(ds\) => ds\.filter\(\(d\) => d !== gone\)\)/, "按目录名删而不是下标");
});

test("195-K.2/K.6/K.7/BB.4 已删项目保留在任务下拉；型号晚到补下拉；返回前确认未保存指令；定时页轮询", () => {
  const s = src("14-projects-sched.js");
  has(s, /已删除的项目（\{id\}）/, "已删项目选项");
  has(s, /if \(o\.isConnected && q\("#t-model"\)\) fillModels\(true\);/, "型号晚到补下拉");
  has(s, /项目指令还没保存，返回会丢掉这次修改/, "返回前确认");
  has(s, /schedPollSet\(name === "sched"\);/, "进页开轮询");
  has(s, /schedPollSet\(false\);/, "离开停轮询");
  has(s, /setTimeout\(async \(\) => \{[\s\S]*?loadSched\(\)[\s\S]*?\}, 5000\)/, "5 秒补拉");
});

test("195-K.8 脉络后台重取保持用户位置：只有头一回拿到图才归位", () => {
  const s = src("18b-lineage.js");
  has(s, /const first = !LIN\.map;[\s\S]*?linPaint\(first\);/, "只有首次 linPaint(true)");
  assert.doesNotMatch(s, /LIN\.g = g; LIN\.stale = false;\s*\n\s*linPaint\(true\)/, "后台重取不再强制归位");
});

test("196 HTTP 技能导入：超过后端 64 MB 上限的包先在界面拦住，不读进内存", () => {
  const s = src("08-extensions.js");
  has(s, /f\.size > 64 \* 1024 \* 1024[\s\S]*?技能包超过 64 MB/, "先查大小再 arrayBuffer");
  assert.ok(s.indexOf("f.size > 64 * 1024 * 1024") < s.indexOf("await f.arrayBuffer()"), "大小检查在读取之前");
});

test("196 输入域：「使用」指令和指令卡插到光标处，不覆盖未发送草稿", () => {
  const ext = src("08-extensions.js"), caps = src("12-model-caps.js");
  has(ext, /if \(act === "use" && c\) \{ closePage\(\); insertAtCursor\(/, "命令「使用」走 insertAtCursor");
  assert.doesNotMatch(ext, /if \(act === "use" && c\)[^\n]*inputEl\.value =/, "命令「使用」还在整段覆盖");
  has(caps, /insertAtCursor\(b\.dataset\.cmd\)/, "指令卡走 insertAtCursor");
});

test("195-N.8 帮助/更新日志加载失败说清楚是哪一步并给重试", () => {
  const s = src("15-pages.js");
  has(s, /帮助加载失败：\{msg\}/, "帮助失败文案");
  has(s, /id="help-retry"[\s\S]*?loadHelp\(\);/, "帮助重试");
  has(s, /更新日志加载失败：\{msg\}/, "更新日志失败文案");
  has(s, /id="cl-retry"[\s\S]*?loadChangelog\(\);/, "更新日志重试");
});

test("v1.0.2+ 会话里点 APK 直接走安装，不进压缩包浏览（上游 d350750 移植）", () => {
  const s = src("01-core.js");
  has(s, /return vwInstallApk\(r\.path\);/, "APK 点开直接安装");
  has(s, /r\.kind === "archive"/, "APK 分支在压缩包浏览之前");
});

test("紧凑聊天底栏（上游 0cedf00 移植，默认关 = 48px 大触控）：键 agycodroid-compact-chat-bar，类 compact-bar", () => {
  const s = src("01-core.js");
  has(s, /agycodroid-compact-chat-bar/, "紧凑开关读 fork 约定的 localStorage 键");
  has(s, /classList\.toggle\("compact-bar"/, "按这个键加/去 compact-bar 类");
  const css = fs.readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(css, /html\.compact-bar #hint-row/, "compact-bar 下有紧凑样式");
  assert.match(css, /compact-bar[\s\S]{0,400}?26px/, "紧凑触控盒 26px");
});

test("上游 a6b1f36 前端：存储读失败时排队消息挂起保留，排队条说清是读取历史失败", () => {
  const s = src("04-session-flow.js");
  has(s, /const q = srv\.queue, held = q\.filter\(\(it\) => it\.held\);/, "held 先算出来");
  has(s, /held\.some\(\(it\) => it\.storageHold\)/, "storageHold 单独分支");
  has(s, /读取历史失败：\{msg\}/, "存储失败文案");
});

test("W3 P0 #hint-row 不再被动折行：模型 chip 上限、短标签、折行降扩展区", () => {
  const css = fs.readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(css, /#hint-row #model-chip \.chip\{min-width:0;max-width:14em;/, "模型 chip 真正的宽度上限 14em");
  assert.match(css, /#hint-row\.wrapped #model-chip \.chip::after,#hint-row\.wrapped #perm-chip::after,#hint-row\.wrapped #draft-chip::after\{[^}]*height:30px/, "折行时扩展区降到 30px");
  assert.match(css, /#perm-menu \.pm-sec b\{display:block;padding:10px 10px 4px;font-size:12px;color:var\(--fg3\);font-weight:600\}/, "权限菜单组标题样式");
  assert.match(css, /#perm-menu \.pm-sec \+ \.pm-sec\{border-top:1px solid var\(--line\);margin-top:4px;padding-top:4px\}/, "第二组顶部有分隔线");
  assert.match(css, /#perm-bar button,\.perm-acts button\{[^}]*padding:10px 16px;font-size:13px/, "审批按钮 10px 16px / 13px");
  assert.match(css, /\.perm-acts\{display:flex;flex-wrap:wrap;gap:8px;/, "确认卡按钮间距 8px");
  const s = src("03-perm-status.js");
  has(s, /tpShort|逐项/, "chip 只用短标签映射");
  has(s, /checkHintWrap\(\)/, "setPermChip 后量一次是否折行");
});

test("W3 P0 setPermChip 真跑：chip 只显示短标签，折行时 hint-row 挂 wrapped 类", async () => {
  const { default: vm } = await import("node:vm");
  const s = src("03-perm-status.js");
  const a = s.indexOf("  const tpLabel"), b = s.indexOf("  // 别叫 diffHtml", a);
  assert.ok(a >= 0 && b > a, "setPermChip 片段");
  const code = s.slice(a, b) + "\n({ setPermChip })";
  const mkRow = (tops) => {
    const row = { classes: {}, classList: { toggle(n, f) { row.classes[n] = f; } },
      children: tops.map((t) => ({ offsetTop: t, offsetParent: {}, textContent: "x", classList: { contains: () => false } })) };
    return row;
  };
  const mkBox = (row) => ({
    state: { settings: {} },
    permEl: { innerHTML: "", classList: { toggle() {} } },
    $: (id) => (id === "hint-row" ? row : null),
    esc: (x) => String(x ?? ""),
    t: (x) => x,
  });
  // 最长组合：沙箱中继续 · 自动接受编辑 → 沙箱 · 自动改
  let row = mkRow([0, 0, 0]);
  let box = mkBox(row);
  let { setPermChip } = vm.runInNewContext(code, box);
  setPermChip("proceed-in-sandbox", "accept-edits");
  assert.match(box.permEl.innerHTML, /沙箱/, "chip 显示短标签 沙箱");
  assert.match(box.permEl.innerHTML, /自动改/, "chip 显示短标签 自动改");
  assert.doesNotMatch(box.permEl.innerHTML, /沙箱中继续|自动接受编辑/, "chip 不用完整文案");
  assert.match(box.permEl.innerHTML, /hint-perm-label/, "标签包在可省略的 span 里");
  assert.equal(row.classes.wrapped, false, "单行不挂 wrapped");
  // 折行：第三个子元素 offsetTop 不同
  row = mkRow([0, 0, 18]);
  box = mkBox(row);
  ({ setPermChip } = vm.runInNewContext(code, box));
  setPermChip("request-review", "");
  assert.equal(row.classes.wrapped, true, "折行挂 wrapped");
  // 危险态：始终继续 · 只出计划 → 始终 · 计划
  row = mkRow([0, 0]);
  box = mkBox(row);
  ({ setPermChip } = vm.runInNewContext(code, box));
  setPermChip("always-proceed", "plan");
  assert.match(box.permEl.innerHTML, /始终/, "chip 显示短标签 始终");
  assert.match(box.permEl.innerHTML, /计划/, "chip 显示短标签 计划");
  assert.doesNotMatch(box.permEl.innerHTML, /始终继续|只出计划/, "chip 不用完整文案");
});

test("W3 P1 审批条命令截断：前缀 + … + 末尾 20 字符，不再只留前 80 字符；说明文字可折两行", () => {
  const s = src("03-perm-status.js");
  has(s, /slice\(0, 60\) \+ "…" \+ [\s\S]{0,40}?slice\(-20\)/, "长命令保留末尾 20 字符");
  const css = fs.readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
  assert.match(css, /#perm-bar \.pb-txt\{[^}]*-webkit-line-clamp:2/, "审批条说明文字可折两行");
  assert.match(css, /@media \(max-width:380px\)\{\n  #hint-row #proj-chip \.pj-fold\{display:none\}/, "极窄屏藏掉项目 chip 文件夹图标");
});

test("W3 P0/P1 上游 277651c：工具事件跟底批量排队、重放先取消旧帧", () => {
  const s03 = src("03-perm-status.js");
  has(s03, /if \(live\) queueToolFollow\(\);[\s\S]*?else scrollDown\(\);/, "工具卡 live 时排队跟底");
  const s04 = src("04-session-flow.js");
  has(s04, /toolResult\(ev\.id, ev\.ok, ev\.text\); av\.toolDone\(ev\.id\); queueToolFollow\(\);/, "tool_result 走 queueToolFollow");
  has(s04, /if \(scrollRaf\) \{ cancelAnimationFrame\(scrollRaf\); scrollRaf = 0; \} \/\/ 不让旧轮次排的工具跟底挡住新一轮重放的跟底/, "重放开始取消旧跟底帧");
  const s05 = src("05-composer.js");
  has(s05, /let growFrame = 0;/, "输入框测高按帧合并");
  has(s05, /inputEl\.addEventListener\("input", \(\) => \{\n    growSoon\(\);/, "input 事件走 growSoon");
});
