import { log } from "./config.mjs";
import { SETTINGS, saveSettings } from "./settings-store.mjs";
import { PROVIDER, providerById } from "./providers.mjs";
import { effortLevelsOf, fetchModels, normEffort } from "./models.mjs";
import { effectiveModel, setSessModel } from "./sessmodel.mjs";

// ── /model 与 /effort：由网关本地处理 ─────────────────────────────────
// 为什么不让 agy 自己处理：它没有 /model 这类网关命令，
// 而 GUI 每次调用都是新进程 —— 下一条消息就忘了。所以由网关记：
// 0.3.16 起：在会话里打 → 只改这个会话（sid）；新会话里打（还没会话号）→ 改全局默认。
// agy 不认识的模型名会在 headless 下直接报错退出，不会静默换一个，
// 所以网关不按清单校验：清单里没有的名字也照收，错了由 agy 自己报错。
// /autocompact 没有了：agy 没有 /compact、也不报窗口，压缩线无从谈起。
/** 网关自己处理的命令：不交给 agy，也就不能插进正在跑的进程（queue.mjs 的 tryInject） */
export const LOCAL_CMD_RE = /^\/(model|models|effort)(?:\s+([\s\S]*))?$/i;
export async function handleLocalCommand(name, arg, reply, sid, stopped = () => false) {
  // 清单、档位、校验都按这个会话真跑的那家：钉的 → 项目默认 → 全局（和 run.mjs、/api/models 同一套，#78）
  const now = effectiveModel(sid);
  const P = providerById(now.provider) || PROVIDER;
  const models = await fetchModels(false, P, { guess: true });   // 静态清单：直接回，不用等网络
  // 等清单期间用户点了停止：这条命令就算撤回了，迟到的清单不能再改型号或强度（#142-1）
  if (stopped()) return reply("已停止，没有改动。", name === "models" ? "model" : name);
  const curId = now.model, curEff = now.effort;
  // 只认同名的：指定的型号不在清单里就当不知道窗口，别借默认或第一项的（#82）；没指定才按那家默认 / 第一项
  const want = curId || P.defaultModel;
  const cur = want ? models.find((m) => m.id === want) : models[0];
  const commit = (patch) => {
    // 等清单期间这个会话真跑的那家可能被改了（比如项目默认接口 A→B，审查 #122-2）：这里选中的型号是按旧那家的
    // 清单校验的，不能再写到新那家名下。同一家里型号、思考强度被别处（会话面板、设置页）改了也一样：
    // 那是更晚的选择，旧命令不能盖掉它。三样有一样变了就作废这次命令，让用户按现在的设置重来。
    const n = effectiveModel(sid), nowP = providerById(n.provider) || PROVIDER;
    if (nowP.id !== P.id || n.model !== now.model || n.effort !== now.effort) return false;
    if (sid) { setSessModel(sid, patch); return true; }
    if (patch.model !== undefined) SETTINGS.model = patch.model || null;
    if (patch.effort !== undefined) SETTINGS.effort = patch.effort || null;
    saveSettings();
    return true;
  };
  const staleReply = (tag) => reply("没改成：等型号清单的时候，这个会话的接口、型号或思考强度在别处被改过了。请按现在的设置重新执行一遍。", tag);
  const scope = sid ? "（只改这个会话）" : "（改的是全局默认）";

  // ── /model ──
  if (name === "model" || name === "models") {
    if (!arg) {
      const lines = models.map((m) => {
        const on = m.id === curId ? "**▸** " : "　　";
        const eff = (Array.isArray(m.effort?.supported_levels) ? m.effort.supported_levels : []).join(" / ");
        return `${on}\`${m.id}\` — ${m.name || ""}\n　　effort ${eff}`;
      }).join("\n\n");
      return reply(
        `当前接口：**${P.label || P.id}**\n` +
        `当前模型：**${curId || "(由 agy 决定)"}**　（effort **${curEff || "默认"}**）\n\n` +
        `可用模型：\n\n${lines}\n\n` +
        `用法：\`/model <id>\`　切换思考强度：\`/effort\`\n\n` +
        `> agy 没有公开的模型列表：上面只有官方文档给过的例子和你在接口卡里加的 slug。\n` +
        `> 填清单外的名字也可以——agy 不认识会在下一轮直接报错退出，不会静默换一个。`,
        "model"
      );
    }
    const t = arg.trim();
    const target = models.find((m) => m.id.toLowerCase() === t.toLowerCase())
      || models.find((m) => (m.name || "").toLowerCase() === t.toLowerCase())
      || models.find((m) => m.id.toLowerCase().includes(t.toLowerCase()));
    // 清单里没有也照收：agy 会在下一轮校验，不认识就报错退出（不静默回落）
    const id = target ? target.id : t;
    const known = !!target;
    const eff = normEffort(target, curEff, P);
    const effChanged = eff !== curEff;
    if (!commit({ model: id, effort: eff || "" })) return staleReply("model");
    return reply(
      `已切换到 **${id}**${target && target.name && target.name !== target.id ? "（" + target.name + "）" : ""}\n\n` +
      (known
        ? `- effort 档位：${(target.effort?.supported_levels || []).join(" / ")}\n`
        : `- 清单里没有这个名字：下一轮 agy 会自己校验，不认识就直接报错退出，不会静默换一个。\n`) +
      (effChanged ? `- **注意**：原 effort 该模型不支持，已调为 \`${eff}\`\n` : "") +
      `\n下一条消息生效${scope}。`,
      "model"
    );
  }

  // ── /effort ──
  if (name === "effort") {
    const levels = effortLevelsOf(cur, P);
    const dflt = cur && cur.effort && cur.effort.default_level;
    if (!arg) {
      const lines = levels.map((l) =>
        `${l === curEff ? "**▸** " : "　　"}\`${l}\`` + (l === dflt ? "　（模型默认）" : "")).join("\n");
      return reply(
        `当前模型 **${curId || "默认"}** 的思考强度：**${curEff || "(未设置)"}**\n\n${lines}\n\n` +
        `用法：\`/effort <level>\`\n\n` +
        `> 档位越高思考越久、通常质量越好。官方没有公布哪个模型支持哪几档，不支持的组合由 agy 在下一轮报错。`,
        "effort"
      );
    }
    const t = arg.toLowerCase().trim();
    if (levels.includes(t)) {
      if (!commit({ effort: t })) return staleReply("effort");
      return reply(`思考强度已设为 **${t}**（模型 ${curId || "默认"}）。\n\n下一条消息生效${scope}。`, "effort");
    }
    return reply(`\`${arg}\` 不是有效档位。支持：${levels.map((l) => "`" + l + "`").join("、")}`, "effort");
  }

  return reply(`未知命令 /${name}`, name);
}
