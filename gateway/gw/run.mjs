import fs from "node:fs";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { CFG, LAST_LANG, PATHS, log, tr, tz } from "./config.mjs";
import { SETTINGS, capList, settingsDiskCheck } from "./settings-store.mjs";
import { PERM_MODES, PROVIDER, billAfterRun, keyOf, noteTokenDelta, providerById, providersDiskCheck } from "./providers.mjs";
import { ALIAS_SEEN, effortLevelsOf, isLoginMode, loginState, normEffort } from "./models.mjs";
import { agyBlocked, agyCmd, agyEnv, currentModelInfo, safeMode, safeModePerm, writeAgySettings } from "./agy.mjs";
import { sealStillValid } from "./agyseal.mjs";
import { setLastInit } from "./caps.mjs";
import { RUNS, SESSIONS, rememberSession, runFlag, runList } from "./runs.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { clearIncomplete, markIncomplete } from "./incomplete.mjs";
import { INTERRUPTED, QUEUE, RUN_LANE, RUN_SESSIONS, abortRun, clearInterrupted, endRun, holdLane, laneOfItem, publishState, runEmit, runTag, saveRunMark, setInterrupted, setPermMode, sidForItem } from "./queue.mjs";
import { LOCAL_CMD_RE, handleLocalCommand } from "./modelcmd.mjs";
import { usageAdd, usageIsPrompt, usageMeter } from "./usage.mjs";
import { TASKS_HINT, contextWindowOf, toolsHint, translate } from "./stream.mjs";
import { archiveHint } from "./archive.mjs";
import { autoTitle } from "./autotitle.mjs";
import { SUBAGENT_HINT, agentBook, takeAgentNote, putAgentNote } from "./agents.mjs";
import { appendSessionRecord, findSessionFile, peekSession } from "./sessions.mjs";
import { applyTaskToolCall, noteTaskTools } from "./goal.mjs";
import { projectById, projectDefaults, projectOfDir } from "./projects.mjs";
import { sessLostProvider, sessModel, sessProvider, setSessModel } from "./sessmodel.mjs";
import { noteManaged } from "./sessmanaged.mjs";
import { inlineImages, inlineImagesSync, wantsInline } from "./inlineimg.mjs";
import { pathWatch, previewHint, putPathNote, settlePathNote, takePathNote } from "./pathnote.mjs";
import { tamperNote, tamperRecord, tamperRetell } from "./tamper.mjs";
import { SPOOF_NOTE, checkSession, integrityHint, integrityNote, neutralizeMarkers, sealSession, sessionAnchor } from "./integrity.mjs";
import { ruleblockHint } from "./ruleblock.mjs";
import { recordExtra } from "./lineage-store.mjs";
import { refNote, refNoteSync } from "./merge.mjs";
import { checkAppFiles } from "./appfiles.mjs";
import { pathBlocked } from "./files.mjs";
import { holdsPrivate } from "./pathguard.mjs";
import { keepProcs, killProcs, leftoverProcs, nowTicks, procStart } from "./leftover.mjs";
import { localAddr, witnessMac } from "./access.mjs";

// 空闲中后台任务自己跑完、agy 却一直没起新一轮：这么久没动静才关 stdin 收尾（我们发过 stop_task 的 6 秒）。环境变量只给测试用
const IDLE_CLOSE_MS = Number(process.env.AGAPP_IDLE_CLOSE_MS) || 120000;

/** 这一轮在哪个目录跑：显式指定 → 接着的会话当初的 cwd（--conversation 只在同一 cwd 下找得到）→ 项目目录 → 工作区 */
const isDirSync = (d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } };
// 指定了目录（请求带的、会话记着的、项目的）却不在了（被删、改名、存储卡拔了）：返回 lost，这一轮不跑。
function cwdOf(item, sessionId) {
  if (item.cwd) return isDirSync(item.cwd) ? item.cwd : { lost: item.cwd };
  if (sessionId) { const f = findSessionFile(String(sessionId)); const c = f && peekSession(f.file).cwd; if (c) return isDirSync(c) ? c : { lost: c }; }
  if (item.projectId) { const p = projectById(item.projectId); if (p) return isDirSync(p.path) ? p.path : { lost: p.path }; }
  return fs.existsSync(CFG.workspace) ? CFG.workspace : CFG.home;
}
const cwdPath = (c) => (typeof c === "string" ? c : null);

// ── 跑一轮 ────────────────────────────────────────────────────────────
// 和 HTTP 请求完全脱钩：前端断了也接着跑，结果照样落进 transcript、照样广播。
// 这一轮用哪家：定时任务指定的 → 新会话首条带来的选择（pin）→ 这个会话钉的 → 项目默认 → 全局生效的。
// 整轮都按它（地址、密钥、模型名规则）。/api/chat 入口查 Key 也用它，两边才不会各认一家（审查 #49 P2-4）
// 特权命令「这个会话都允许」：每个会话一个随机口令，经环境变量 AGAPP_PRIV_SESS 跟着这个会话的每一轮 agy 走，
// 应用在确认框里勾了「本会话都允许」就记下它（只在内存里，应用或网关重启即失效）。无人值守（定时任务）的轮次不带，
// 用户点头时没看着的任务不该沾光
const PRIV_TOK = new Map();
function privToken(run) {
  if (run.unattended) return "";
  const tok = (run.sessionId && PRIV_TOK.get(run.sessionId)) || crypto.randomBytes(16).toString("hex");
  if (run.sessionId) PRIV_TOK.set(run.sessionId, tok);
  if (PRIV_TOK.size > 500) PRIV_TOK.delete(PRIV_TOK.keys().next().value);
  return tok;
}

/**
 * 给应用作证（Priv.java chainToken）：发起特权请求的进程往上数，碰到一个看不见的祖先 anc（网关自己，
 * 见 android/native/nodump.c），它下面那个看得见的是 top。应用读不了它们的环境，来问网关：这是不是我起的哪一轮 agy、口令是什么。
 *   anc 是网关自己：top 得是某一轮的直接子进程（agy 本身）
 *   anc 是别的：得是某一轮的 agy（直接子进程）
 * 注意：agy 是 bionic 程序，/proc 里看得见它（不像以前的 claude 那样不可转储），
 * 但口令只认网关这里登记的这一份，不认进程环境里抄来的。
 */
export function privWitness(anc, top) {
  for (const run of RUNS.values()) {
    const c = run.child;
    if (!c || !c.pid || !run.privTok || c.exitCode !== null || c.signalCode !== null) continue;
    if (anc === process.pid ? top === c.pid : anc === c.pid || (run.agyPid > 0 && anc === run.agyPid)) return run.privTok;
  }
  return "";
}

export function pickProvider(item) {
  // 跟的那条被撤销了也照样接上车道上首条跑出来的会话（#120-1），不然会另起一个会话
  const sid0 = sidForItem(item);
  const pdef0 = projectDefaults(item.projectId ? projectById(item.projectId) : projectOfDir(cwdPath(cwdOf(item, sid0))));
  const rec0 = sessModel(sid0);
  return { sid0, pdef0, P: (item.provider && providerById(item.provider))
    || (item.pin && item.pin.provider && providerById(item.pin.provider))
    || (rec0 && rec0.model != null ? sessProvider(sid0) : null)
    || (pdef0.provider && providerById(pdef0.provider))
    || sessProvider(sid0) };
}

/** 这条消息按现在的设置新起一轮会用哪家、哪个模型、哪个思考强度（startRun 里取值那段的同步副本）。
 *  空闲的后台进程要被自动复用时，队列拿它和那一轮起跑时的取值比对（#120-2）：用户刚在面板里换了接口/模型，
 *  下一条普通消息就不能再悄悄交给旧进程。清单还没拉过时档位可能算得比真跑时保守，不一致只会让它照常排队，不会错塞。 */
export function execIntent(item, ctx) {
  const { sid0, pdef0, P } = ctx || pickProvider(item);
  // 模型 / 思考强度的取值顺序：本次请求指定（定时任务）→ 新会话首条带来的选择（pin）→ 这个会话单独选过的
  // → 项目默认 → 全局默认（设置页）→ 该厂商自己的默认。选过的 "" 表示「接口默认」，也算选过
  // ⚠️ 不能回落到 CFG.model：那是全局兜底，只有内置厂商能碰。
  // 首条带来的接口和会话现在的不是同一家时，会话记下的模型名不作数
  const own0 = sessModel(sid0), pin = item.pin || {};
  const own = own0 && (own0.model == null || own0.provider === P.id) ? own0 : null;
  const ownM = pin.model != null ? pin.model : own && own.model != null ? own.model : null;
  const ownE = pin.effort != null ? pin.effort : own && own.effort != null ? own.effort : null;
  let effort = item.effort || (ownE != null ? ownE : pdef0.effort || SETTINGS.effort) || "";
  // 项目默认的模型名是给项目那家的（没指定家就是全局那家），全局默认的是给全局那家的；对不上的不作数，走这家自己的默认
  const fallM = (P.id === (pdef0.provider || PROVIDER.id) ? pdef0.model : "") || (P.id === PROVIDER.id ? SETTINGS.model : "");
  let model = (item.model || (ownM != null ? ownM : fallM) || P.defaultModel || (P.explicit ? "" : CFG.model) || "").trim();
  model = model.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 200);
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) effort = "";
  if (effort && !P.local) {
    const mi = currentModelInfo(model, P);
    if (!effortLevelsOf(mi, P).includes(effort)) effort = normEffort(mi, effort, P) || "";
  }
  return { sid0, pdef0, P, model, effort };
}

/** 起进程前要用户点头的卡片（之前对话留下的后台进程）：借用敏感操作卡，答复走同一个 /api/perm/answer。
 *  允许 → true；拒绝 → false；这期间点了停止、或超时 → null。
 *  超时：按停止收尾，记一条中断记录（why: card），界面在那个会话（没建会话的在新对话页）给「重发」 */
export const CARD = { timeout: 10 * 60e3 };
export function askCard(run, emit, { key, tool, input, guard, what, yes, no }) {
  return new Promise((resolve) => {
    const id = `agyapp-${key}-` + run.id;
    const p = { id, tool, input, suggestions: [], at: Date.now(), runId: run.id, sessionId: run.sessionId || null, guard };
    const timer = setTimeout(() => {
      if (!run.perms?.has(id)) return;
      log(`${runTag(run)} ⏹ ${what}：${Math.round(CARD.timeout / 60e3)} 分钟没人确认，这一轮停下`);
      holdLane(run); run.aborted = true;
      setInterrupted([...INTERRUPTED.filter((e) => e.id !== run.id),
        { id: run.id, sessionId: run.sessionId || null, text: String(run.text || "").slice(0, 64 << 10), ...(String(run.text || "").length > 64 << 10 ? { textCut: true } : {}),
          ...(run.req && Object.keys(run.req).length ? { req: run.req } : {}), startedAt: run.startedAt, at: Date.now(), why: "card" }]);   // 同运行标记（195-AA.5）
      emit({ type: "perm_resolved", id, behavior: "cancel" });
      done(null);
    }, CARD.timeout);
    timer.unref?.();
    const done = (v) => {
      if (!run.perms?.delete(id)) return;
      clearTimeout(timer);
      run.readyAbort = null; run.answerPerm = null;
      publishState();
      resolve(v);
    };
    run.perms = new Map([[id, p]]);
    run.readyAbort = new AbortController();
    run.readyAbort.signal.addEventListener("abort", () => { emit({ type: "perm_resolved", id, behavior: "cancel" }); done(null); });
    run.answerPerm = (pid, a) => {
      if (pid !== id || !run.perms?.has(id)) return false;
      const allow = a.behavior === "allow";
      log(`${allow ? yes : no} ${what}${a.interrupt ? "（并停止）" : ""}`);
      emit({ type: "perm_resolved", id, behavior: allow ? "allow" : "deny", interrupt: !!a.interrupt });
      if (a.interrupt) { holdLane(run); run.aborted = true; }
      done(allow);
      return true;
    };
    log(`⏸ 等确认 ${what}`);
    emit({ type: "perm_request", ...p });
    publishState();
  });
}

/** 日志里怎么称呼一条用户消息：诊断包承诺不含消息内容，提问只记字数，斜杠命令只记命令名（FIND-046）。
 *  以前记前 60 字，原生打包虽然会抹掉整行，但日志文件本身已经把正文写进去了。 */
export function promptLogLine(message, isCmd) {
  const s = String(message || "").trim();
  return isCmd ? `命令 ${s.split(/\s+/)[0].slice(0, 24)}` : `提问（${s.length} 字）`;
}

// agy 异常退出时给用户的一句话。143 / 137（SIGTERM / SIGKILL）是被别的程序结束的：系统回收内存、别的应用、终端里 kill……
// 不是模型或接口的问题，说清楚，别让人以为要换模型（11-04 用户反馈）
function exitHint(code, signal) {
  if (signal === "SIGTERM" || signal === "SIGKILL" || code === 143 || code === 137)
    return tz("Antigravity CLI 被别的程序结束了（{why}），不是模型或接口的问题", { why: signal || code });
  return signal ? tz("生成中断（{sig}）", { sig: signal }) : tz("生成失败（退出码 {code}）", { code });
}
// 保留的是最后一段 stderr，这里也取末尾：报错原因通常在最后（FIND-045）
const exitDetail = (stderr) => String(stderr || "").split("\n").join("\n").trim().slice(-1200);

/** 这一轮本该用的那家已经不在了：返回说明（不在就不跑），否则 ""。
 *  pickProvider 找不到指定的那家会一路退到全局默认——全局可能是另一家，会话内容、交给它的材料就换了一家发出去。
 *  顺序同 pickProvider：定时任务指定的 → 新会话首条带来的 → 会话钉的 → 项目默认 */
export function lostProvider(item, sid0, pdef0) {
  const gone = (id) => typeof id === "string" && id && !providerById(id);
  if (item.provider) return gone(item.provider) ? tz("指定的接口「{id}」不存在，这一轮没有发出去。", { id: item.provider }) : "";
  if (item.pin && item.pin.provider) return gone(item.pin.provider) ? tz("指定的接口「{id}」不存在，这一轮没有发出去。", { id: item.pin.provider }) : "";
  const s = sessLostProvider(sid0);
  if (s) return tz("这个会话原来用的接口「{id}」已经删掉了，这一轮没有发出去。在模型面板里换一家再发。", { id: s });
  if (sessModel(sid0)) return "";
  if (pdef0 && gone(pdef0.provider)) return tz("项目默认的接口「{id}」已经删掉了，这一轮没有发出去。到项目设置里重新选个接口。", { id: pdef0.provider });
  return "";
}

export async function startRun(item) {
  const { sid0, pdef0, P } = pickProvider(item);
  const KEY = keyOf(P);
  const run = {
    id: item.id,
    text: item.message,
    // 跟在一个还没拿到会话号的新会话后面排队的：等前一条 init 了再接上它的会话；
    // 跟的那条中途被撤销、从没启动时，按车道找回首条已经跑出来的会话（#120-1）
    sessionId: sidForItem(item),
    follow: item.follow,
    cid: item.cid,
    auto: item.auto || null,
    startedAt: Date.now(),
    child: null, aborted: false, ended: false, preSpawn: true,
    provider: P.id,                    // 这一轮用的那家：记 token、删接口前查占用都看它
    log: [], pend: null, pendTimer: null,
    sched: item.sched || null,         // 定时任务跑的：{ taskId, runKey }（结束时 sched.mjs 记运行记录）
    unattended: !!item.unattended,     // 没人看着：要确认的一律拒绝
    // 被系统结束后「重发」要按原样发：项目、钉的模型、权限模式、附加目录、汇合来源都记进运行标记（0.6.9 审计 195-AA.5）
    req: Object.fromEntries(Object.entries({ projectId: item.projectId, pin: item.pin, model: item.model, permissionMode: item.permissionMode,
      addDirs: item.addDirs && item.addDirs.length ? item.addDirs : null, mergeFrom: item.mergeFrom }).filter(([, v]) => v != null)),
  };
  // 进程起来之前（拉模型、问设备工具、读建档提示都要等）用户改权限模式：先记下来，起进程时按最新的那个启动；
  // 起来后由下面真的 setMode 接手（审查 v0.5.20 02-001：以前这段时间收紧会被开头读的旧模式盖掉，新进程照样全部放行）
  // agy 没有 set_permission_mode 控制请求：setMode 只改这一轮记下的模式，下一轮起进程时经 settings.json 生效。
  run.setMode = (mode) => { mode = safeModePerm(mode); run.permMode = mode; return true; };
  run.lane = laneOfItem(item);
  RUNS.set(run.id, run);                 // 同步占槽，中间不许有 await
  RUN_LANE.set(run.id, run.lane);
  if (RUN_LANE.size > 1000) for (const k of [...RUN_LANE.keys()].slice(0, 500)) if (!RUNS.has(k)) RUN_LANE.delete(k);
  runFlag(true);
  // 在被中断的那个会话里又跑起来了（点了「继续」或者直接接着聊）：等这一轮真答出来再撤中断提示。
  // 以前一开跑就撤，「继续」起不来、空完成时卡片已经没了，用户不知道没跑（0.6.9 审计 195-R.1）。跑着时界面本来就不显示这张卡
  run.intrPending = !!run.sessionId && INTERRUPTED.some((e) => e.sessionId === run.sessionId);
  if (run.sessionId) RUN_SESSIONS.set(run.id, run.sessionId);
  if (run.sessionId) markIncomplete(run.sessionId, run.id);   // 这一轮开跑：先记上，拿到结果再清（FIND-040）
  const emit = (ev) => runEmit(run, ev);
  emit({ type: "run_start", text: run.text, sessionId: run.sessionId, follow: run.follow, cid: run.cid, startedAt: run.startedAt, ...(run.auto ? { auto: run.auto } : {}) });
  publishState();

  const message = run.text;
  const local = message.trim().match(LOCAL_CMD_RE);
  if (local) {
    local[1] = local[1].toLowerCase();   // /MODEL 也是网关的（复核 v067b-4）
    log(`⌘ 本地命令 /${local[1]}`);   // 参数不记：诊断包说了不含消息内容（审查 v0.5.20 08-001）
    return handleLocalCommand(local[1], (local[2] || "").trim(),
      (text, cmd) => endRun(run, { localCommand: cmd || local[1], resultText: text, durationMs: 0, costUsd: 0 }), run.sessionId, () => run.aborted);
  }

  const lost = lostProvider(item, sid0, pdef0);
  if (lost) {
    log(`${runTag(run)} ⛔ 这一轮要用的接口不在了，没有启动（不退回全局默认）`);
    emit({ type: "error", message: tr(LAST_LANG, lost) });
    return endRun(run, { failed: true });
  }
  if (P.endpointLost) {
    emit({ type: "error", message: tr(LAST_LANG, tz("{name} 原来选的线路「{ep}」已经不在了。请到设置里重选线路，并重新填这条线路的密钥。", { name: P.label || P.id, ep: P.endpointLost })) });
    return endRun(run, { failed: true });
  }
  if (!KEY && !P.login) {
    emit({ type: "error", message: tr(LAST_LANG, tz("未配置 API 密钥。请在设置里填入 {name} 的密钥。", { name: P.label || P.id })) });
    return endRun(run, { failed: true });
  }
  // LG-15：走 Google 登录、且网关已经探过明确没登录时，别再起一轮 agy 等它报 authentication required，
  // 直接回一句能照着做的提示。只认“探过且没登录”（loginState() === false）：还没问过（null）不拦，
  // 免得网关刚起、用户其实登着时误拦；探登录态本身要起一次 agy ping，这里只读缓存、不新起探针。
  if (isLoginMode(P) && loginState() === false) {
    emit({ type: "error", message: tr(LAST_LANG, tz("还没登录 Google 账号，这一轮没有发出去。请先到「设置」里登录 Google 账号（或改用 Gemini API Key），再重新发送。")) });
    return endRun(run, { failed: true });
  }
  // 用户在设置里卸了 Antigravity CLI（之后自己选版本装）：说清楚，别让加载器报一句看不懂的找不到文件
  if (!fs.existsSync(PATHS.agy)) {
    emit({ type: "error", message: tr(LAST_LANG, tz("Antigravity CLI 未安装。到 设置 → 更新 里点「安装…」选一个版本装上。")) });
    return endRun(run, { failed: true });
  }
  if (run.aborted) return endRun(run, {});

  const cwd0 = cwdOf(item, run.sessionId);
  if (typeof cwd0 !== "string") {
    const msg = tz("工作目录 {dir} 不在了（被删、改名或存储卡拔出了），这一轮没有运行。把目录放回去，或者到项目设置里改路径后再发。", { dir: cwd0.lost });
    log(`${runTag(run)} ⛔ 工作目录不在了：${cwd0.lost}`);
    emit({ type: "error", message: tr(LAST_LANG, msg) });
    return endRun(run, { failed: true, finalText: msg });
  }
  const cwd = cwd0;
  run.cwd = cwd;
  const pdef = projectDefaults(item.projectId ? projectById(item.projectId) : projectOfDir(cwd));
  if (!item.permissionMode && pdef.perm) item.permissionMode = pdef.perm;
  // 模型 / 思考强度的取值顺序见 execIntent（这里的取值和队列判断能否复用空闲进程时用的是同一份）
  let { model, effort } = execIntent(item, { sid0, pdef0: pdef, P });
  // 型号清单是静态的（官方文档给过的例子 + 用户自己加的 slug），不用拉：窗口、档位都不用等
  if (effort) {
    const mi = currentModelInfo(model, P);
    if (!effortLevelsOf(mi, P).includes(effort)) effort = normEffort(mi, effort, P) || "";
  }
  // 这一轮起跑时的执行配置：后台轮次还留着进程时，队列据此判断下一条消息能不能自动塞进来（#120-2）
  run.exec = { provider: P.id, model: model || "", effort: effort || "" };
  let permMode = String(run.permMode || item.permissionMode || SETTINGS.permissionMode || "request-review").trim();
  if (!PERM_MODES.includes(permMode)) permMode = "request-review";
  // 安全模式下不问人的那档退回 request-review
  if (safeModePerm(permMode) !== permMode) { log(`安全模式：权限模式 ${permMode} → request-review`); permMode = safeModePerm(permMode); }
  run.permMode = permMode;
  run.agentMode = SETTINGS.agentMode || "";   // 这一轮起跑时的代理模式（init 回推与状态快照用，见 runInfo）

  // agy 的启动参数：长驻单进程 + stream-json 双向流。
  //   --input-format stream-json --output-format stream-json：stdin 一直开着，跑到一半还能再递消息进去（插话）。
  //   --conversation <id>：续接对话（agy 的续接旗标；-c 是“续最近一次”）。
  //   --model / --effort：模型 slug 与思考强度（agy 不认识的模型名会直接报错退出，不会静默换一个）。
  // 没有的旗标（不要补）：-p（那是单次模式，跑完即退）；--replay-user-messages（agy 不回显）；
  //   --permission-mode / --permission-prompt-tool / --allow-dangerously-skip-permissions
  //   （agy headless 下做不到逐条审批：权限走 settings.json 里的 toolPermission + permissions.allow 预先放行，
  //   没预先放行的工具会被软拒绝——见 writeAgySettings）；--settings（agy 的配置走 settings.json 文件）；
  //   --add-dir（agy 没有这个旗标：附加目录写成 permissions.allow 里的 write_file(<目录>) 规则）；
  //   --mcp-config（设备 MCP 没有 agy 的接法，先不挂）；--verbose / --include-partial-messages /
  //   --include-hook-events（agy 不认这些旗标）。
  const argv = ["--input-format", "stream-json", "--output-format", "stream-json"];
  if (model) argv.push("--model", model);
  if (effort) argv.push("--effort", effort);
  if (run.sessionId) argv.push("--conversation", String(run.sessionId));

  // 告诉 agy 这台设备上有什么现成工具 —— 不说它就不会去用。
  // agy 没有 --append-system-prompt-file：这些提示改成 system-reminder 块，跟在第一条用户消息里发过去
  // （见下面的 withNotes；记录里只留用户原话，提示不进 transcript）。
  // 子代理的联络规矩也一样（agy 自己拉起的子代理，网关没法另给它系统提示，主会话的提示里带一句）。
  const arch = await archiveHint(run.sessionId).catch(() => null);
  const styleHint = SETTINGS.outputStyle === "Explanatory" ? "Output style: explain implementation trade-offs as you work."
    : SETTINGS.outputStyle === "Learning" ? "Output style: leave TODOs for the user to implement parts themselves, and explain what to do."
    : "";
  const firstHints = [styleHint, toolsHint(), TASKS_HINT, previewHint(cwd), integrityHint(), ruleblockHint(), arch?.rule,
    SUBAGENT_HINT + "\n\n" + integrityHint() + "\n\n" + ruleblockHint()].filter(Boolean).join("\n\n");
  // 设置和这一条各自有上限，合起来再按总长截一次（10-31 复核：两边都顶满能超 ARG_MAX，这一轮 spawn 直接 E2BIG）
  const allowed = capList([...(SETTINGS.allowedTools || []), ...(Array.isArray(item.allowedTools) ? item.allowedTools : [])], 400, 512, 8192);
  const disallowed = capList([...(SETTINGS.disallowedTools || []), ...(Array.isArray(item.disallowedTools) ? item.disallowedTools : [])], 400, 512, 8192);

  const dirs = new Set();
  if (fs.existsSync(CFG.workspace) && cwd !== CFG.workspace) dirs.add(CFG.workspace);
  if (process.env.AGAPP_SHARED && fs.existsSync(process.env.AGAPP_SHARED)) dirs.add(process.env.AGAPP_SHARED);
  // 附加目录同样不许是应用私有目录、或装着它的上级（按目录身份判，别名也认得；0.6.9 审计 P0-1）
  const addOk = (d) => { try { const r = fs.realpathSync(d); return !pathBlocked(r) && !holdsPrivate(r, { workspace: false }); } catch { return false; } };
  for (const d of SETTINGS.addDirs || []) if (addOk(d)) dirs.add(d); else if (d) log(`附加目录 ${d} 不存在或在应用私有目录里，没加`);
  for (const d of item.addDirs || []) if (typeof d === "string" && addOk(d)) dirs.add(d);
  const dirLen = [...dirs].reduce((n, d) => n + d.length, 0);
  if (dirLen > 24576) log(`附加目录太多，超出的没加`);
  // 附加目录 → permissions.allow 里的 write_file(<目录>) 规则（agy 没有 --add-dir）；
  // 这一轮单独带的允许工具也一起写进去（settings.json 里的 allow 由 writeAgySettings 从设置里读，
  // 这里只补这一轮的）
  const extraAllow = [...allowed, ...[...dirs].slice(0, 64).map((d) => `write_file(${d})`)];

  const isCmd = message.trim().startsWith("/");
  log(`▶ ${promptLogLine(message, isCmd)}  ${run.sessionId ? `(续 ${String(run.sessionId).slice(0, 8)})` : "(新会话)"}  [model=${model || "默认"} effort=${effort || "默认"} style=${SETTINGS.outputStyle || "默认"} perm=${permMode}]`);
  const t0 = Date.now();

  // 接口勾了「图片随消息发」：消息里提到的图片再各带一份 image 块（太大的先缩，要等，所以放在起进程前）
  let imgs0 = [];
  if (!isCmd && wantsInline(P)) { const env = agyEnv({ model, provider: P }); imgs0 = await inlineImages(message, P, { tmpDir: env.TMPDIR, env }); }
  // 会话封签（见 integrity.mjs）：上一轮之后记录在应用外被改过、或是导入的，这一轮告诉模型别把那段历史当成自己说过的。
  const sfile = () => run.sessionId ? findSessionFile(String(run.sessionId), run.cwd)?.file : null;   // 按这一轮的目录找（F8）
  let integ = checkSession(run.sessionId, sfile());
  let integNote = isCmd ? "" : integrityNote(integ);
  // 消息里提到档号（0ab2·61）：附上那一章的压缩摘要（见 merge.mjs refNote）。读不出来就算了，不挡这一轮
  const refN = isCmd ? "" : await refNote(message, run.sessionId).catch((e) => { log("档号引用失败: " + e.message); return ""; });
  // 上面拉模型清单、问设备工具、读建档提示都要等：这期间点了停止（还没有进程可杀）就别再起了（安全通告 GHSA-g35m）
  if (run.aborted) { log("⏹ 起进程前已停止"); return endRun(run, { durationMs: 0 }); }
  // 之前的对话留下了后台进程（见 leftover.mjs）：先问。没人看着的（定时任务、空闲压缩）不跑。
  // 注意：以前这里还会问“用户级配置（~/.claude）有改动”——agy 不读 ~/.claude，网关的 settings.json
  // 由网关自己写（改了就按内存写回，见 settingsDiskCheck），所以只问留下的进程。
  const procs = leftoverProcs(new Map([...RUNS].filter(([k]) => k !== run.id).map(([k, r]) => [String(k), r.childStart ?? null])));
  if (procs.length) {
    if (run.unattended || run.auto) {
      const msg = tz("之前的对话留下了后台进程，这次没有运行。打开 agycodroid 发一条消息，在弹出的卡片里确认后再试。");
      log(`⏭ 留下的进程没确认，${run.auto ? "空闲压缩" : "无人值守的这一轮"}不跑`);
      if (!run.auto) emit({ type: "error", message: tr(LAST_LANG, msg) });
      return endRun(run, run.auto ? { durationMs: 0 } : { failed: true, finalText: msg });
    }
    const ok = await askCard(run, emit, { key: "uc", tool: "UserConfig", input: { first: false, changes: [], procs },
      guard: { cat: "userconf", what: "leftover" }, what: `留下的进程 ${procs.length} 个`, yes: "✓ 保留", no: "✗ 撤销" });
    if (ok) keepProcs(procs);
    else if (ok === false) {
      if (procs.length) killProcs(procs);
    }
    if (run.aborted) { log("⏹ 等确认时停止"); return endRun(run, { durationMs: 0 }); }
  }
  // 建档规范、bin/agy 这些被改了先写回（见 appfiles.mjs）。放在起进程紧前：上面等确认可能等很久
  checkAppFiles();
  // 设置、厂商配置网关跑着时只有网关自己写：被别人改了按内存写回，留痕（换了接口地址就能把密钥送出去）
  for (const [f, chk] of [["agyapp-settings.json", settingsDiskCheck], ["agyapp-providers.json", providersDiskCheck]]) if (chk()) tamperRecord("runtime", [f]);
  // agy 程序本身：和安装时存下的 manifest 副本 + 程序 sha512 对不上就不起（见 agyseal.mjs）
  {
    const blocked = await agyBlocked();
    if (blocked) { emit({ type: "error", message: tr(LAST_LANG, blocked) }); return endRun(run, { failed: true }); }
    if (run.aborted) { log("⏹ 核验 Antigravity CLI 时停止"); return endRun(run, { durationMs: 0 }); }
  }
  // 会话封签起进程紧前再核一次：上面等卡片、核程序可能等很久，这期间记录被改了，这一轮就该带提醒（199-S-04）。
  // 同时拍底，收尾时核这一轮只是往后追加
  if (!integ) { integ = checkSession(run.sessionId, sfile()); if (integ) integNote = isCmd ? "" : integrityNote(integ); }
  run.sealBase = run.sessionId ? { sid: run.sessionId, ...sessionAnchor(sfile()) } : null;
  if (run.sealBase) saveRunMark();     // 底要进运行标记：这一轮被系统结束时，下次启动凭它重新封签（195-A.8）
  if (run.aborted || run.ended) { log("⏹ 起进程前已停止"); return endRun(run, { durationMs: 0 }); }
  // 起进程之前写一遍网关管理的 settings.json（权限模式、预先放行的规则、模型都以这一轮为准）
  try { writeAgySettings(P, { safe: safeMode(), extraAllow, extraDeny: disallowed }); } catch (e) { log(`写 agy 设置失败: ${e.message}`); }
  const [cmd0, args0] = agyCmd(argv);
  const child = spawn(cmd0, args0, {
    cwd,
    // AGAPP_RUN_ID / AGAPP_GW_PORT：建档命令 cc-archive 靠它们告诉网关「这是哪一轮」；AGAPP_GW_PID 给 leftover.mjs 认是不是本网关起的
    env: { ...agyEnv({ model, provider: P }), AGAPP_RUN_ID: String(run.id), AGAPP_GW_PORT: String(CFG.port), AGAPP_GW_PID: String(process.pid), ...((run.privTok = privToken(run)) ? { AGAPP_PRIV_SESS: run.privTok } : {}) },
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,            // 当进程组长，中断时好整组带走（见 killTree）
  });
  run.child = child; run.preSpawn = false;
  // 首字前分段（F6）：准备（起进程前那些等待）→ 启动并连工具（到 agy 的 init）→ 等端口（到第一条 text_delta）
  run.tBoot = Date.now();
  emit({ type: "phase", phase: "boot" });
  run.agyPid = child.pid;
  // 留下的进程冒充这一轮时比启动先后（见 leftover.mjs）
  run.childStart = procStart(child.pid) ?? nowTicks();
  // 核过之后、真正执行之前程序被换掉了（来回替换卡时间窗）：这一轮停掉（DeepSeek 复核建议 2）
  if (!sealStillValid()) {
    log(`${runTag(run)} ⚠️ [Antigravity CLI 核验] 核过之后程序文件又变了，停掉这一轮`);
    tamperRecord("agy", ["agy: changed right after it was verified"]);
    emit({ type: "error", message: tr(LAST_LANG, "Antigravity CLI 程序和安装时存下的核验记录对不上，可能被改过，这一轮没有启动。到 设置 → 更新 里重新安装后再试。") });
    abortRun(run);
  }
  if (item.timeoutMs > 0) run.limitTimer = setTimeout(() => { run.timedOut = true; log(`${runTag(run)} ⏱ 超过时长上限 ${Math.round(item.timeoutMs / 60000)} 分钟，停止`); abortRun(run); }, item.timeoutMs);
  child.stdin.on("error", () => {});
  // 待答的网关卡片（askCard 的用户确认，只给网关自己的卡片用；agy 没有逐条审批，工具确认不在这里）。
  // 起进程前问过的卡片已经答完（run.perms 被 askCard 的 done() 清掉），这里只是兜底初始化。
  run.perms ??= new Map();
  const writeUser = (content, originalText) => {
    child.stdin.write(JSON.stringify({ event: "user", message: { content } }) + "\n");
    // 会话记录（网关自己写，见 sessions.mjs）：只记用户原话，system-reminder 块不进记录。
    // 新会话还没拿到 conversation_id：先攒着，init 来了再按会话号落盘。
    record({ type: "user", message: { role: "user", content: originalText }, uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd, sessionId: run.sessionId || null });
  };
  // 会话记录的落盘：有会话号直接写，没有先攒着（新会话的 init 还没来）。
  const pendingRecords = [];
  function record(rec) {
    if (run.sessionId) { try { appendSessionRecord(run.sessionId, run.cwd, rec); } catch (e) { log(`会话记录写失败: ${e.message}`); } return; }
    pendingRecords.push(rec);
  }
  const flushRecords = () => {
    if (!run.sessionId || !pendingRecords.length) return;
    const recs = pendingRecords.splice(0);
    for (const r of recs) { r.sessionId = run.sessionId; try { appendSessionRecord(run.sessionId, run.cwd, r); } catch (e) { log(`会话记录写失败: ${e.message}`); } }
  };
  // 该建档时，提醒作为本轮消息的第二段跟进去：读用户消息的地方只认第一段、或跳过 <…> 开头的段，历史 / 搜索 / 分叉比对都看不见它。
  // 子代理汇总也是这样跟着用户的消息进去（见 takeAgentNote），不单独叫醒主会话
  // 图片块（见 inlineimg.mjs）排在用户原话后面、提醒前面
  // 用户原话里冒充系统的标签（[escaped: system-reminder> 之类）先换成全角，只有网关自己加的提醒是真标签（见 integrity.mjs）
  // 取走的提醒先记着：这一轮没送到模型（没起来、出错、没答完）就放回去，下一轮再带（0.6.9 审计 200-S-10：以前取用即销毁）
  const back = { tamper: [], path: "", agent: [] };
  run.giveNotesBack = () => {
    run.giveNotesBack = null;
    if (back.tamper.length) tamperRetell(back.tamper);
    putPathNote(run.sessionId, back.path);
    if (back.agent.length) putAgentNote(run.cwd, run.sessionId, back.agent.join("\n"));
    if (back.tamper.length || back.path || back.agent.length) log("这一轮没送到模型：提醒放回去，下一轮再带");
  };
  const withNotes = (msg0, extra, imgs = []) => {
    const msg = neutralizeMarkers(msg0);
    if (msg.trim().startsWith("/")) return msg;
    const an = takeAgentNote(run.cwd, run.sessionId);
    if (an) back.agent.push(an);
    const notes = [msg !== msg0 ? SPOOF_NOTE : "", extra, an].filter(Boolean);
    return notes.length || imgs.length ? [{ type: "text", text: msg }, ...imgs, ...notes.map((n) => ({ type: "text", text: `[escaped: system-reminder>\n${n}\n[escaped: /system-reminder>` }))] : msg;
  };
  // 上一轮只写了文件名没写全路径：这一轮的消息带上提醒（见 pathnote.mjs）。命令那轮不带（带了也包不进去，提醒会白白丢掉）
  const pathNote = back.path = isCmd ? "" : takePathNote(run.sessionId);
  // 应用文件被改过、已还原（tamper.mjs）：告诉模型一次，别再去改回来
  // 这条不分会话：没人看着的（定时任务）不取，留给用户下一次自己发的那轮
  const tamperN = isCmd || run.unattended ? "" : tamperNote(back.tamper);
  // agy 没有 --append-system-prompt-file：第一条消息把网关的提示（工具说明、任务跟踪、建档规则、子代理规矩）
  // 当作 system-reminder 块一起发过去；之后的消息不再带（只带当轮的提醒）。
  const firstExtra = [firstHints, tamperN, integNote, arch?.note, pathNote, refN].filter(Boolean).join("\n\n");
  writeUser(withNotes(message, firstExtra || null, imgs0), message);
  run.inputOpen = true;
  run.pendingInject = [];      // 已写进 stdin、还没被 agy 吃进去的插话
  run.replays = 0;             // agy 回显的 user_input 步数：第一条是本轮原消息，之后每条是一条送达的插话（L7）
  const WROTE = new WeakMap();  // 普通插话 → 写进 stdin 的文字（回显按它认，复核 v067b-1）
  const textOf = (c) => (typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x && x.type === "text").map((x) => x.text).join("\n") : "").trim();
  run.usageTools = new Set();   // 使用统计：本轮见过的工具调用（流式会重复报同一个）
  let subDir = null;
  // 本轮输出了多少 token（主会话 + 子代理，按请求去重，口径同使用统计）：边跑边推给底栏，收尾也报这个数。
  // 一秒最多推一次，推的事件进本轮记录，切走再切回来补发时也接得上
  run.outTok = 0;
  let outTimer = null, outSent = 0;
  const outEmit = () => {
    outTimer = null;
    if (run.ended || run.outTok === outSent) return;
    outSent = run.outTok;
    emit({ type: "run_tokens", out: run.outTok });
  };
  run.meter = usageMeter({ sid: () => run.sessionId, model: () => run.usageModel, start: Date.now(),   // token 边跑边记（见 usage.mjs）
    add: (d, sid, model) => {
      usageAdd(d, sid, model);   // 使用统计关着时它自己不记，这里的累计照算
      noteTokenDelta(run.provider, d);   // 接口账本也按这个记：含子代理、中断的那轮、按实际发生的小时（195-O.1/O.3/O.4）
      if (d.o > 0) { run.outTok += d.o; if (!outTimer) { outTimer = setTimeout(outEmit, 1000); outTimer.unref?.(); } }
    },
    subDir: () => subDir || (subDir = sfile()?.replace(/\.jsonl$/, "/subagents") || null) });
  run.paths = pathWatch();      // 本轮写过的文件、回复里有没有写全路径（收尾时核对，见 pathnote.mjs）
  run.inject = (item) => {
    if (!run.inputOpen || run.ended || run.aborted) return false;
    // 插话里的档号也附上那一章的摘要（同步版：只查已有索引，等不起整理）
    let refI = "";
    try { refI = refNoteSync(item.message, run.sessionId); } catch (e) { log("插话档号引用失败: " + e.message); }
    const content = withNotes(item.message, refI || null, inlineImagesSync(item.message, P));
    try { writeUser(content, item.message); } catch { return false; }
    WROTE.set(item, textOf(content));
    run.pendingInject.push(item);
    saveRunMark();     // 马上落盘：送达前 App 被强停，下次启动它还能回到队列里，不会凭空消失
    log(`↪ 插话 ${promptLogLine(item.message, false)}`);
    return true;
  };
  // 子代理联络簿：落盘交代/汇报/长消息，推 ag 事件；一批全部结束时留一条只带路径的短话，跟着用户下一条消息进去
  run.agents = agentBook(run, { emit });
  // 每轮 result 之后：没有待送达的插话就关 stdin，agy 随即退出；有就留着，它会接着处理
  const closeInput = () => {
    if (!run.inputOpen || run.perms.size) return;
    run.inputOpen = false;
    try { child.stdin.end(); } catch {}
  };

  // ── 会话记录：把 agy 的 step_update 累积成 Claude-jsonl 形状的记录 ──
  // agy 不写 transcript，网关自己写（格式与 Claude 的 jsonl 兼容：sessions.mjs / transcript.mjs 照读）。
  // 正文按 step_index 累积，DONE 时落一条 assistant 记录；工具 DONE 时落 tool_use + tool_result 各一条。
  const acc = { text: "", usage: null, tools: new Map() };
  const flushText = () => {
    if (!acc.text) return;
    record({ type: "assistant", message: { role: "assistant", model: run.usageModel || model, content: [{ type: "text", text: acc.text }], ...(acc.usage ? { usage: acc.usage } : {}) },
      uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd, sessionId: run.sessionId || null });
    acc.text = ""; acc.usage = null;
  };
  const recordStep = (ev) => {
    const st = ev.step_update || {};
    const idx = Number.isInteger(st.step_index) ? st.step_index : -1;
    if (st.step_type === "agent_response") {
      if (typeof st.text_delta === "string" && st.text_delta) {
        // 子代理的正文不进主记录（带 subagent_info 的步骤）：主记录只留主会话的。
        if (!st.subagent_info?.subagents?.length) { acc.text += st.text_delta; if (st.usage) acc.usage = st.usage; }
      }
      if (st.state === "DONE") flushText();
      return;
    }
    if (st.step_type === "tool") {
      const info = st.tool_info || {};
      const id = "agy-tool-" + (flags.turn || 0) + "-" + idx;   // 轮次号 + step_index：step_index 跨轮复用时工具 id 不撞车（M2）
      // 子代理标记只在 ACTIVE 步上时也要记住：DONE 步不一定再带标记（B2），
      // 否则子代理的清单调用会被当成主会话的累积。
      const subagentStep = Array.isArray(st.subagent_info?.subagents) && st.subagent_info.subagents.length > 0;
      if (st.state !== "DONE") { acc.tools.set(id, { id, name: String(info.name || st.tool_name || ""), input: info.parameters || {}, subagent: subagentStep }); return; }
      const known = acc.tools.get(id) || { id, name: String(info.name || st.tool_name || ""), input: info.parameters || {} };
      acc.tools.delete(id);
      record({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: known.id, name: known.name, input: known.input }] },
        uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd, sessionId: run.sessionId || null });
      // 任务清单（E05 方案 A）：清单类工具调用到 DONE 才确认——ACTIVE 时的入参可能随后被改写、
      // 调用也可能失败；子代理的清单不并入主清单（它的调用仍照常记进记录，见 goal.mjs 的注）。
      // 形状对不上由 applyTaskToolCall 直接忽略；这里再包一层 try，清单逻辑绝不能带崩记录落盘。
      try { applyTaskToolCall(run.sessionId, known.name, known.input, { subagent: !!(known.subagent || subagentStep) }); } catch (e) { log(`${runTag(run)} ⚠️ 任务清单累积失败（已忽略）: ${(e && e.message) || e}`); }
      const err = info.error;
      const out = typeof info.output === "string" ? info.output : (info.output == null ? "" : JSON.stringify(info.output));
      record({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: known.id, content: err ? String((err && err.message) || err) : out, ...(err ? { is_error: true } : {}) }] },
        uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd, sessionId: run.sessionId || null });
      return;
    }
  };

  // lastResult 只证明「它那一轮」答完了：插话会在同一进程里再起一轮，
  // 那一轮还没出 result 就异常退出时，不能拿旧的 result 报成功（#96 02-002）。resultStale 记「之后又动起来了」
  let buf = "", stderr = "", lastResult = null, resultStale = false, prevTurns = 0;   // prevTurns：上一个 result 报的 num_turns，核对轮数用（L7）
  // 原始 result（带 modelUsage）：translate() 交出来的 lastResult 是归一化过的，里面没有 modelUsage，
  // 收尾时学窗口要用这一份（见 finish 里的 learnWindow 调用点）。
  let lastRawResult = null;
  // agy 的 step_update 就是逐字增量，没有单独的 assistant 事件需要去重。
  const flags = { isCmd };
  // 新会话的记录文件是网关在 init 之后才建的：等它在磁盘上真正出现再广播 session_created。
  // 前端收到就重读会话列表，不用等到 run_end —— 落盘可能比任何固定延时都晚，猜时间治不了。
  // 每个新会话只报一次；续跑的老会话文件本来就在，不报（那不是「新建」）。
  const noteSessionFile = (evType) => {
    if (run.sched) return;   // 定时任务的会话归定时任务页：saveSession=false 的收尾会进回收站，提前闪进侧栏反而点开就 404
    if (evType === "step_update") { if (run.streamChecked) return; run.streamChecked = true; }
    if (!run.newSession || run.ended || run.fileSeen || !run.sessionId) return;
    let found = null;
    try { found = findSessionFile(String(run.sessionId), run.cwd); } catch { found = null; }
    if (!found) return;
    run.fileSeen = true;
    emit({ type: "session_created", sessionId: run.sessionId, runId: run.id, cwd: run.cwd });
  };
  const onInit = (init) => {
    if (!run.tInit) { run.tInit = Date.now(); emit({ type: "phase", phase: "connect", from: "init" }); }
    setLastInit(init);
    run.newSession = !run.sessionId;
    run.sessionId = init.session_id;
    noteTaskTools(run.sessionId, init.tools);   // E05：init.tools 里有没有清单工具，决定任务面板是“暂无任务”还是“不上报”
    noteManaged(run.sessionId);              // 应用里开的会话（含 --conversation）：记一笔，列表才不会归进杂项
    markIncomplete(run.sessionId, run.id);   // 新会话：拿到会话号就记上（FIND-040）
    run.usageModel = init.model || run.usageModel;
    // 新会话的 run_start 发出时还没有会话号：回填进日志，别的视图切过来、整轮重放时才认得出这是它的
    for (const e of run.log || []) if (e.type === "run_start" && !e.sessionId) e.sessionId = run.sessionId;
    RUN_SESSIONS.set(run.id, run.sessionId);
    if (run.privTok && !PRIV_TOK.has(run.sessionId)) PRIV_TOK.set(run.sessionId, run.privTok);   // 新会话：有了会话号才挂上
    if (RUN_SESSIONS.size > 500) RUN_SESSIONS.delete(RUN_SESSIONS.keys().next().value);
    rememberSession(run.sessionId);
    if (item.pin) setSessModel(run.sessionId, item.pin, item.projectId);   // 新会话首条带来的选择：有了会话号就记上
    if (item.mergeFrom && !item.sessionId) { recordExtra(run.sessionId, item.mergeFrom); item.mergeFrom = null; }   // 汇合：当场记来源（事后推断不出来）
    saveRunMark();                       // 标记里补上会话号：被杀之后「继续」要靠它 --conversation
    flushRecords();                      // init 之前攒下的用户消息，现在按会话号落盘
    if (init.session_id && !SESSIONS.has(init.session_id)) {
      SESSIONS.set(init.session_id, { id: init.session_id, title: message.slice(0, 60), createdAt: Date.now() });
      // 网关长跑不重启时别一直涨（0.6.9 审计 200-6-05 剩下的一半，v4pro 复核）。只拿来判断「本次起过的会话」，淘汰掉的退回查文件在不在
      if (SESSIONS.size > 5000) SESSIONS.delete(SESSIONS.keys().next().value);
    }
    if (model && init.model && model !== init.model) ALIAS_SEEN[model] = init.model;
    emit({
      type: "init",
      sessionId: init.session_id,
      model: init.model,
      permissionMode: init.permissionMode,
      toolPermission: run.permMode || null,   // 前端只认 toolPermission / agentMode：以网关为准（这一轮实际在用的模式）
      agentMode: run.agentMode || null,
      outputStyle: init.output_style,
      version: init.version,
    });
    noteSessionFile("init");     // 文件要是在 init 前就有了（少见），当场补报
    publishState();
  };
  // 同一个 result 重复到达（相同的 conversation + num_turns）只结算一次（BUG-R03）：否则 usage 对账把同一份差额再加一遍、
  // 回复轮数也重复记。
  const seenResults = new Set();
  const resultKey = (r) => {
    if (typeof r?.uuid === "string" && r.uuid) return "u:" + r.uuid;
    return "";
  };
  const onResult = (r) => {
    const rk = resultKey(r);
    if (rk && seenResults.has(rk)) {
      log(`${runTag(run)} ↺ 重复到达的 result（${rk.slice(0, 80)}），不重复结算`);
      return;
    }
    if (rk) { seenResults.add(rk); if (seenResults.size > 200) seenResults.delete(seenResults.keys().next().value); }
    lastResult = r; resultStale = false;
    // 轮次号：本轮的 result 到了，下一轮的 step_index 从这个数起算（M2：工具 id 与 toolsSeen 的键是“轮次号 + step_index”）
    flags.turn = (flags.turn || 0) + 1;
    // 轮数核对（L7）：num_turns 回退说明回显/续接可能错位，只记日志——agy 的计数口径未经真机确认，不当成错误
    if (r.num_turns && prevTurns && r.num_turns < prevTurns) log(`${runTag(run)} ⚠️ result 的 num_turns 回退（${prevTurns} → ${r.num_turns}），插话回显可能错位`);
    if (r.num_turns) prevTurns = Math.max(prevTurns, r.num_turns);
    // 真实占用（agy 的 usage 是 Claude 形状：input + cache_read + cache_creation）
    flags.contextTokens = (r.usage?.input_tokens || 0) + (r.usage?.cache_read_input_tokens || 0) + (r.usage?.cache_creation_input_tokens || 0);
    // 这一轮走到了结果（答完或报错）：不再是「没跑完」（FIND-040）
    clearIncomplete(run.sessionId);
    if (run.intrPending && !r.is_error) { run.intrPending = false; clearInterrupted(run.sessionId); }
    run.meter.result(r, !isCmd);   // 斜杠命令不算一轮对话（本地命令不走这里）
    // 定时任务的单次花费上限：agy 不报花费，这条检查永远不触发（留着，万一以后 agy 开始报花费）。
    if (item.limitCost > 0 && (run.costSeen || 0) > item.limitCost && !run.overBudget) {
      run.overBudget = true;
      if (run.pendingInject.length) {
        log(`${runTag(run)} 💸 花费 $${run.costSeen.toFixed(4)} 超过单次上限 $${item.limitCost}，停止`);
        abortRun(run);
        return;
      }
    }
    if (run.pendingInject.length) { resultStale = true; return; }   // 插话还没送到：agy 接着还要答一轮
    run.idle = true;      // 这一轮答完了（M1）：进程可能还留着等后台任务，状态快照与“只剩后台任务”的分支靠它
    return closeInput();
  };
  const onReplay = () => {
    // user_input 步 = agy 已接住一条用户消息。第一条是本轮的原始消息；之后每条都是一条送达的插话（按写入顺序）。
    // agy 的 user_input 步不带正文，所以按顺序认，不按内容匹配。
    if (run.replays === 0) {
      if (message && usageIsPrompt(message)) usageAdd({ m: 1 }, run.sessionId);
      run.replays++;
      return;
    }
    const it = run.pendingInject[0];
    if (it && usageIsPrompt(it.message)) usageAdd({ m: 1 }, run.sessionId);
    run.replays++;
    // 排着的插话已经空了，agy 又回显一条 user_input：恢复续接时重放了历史，或某条插话被拒收却仍回显。
    // user_input 步不带正文，按顺序认领在这里就会错位（L7）：只记日志，别把没送达的记成已送达。
    if (!run.pendingInject.length) log(`${runTag(run)} ⚠️ agy 回显了一条 user_input，但没有排着的插话（可能是恢复续接时重放历史），插话送达确认可能错位`);
    const shifted = run.pendingInject.shift();
    if (shifted) { emit({ type: "inject", text: shifted.message, cid: shifted.cid, itemId: shifted.id }); saveRunMark(); }
  };
  const feed = (line) => {
    let ev; try { ev = JSON.parse(line); } catch { return; }
    // 后台任务回报又起一轮：这一轮不再空闲（M1：idle 只表示“刚答完、等后台任务”）
    if (run.idle && ev.event === "step_update") run.idle = false;
    // 上一条事件之后文件可能已经建好：先核一次
    noteSessionFile(ev.event);
    if (!run.tFirst && run.tInit && ev.event === "step_update" && ev.step_update?.step_type === "agent_response" && typeof ev.step_update.text_delta === "string" && ev.step_update.text_delta) {
      run.tFirst = Date.now();
      const s = (ms) => (ms / 1000).toFixed(1) + "s";
      log(`⏱ 首个回应前：准备 ${s(run.tBoot - run.startedAt)} · 启动并连工具 ${s(run.tInit - run.tBoot)} · 等端口 ${s(run.tFirst - run.tInit)}`);
    }
    run.meter.feed(ev);
    run.agents.feed(ev);
    // 会话记录：先落盘，再翻译（翻译可能触发收尾，收尾时记录必须已经在了）
    if (ev.event === "step_update") recordStep(ev);
    if (ev.event === "result") { flushText(); lastRawResult = ev.result || null; record({ type: "result", usage: ev.result?.usage || null, num_turns: ev.result?.num_turns || 0, status: ev.result?.status || "", response: typeof ev.result?.response === "string" ? ev.result.response : "", uuid: crypto.randomUUID(), timestamp: new Date().toISOString(), cwd, sessionId: run.sessionId || null }); }
    translate(ev, { sse: emit, flags, onInit, onResult, onReplay, provider: P });
    // init 之后的每个事件都核一次：网关在 init 后就把记录建好了，
    // 这里一旦看到文件就广播；没看到就等下一个事件，不在前端猜延时
    noteSessionFile(ev.event);
  };

  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");   // 按流解码：多字节字符跨块不会被拆坏
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      // 单条事件处理出错只丢这一条：以前这里没有 try，一个形状不对的事件就带走整个网关（0.6.9 审计 P1-6）
      if (line) { try { feed(line); } catch (e) { log(`${runTag(run)} ⚠️ 处理 agy 事件出错（已跳过这条）: ${(e && e.stack) || e}`); } }
    }
  });

  child.stderr.on("data", (d) => {
    const s = d.toString("utf8");
    stderr = (stderr + s).slice(-20000);      // 留最后一段：出错原因通常在末尾，以前只留开头，尾巴全丢（FIND-045）
    // agy 把拿不到审批的工具软拒绝时，会往 stderr 打印提示（说清是哪个工具、怎么放行）：那不是错误，别当报错记
    if (/soft-denied|soft denied/i.test(s)) log(`${runTag(run)} [agy 软拒绝] ${s.trim().slice(0, 300)}`);
    else if (/error|Error|failed|ENOENT|EACCES/.test(s)) log(`${runTag(run)} [agy!] ${s.trim().slice(0, 300)}`);
  });

  // 收尾时把没送达的插话退回队列。抽成函数，强制收尾路径（queue.abortRun）也要用，
  // 否则 5 秒兜底直接 endRun 会把已经写进 stdin 的消息静默丢掉（审查 11-05）
  const requeuePending = () => {
    if (run.pendingInject.length) {
      log(`插话 ${run.pendingInject.length} 条没来得及送达，退回队首`);
      QUEUE.unshift(...run.pendingInject.map((it) => ({ ...it, injected: false, held: !!((run.aborted && !run.retired) || run.laneHeld) })));
      run.pendingInject = [];
    }
  };
  run.requeuePending = requeuePending;

  const finish = (code, signal) => {
    // 尾部残行：stdout 回调只按 \n 切行，进程退出瞬间最后一段没换行的内容留在这里。
    // 解析失败不能静默丢掉——那可能正是 result 事件（L9）：记一笔（含前 200 字），下面按“未收到结果”处理。
    let tailFailed = false, tailPreview = "";
    if (buf.trim()) {
      const tail = buf.trim();
      try { JSON.parse(tail); } catch { tailFailed = true; tailPreview = tail.slice(0, 200); }
      feed(tail);
    }
    buf = "";
    if (tailFailed) log(`${runTag(run)} ⚠️ 尾部残行解析失败，已丢弃（前 200 字）: ${tailPreview}`);
    // 收尾时再学一次窗口（非流式/回放路径的兜底）：translate() 流式路径的 learnWindow 是
    // fire-and-forget，进程退出瞬间可能还没跑完；这里用原始 result（带 modelUsage，
    // translate 交出来的 lastResult 里没有）再调一次。learnWindow 幂等：已学过的窗口跳过，
    // 读不到/校验不过返回 false 不抛错；学不到就什么都不做。
    if (lastRawResult) import("./models.mjs").then((m) => m.learnWindow(lastRawResult, P)).catch(() => {});
    const hadPartialText = !!acc.text;   // M5：有没有攒下半截正文（下面无 result 时提示“发一句『继续』”）
    flushText();                       // 进程死在半截时，累积的正文也要落进记录
    // agy 没发 init（或 init 里没给会话号）：攒下的记录没处落盘。按“未建会话的孤儿消息”另存一份，
    // 别静默丢掉首条消息（B9-H2）；同时明确告诉用户这一轮没建起会话。
    if (pendingRecords.length && !run.sessionId) {
      const recs = pendingRecords.splice(0);
      try {
        const dir = path.join(CFG.home, "agyapp-orphans");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `orphan-${Date.now()}.jsonl`);
        fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join("\n") + "\n");
        log(`${runTag(run)} ⚠️ agy 没给会话号，${recs.length} 条消息没能进会话记录，已另存到 ${file}`);
      } catch (e) { log(`${runTag(run)} ⚠️ 孤儿消息另存失败: ${e.message}`); }
      // detail 也带上 stderr 尾部：这条报错往往是本轮的第一个 error 事件（后面收尾还会再报一次退出原因），
      // 不带 detail，前端只看到“没建起会话”却看不到 agy 临死前说了什么（FIND-045：stderr 留最后一段）。
      emit({ type: "error", message: tr(LAST_LANG, tz("Antigravity 没有返回会话号，这一轮的消息没能存进会话记录。请新开一轮重发。")), detail: exitDetail(stderr) });
    }
    noteSessionFile("finish");           // 记录只在退出前才落盘的情况：收尾前再核一次
    run.meter.close();                   // 中断 / 被杀也走这里：子代理已随流实时记入，收尾无补扫（见 usageMeter.close）
    try { run.agents?.close(); } catch (e) { log(`${runTag(run)} 子代理收尾出错: ${e.message}`); }
    // agy 已经退出，这时的记录就是下一轮的基准；提醒这一轮已经交出去（正常答完）才清掉标记
    if (!lastResult || lastResult.is_error) run.giveNotesBack?.();
    try { sealSession(run.sessionId, sfile(), { clear: !!integNote && !run.aborted && !!lastResult && !lastResult.is_error, base: run.sealBase?.sid === run.sessionId && run.sealBase.hash ? run.sealBase : null }); } catch (e) { log(`${runTag(run)} [封签] ${e.message}`); }
    run.inputOpen = false;
    run.perms.clear();                // 卡片随 run_end 一起作废（前端按 run_end 收起）
    requeuePending();
    const ms = Date.now() - t0;
    // 定时任务已经花掉的（崩了、没出 result 也一样）：按 0 记会让它当作没花钱再重试（DeepSeek 复核 #1）
    const spent = () => (run.sched && run.costSeen ? { costRaw: run.costSeen } : {});
    if (run.aborted) {
      log(`${runTag(run)} ⏹ 已中断 (${ms}ms)`);
      return endRun(run, { durationMs: ms, ...(run.retired ? { retired: true } : {}), ...(run.outTok ? { usage: { output_tokens: run.outTok } } : {}), ...(run.sched && run.costSeen ? { costRaw: run.costSeen } : {}) });
    }
    // 最后一个 result 之后又起了一轮、没等到它的 result 就退出了：按失败算，别沿用上一轮的成功。
    // 不能只在非零退出 / 有信号时才算（BUG-R02）：CLI 正常退 0、新一轮却没答完，同样是没答完。
    if (lastResult && resultStale) {
      const hint = code !== 0 || signal ? exitHint(code, signal) : tz("上一轮已答完，接着的这一轮没有等到结果（已中断）");
      log(`${runTag(run)} ✖ ${hint}（上一轮已答完，接着的这一轮没答完）${stderr ? " :: " + stderr.trim().slice(-300) : ""}`);
      billAfterRun(run.provider);
      emit({ type: "error", message: tr(LAST_LANG, hint), detail: exitDetail(stderr) });
      return endRun(run, { failed: true, durationMs: ms, ...spent() });
    }
    if (lastResult) {
      log(`✔ 完成 ${ms}ms  ${lastResult.num_turns || "?"} 轮  ` +
          `上下文=${flags.contextTokens ?? "?"} out=${lastResult.usage?.output_tokens ?? "?"}  ` +
          `$${Number(lastResult.total_cost_usd || 0).toFixed(5)}`);
      billAfterRun(run.provider);
      if (!isCmd && !lastResult.is_error) settlePathNote(run.sessionId, run.paths);
      // 新会话第一轮答完就在后台起个标题，不等第二条消息（#60，见 autotitle.mjs）；定时任务的会话不起
      if (!isCmd && !lastResult.is_error) autoTitle(run.sessionId, P, model);
      return endRun(run, {
        durationMs: ms,
        // agy 不报花费
        costUsd: 0,
        usage: lastResult.usage
          ? {
              // 算上子代理（result.usage 只有主会话）；流里一条都没记到时退回 result 的数
              output_tokens: run.outTok || lastResult.usage.output_tokens || 0,
              context_tokens: flags.contextTokens || 0,   // 真实占用（累计和不算）
              context_window: contextWindowOf(lastResult, P, model || undefined),
            }
          : null,
        subtype: lastResult.subtype,
        isError: !!lastResult.is_error,
        ...(run.sched ? { finalText: String(lastResult.result || "").slice(0, 4000), costRaw: 0 } : {}),
      });
    }
    const hint = code !== 0 || signal ? exitHint(code, signal) : tz("生成结束但没有返回结果");
    log(`${runTag(run)} ✖ ${hint}${stderr ? " :: " + stderr.trim().slice(-300) : ""}`);
    emit({ type: "error", message: tr(LAST_LANG, hint), detail: exitDetail(stderr) });
    // 无 result 时这里直接提示。已有部分正文但没等到收尾，回答可能不完整；
    // 有会话号才能“继续”（没会话号时上面孤儿分支已经报错，让用户新开一轮）。
    if (hadPartialText && run.sessionId) emit({ type: "note", key: "run-incomplete", text: tr(LAST_LANG, tz("只收到了一部分回答，可能不完整：发一句「继续」让它接着说")) });
    endRun(run, { failed: true, durationMs: ms, ...spent() });
  };

  child.on("error", (e) => {
    log(`${runTag(run)} spawn 出错: ${e.message}`);
    run.giveNotesBack?.();
    emit({ type: "error", message: tr(LAST_LANG, tz("无法启动 agy：{err}", { err: e.message })) });
    endRun(run, { failed: true });
  });
  // 收尾出错也要把这一轮结束掉，不然车道永远占着（0.6.9 审计 P1-6）
  let closed = false;
  const finishSafe = (code, signal) => {
    if (closed) return;
    closed = true;
    try { finish(code, signal); }
    catch (e) { log(`${runTag(run)} ⚠️ 收尾出错: ${(e && e.stack) || e}`); try { endRun(run, { failed: true }); } catch {} }
  };
  // 管道关不掉的兜底（queue.abortRun 5+2 秒后调）：走和正常退出同一条 finish —— 封签、账本、权限卡、未送达消息都要收，
  // 以前直接 endRun 把这些全跳过了（FIND-002）。进程树由调用方负责杀，这里只把管道拆掉
  run.forceFinish = () => {
    log(`${runTag(run)} ⏹ 强制收尾：按正常收尾处理`);
    for (const s of [child.stdin, child.stdout, child.stderr]) try { s?.destroy(); } catch {}
    finishSafe(null, "SIGKILL");
  };
  child.on("close", finishSafe);
  // agy 已经退出、但另开进程组的子孙还攥着它的 stdout / stderr 时，close 永远不来：退出 5 秒后还没 close 就自己收尾（0.6.9 审计 195-T.1，同 terminal.mjs）
  child.on("exit", (code, signal) => {
    const t = setTimeout(() => {
      if (closed) return;
      log(`${runTag(run)} agy 已退出，输出管道还被别的进程占着，强制收尾`);
      try { child.stdout.destroy(); child.stderr.destroy(); } catch {}
      finishSafe(code, signal);
    }, 5000);
    t.unref?.();
  });
}

// ── 路由：/api/perm/answer /api/perm/mode /api/task/stop /api/abort ──
// 注意：/api/perm/answer 只回答网关自己的卡片（askCard：留下的后台进程确认）。
// agy 没有逐条审批，工具确认不在这里走。
export async function routeRun(req, res, u, p) {
  // ── 给应用作证：特权请求来自哪一轮 agy（见 privWitness）。应答带签名，应用按启动随机数派生的钥匙核 ──
  if (req.method === "GET" && p === "/api/priv/witness") {
    const n = String(u.searchParams.get("n") || ""), anc = +u.searchParams.get("anc"), top = +u.searchParams.get("top");
    if (!/^[0-9a-f]{32}$/.test(n) || !(anc > 1) || !(top > 1)) return sendJson(res, 400, { error: "bad request" });
    const tok = privWitness(anc, top);
    return sendJson(res, 200, { tok, mac: witnessMac(n, anc, top, tok, localAddr(req)) });
  }
  // ── 网关卡片确认：回答 askCard 的确认 ──
  if (req.method === "POST" && p === "/api/perm/answer") {
    const b = JSON.parse((await readBody(req)) || "{}");
    // 不带 runId（通知里的「拒绝」）就按请求号找它属于哪一轮
    const run = b.runId ? RUNS.get(String(b.runId)) || null : runList().find((r) => r.perms && r.perms.has(String(b.id || ""))) || null;
    if (!run || !run.answerPerm) return sendJson(res, 409, { error: "gone", message: tz("这一轮已经结束了") });
    if (!run.answerPerm(String(b.id || ""), {
      behavior: b.behavior === "allow" ? "allow" : "deny",
      message: b.message, interrupt: !!b.interrupt, always: !!b.always,
      answers: b.answers, mode: b.mode ? String(b.mode) : null,
    })) return sendJson(res, 409, { error: "gone", message: tz("这项已经回答过了") });
    return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/perm/mode") {
    const b = JSON.parse((await readBody(req)) || "{}");
    const r = setPermMode(String(b.mode || ""));
    if (!r) return sendJson(res, 400, { error: "bad mode" });
    // mode 是实际生效的（安全模式下可能被退回 request-review），wanted 是用户选的；saved=false 时这次切换重启后会丢（195-A.6）
    return sendJson(res, 200, { ok: true, mode: r.mode, wanted: SETTINGS.permissionMode, saved: r.saved, live: RUNS.size > 0 });
  }
  if (req.method === "POST" && p === "/api/task/stop") {
    const b = JSON.parse((await readBody(req)) || "{}");
    // agy 没有单独停止一个后台任务的控制请求：只能中断整轮。
    return sendJson(res, 409, { error: "unsupported", message: tz("Antigravity 不支持单独停止后台任务；要停请中断整轮。") });
  }
  if (req.method === "POST" && p === "/api/abort") {
    const b = JSON.parse((await readBody(req)) || "{}");
    if (b.clearQueue) QUEUE.length = 0;
    // 带 id 只停那一轮；不带 id（旧前端）停掉全部
    const stop = (run) => abortRun(run, { userStopped: true });
    const killed = b.id ? stop(RUNS.get(String(b.id))) : runList().map(stop).some(Boolean);
    if (b.clearQueue) publishState();
    return sendJson(res, 200, { ok: true, killed });
  }
  return NEXT;
}
