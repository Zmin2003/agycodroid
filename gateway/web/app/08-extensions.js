  // ── 扩展：插件 / 技能 / MCP ──────────────────────────────────────────
  const ext = { q: "", offset: 0, busy: false };
  // 设计稿的行：左名称 + 一行等宽小字，右边大小 / 状态 / 按钮；说明、依赖这些点一下行才展开（.it-more），进度条一直在
  const EI = {
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7"/>',
    cube: '<path d="M12 2l9 5v10l-9 5-9-5V7z"/><path d="M3 7l9 5 9-5M12 12v10"/>',
    book: '<path d="M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3"/><path d="M20 4v14h-7"/>',
    gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 18l4-6"/>',
    bolt: '<path d="M13 2 4.5 13.5H11l-1 8.5L18.5 10H12z"/>',
    spark: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
    tool: '<path d="M4 20l7-7M14 4l6 6-3 3-6-6zM10 8l6 6"/>',
    play: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    plug: '<path d="M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4"/>',
    puzzle: '<path d="M10 3h4v3a2 2 0 1 0 4 0V3h3v7h-3a2 2 0 1 0 0 4h3v7h-7v-3a2 2 0 1 0-4 0v3H3v-7h3a2 2 0 1 0 0-4H3V3z"/>',
  };
  const ei = (n) => `<svg class="ei" viewBox="0 0 24 24">${EI[n]}</svg>`;
  const sdot = (st, label) => `<span class="sdot ${st}"><i></i>${esc(label)}</span>`;
  const rowItem = (title, sub, right, o = {}) => `<div class="item xrow${o.cls ? " " + o.cls : ""}"${o.tags ? ` data-tags="${esc(o.tags.join(" "))}"` : ""}>
      <div class="xr-l"><div class="it-title">${title}</div>${sub ? `<div class="xr-sub">${sub}</div>` : ""}</div>
      <div class="xr-r">${right || ""}</div>${o.extra || ""}${o.more ? `<div class="it-more">${o.more}</div>` : ""}</div>`;
  // 点行（不是点按钮、链接、输入框）展开 / 收起说明
  $("tab-ext").addEventListener("click", (e) => {
    // 只排除行「里面」的按钮、链接、折叠块：整个分区本身就是 <details>，以前一律被它挡掉，组件和模块的说明永远点不开（审查 F-001）
    const r = e.target.closest(".xrow, .ccard"); if (!r || !r.querySelector(".it-more")) return;
    const i = e.target.closest("button, a, input, select, textarea, label, summary, details, .gh-auth");
    if (i && r.contains(i)) return;
    r.classList.toggle("open");
  });
  const extItem = (title, meta, acts, desc, tags) => `<div class="item"${tags ? ` data-tags="${esc(tags.join(" "))}"` : ""}>
      <div class="it-title">${title}</div>
      ${meta ? `<div class="it-meta">${meta}</div>` : ""}
      ${desc || ""}
      ${acts ? `<div class="it-acts">${acts}</div>` : ""}</div>`;

  // ── 工具包模块（0.3.9 起）：基础 + 随装随卸的模块；用途、命令、包、大小、依赖、谁在用都摆出来 ──
  let modTimer = 0;
  // 模块装完 / 卸完后组件卡要跟着刷新：组件装的正是刚补上的模块，不刷新的话安装按钮一直是灰的（0.6.10 审计 195-I.4）
  let modTouched = false;
  const MOD_USES = () => ({
    agy: t("Antigravity CLI 本身"), git: t("git 面板"), terminal: t("终端"), shizuku: t("Shizuku 一键启动（无线调试）"), search: t("Antigravity 搜代码、看差异"),
    "native-build": t("编译原生程序"), apk: t("打 APK"), "usb-adb": t("USB 调试"), "gpu-components": t("GPU 组件（Blender、浏览器等）"),
    media: t("音视频处理"), docs: t("排版、表格分析、图片处理"),
  });
  // 停用名单（F5）：组件、模块停用 = 不再告诉 Antigravity，命令文件还在
  const extOffNow = () => api("/api/ext/off").catch(() => ({ comp: [], mod: [] }));
  const OFF_TIP = () => t("停用后 Antigravity 看不到它，命令文件还在，随时可以启用。");
  async function loadModules() {
    clearTimeout(modTimer);
    const visit = pageVisit, live = () => pageVisible("ext", visit);
    if (!live()) return;
    const [r, xoff] = await Promise.all([sameGet("/api/devkit/modules").catch(() => null), extOffNow()]);
    if (!live()) return;
    const modOff = new Set(xoff.mod || []);
    const on = !!(r && r.supported && r.modular);
    $("mod-field").classList.toggle("hidden", !on);
    if (!on) return;
    const items = r.items || [], byId = Object.fromEntries(items.map((m) => [m.id, m]));
    const nameOf = (id) => esc(pickLang((byId[id] || {}).name) || id);
    const inst = items.filter((m) => m.state === "ok");
    $("mod-count").textContent = inst.length + "/" + items.length;
    ext.nMod = items.length; extSub();
    ext.modBytes = inst.reduce((s, m) => s + m.installed, 0); ext.free = r.free; paintStorage();
    const btn = (c, id, label, extra = "") => `<button data-c="${c}" data-id="${esc(id)}"${extra}>${label}</button>`;
    let moving = false;
    $("mod-list").innerHTML = items.map((m) => {
      const pr = m.progress;
      moving ||= !!pr;
      const st = { absent: t("未安装"), downloading: t("下载中"), verifying: t("校验中"), installing: t("正在装进工具包…"), ok: t("已安装"), error: t("安装失败") }[m.state] || m.state;
      const kind = m.required ? t("必装") : m.kind === "shared" ? t("共享运行库") : "";
      const meta = "<span>" + esc(st) + "</span>" + (kind ? "<span>" + kind + "</span>" : "") +
        "<span>" + (m.state === "ok" ? t("占用 {b}", { b: MB(m.installed) }) : t("下载约 {a}，装好后约 {b}", { a: MB(m.download), b: MB(m.installed) })) + "</span>";
      let desc = '<div class="tiny ext-desc">' + esc(pickLang(m.desc)) + "</div>";
      const uses = (m.uses || []).map((u) => MOD_USES()[u] || u);
      if (uses.length) desc += '<div class="tiny">' + t("App 里用到它的：{list}", { list: esc(listOf(uses)) }) + "</div>";
      const deps = (m.deps || []).filter((d) => byId[d] && !byId[d].required);
      if (deps.length) desc += '<div class="tiny">' + t("依赖：{list}", { list: listOf(deps.map(nameOf)) }) + "</div>";
      if (m.kind === "shared" && (m.users || []).length) desc += '<div class="tiny">' + t("给这些模块用：{list}", { list: listOf(m.users.map(nameOf)) }) + "</div>";
      const ub = m.usedBy || {};   // 缺 usedBy 时不能让整个模块列表渲染失败、轮询也停（196 前端注入域）
      const used = [...(ub.modules || []).map(nameOf), ...(ub.components || []).map((c) => esc(c)), ...(ub.pkgs || []).map((n) => "pkg " + esc(n))];
      if (used.length) desc += '<div class="tiny">' + t("正在用它的：{list}", { list: listOf(used) }) + "</div>";
      if (m.error) desc += '<div class="tiny err">' + esc(m.error) + "</div>";
      // 命令与包：点开看全部
      const cmds = m.commands || [];
      if ((m.key || []).length) desc += '<div class="tiny">' + t("主要命令：") + " " + m.key.map((x) => "<code>" + esc(x) + "</code>").join(" ") + "</div>";
      desc += '<details class="tiny"><summary>' + t("{n} 个命令、{p} 个包", { n: cmds.length, p: (m.packages || []).length }) + "</summary>" +
        (cmds.length ? "<div>" + cmds.map((c) => "<code>" + esc(c) + "</code>").join(" ") + "</div>" : "") +
        '<div class="mono" style="margin-top:4px;color:var(--fg3)">' + (m.packages || []).map(esc).join("<br>") + "</div>" +
        '<div style="margin-top:4px;color:var(--fg3)">' + t("来源：Termux 官方仓库 · 快照 {s}", { s: esc(r.snapshot || "") }) + (m.sha256 ? "<br>sha256 " + esc(m.sha256) : "") + "</div></details>";
      let bar = "";
      if (pr && pr.total) {
        const pct = Math.min(100, (pr.done / pr.total) * 100).toFixed(1);
        bar = '<div class="comp-bar"><i style="width:' + pct + '%"></i></div><div class="tiny">' + (pr.current && pr.current !== m.id ? nameOf(pr.current) + " · " : "") + MB(pr.done) + " / " + MB(pr.total) + (pr.via ? " · " + t("来自 {src}", { src: esc(pr.via) }) : "") + "</div>";
      }
      let acts = "", size = MB(m.state === "ok" ? m.installed : m.download);
      if (m.required || m.kind === "shared") acts = m.state === "ok" ? sdot("ok", t("已装")) : sdot("", st);
      else if (m.state === "absent" || m.state === "error") {
        // 连同还没装的依赖一起算下载量
        const chain = [...deps.filter((d) => byId[d].state !== "ok"), m.id];
        size = MB(chain.reduce((s, id) => s + byId[id].download, 0));
        acts = (m.state === "error" ? sdot("err", st) : "") + btn("install", m.id, ei("download") + (m.state === "error" ? t("重试") : t("安装")), ' class="btn sm"' + (chain.length > 1 ? ` data-chain="${esc(listOf(chain.map(nameOf)))}"` : ""));
      } else if (m.state === "downloading" || m.state === "verifying" || m.state === "installing") acts = sdot("warn", st) + (m.state === "installing" ? "" : btn("cancel", m.id, t("取消"), ' class="btn sm ghost"'));
      else if (m.state === "ok") acts = btn("toggle", m.id, modOff.has(m.id) ? t("启用") : t("停用"), ` class="btn sm ghost" data-on="${modOff.has(m.id) ? 1 : 0}" title="${esc(OFF_TIP())}"`)
        + btn("remove", m.id, t("卸载"), ' class="btn sm ghost"' + (used.length ? ' data-usedby="' + listOf(used) + '"' : ""));
      const tag = m.required ? `<span class="tag">${ei("lock")}${t("必装")}</span>` : m.kind === "shared" ? `<span class="tag">${t("共享运行库")}</span>`
        : m.state === "ok" && modOff.has(m.id) ? `<span class="tag">${t("已停用")}</span>` : "";
      return rowItem(esc(pickLang(m.name) || m.id) + tag, '<span class="mono">' + (m.key || []).map(esc).join(" ") + "</span>",
        '<span class="num">' + size + "</span>" + acts, { more: desc, extra: bar });
    }).join("");
    if (moving && pageOn("ext")) modTimer = setTimeout(() => { if (live()) loadModules(); }, 1500);
    // 装 / 卸完成后（列表里不再有进行中的那块）再刷组件卡；模块 POST 一返回任务才刚起，不能当场刷
    if (!moving && modTouched && pageOn("ext")) { modTouched = false; loadComponents(); }
  }
  $("mod-list").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-c]");
    if (!b) return;
    // 模块列表在扩展页里：同样是 data-c 按钮，冒泡上去会被组件的处理器当成组件再装/卸一遍（取消确认框之后也会）
    e.stopPropagation();
    const c = b.dataset.c, id = b.dataset.id;
    if (c === "toggle") {
      b.disabled = true;
      const r = await post("/api/ext/off", { kind: "mod", id, on: b.dataset.on === "1" }).catch((e2) => ({ ok: false, message: e2.message }));
      toast(r.ok ? (b.dataset.on === "1" ? t("已启用") : t("已停用") + " · " + OFF_TIP()) : t("失败：{msg}", { msg: r.message || "" }), !r.ok);
      return loadModules();
    }
    if (c === "remove") {
      if (b.dataset.usedby) return toast(t("{names} 要用它，先卸载那些", { names: b.dataset.usedby }), true);
      if (!confirm(t("卸载这个模块？它的命令会从工具包里删掉，别的模块和组件还在用的文件会留下。以后可以随时再装。"))) return;
    }
    if (c === "install" && b.dataset.chain && !confirm(t("会一起装上：{list}。继续？", { list: b.dataset.chain }))) return;
    b.disabled = true;
    const r = await post("/api/devkit/modules/" + c, { id }).catch((e2) => ({ ok: false, message: e2.message }));
    if (!r.ok) toast(r.message || t("失败"), true);
    else modTouched = true;   // 任务结束后刷组件卡（见 loadModules 末尾）
    setTimeout(loadModules, 300);
  });

  function loadExt() { loadModules(); loadComponents(60); loadCustom(); loadExtPlugins(); loadExtCmds(); loadExtSkills(); loadExtMcp(); loadExtMarkets(); loadExtHooks(); }

  // ── 分类索引条：扩展页每节一条，横向滚动。点一下只看那一类，点「全部」复原；刷新列表后选中的分类保留 ──
  // 条目带 data-tags（空格分隔的分类键）。labels 定顺序和显示名；没列出的键（如插件市场名 m:<名字>）按名字附在后面
  const tg = (s) => encodeURIComponent(String(s));
  const extPick = {}, extLabels = {};
  const CAT = () => ({ dev: t("开发工具"), office: t("文档办公"), media: t("图像影音"), science: t("科学计算"), eda: t("电子设计"),
    cad: t("3D 与建模"), ai: t("AI 推理"), gpu: t("GPU 与驱动"), net: t("网络"), mcp: "MCP", other: t("其他") });   // MCP：各语言都叫这个名，不进词典
  function renderIdx(sec, labels) {
    if (labels) extLabels[sec] = labels; else labels = extLabels[sec] || [];
    const bar = $(sec + "-idx"); if (!bar) return;
    const safeDecode = (x) => { try { return decodeURIComponent(x); } catch { return x; } };   // 坏的百分号序列别把整个列表画崩（审查 v0.5.5 W-L6）
    const items = [...document.querySelectorAll(`details[data-sec="${sec}"] .item[data-tags]`)];
    const count = new Map();
    for (const it of items) for (const g of it.dataset.tags.split(" ")) count.set(g, (count.get(g) || 0) + 1);
    const known = new Set(labels.map(([g]) => g));
    const chips = [...labels.filter(([g]) => count.get(g)),
      ...[...count.keys()].filter((g) => !known.has(g)).sort().map((g) => [g, safeDecode(g.replace(/^[a-z]+:/, ""))])];
    if (extPick[sec] && !count.get(extPick[sec])) extPick[sec] = "";
    const cur = extPick[sec] || "";
    const inner = [["", t("全部"), items.length], ...chips.map(([g, l]) => [g, l, count.get(g)])]
      .map(([g, l, n]) => `<button class="idx-chip${g === cur ? " on" : ""}" data-sec="${sec}" data-idx="${esc(g)}">${esc(l)}${g ? `<span>${n}</span>` : ""}</button>`).join("");
    // 轮询期间标签/计数/选中通常没变：签名相同就别重建（横向滚动条的位置和焦点会被 innerHTML 清掉）
    if (bar._html !== inner) {
      bar._html = inner; bar.innerHTML = inner;
      bar.classList.toggle("hidden", chips.length < 2 && !cur);    // 只有一类时没什么可切的
    }
    for (const it of items) it.classList.toggle("hidden", !!cur && !it.dataset.tags.split(" ").includes(cur));
  }
  $("tab-ext").addEventListener("click", (e) => {
    const c = e.target.closest(".idx-chip"); if (!c) return;
    extPick[c.dataset.sec] = c.dataset.idx; renderIdx(c.dataset.sec);
    if (c.dataset.sec === "comp") syncCatalog();
  });
  // 节头照设计稿：图标块 + 标题，下面一句说明（原来是节里第一行小字，挪进标题里）；节不再折叠，靠顶上的分区导航跳
  for (const d of document.querySelectorAll("#tab-ext details.ext-sec")) {
    d.open = true;
    const sum = d.querySelector(":scope > summary"), tip = sum.nextElementSibling;
    if (tip && tip.classList.contains("tiny")) { tip.classList.add("sec-desc"); sum.appendChild(tip); }
    sum.addEventListener("click", (e) => e.preventDefault());
  }

  // ── 可选组件（浏览器组件 = 无头 Chromium）：下载 → 校验 → 换进工具包，进度靠轮询 ──
  let compTimer = 0, compLoad = 0;
  const compRemoving = new Set();
  const compRemovalHint = () => '<span class="tiny muted" role="status">' + esc(t("正在卸载，这一步不能取消，请等待完成")) + "</span>";
  // 只有 zh / en 两份：中文界面（简繁都算）用 zh，其它语言一律用 en
  const pickLang = (o) => (o && typeof o === "object" ? (isZh() ? o.zh || o.en : o.en || o.zh) || "" : o || "");
  // 一整块工具包动辄上 GB：999 MB 之后就用 GB，手机上那一列放得下、也一眼看得懂
  const MB = (n) => (n || 0) >= 1048576 * 1024 ? (n / 1073741824).toFixed(1) + " GB" : Math.max(1, Math.round((n || 0) / 1048576)) + " MB";
  // 「A、B 和 C」这种并列按当前语言的习惯拼
  const listOf = (a) => { try { return new Intl.ListFormat((window.I18N && I18N.lang) || "zh", { type: "conjunction" }).format(a); } catch { return a.join(", "); } };
  // 顶栏副标题：几个模块 · 几个组件
  function extSub() { setPageSub("ext", [ext.nMod ? t("{n} 个模块", { n: ext.nMod }) : "", ext.nComp ? t("{n} 个组件", { n: ext.nComp }) : ""].filter(Boolean).join(" · ")); }
  // 分类的颜色和图标（卡片左上角）
  const CAT_LOOK = { gpu: ["#c96442", "cube"], cad: ["#c96442", "cube"], media: ["#b5532f", "play"], office: ["#2f6aa8", "book"], science: ["#7650c0", "gauge"],
    eda: ["#9a6a00", "bolt"], ai: ["#3d7a2a", "spark"], dev: ["#5d594f", "tool"], net: ["#2f6aa8", "globe"], mcp: ["#7650c0", "plug"], other: ["#5d594f", "puzzle"] };
  // 存储条：工具包模块 + 组件占多少，盘里还剩多少
  function paintStorage() {
    const el = $("ext-storage"); if (!el) return;
    const a = ext.modBytes || 0, b = ext.compBytes || 0, all = a + b + (ext.free || 0);
    el.classList.toggle("hidden", !a && !b);
    if (!all) return;
    const GB = (n) => n >= 1073741824 ? (n / 1073741824).toFixed(n >= 107374182400 ? 0 : 1) + " GB" : MB(n);
    el.innerHTML = `<div class="st-bar"><i style="width:${(a / all * 100).toFixed(2)}%;background:#c96442"></i><i style="width:${(b / all * 100).toFixed(2)}%;background:#2f6aa8"></i></div>
      <div class="st-leg"><span><b class="sw" style="background:#c96442"></b>${t("工具包")} <span class="num">${GB(a)}</span></span><span><b class="sw" style="background:#2f6aa8"></b>${t("组件")} <span class="num">${GB(b)}</span></span>${ext.free != null ? `<span class="muted">${t("剩余")} <span class="num">${GB(ext.free)}</span></span>` : ""}</div>`;
  }
  // 组件节头的「检查更新」：强制重拉组件索引
  // 只在这次真查成了才说「已检查」：清单取不到报原因，被后来的刷新顶掉就不吭声（#177-10）
  $("comp-check").addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    loadComponents(true).then((st) => {
      if (st === "stale") return;
      if (st && st.err) return toast(t("组件清单取不到：{msg}", { msg: st.err }), true);
      toast(t("已检查组件更新"));
    });
  });
  // E12 已删 llmDl（端侧小模型目录读取）：上游 82228b1 的 syncCatalog / pauseCatalog
  // 在分叉里没有目录可同步/可停，这里留空操作，仅保住已贴入的调用接线（renderIdx 切片、
  // pauseExtReads、loadComponents 的 !r.supported 分支），避免未定义引用。
  function syncCatalog() {}
  function pauseCatalog() {}
  function pauseExtReads() {
    clearTimeout(compTimer); clearTimeout(modTimer); clearTimeout(ghAuth.timer);
    compLoad++;
    pauseCatalog();
  }
  async function loadComponents(refresh) {
    if (!pageOn("ext")) return "stale";
    const request = ++compLoad;
    clearTimeout(compTimer);
    const r = await api("/api/components" + (refresh ? "?refresh=" + (refresh === true ? 1 : refresh) : "")).catch((e) => ({ supported: true, items: [], indexError: e.message }));
    const compOff = new Set((await extOffNow()).comp || []);
    // 完成后的刷新比卸载中的轮询新；旧响应不能把已恢复的卡片盖回去。
    if (request !== compLoad || !pageOn("ext")) return "stale";
    const outcome = { err: r.indexError || "" };
    $("comp-field").classList.toggle("hidden", !r.supported);
    if (!r.supported) { syncCatalog(); return loadGhField(); }
    const box = $("comp-list");
    const btn = (c, id, label) => `<button data-c="${c}" data-id="${esc(id)}">${label}</button>`;
    const html = (r.items || []).map((c) => {
      if (compRemoving.has(c.id)) c = { ...c, state: "removing", progress: null };
      const name = esc(pickLang(c.name) || c.id), pr = c.progress;
      const size = c.available ? t("下载约 {a}，装好后约 {b}", { a: MB(c.bytes), b: MB(c.installed) }) : "";
      const st = c.state === "outdated" && !c.available ? t("工具包更新过，暂无适配版本") : ({
        absent: c.available ? t("未安装") : t("暂无适配当前工具包的版本"),
        downloading: t("下载中"), verifying: t("校验中"), installing: t("正在装进工具包…"), removing: t("正在卸载…"),
        ok: t("已安装"), update: t("有新版本"), outdated: t("工具包已更新，需要重新安装"),
        damaged: t("安装不完整，需要重新安装"), error: t("安装失败"),
      }[c.state] || c.state);
      // 依赖没装齐：安装按钮置灰，下面写明要先装哪个；只限骁龙的组件在别家 SoC 上干脆不给装
      const miss = (c.requires || []).filter((d) => !d.ok).map((d) => esc(pickLang(d.name) || d.id));
      const gpuOnly = c.needs && (c.needs.gpu === "adreno" || c.needs.gpu === "mali") ? c.needs.gpu : "";
      let acts = "";
      if (c.state === "absent" && c.available && !c.unsupported) acts = btn("install", c.id, t("下载安装"));
      else if (c.state === "downloading" || c.state === "verifying") acts = btn("cancel", c.id, t("取消"));
      else if (c.state === "ok") acts = btn("remove", c.id, t("卸载"));
      else if (["update", "outdated", "damaged", "error"].includes(c.state)) {
        if (c.available) acts += btn("install", c.id, c.state === "update" ? t("更新") : t("重新安装"));
        if (c.installedVersion) acts += btn("remove", c.id, t("卸载"));
      }
      let bar = "";
      if (pr && pr.total) {
        const pct = Math.min(100, (pr.done / pr.total) * 100).toFixed(1);
        // installing 阶段的 done/total 是文件数，别再当字节显示成 0.0 MB（复核 P2-12）
        const amt = pr.files ? pr.done + " / " + pr.total + " " + t("个文件") : MB(pr.done) + " / " + MB(pr.total);
        bar = '<div class="comp-bar"><i style="width:' + pct + '%"></i></div><div class="tiny">' + amt + (pr.via ? " · " + t("来自 {src}", { src: esc(pr.via) }) : "") + "</div>";
      }
      // 已装和待装不是同一个版本时两个都写出来：以前只显示已装版本，点「更新」之前看不到会升到哪一版，
      // 被回放的旧索引推着「更新」也无从察觉（0.6.9 审计 195-V.1）
      const ver = c.installedVersion && c.version && c.installedVersion !== c.version
        ? c.installedVersion + " → " + c.version
        : (c.installedVersion || c.version);
      const meta = "<span>" + esc(st) + "</span>" + (ver ? "<span>" + esc(ver) + "</span>" : "") +
        (size && c.state !== "ok" ? "<span>" + esc(size) + "</span>" : "") +
        // 社区组件标出来；没有真机验证记录的再加一个提醒
        (c.source === "community" ? "<span>" + t("社区") + "</span>" : "") +
        (!c.verified ? '<span class="warn">' + t("未经真机验证") + "</span>" : "") +
        (c.license && c.state !== "ok" ? "<span>" + esc(c.license) + "</span>" : "") +
        (gpuOnly && c.state !== "ok" ? (c.unsupported ? '<span class="warn">' + (gpuOnly === "mali" ? t("只限 ARM Mali GPU（天玑、Exynos 等）设备，本机用不了") : t("只限高通骁龙（Adreno GPU）设备，本机用不了")) + "</span>"
          : "<span>" + (gpuOnly === "mali" ? t("Mali 专用") : t("骁龙专用")) + "</span>") : "");
      let desc = '<div class="tiny ext-desc">' + esc(pickLang(c.desc)) + "</div>";
      if (c.error) desc += '<div class="tiny err">' + esc(c.error) + "</div>";
      // 没有对应构建时说明原因，并给「检查更新」：索引可能还没拉到（0.6.10 审计 195-I.7）
      if (c.state === "outdated" && !c.available) desc += '<div class="tiny warn">' + t("工具包更新过，组件库里暂时没有适配当前工具包的版本；先更新工具包，或点「检查更新」重新拉一次清单。") + "</div>";
      if (miss.length && c.state !== "ok") desc += '<div class="tiny warn">' + t("要先装：{names}", { names: listOf(miss) }) + "</div>";
      if (webUrl(c.homepage) && c.state !== "ok") desc += '<div class="tiny"><a class="weblink" href="' + esc(c.homepage) + '">' + esc(c.homepage) + "</a></div>";
      if (c.state === "ok" && c.bin.length) desc += '<div class="tiny">' + t("命令：") + " " + c.bin.map((b) => "<code>" + esc(b) + "</code>").join(" ") + "</div>";
      if (c.id === "gh" && c.state === "ok") desc += '<div class="gh-auth" id="gh-auth">' + ghAuth.html + "</div>";
      const used = (c.usedBy || []).map((d) => esc(pickLang(d.name) || d.id));
      const cat = c.category && CAT()[c.category] ? c.category : "other";
      const tags = ["cat:" + cat];
      if (["ok", "removing"].includes(c.state)) tags.push("inst");
      if (["update", "outdated", "damaged", "error"].includes(c.state)) tags.push("upd");
      // 设计稿的卡片：分类色图标 + 名称 + 「版本 · 大小」，验证过的带盾牌；底下一条虚线隔开状态和按钮
      const [cc, ci] = CAT_LOOK[cat] || CAT_LOOK.other;
      const dotSt = { ok: "ok", update: "warn", downloading: "warn", verifying: "warn", installing: "warn", removing: "warn", outdated: "err", damaged: "err", error: "err" }[c.state] || "";
      const dotL = c.unsupported && c.state !== "removing" ? (gpuOnly === "mali" ? t("需要 Mali GPU") : t("需要骁龙")) : { ok: t("已装"), update: t("可更新"), absent: c.available ? t("未装") : t("暂无适配版本") }[c.state] || st;
      let cbtn = "";
      if (c.state === "removing") cbtn = compRemovalHint();
      else if (c.unsupported && c.state !== "ok") cbtn = '<span class="muted">' + t("本机用不了") + "</span>";
      else if (c.state === "absent" && c.available) cbtn = btn("install", c.id, ei("download") + MB(c.bytes)).replace("<button ", '<button class="btn sm ghost" ');
      else if (c.state === "downloading" || c.state === "verifying") cbtn = btn("cancel", c.id, t("取消")).replace("<button ", '<button class="btn sm ghost" ');
      else if (c.state === "ok") {
        // 停用放最前
        const isOff = compOff.has(c.id);
        cbtn = btn("toggle", c.id, isOff ? t("启用") : t("停用")).replace("<button ", `<button class="btn sm ghost" data-on="${isOff ? 1 : 0}" title="${esc(OFF_TIP())}" `);
        cbtn += btn("remove", c.id, t("卸载")).replace("<button ", '<button class="btn sm ghost" ');
      } else if (["update", "outdated", "damaged", "error"].includes(c.state)) {
        if (c.available) cbtn += btn("install", c.id, ei("download") + (c.state === "update" ? t("更新") : t("重新安装"))).replace("<button ", '<button class="btn sm" ');
        if (c.installedVersion) cbtn += btn("remove", c.id, t("卸载")).replace("<button ", '<button class="btn sm ghost" ');
        // 索引里没有对应构建时没有安装按钮，至少给个重新拉清单的入口（0.6.10 审计 195-I.7）
        if (c.state === "outdated" && !c.available) cbtn += btn("reindex", c.id, t("检查更新")).replace("<button ", '<button class="btn sm ghost" ');
      }
      const live = (c.id === "gh" && c.state === "ok") ? desc.slice(desc.indexOf('<div class="gh-auth"')) : "";
      const more = (live ? desc.slice(0, desc.length - live.length) : desc) + '<div class="it-meta">' + meta + "</div>";
      const warn = (c.error ? '<div class="tiny err">' + esc(c.error) + "</div>" : "") + (miss.length && c.state !== "ok" ? '<div class="tiny warn">' + t("要先装：{names}", { names: listOf(miss) }) + "</div>" : "");
      return (`<div class="item ccard${c.unsupported && !["ok", "removing"].includes(c.state) ? " dim" : ""}" data-comp="${esc(c.id)}" data-tags="${esc(tags.join(" "))}">
        <div class="cc-top"><span class="icobox" style="--c:${cc}">${ei(ci)}</span><div class="grow"><b>${name}</b><div class="mono muted">${esc(ver || "")}${ver ? " · " : ""}${MB(c.state === "ok" ? c.installed : c.bytes)}</div></div>${c.verified ? `<span class="vmark" title="${esc(t("真机验证过"))}">${ei("shield")}</span>` : ""}</div>
        ${warn}${bar}${live}<div class="it-more">${more}</div>
        <div class="cc-foot">${sdot(dotSt, dotL)}<span class="cc-btns">${cbtn}</span></div></div>`)
        .replace(" data-c=\"install\"", " data-c=\"install\"" + (c.verified ? "" : " data-unverified=\"1\"") + (miss.length ? " disabled" : ""))
        .replace(" data-c=\"remove\"", " data-c=\"remove\"" + (used.length ? ' data-usedby="' + listOf(used) + '"' : ""));
    }).join("");
    // devkit M1 补漏：工具包升级后，旧工具包里装的组件文件已随旧包没了（state=outdated），
    // 每张卡上虽有单个「重新安装」，但没有升级完成后的集中入口。这里在列表顶上给一条
    // 提示 +「一键重装全部组件」，批量复用单个重装接口（见下面 data-c="reinstall-all" 的处理，
    // 不另写安装流程）；暂无适配构建的只计数、不进批量。
    const reinstallable = (r.items || []).filter((c) => c.state === "outdated" && c.available && c.installedVersion);
    const noBuild = (r.items || []).filter((c) => c.state === "outdated" && !c.available).length;
    box._reinstallAll = reinstallable.map((c) => ({ id: c.id, name: pickLang(c.name) || c.id, unverified: !c.verified, requires: (c.requires || []).map((d) => d.id || d) }));
    const reinstallBanner = reinstallable.length ? `<div class="item"><div class="it-title wrap">${esc(t("工具包已更新，{n} 个组件需要重新安装", { n: reinstallable.length }))}${noBuild ? " · " + esc(t("另 {n} 个暂无适配当前工具包的版本", { n: noBuild })) : ""}</div><div class="tiny">${esc(t("会按顺序逐个重新下载安装；你自己的文件、会话和设置不受影响。"))}</div><div class="it-acts"><button class="btn sm" data-c="reinstall-all">${esc(t("一键重装全部组件"))}</button></div></div>` : "";
    const next = reinstallBanner + (r.allowUnsigned ? '<div class="tiny err">' + esc(t("组件签名检查已关闭（网关带了测试开关启动）")) + "</div>" : "") +
      // 清单还没发布（预置索引 404）：空列表时只说一句人话，不挂红字报错；已装组件照常列出、可管理（components H4）
      (html || '<div class="tiny">' + (r.indexNotPublished ? t("组件清单还没发布") : r.indexError ? t("组件清单取不到：{msg}", { msg: esc(r.indexError) }) : t("暂时没有可装的组件。")) + "</div>") +
      (html && r.indexError ? '<div class="tiny err">' + t("部分组件清单取不到：{msg}", { msg: esc(r.indexError) }) + "</div>" : "") +
      (r.indexError ? '<div class="it-acts"><button class="btn ghost sm" data-c="reindex">' + t("重试") + "</button></div>" : "");
    const changed = box._html !== next;
    if (changed) {
      const opened = new Set([...box.querySelectorAll(".ccard.open")].map((c) => c.dataset.comp));
      // live 区（GitHub 登录状态）是缓存外原地更新的：整块重画会把它打回初始值，记下来写回
      const gh = $("gh-auth");
      const ghHtml = gh ? gh.innerHTML : null;
      const active = document.activeElement, activeId = active && active.id && box.contains(active) ? active.id : null;
      box.innerHTML = next; box._html = next;
      // 进度更新可以换卡片，用户刚展开的说明不能每秒被收回去。
      for (const c of box.querySelectorAll(".ccard")) if (opened.has(c.dataset.comp)) c.classList.add("open");
      if (ghHtml != null && $("gh-auth")) $("gh-auth").innerHTML = ghHtml;
      if (activeId && box.querySelector("#" + activeId)) box.querySelector("#" + activeId).focus();
    }
    $("comp-count").textContent = (r.items || []).length || "";
    ext.nComp = (r.items || []).length; extSub();
    ext.compBytes = (r.items || []).filter((c) => c.installedVersion || c.state === "ok").reduce((s, c) => s + (c.installed || 0), 0); paintStorage();
    renderIdx("comp", [["inst", t("已装")], ["upd", t("要更新")], ...Object.entries(CAT()).map(([k, v]) => ["cat:" + k, v])]);
    if ($("gh-auth")) loadGhAuth(refresh);
    // 有在跑的就一秒刷一次；抽屉关了 / 换了页签就停
    if ((compRemoving.size || (r.items || []).some((c) => c.progress || c.state === "removing")) && pageOn("ext"))
      compTimer = setTimeout(() => { if (request === compLoad && pageOn("ext")) loadComponents(); }, 1000);
    // 先显示的是上回存下的列表、网关还在后台拉新索引：两秒后再要一次，拉完自然停
    else if (r.refreshing && pageOn("ext"))
      compTimer = setTimeout(() => { if (request === compLoad && pageOn("ext")) loadComponents(); }, 2000);
    return outcome;
  }

  // ── 自定义组件：用户自己导入 Linux arm64 程序。选文件 → 网关分析（ELF 类型、缺的库）→ 勾要用的命令 → 安装（补库、写入口和技能）──
  const cust = { rep: null, busy: false, installing: false };
  // 分析结果记在本机：刷新、重开应用后接回向导，网关那边暂存的还能装、能取消（网关一小时后自己清，#177-4）
  const CUST_KEY = "cc.custStage", CUST_TTL = 55 * 60e3;
  function custSave() {
    try { if (cust.rep) localStorage.setItem(CUST_KEY, JSON.stringify({ at: Date.now(), rep: cust.rep })); else localStorage.removeItem(CUST_KEY); } catch {}
  }
  function custRestore() {
    if (cust.rep || cust.busy) return;
    try {
      const j = JSON.parse(localStorage.getItem(CUST_KEY) || "null");
      if (j && j.rep && Date.now() - j.at < CUST_TTL) { cust.rep = j.rep; renderCustomWiz(); } else localStorage.removeItem(CUST_KEY);
    } catch {}
  }
  const cpost = (p, body) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const KIND = () => ({ glibc: t("Linux 程序（glibc）"), bionic: t("安卓原生程序"), static: t("静态程序"), script: t("脚本"),
    musl: "musl", unsupported: t("跑不了") });
  async function loadCustom() {
    // 读失败不能当成「这个版本没有自定义组件」把整节藏掉（195-N.4 / X.2）
    const r = await api("/api/custom").catch((e) => ({ supported: true, error: e.message, items: [] }));
    if (r.ok === false && !r.error) r.error = r.message || "?";
    $("custom-field").classList.remove("hidden");
    if (r.error) {
      $("custom-count").textContent = "—";
      $("custom-list").innerHTML = '<div class="tiny err">' + esc(t("自定义组件列表读取失败：{msg}", { msg: r.error })) + '</div><div class="it-acts"><button class="btn ghost sm" id="custom-retry">' + t("重试") + "</button></div>";
      $("custom-retry").onclick = () => loadCustom();
      return;
    }
    if (!r.supported) { $("custom-field").classList.add("hidden"); return; }
    custRestore();
    $("custom-count").textContent = (r.items || []).length || "";
    $("custom-list").innerHTML = (r.items || []).map((c) => {
      const cmds = c.entries.map((e) => "<code>" + esc(e.cmd) + "</code>" + (e.ok ? "" : ' <span class="warn">' + t("入口丢了") + "</span>") +
        ' <button class="btn ghost sm" data-cu="try" data-id="' + esc(c.id) + '" data-cmd="' + esc(e.cmd) + '">' + t("试运行") + "</button>").join(" ");
      const meta = "<span>" + esc(c.source) + "</span><span>" + MB(c.bytes) + "</span>" +
        (c.deps ? "<span>" + t("补了 {n} 个库", { n: c.deps }) + "</span>" : "") +
        [...new Set(c.entries.map((e) => KIND()[e.kind] || e.kind))].map((k) => "<span>" + esc(k) + "</span>").join("");
      let desc = (c.desc ? '<div class="tiny ext-desc">' + esc(c.desc) + "</div>" : "") + '<div class="tiny cu-cmds">' + t("命令：") + " " + cmds + "</div>";
      if (c.unresolved.length) desc += '<div class="tiny warn">' + t("还缺这些库，可能跑不起来：{libs}", { libs: esc(c.unresolved.join(", ")) }) + "</div>";
      desc += '<pre class="cu-out hidden" id="cu-out-' + esc(c.id) + '"></pre>';
      return extItem(esc(c.name), meta, '<button data-cu="remove" data-id="' + esc(c.id) + '">' + t("卸载") + "</button>", desc);
    }).join("");
  }
  async function customAnalyze(file, pathStr) {
    if (cust.busy) return;
    // 正在装上一份：装完的回执会收起向导，这时开始新的一份会被它一起清掉（#177-5）
    if (cust.installing) return toast(t("正在安装，装完再分析下一个"), true);
    cust.busy = true;
    // 上一份分析了没装：先让网关丢掉它的暂存，别占着磁盘等一小时
    if (cust.rep) { cpost("/api/custom/discard", { stage: cust.rep.stage }).catch(() => {}); cust.rep = null; custSave(); }
    const wiz = $("custom-wiz");
    wiz.innerHTML = '<div class="tiny">' + (file ? t("正在上传并分析 {name}…", { name: esc(file.name) }) : t("正在分析…")) + "</div>";
    try {
      const r = file
        ? await fetch("/api/custom/upload?name=" + encodeURIComponent(file.name || "program"), { method: "POST", body: file }).then((x) => x.json())
        : await cpost("/api/custom/analyze", { path: pathStr });
      if (!r.ok) { wiz.innerHTML = '<div class="tiny err">' + esc(r.message || "") + "</div>"; return; }
      cust.rep = r; custSave(); renderCustomWiz();
    } catch (e) { wiz.innerHTML = '<div class="tiny err">' + esc(e.message) + "</div>"; }
    finally { cust.busy = false; }
  }
  function renderCustomWiz() {
    const r = cust.rep, wiz = $("custom-wiz");
    if (!r) { wiz.innerHTML = ""; return; }
    const ok = new Set(["glibc", "bionic", "static", "script"]);
    const rows = r.programs.map((p, i) => {
      const can = ok.has(p.kind);
      const clash = p.clash === "toolkit" ? t("工具包里已有同名命令，换个名字") : p.clash === "system" ? t("系统或 agycodroid 自带同名命令，换个名字") : p.clash === "custom" ? t("别的自定义组件占了这个名字") : p.clash === "busy" ? t("另一个组件正在安装这个名字，稍后再试或换个名字") : p.clash === "bad" ? t("改个名字（只能用字母、数字和 ._+-）") : "";
      return '<div class="cu-prog' + (can ? "" : " dim") + '" data-i="' + i + '">' +
        '<label class="cu-row"><input type="checkbox" class="cu-on"' + (can ? "" : " disabled") + (can && p.suggest && !p.clash ? " checked" : "") + "> <code>" + esc(p.rel) + "</code>" +
        ' <span class="tiny">' + esc(KIND()[p.kind] || p.kind) + "</span></label>" +
        (can ? '<div class="cu-row tiny">' + t("命令名") + ' <input class="cu-cmd" value="' + esc(p.cmd) + '" spellcheck="false" autocapitalize="off">' +
          (p.kind === "glibc" && r.gpu ? ' <label><input type="checkbox" class="cu-gpu"> ' + t("用 GPU") + "</label>" : "") +
          (p.kind === "glibc" ? ' <label title="' + esc(t("直接改程序的解释器，不经加载器启动。程序按自身位置找数据文件时用")) + '"><input type="checkbox" class="cu-pe"> patchelf</label>' : "") + "</div>" : "") +
        (clash && can ? '<div class="tiny warn">' + clash + "</div>" : "") +
        (p.why ? '<div class="tiny warn">' + esc(p.why) + "</div>" : "") +
        (p.missing.length ? '<div class="tiny dim">' + t("缺：{libs}", { libs: esc(p.missing.join(", ")) }) + "</div>" : "") + "</div>";
    }).join("");
    const fix = r.fixable.length ? '<div class="tiny">' + t("会从 Termux glibc 仓库补这些库（约 {size}）：{libs}", { size: MB(r.fixable.reduce((a, f) => a + f.size, 0)), libs: esc([...new Set(r.fixable.map((f) => f.soname))].join(", ")) }) + "</div>" : "";
    const unres = r.unresolved.length ? '<div class="tiny warn">' + t("这些库找不到来源，用到它们的程序可能跑不起来：{libs}", { libs: esc(r.unresolved.join(", ")) }) + "</div>" : "";
    wiz.innerHTML = '<div class="cu-wiz">' +
      '<div class="tiny">' + t("{src}：{n} 个文件，{size}", { src: esc(r.source), n: r.files, size: MB(r.bytes) }) + "</div>" +
      '<div class="cu-row"><span class="tiny">' + t("名称") + '</span> <input id="cu-name" value="' + esc(r.name) + '"></div>' +
      '<div class="cu-row"><span class="tiny">ID</span> <input id="cu-id" value="' + esc(r.id) + '" spellcheck="false" autocapitalize="off"></div>' +
      '<div class="cu-row"><span class="tiny">' + t("说明") + '</span> <input id="cu-desc" placeholder="' + esc(t("可选：它是干什么的，Antigravity 会看到")) + '"></div>' +
      '<div class="tiny">' + t("要用哪些命令") + "</div>" + rows + fix + unres +
      r.warnings.map((w) => '<div class="tiny warn">' + esc(w) + "</div>").join("") +
      '<div class="tiny dim">' + t("程序来源由你负责：它能读写本应用里的所有文件。") + "</div>" +
      '<div class="it-acts"><button class="btn sm" data-cu="install">' + t("安装") + '</button><button class="btn ghost sm" data-cu="discard">' + t("取消") + "</button></div></div>";
  }
  $("custom-pick").addEventListener("click", () => $("custom-file").click());
  $("custom-file").addEventListener("change", (e) => { const f = e.target.files[0]; e.target.value = ""; if (f) customAnalyze(f); });
  $("custom-path-go").addEventListener("click", () => { const p = $("custom-path").value.trim(); if (p) customAnalyze(null, p); });
  $("custom-field").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-cu]"); if (!b || b.disabled) return;
    const a = b.dataset.cu;
    if (a === "discard") { if (cust.installing) return; if (cust.rep) cpost("/api/custom/discard", { stage: cust.rep.stage }).catch(() => {}); cust.rep = null; custSave(); return renderCustomWiz(); }
    if (a === "install") {
      const r = cust.rep, entries = [];
      for (const d of document.querySelectorAll("#custom-wiz .cu-prog")) {
        if (!d.querySelector(".cu-on")?.checked) continue;
        const p = r.programs[+d.dataset.i];
        entries.push({ rel: p.rel, cmd: d.querySelector(".cu-cmd").value.trim(), gpu: !!d.querySelector(".cu-gpu")?.checked, patchelf: !!d.querySelector(".cu-pe")?.checked });
      }
      if (!entries.length) return toast(t("至少选一个要用的命令"), true);
      b.disabled = true; b.textContent = r.fixable.length ? t("正在补库并安装…") : t("正在安装…");
      cust.installing = true;
      const x = await cpost("/api/custom/install", { stage: r.stage, id: $("cu-id").value.trim(), name: $("cu-name").value.trim(), desc: $("cu-desc").value.trim(), entries })
        .catch((err) => ({ ok: false, message: err.message })).finally(() => { cust.installing = false; });
      if (!x.ok) { b.disabled = false; b.textContent = t("安装"); return toast(t("失败：{msg}", { msg: x.message || "" }), true); }
      if (cust.rep === r) { cust.rep = null; custSave(); renderCustomWiz(); }
      toast(x.unresolved && x.unresolved.length ? t("已安装，但还缺 {n} 个库", { n: x.unresolved.length }) : t("已安装，Antigravity 和终端里都能用了"), !!(x.unresolved && x.unresolved.length));
      loadExtSkills();   // 自定义组件会生成一个技能：同页的技能列表跟着刷新（195-J.9）
      return loadCustom();
    }
    if (a === "remove") {
      const nm = (b.closest(".item")?.querySelector(".it-title")?.textContent || b.dataset.id).trim();
      if (!confirm(t("卸载自定义组件 {name}？会删掉导入的程序、补进来的库和它的命令。", { name: nm }))) return;
      b.disabled = true;
      const x = await cpost("/api/custom/remove", { id: b.dataset.id }).catch((err) => ({ ok: false, message: err.message }));
      toast(x.ok ? t("已卸载") : t("失败：{msg}", { msg: x.message || "" }), !x.ok);
      if (x.ok) loadExtSkills();   // 它的技能也一起删了（195-J.9）
      return loadCustom();
    }
    if (a === "try") {
      const out = $("cu-out-" + b.dataset.id); b.disabled = true;
      out.classList.remove("hidden"); out.textContent = "$ " + b.dataset.cmd + " --version\n…";
      const x = await cpost("/api/custom/try", { id: b.dataset.id, cmd: b.dataset.cmd }).catch((err) => ({ ok: false, output: err.message }));
      out.textContent = "$ " + b.dataset.cmd + "\n" + (x.output || t("（没有输出，退出码 {c}）", { c: x.code }));
      out.classList.toggle("err", !x.ok);
      b.disabled = false;
    }
  });

  // ── gh 登录卡：设备码流程。令牌只在 gh 自己那儿，网关只回账号名与状态 ──
  const ghAuth = { html: "", at: 0, timer: 0, polling: false };
  // 没有组件系统的地方（开发端）：gh 在 PATH 里就单独给一张 GitHub 卡片，登录卡同一套
  async function loadGhField() {
    const visit = pageVisit;
    const st = await api("/api/gh/auth").catch(() => null);
    if (!pageVisible("ext", visit)) return;
    $("gh-field").classList.toggle("hidden", !(st && st.installed));
    if (!st || !st.installed) return;
    $("gh-field-box").innerHTML = '<div class="item"><div class="it-title">GitHub CLI（gh）</div><div class="gh-auth" id="gh-auth">' + ghAuth.html + "</div></div>";
    loadGhAuth(true, st);
  }
  async function loadGhAuth(force, data) {
    const visit = pageVisit, live = () => pageVisible("ext", visit);
    if (!live()) return;
    clearTimeout(ghAuth.timer);
    // 组件列表下载时一秒刷一次，gh auth status 要联网验令牌，别跟着每秒跑
    if (!force && !ghAuth.polling && Date.now() - ghAuth.at < 30000) return;
    ghAuth.at = Date.now();
    const r = data || await api("/api/gh/auth").catch((e) => ({ installed: true, accounts: [], error: e.message }));
    if (!live()) return;
    const j = r.job, wasPolling = ghAuth.polling;
    ghAuth.polling = !!j && ["starting", "waiting"].includes(j.state);
    if (wasPolling && j && j.state === "done") toast(j.git ? t("GitHub 已登录，git 推送已配好") : t("GitHub 已登录，但 git 凭据没配上，可在终端运行 gh auth setup-git"), !j.git);
    let h = "";
    if (j && j.state === "starting") h = '<div class="tiny">' + t("正在向 GitHub 申请一次性码…") + "</div>" + '<div class="it-acts"><button data-g="cancel">' + t("取消") + "</button></div>";
    else if (j && j.state === "waiting") {
      h = '<div class="tiny">' + t("在浏览器里输入这个一次性码，授权后这里会自动完成：") + "</div>" +
        '<div class="gh-code" data-g="copy">' + esc(j.code) + "</div>" +
        '<div class="it-acts"><button data-g="open" data-code="' + esc(j.code) + '" data-url="' + esc(j.url || "https://github.com/login/device") + '">' + t("复制并打开浏览器") + "</button>" +
        '<button data-g="cancel">' + t("取消") + "</button></div>";
    } else {
      const acc = r.accounts || [];
      h = acc.length ? acc.map((a) => '<div class="gh-acc"><span>@' + esc(a.login) + "</span>" +
          (a.active && acc.length > 1 ? '<span class="badge">' + t("当前") + "</span>" : "") +
          (a.ok ? "" : '<span class="warn">' + t("登录已失效") + "</span>") +
          (a.active ? "" : '<button data-g="switch" data-user="' + esc(a.login) + '">' + t("切换到这个") + "</button>") +
          '<button data-g="logout" data-user="' + esc(a.login) + '">' + t("退出") + "</button></div>").join("")
        : '<div class="tiny">' + t("还没登录 GitHub。登录后 gh 和 git 推送都能用。") + "</div>";
      if (j && j.state === "error") h += '<div class="tiny err">' + (j.error === "timeout" ? t("一次性码过期了，重新登录吧") : t("登录失败：{msg}", { msg: esc(j.error) })) + "</div>";
      if (r.error) h += '<div class="tiny err">' + esc(r.error) + "</div>";
      h += '<div class="it-acts"><button data-g="login">' + (acc.length ? t("再登录一个账号") : t("登录 GitHub")) + "</button></div>";
    }
    ghAuth.html = h;
    const box = $("gh-auth");
    if (box) box.innerHTML = h;
    if (ghAuth.polling && box) ghAuth.timer = setTimeout(() => { if (live()) loadGhAuth(); }, 2000);
  }

  async function loadExtPlugins() {
    // 插件是 Claude Code 专属，Antigravity CLI 没有：网关的 /api/ext/plugins* 一律返回 400，这里直接写明不支持，不调接口。
    // 搜索框、目录和市场入口一并藏起来，免得点进去才看到报错。
    $("ext-p-count").textContent = "—";
    $("ext-plugins").innerHTML = `<div class="tiny">${esc(t("插件是 Claude Code 专属，Antigravity CLI 没有，agycodroid 不支持。"))}</div>`;
    $("ext-p-q")?.closest("label")?.classList.add("hidden");
    $("ext-catalog")?.classList.add("hidden");
    $("ext-markets")?.closest("details")?.classList.add("hidden");
  }

  async function searchPlugins(more) {
    // 见 loadExtPlugins：插件不支持，搜索也不跑。
    return;
  }

  async function installPlugin(id, btn) {
    toast(t("插件是 Claude Code 专属，Antigravity CLI 没有，agycodroid 不支持。"), true);
    if (btn) { btn.disabled = false; btn.textContent = t("安装"); }
  }

  async function loadExtMarkets() {
    // 见 loadExtPlugins：插件市场随插件一起不支持，入口已藏起来，这里什么也不做。
    return;
  }

  async function loadExtSkills() {
    // 技能是 Claude Code 专属，Antigravity CLI 没有：网关的 /api/ext/skills* 一律返回 400，这里直接写明不支持，不调接口。
    // 导入按钮和官方目录入口一并藏起来。
    $("ext-s-count").textContent = "—";
    $("ext-skills").innerHTML = `<div class="tiny">${esc(t("技能是 Claude Code 专属，Antigravity CLI 没有，agycodroid 不支持。"))}</div>`;
    $("ext-s-import")?.closest(".row-actions")?.classList.add("hidden");
    $("ext-s-catbox")?.classList.add("hidden");
  }

  $("ext-skills").addEventListener("change", async (e) => {
    const sel = e.target.closest("select.sk-mode");
    if (!sel) return;
    sel.disabled = true;
    const r = await post("/api/ext/skills/mode", { dir: sel.dataset.id, mode: sel.value }).catch((err) => ({ ok: false, message: err.message }));
    toast(r.ok ? t("下一轮对话起生效") : t("失败：{msg}", { msg: r.message || "" }), !r.ok);
    loadExtSkills();
  });

  async function loadExtHooks() {
    // Hooks 是 Claude Code 专属（PreToolUse 等），Antigravity CLI 没有：网关的 /api/ext/hooks* 一律返回 400，这里直接写明不支持，不调接口。
    // 作用域、规则列表、常用规则和表单入口一并藏起来。
    $("ext-h-count").textContent = "—";
    $("ext-hooks").innerHTML = `<div class="tiny">${esc(t("Hooks 是 Claude Code 专属，Antigravity CLI 没有，agycodroid 不支持。"))}</div>`;
    $("hook-scope")?.classList.add("hidden");
    $("hook-bar")?.classList.add("hidden");
    $("hook-recipes-box")?.classList.add("hidden");
    $("hook-form-box")?.classList.add("hidden");
  }


  async function loadExtMcp() {
    const box = $("ext-mcp");
    const r = await api("/api/ext/mcp").catch((e) => ({ items: [], err: e.message }));
    if (r.ok === false) r.err = r.message || "?";   // 200 + {ok:false} 也是失败，不能画成空列表（195-X.2）
    $("ext-m-count").textContent = r.err ? "—" : (r.items || []).length;
    box.innerHTML = (r.items || []).map((m) => extItem(
      esc(m.name) + (m.cloud ? ` <span class="badge">${t("账户连接器")}</span>` : ""),
      `<span class="mono">${esc(m.target)}</span>` + (m.hdr ? ` <span class="badge">${esc(t("请求头"))}: ${esc(m.hdr)}</span>` : ""),
      m.cloud ? "" : m.disabled ? `<button data-x="mcp-on" data-id="${esc(m.name)}" data-target="${esc(m.target)}">${t("启用")}</button><button data-x="mcp-edit" data-id="${esc(m.name)}">${t("编辑")}</button><button data-x="mcp-forget" data-id="${esc(m.name)}">${t("移除")}</button>`
        : (m.user ? `<button data-x="mcp-off" data-id="${esc(m.name)}">${t("停用")}</button><button data-x="mcp-edit" data-id="${esc(m.name)}">${t("编辑")}</button>` : "") + `<button data-x="mcp-rm" data-id="${esc(m.name)}">${t("移除")}</button>`,
      m.disabled ? `<div class="tiny ext-st">${esc(t("已停用：Antigravity 不会连它，定义存着，点启用就加回来。"))}</div>` : `<div class="tiny ext-st ${m.ok ? "ok" : "warn"}">${esc(m.status)}</div>`,
      m.cloud ? ["cloud"] : m.disabled ? ["off"] : [m.ok ? "ok" : "bad", /^https?:/i.test(m.target || "") ? "remote" : "local"])).join("")
      || `<div class="tiny">${esc(r.err || t("还没有 MCP 服务器。"))}</div>`;
    // 长按编辑要知道按的是哪条：条目顺序和 items 一一对应，渲染完把名字挂上去，不塞进 innerHTML 省得再转义一遍
    [...box.querySelectorAll(".item")].forEach((el, i) => { const m = (r.items || [])[i]; if (m) el.dataset.mcp = m.name; });
    renderIdx("mcp", [["ok", t("已连接")], ["bad", t("连不上")], ["off", t("已停用")], ["cloud", t("账户连接器")], ["local", t("本地")], ["remote", t("远程")]]);
  }

  // ── 官方技能目录：技能不支持，不列官方仓库（见 loadExtSkills）──
  const KB = (n) => (n < 1048576 ? Math.max(1, Math.ceil((n || 0) / 1024)) + " KB" : MB(n));
  async function loadSkillCat(force) {
    // 见 loadExtSkills：技能不支持，官方技能目录也不列。
    return;
  }
  $("ext-s-catbox").addEventListener("toggle", () => { if ($("ext-s-catbox").open) loadSkillCat(); });

  // ── 官方 MCP 注册表：搜索 → 条目里展开小表单（名字、装法、环境变量 / 请求头）→ 交给 agy mcp add（待实测）。
  // MCP 本身 agy 支持（mcp 动作与 agy mcp list 已确认），注册表对接方式待实测 ──
  const mcpCat = { q: "", next: "", npx: false, items: new Map(), seq: 0 };
  const mcpShort = (n) => (String(n).split("/").pop() || "mcp").replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  async function searchMcpCat(more) {
    const box = $("ext-mcp-cat");
    if (!more) { mcpCat.q = $("ext-mcp-q").value.trim(); mcpCat.next = ""; mcpCat.items.clear(); box.innerHTML = `<div class="tiny">${t("正在查注册表…")}</div>`; }
    const my = ++mcpCat.seq;
    const r = await api(`/api/ext/catalog/mcp?q=${encodeURIComponent(mcpCat.q)}&cursor=${encodeURIComponent(more ? mcpCat.next : "")}`).catch((e) => ({ ok: false, message: e.message }));
    if (my !== mcpCat.seq) return;   // 之后又搜过 / 又点过「再显示」：迟到的旧回执不许盖掉新结果、串用游标（审查 B26）
    const old = box.querySelector(".mcpcat-more"); if (old) old.remove();
    if (!r.ok) { box.insertAdjacentHTML(more ? "beforeend" : "afterbegin", `<div class="tiny err">${esc(r.message || "")}</div>`); if (!more) box.querySelector(".tiny:not(.err)")?.remove(); return; }
    mcpCat.npx = r.npx; mcpCat.next = r.next;
    const html = r.items.filter((m) => !mcpCat.items.has(m.name)).map((m) => {
      mcpCat.items.set(m.name, m);
      const usable = m.options.filter((o) => o.kind === "remote" || r.npx);
      const meta = (m.version ? `<span>${esc(m.version)}</span>` : "") +
        m.options.map((o) => `<span>${o.kind === "remote" ? esc(t("远程") + " · " + o.transport) : "npm"}</span>`).join("") +
        (m.other.length ? `<span class="warn">${t("另有 {kinds} 装法，本机用不了", { kinds: esc(m.other.join(" / ")) })}</span>` : "");
      const acts = usable.length ? `<button data-x="mcpcat-add" data-id="${esc(m.name)}">${t("添加")}</button>`
        : `<span class="tiny warn">${m.options.length ? t("要 npx（agycodroid 的工具包里有）") : t("本机装不了")}</span>`;
      return extItem(esc(m.title || m.name), meta, acts,
        `<div class="tiny mono">${esc(m.name)}</div><div class="tiny ext-desc">${esc(m.description)}</div>` +
        (webUrl(m.homepage) ? `<div class="tiny"><a class="weblink" href="${esc(m.homepage)}">${esc(m.homepage)}</a></div>` : "") + `<div class="mcpcat-form hidden"></div>`);
    }).join("");
    if (!more) box.innerHTML = html || `<div class="tiny">${t("没找到。换个关键词试试（英文更全）。")}</div>`;
    else box.insertAdjacentHTML("beforeend", html);
    if (r.next) box.insertAdjacentHTML("beforeend", `<button class="btn ghost sm mcpcat-more">${t("再显示 30 个")}</button>`);
  }
  function mcpCatForm(m, form, oi = 0) {
    const usable = m.options.filter((o) => o.kind === "remote" || mcpCat.npx), o = usable[oi];
    const fields = (o.kind === "npm" ? o.env : o.headers) || [];
    form.innerHTML = `<div class="ext-form">
      ${usable.length > 1 ? `<select data-f="opt">${usable.map((x, i) => `<option value="${i}"${i === oi ? " selected" : ""}>${x.kind === "npm" ? "npm · " + esc(x.package) : esc(t("远程") + " · " + x.target)}</option>`).join("")}</select>` : ""}
      <input data-f="name" value="${esc(mcpShort(m.name))}" placeholder="${esc(t("名字（字母、数字、- _ .）"))}" autocomplete="off">
      <div class="tiny mono">${esc(o.target)}</div>
      ${fields.map((x) => `<input data-k="${esc(x.name)}" data-req="${x.required ? 1 : ""}" type="${x.secret ? "password" : "text"}" autocomplete="off"
        placeholder="${esc(x.name + (x.required ? " *" : "") + (x.description ? " — " + x.description : ""))}">`).join("")}
      <button class="btn sm" data-x="mcpcat-go" data-id="${esc(m.name)}" data-oi="${oi}">${t("确认添加")}</button></div>`;
    form.classList.remove("hidden");
  }
  $("tab-ext").addEventListener("change", (e) => {
    if (e.target.dataset.f !== "opt") return;
    const form = e.target.closest(".mcpcat-form"), id = form.parentElement.querySelector("[data-x=mcpcat-add]")?.dataset.id;
    if (id) mcpCatForm(mcpCat.items.get(id), form, Number(e.target.value));
  });
  $("tab-ext").addEventListener("click", async (e) => {
    const b = e.target.closest("button"); if (!b) return;
    if (b.classList.contains("mcpcat-more")) return searchMcpCat(true);
    const x = b.dataset.x;
    if (x === "skillcat-retry") return loadSkillCat(true);
    if (x === "market-retry") return loadExtMarkets();
    if (x === "skillcat-install") {
      b.disabled = true; b.textContent = t("安装中…");
      const r = await post("/api/ext/catalog/skills/install", { dir: b.dataset.id }).catch((er) => ({ ok: false, message: er.message }));
      toast(r.ok ? t("已安装 {name}，下一条消息生效", { name: b.dataset.id }) : t("安装失败：{msg}", { msg: r.message || "" }), !r.ok);
      if (r.ok) loadExtSkills(); else { b.disabled = false; b.textContent = t("安装"); }
      return;
    }
    if (x === "mcpcat-add") {
      const form = b.closest(".item").querySelector(".mcpcat-form");
      if (!form.classList.contains("hidden")) return form.classList.add("hidden");
      return mcpCatForm(mcpCat.items.get(b.dataset.id), form);
    }
    if (x === "mcpcat-go") {
      const m = mcpCat.items.get(b.dataset.id), form = b.closest(".mcpcat-form");
      const o = m.options.filter((y) => y.kind === "remote" || mcpCat.npx)[Number(b.dataset.oi) || 0];
      const vals = [...form.querySelectorAll("input[data-k]")].map((i) => [i.dataset.k, i.value.trim(), !!i.dataset.req]);
      const lack = vals.filter(([, v, req]) => req && !v).map(([k]) => k);
      if (lack.length) return toast(t("要先填：{names}", { names: lack.join(", ") }), true);
      const filled = vals.filter(([, v]) => v);
      const body = { name: form.querySelector("[data-f=name]").value.trim(), transport: o.transport, target: o.target,
        env: o.kind === "npm" ? filled.map(([k, v]) => k + "=" + v) : [], headers: o.kind === "remote" ? filled.map(([k, v]) => k + ": " + v) : [] };
      if (o.kind === "npm" && !confirm(t("这个 MCP 服务器会在本机运行下面的 npm 包（注册表里任何人都能发布，没人审核），确认是你信任的来源再继续：\n\n{cmd}", { cmd: o.target }))) return;
      b.disabled = true;
      const r = await post("/api/ext/mcp/add", body).catch((er) => ({ ok: false, message: er.message }));
      b.disabled = false;
      toast(r.ok ? t("已添加 {name}", { name: body.name }) : t("添加失败：{msg}", { msg: r.message || "" }), !r.ok);
      if (r.ok) { form.classList.add("hidden"); loadExtMcp(); }
    }
  });
  $("ext-mcp-search").addEventListener("click", () => searchMcpCat(false));
  $("ext-mcp-q").addEventListener("keydown", (e) => { if (e.key === "Enter") searchMcpCat(false); });
  $("ext-mcp-catbox").addEventListener("toggle", () => { if ($("ext-mcp-catbox").open && !$("ext-mcp-cat").children.length) searchMcpCat(false); });

  $("ext-p-search").addEventListener("click", () => searchPlugins(false));
  $("ext-p-q").addEventListener("keydown", (e) => { if (e.key === "Enter") searchPlugins(false); });
  $("ext-s-import").addEventListener("click", () => $("ext-s-file").click());
  $("ext-s-file").addEventListener("change", async (e) => {
    // 文件选择器不限类型（群里转来的 zip 常被标成别的类型，限了就选不中）；可一次选多个，zip 里有几个技能装几个
    const list = [...(e.target.files || [])]; e.target.value = "";
    if (!list.length) return;
    const ok = [], bad = [];
    for (const f of list) {
      // 后端整包接收上限 64 MB：先看大小，别把几百 MB 读进内存再撞 413（196 HTTP/静态/路由）
      if (f.size > 64 * 1024 * 1024) { bad.push(`${f.name}：${t("技能包超过 64 MB，请解压后逐个导入")}`); continue; }
      const r = await api("/api/ext/skills/import", { method: "POST", headers: { "content-type": "application/octet-stream" }, body: await f.arrayBuffer() })
        .catch((err) => ({ ok: false, message: err.message }));
      if (r.ok) ok.push(...(r.dirs || [r.dir]));
      else bad.push(`${f.name}：${r.message || ""}`);
      for (const x of r.skipped || []) bad.push(`${x.name}：${x.why}`);
    }
    if (ok.length) toast(t("已安装技能 {name}", { name: ok.join("、") }) + (bad.length ? "\n" + t("未装：{msg}", { msg: bad.join("；") }) : ""), !!bad.length);
    else toast(t("安装失败：{msg}", { msg: bad.join("；") }), true);
    loadExtSkills();
  });
  $("ext-m-add").addEventListener("click", async () => {
    const source = $("ext-m-src").value.trim();
    if (!source) return;
    toast(t("正在添加市场…"));
    const r = await post("/api/ext/marketplaces/add", { source }).catch((e) => ({ ok: false, message: e.message }));
    toast(r.ok ? t("已添加") : t("添加失败：{msg}", { msg: r.message || "" }), !r.ok);
    if (r.ok) $("ext-m-src").value = "";
    loadExtMarkets();
  });
  // 选 http / sse 时把输入框提示换成请求头的写法：远程服务器常要 Bearer 令牌，
  // 写成 KEY=值 会被当成环境变量（远程没有子进程，-e 无处注入），令牌根本没发出去。
  const syncMcpHint = () => {
    $("ext-mcp-env").placeholder = $("ext-mcp-tr").value === "stdio"
      ? t("环境变量，可选，用逗号分隔（KEY=值）")
      : t("请求头，可选，用逗号分隔（Header: 值），例如 Authorization: Bearer 你的令牌");
  };
  // 本机服务器走回环最稳：填局域网 IP，手机一切换网络 IP 就变，MCP 跟着断连（群里实际踩过）。
  // 从目标里抠出主机：去掉协议和路径，再剥掉端口，剩下要是个 IPv4 再判断私网段。
  const mcpLanHost = (target) => {
    const host = String(target || "").trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").split(/[/?#]/)[0].split(":")[0];
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
    if (!m) return false;
    const [a, b] = [+m[1], +m[2]];
    if (a === 127) return false;   // 回环不是局域网，不提醒
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  };
  const syncMcpIpTip = () => {
    const tip = $("ext-mcp-ip-tip");
    if ($("ext-mcp-tr").value === "stdio") { tip.classList.add("hidden"); return; }
    const lan = mcpLanHost($("ext-mcp-target").value);
    tip.textContent = lan
      ? t("这像是一个局域网地址：服务器在本机的话，请改成 http://127.0.0.1:端口，局域网 IP 一变就断连")
      : t("服务器在本机就填 http://127.0.0.1:端口 最稳；局域网 IP 会随网络切换而变化，导致断连");
    tip.classList.toggle("warn", lan);
    tip.classList.remove("hidden");
  };
  $("ext-mcp-tr").addEventListener("change", () => { syncMcpHint(); syncMcpIpTip(); });
  $("ext-mcp-target").addEventListener("input", syncMcpIpTip);
  syncMcpHint();
  syncMcpIpTip();
  // ── MCP 编辑模式：mcpEdit = null 是添加；有值 = 正在编辑这条（名字和点掉的键存这里，表单字段直接读）──
  // 值（令牌等）不回到表单：留空 = 保留原值，要换就填新的；点掉 chip 的键会从配置里删掉。
  let mcpEdit = null;
  const endMcpEdit = () => {
    mcpEdit = null;
    ["ext-mcp-name", "ext-mcp-target", "ext-mcp-env"].forEach((id) => ($(id).value = ""));
    $("ext-mcp-tr").value = "stdio";
    syncMcpHint();
    $("ext-mcp-ip-tip").classList.add("hidden");
    $("ext-mcp-cur").classList.add("hidden");
    $("ext-mcp-cur").innerHTML = "";
    $("ext-mcp-edit-tip").classList.add("hidden");
    $("ext-mcp-add").classList.remove("hidden");
    $("ext-mcp-save").classList.add("hidden");
    $("ext-mcp-cancel").classList.add("hidden");
  };
  const renderMcpCur = () => {
    const box = $("ext-mcp-cur");
    const chip = (k, which) => `<span class="chip">${esc(k)}<button data-x="mcp-drop" data-which="${which}" data-k="${esc(k)}" title="${esc(t("从配置里删掉"))}">×</button></span>`;
    const env = mcpEdit.fullEnv.filter((k) => !mcpEdit.dropEnv.has(k));
    const hdr = mcpEdit.fullHdr.filter((k) => !mcpEdit.dropHdr.has(k));
    box.innerHTML = (hdr.length ? `<div>${esc(t("现有请求头"))}：${hdr.map((k) => chip(k, "hdr")).join("")}</div>` : "")
      + (env.length ? `<div>${esc(t("现有环境变量"))}：${env.map((k) => chip(k, "env")).join("")}</div>` : "");
    box.classList.toggle("hidden", !env.length && !hdr.length);
  };
  const openMcpEdit = async (name) => {
    if (mcpEdit) endMcpEdit();
    const r = await api(`/api/ext/mcp/get?name=${encodeURIComponent(name)}`).catch((e) => ({ ok: false, message: e.message }));
    if (!r.ok) return toast(t("打不开编辑：{msg}", { msg: r.message || "" }), true);
    mcpEdit = { name: r.name, fullEnv: r.envNames || [], fullHdr: r.headerNames || [], dropEnv: new Set(), dropHdr: new Set() };
    $("ext-mcp-addbox").open = true;
    $("ext-mcp-name").value = r.name;
    $("ext-mcp-tr").value = r.transport;
    $("ext-mcp-target").value = r.target;
    $("ext-mcp-env").value = "";
    syncMcpHint();
    syncMcpIpTip();
    renderMcpCur();
    $("ext-mcp-edit-tip").textContent = t("正在编辑 {name}：留空 = 保留原值，点 × 删掉，填新的替换", { name: r.name });
    $("ext-mcp-edit-tip").classList.remove("hidden");
    $("ext-mcp-add").classList.add("hidden");
    $("ext-mcp-save").classList.remove("hidden");
    $("ext-mcp-cancel").classList.remove("hidden");
    $("ext-mcp-addbox").scrollIntoView({ behavior: "smooth", block: "center" });
  };
  // 长按 = contextmenu（和文件列表长按一致）；桌面没有长按，双击也能进
  const mcpEditTarget = (e) => (e.target.closest("button, a, input, select, textarea") ? null : e.target.closest(".item[data-mcp]"));
  $("ext-mcp").addEventListener("contextmenu", (e) => {
    const it = mcpEditTarget(e);
    if (!it) return;
    e.preventDefault();
    openMcpEdit(it.dataset.mcp);
  });
  $("ext-mcp").addEventListener("dblclick", (e) => {
    const it = mcpEditTarget(e);
    if (it) openMcpEdit(it.dataset.mcp);
  });
  $("ext-mcp-cancel").addEventListener("click", endMcpEdit);
  $("ext-mcp-save").addEventListener("click", async () => {
    if (!mcpEdit) return;
    const transport = $("ext-mcp-tr").value;
    // 请求头的值本身可能带英文逗号：有换行就按行分（一行一条），没换行才退回逗号（195-J.11）
    const raw = $("ext-mcp-env").value;
    const extra = (raw.includes("\n") ? raw.split("\n") : raw.split(",")).map((x) => x.trim()).filter(Boolean);
    const envLike = extra.filter((x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
    const hdrLike = extra.filter((x) => x.includes(":") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
    // 远程 MCP 只认请求头。旧代码把 Authorization=Bearer … 静默塞进 -e，agy
    // 收不到 --header → 服务器 401 → 按 MCP 规范转去 OAuth 动态客户端注册 →
    // 界面只报 "Dynamic Client Registration rejected (HTTP 404)"，用户看不出是令牌没带上。
    // 这里直接拦下并给出正确写法，不再生成一条注定连不上的配置。
    if (transport !== "stdio" && envLike.length) {
      return toast(t("远程 MCP 要填请求头：把 {bad} 改成冒号写法，例如 Authorization: Bearer 你的令牌", { bad: envLike[0] }), true);
    }
    // agy 对 stdio 条目不存请求头：留着头的条目切成 stdio 会静默丢令牌（和 #225 同类），先问一句
    if (transport === "stdio") {
      const keep = mcpEdit.fullHdr.filter((k) => !mcpEdit.dropHdr.has(k));
      if (keep.length && !confirm(t("stdio 不保存请求头：{names} 会被丢掉，继续吗？", { names: keep.join("、") }))) return;
    }
    const body = { name: mcpEdit.name, newName: $("ext-mcp-name").value.trim(), transport, target: $("ext-mcp-target").value.trim(),
      env: envLike, headers: hdrLike, dropEnv: [...mcpEdit.dropEnv], dropHeaders: [...mcpEdit.dropHdr] };
    const btn = $("ext-mcp-save");
    btn.disabled = true;
    const r = await post("/api/ext/mcp/edit", body).catch((e) => ({ ok: false, message: e.message }));
    btn.disabled = false;
    toast(r.ok ? t("已保存修改 {name}", { name: body.newName }) : t("编辑失败：{msg}", { msg: r.message || "" }), !r.ok);
    if (r.ok) { endMcpEdit(); loadExtMcp(); }
  });
  $("ext-mcp-add").addEventListener("click", async () => {
    const transport = $("ext-mcp-tr").value;
    const raw = $("ext-mcp-env").value;
    const extra = (raw.includes("\n") ? raw.split("\n") : raw.split(",")).map((x) => x.trim()).filter(Boolean);
    const envLike = extra.filter((x) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
    const hdrLike = extra.filter((x) => x.includes(":") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
    if (transport !== "stdio" && envLike.length) {
      return toast(t("远程 MCP 要填请求头：把 {bad} 改成冒号写法，例如 Authorization: Bearer 你的令牌", { bad: envLike[0] }), true);
    }
    const body = {
      name: $("ext-mcp-name").value.trim(), transport, target: $("ext-mcp-target").value.trim(),
      env: envLike,
      headers: hdrLike,
    };
    const r = await post("/api/ext/mcp/add", body).catch((e) => ({ ok: false, message: e.message }));
    toast(r.ok ? t("已添加 {name}", { name: body.name }) : t("添加失败：{msg}", { msg: r.message || "" }), !r.ok);
    if (r.ok) { ["ext-mcp-name", "ext-mcp-target", "ext-mcp-env"].forEach((id) => ($(id).value = "")); loadExtMcp(); }
  });

  $("tab-ext").addEventListener("click", async (e) => {
    if (e.target.classList.contains("ext-more-btn")) return searchPlugins(true);
    const g = e.target.closest("[data-g]");
    if (g && !g.disabled) {
      const a = g.dataset.g;
      if (a === "copy") { copyText(g.textContent.trim()); return toast(t("已复制")); }
      if (a === "open") { copyText(g.dataset.code); toast(t("一次性码已复制，在打开的页面里粘贴")); return openExternal(g.dataset.url); }
      if (a === "logout" && !confirm(t("退出 GitHub 账号 {name}？gh 会删掉它保存的令牌。", { name: g.dataset.user }))) return;
      g.disabled = true;
      const r = await post("/api/gh/" + a, { user: g.dataset.user || "" }).catch((err) => ({ ok: false, message: err.message }));
      if (!r.ok) toast(t("失败：{msg}", { msg: r.message || "" }), true);
      if (a === "login") ghAuth.polling = true;
      return loadGhAuth(true);
    }
    const cb = e.target.closest("button[data-c]");
    if (cb && cb.closest("#mod-list")) return;   // 模块按钮归上面的处理器
    if (cb && !cb.disabled) {
      const c = cb.dataset.c, id = cb.dataset.id;
      if (c === "reindex") { cb.disabled = true; $("comp-list")._html = null; return loadComponents(true); }
      if (c === "toggle") {
        cb.disabled = true; $("comp-list")._html = null;
        const r = await post("/api/ext/off", { kind: "comp", id, on: cb.dataset.on === "1" }).catch((err) => ({ ok: false, message: err.message }));
        toast(r.ok ? (cb.dataset.on === "1" ? t("已启用") : t("已停用") + " · " + OFF_TIP()) : t("失败：{msg}", { msg: r.message || "" }), !r.ok);
        loadExtSkills();     // 组件自带的技能跟着关 / 开
        return loadComponents();
      }
      // devkit M1 补漏：一键重装全部组件（升级后 outdated 的）。批量复用单个重装接口
      // POST /api/components/install，不另写安装流程：单个装是异步任务（compStart 只起任务
      // 就回），这里逐个起完就刷新列表，进度由 loadComponents 的一秒轮询接着显示。
      // 依赖先装：按 requires 拓扑排一下，省得后装的先报「要先装」；有环排不出来的按原顺序。
      if (c === "reinstall-all") {
        const list = ($("comp-list")._reinstallAll || []).slice();
        if (!list.length) return loadComponents();
        const names = list.map((x) => x.name).join("、");
        const warnUnverified = list.some((x) => x.unverified) ? "\n\n" + t("其中有没在真机上验证过的组件，可能装不上或用不了。") : "";
        if (!confirm(t("工具包更新后，下面的组件要重新安装（会重新下载）：") + "\n\n" + names + warnUnverified + "\n\n" + t("你自己的文件、会话和设置不受影响。继续？"))) return;
        cb.disabled = true;
        const reqs = new Map(list.map((x) => [x.id, x.requires || []]));
        const ordered = [];
        const rest = new Set(list.map((x) => x.id));
        while (rest.size) {
          const ready = [...rest].filter((x) => !(reqs.get(x) || []).some((d) => rest.has(d)));
          if (!ready.length) { ordered.push(...rest); break; }   // 有环：剩下的按原顺序
          for (const x of ready) { ordered.push(x); rest.delete(x); }
        }
        const nameOf = new Map(list.map((x) => [x.id, x.name]));
        const failed = [];
        for (const x of ordered) {
          const r = await post("/api/components/install", { id: x }).catch((err) => ({ ok: false, message: err.message }));
          if (!r.ok) failed.push((nameOf.get(x) || x) + "：" + (r.message || t("失败")));
        }
        if (failed.length) toast(t("有 {n} 个组件没开始重装：", { n: failed.length }) + "\n" + failed.join("\n"), true);
        else toast(t("已开始重装 {n} 个组件，装完自动刷新", { n: ordered.length }));
        return loadComponents();
      }
      if (compRemoving.has(id)) return;
      const nm = (cb.closest(".item")?.querySelector(".it-title")?.textContent || id).trim();
      if (c === "install" && cb.dataset.unverified && !confirm(t("{name} 还没人在真机上验证过，可能装不上或用不了。仍然安装？", { name: nm }))) return;
      if (c === "remove" && cb.dataset.usedby) return toast(t("{names} 要用它，先卸载那些组件", { names: cb.dataset.usedby }), true);
      if (c === "remove" && !confirm(t("卸载组件 {name}？会删掉它装进工具包的文件，你自己的文件不受影响。", { name: nm }))) return;
      cb.disabled = true; $("comp-list")._html = null;
      if (c === "remove") {
        // 停服务可能要等一会儿；在下一次轮询回来前也不能再装、再卸或取消。
        compRemoving.add(id);
        const foot = cb.closest(".ccard")?.querySelector(".cc-foot");
        if (foot) foot.innerHTML = sdot("warn", t("正在卸载…")) + '<span class="cc-btns">' + compRemovalHint() + "</span>";
        loadComponents();
      }
      let r;
      try { r = await post("/api/components/" + c, { id }).catch((err) => ({ ok: false, message: err.message })); }
      finally { if (c === "remove") compRemoving.delete(id); }
      if (!r.ok) toast(t("失败：{msg}", { msg: r.message || "" }), true);
      else if (c === "remove") {
        toast(t("已卸载"));
        // 组件自己攒的运行数据（下载缓存、解开的运行环境）不随卸载删，问一句
        if (r.data && r.data.bytes > 0 && confirm(t("{name} 还留着 {size} 运行数据（{path}：下载缓存、解开的运行环境等）。一起删掉？以后再装要重新下载。", { name: nm, size: fmtSize(r.data.bytes), path: r.data.path }))) {
          const p = await post("/api/components/purge", { id }).catch((err) => ({ ok: false, message: err.message }));
          toast(p.ok ? t("运行数据已删除") : t("失败：{msg}", { msg: p.message || "" }), !p.ok);
        }
      }
      return loadComponents();
    }
    const b = e.target.closest("button[data-x]");
    if (!b || b.disabled) return;
    const x = b.dataset.x, id = b.dataset.id;
    if (x === "install") return installPlugin(id, b);
    if (x === "mcp-edit") {
      await openMcpEdit(id);
      return;
    }
    if (x === "mcp-drop") {
      if (!mcpEdit) return;
      (b.dataset.which === "env" ? mcpEdit.dropEnv : mcpEdit.dropHdr).add(b.dataset.k);
      return renderMcpCur();
    }
    const url = { uninstall: "/api/ext/plugins/uninstall", enable: "/api/ext/plugins/enable", disable: "/api/ext/plugins/disable",
      "skill-rm": "/api/ext/skills/delete", "mcp-rm": "/api/ext/mcp/remove", "market-rm": "/api/ext/marketplaces/remove",
      "mcp-off": "/api/ext/mcp/disable", "mcp-on": "/api/ext/mcp/enable", "mcp-forget": "/api/ext/mcp/forget" }[x];
    // 别的监听管的按钮（MCP 目录添加、技能目录重试…）也带 data-x：不认识的不归这里，以前会 POST /undefined 再报失败（审查 F-002）
    if (!url) return;
    const ask = {
      uninstall: t("卸载插件 {name}？", { name: id }),
      "skill-rm": t("删除技能 {name}？文件夹会被整个删掉。", { name: id }),
      "mcp-rm": t("移除 MCP 服务器 {name}？", { name: id }),
      "mcp-off": t("停用 MCP 服务器 {name}？它的设置会先存起来，随时能启用。", { name: id }),
      // 加回去的是停用名单里存着的那条：先亮给用户看，名单文件被改过也看得出来
      "mcp-on": t("启用 MCP 服务器 {name}？会加回这条：{target}", { name: id, target: b.dataset.target || "?" }),
      "mcp-forget": t("删掉停用着的 MCP 服务器 {name}？删了就不能一键启用了。", { name: id }),
      "market-rm": t("移除插件市场 {name}？从它装的插件也会一并卸载。", { name: id }),
    }[x];
    if (ask && !confirm(ask)) return;
    b.disabled = true;
    const key = x === "skill-rm" ? "dir" : x.startsWith("mcp-") || x === "market-rm" ? "name" : "id";
    const r = await post(url, { [key]: id }).catch((err) => ({ ok: false, message: err.message }));
    toast(r.ok ? t("完成") : t("失败：{msg}", { msg: r.message || "" }), !r.ok);
    b.disabled = false;
    if (x === "skill-rm") loadExtSkills();
    else if (x.startsWith("mcp-")) loadExtMcp();
    else if (x === "market-rm") { loadExtMarkets(); loadExtPlugins(); }
    else loadExtPlugins();
  });

  // ── 排障：安全模式 / 日志分享 / 修复账本 ───────────────────────────
  function paintSafeMode(on) {
    $("safe-mode").checked = !!on;
    let bar = $("safe-bar");
    if (on && !bar) {
      bar = document.createElement("div");
      bar.id = "safe-bar"; bar.className = "safe-bar";
      bar.innerHTML = `<span>${t("安全模式：仅用 agy 默认配置启动，不加载额外设置")}</span> <button class="btn sm ghost" id="safe-off">${t("退出安全模式")}</button>`;
      $("chat").before(bar);
      $("safe-off").onclick = () => setSafe(false);
    } else if (!on && bar) bar.remove();
  }
  async function setSafe(on) {
    const r = await post("/api/safe-mode", { on }).catch((e) => ({ ok: false, message: e.message }));
    if (!r.ok) { paintSafeMode(!on); return toast(r.message || "", true); }   // 没切成：开关拨回去（审查 D-05）
    paintSafeMode(r.safeMode);
    toast(r.safeMode ? t("已进入安全模式，下一条消息生效") : t("已退出安全模式，下一条消息生效"));
  }
  $("safe-mode").addEventListener("change", (e) => setSafe(e.target.checked));
  $("upd-log").addEventListener("click", () => { closeSettings(); openPage("changelog"); });
  $("btn-share-logs").addEventListener("click", async () => {
    // 打包前给用户看清单：发出去的是什么、去掉了什么
    if (!confirm(t("打一个诊断包，经系统分享发出去。\n\n包里有：\n· 版本与设备：agycodroid / Android 版本、机型、芯片、剩余空间\n· 开发工具包：装的是哪一版、更新与自检状态\n· 最近的日志：本应用的系统日志、网关日志的最后一段\n· 修复账本：安装、校验、修复做过哪些、成没成\n· 网络：开没开 VPN，应用连不连得上几个下载源（只记结果）\n\n已经去掉：\n· 密钥、令牌、登录凭据、邮箱\n· 你发给 Antigravity 的消息内容\n· 会话记录本身不在包里\n\n继续？"))) return;
    toast(t("正在打包日志…"));
    const r = await post("/api/app/share_logs").catch((e) => ({ ok: false, message: e.message }));
    if (!r.ok) toast(t("没分享成：{msg}", { msg: r.message || "" }), true);
  });
  // 恢复初始设置：网关只请应用弹原生确认框（说明、勾选、执行都在那边，见 FactoryReset.java）
  $("btn-factory-reset").addEventListener("click", async () => {
    const r = await post("/api/app/factory_reset").catch((e) => ({ ok: false, message: e.message }));
    if (!r.ok) toast(r.message || t("没弹出确认框"), true);
  });
  // 到 GitHub 反馈：网关拼好链接（设备、ROM、自检、组件），先给用户看要填进去的内容，再用外部浏览器打开
  $("btn-issue").addEventListener("click", async () => {
    const b = $("btn-issue");
    // 网关要现拼设备 / 自检 / 组件，最坏要等十来秒：这期间别让连点堆出一串请求（0.6.10 审计 196 端侧.5）
    if (b.dataset.busy) return;
    b.dataset.busy = "1"; b.disabled = true;
    try {
      let r;
      try { r = await api("/api/issue-draft"); } catch (e) { return toast(e.message, true); }
      const dev = r.body.slice(r.body.indexOf("### Device"), r.body.indexOf("<sub>")).trim();
      if (!confirm(t("将打开 GitHub 的新建 Issue 页面，下面这些会预先填好，提交前还能改：") + "\n\n" + (dev.length > 1500 ? dev.slice(0, 1500) + "…" : dev))) return;
      openExternal(r.url);
    } finally { delete b.dataset.busy; b.disabled = false; }
  });
  // 状态对账：组件 / 模块 / 包清单 / 自定义组件的记录和磁盘对一遍（网关启动后自动核过一次，这里看结果或再核）
  // 能自动修的条目带「修补」，顶部「全部修补」：网关按顺序重装组件 / 模块、等做完，工具包和 Antigravity CLI 交给应用，最后自动再核（用户 11-09）
  const fixWhat = (a) => ({ comp: t("重新安装这个组件（会重新下载）"), mod: t("重新安装这个工具包模块（会重新下载）"),
    devkit: t("修复开发工具包：重新下载当前这一版并重装，装的时候暂停服务 1–2 分钟"), agy: t("重新安装 Antigravity CLI") }[a] || "");
  let fixTimer = 0;
  function paintReconcile(r, always) {
    const box = $("reconcile-box"), bad = (r.findings || []).filter((f) => f.level !== "info");
    if (!r.supported || (!always && !bad.length)) return box.classList.add("hidden");
    const fixable = bad.filter((f) => f.act);
    const head = r.at ? `<div class="rc-head"><div class="tiny">${esc(bad.length ? t("记录和磁盘有 {n} 处对不上：", { n: bad.length }) : t("记录和磁盘一致"))} · ${esc(new Date(r.at).toLocaleString())}</div>
        ${fixable.length > 1 ? `<button class="btn sm" data-rcfix="all">${esc(t("全部修补"))}</button>` : ""}</div>` : "";
    box.innerHTML = head + (r.findings || []).map((f) => `<div class="item ledger ${f.level === "info" ? "" : "bad"}">
        <div class="it-title wrap">${uiI(f.level === "error" ? "x" : f.level === "warn" ? "warn" : "info", "lv-" + f.level)}${esc(f.msg)}</div>
        ${f.fix ? `<div class="tiny">${esc(t("怎么办："))}${esc(f.fix)}</div>` : ""}
        ${f.samples.length ? `<div class="tiny mono">${f.samples.slice(0, 5).map(esc).join("<br>")}</div>` : ""}
        ${f.act && f.level !== "info" ? `<div class="rc-act"><button class="btn sm ghost" data-rcfix="${esc(f.key)}" data-act="${esc(f.act)}" data-msg="${esc(f.msg)}">${esc(t("修补"))}</button></div>` : ""}
      </div>`).join("");
    box._fixable = fixable;
    box.classList.remove("hidden");
  }
  const STEP = () => ({ wait: t("等待"), run: t("进行中…"), ok: t("完成"), fail: t("失败"), handed: t("已交给应用") });
  function paintFix(j) {
    const box = $("reconcile-box"), S = STEP();
    box.innerHTML = `<div class="tiny">${esc(j.running ? t("正在修补，关掉这一页也不影响，做完会自动再核对：") : j.steps.some((s) => s.state === "handed") ? t("还有步骤在应用里进行：") : t("修补结束："))}</div>` + j.steps.map((s) => `<div class="item ledger ${s.state === "fail" ? "bad" : ""}">
        <div class="it-title wrap">${uiI(s.state === "ok" ? "check" : s.state === "fail" ? "x" : "info", "lv-" + (s.state === "fail" ? "error" : "info"))}${esc(s.msg)}</div>
        <div class="tiny">${esc(fixWhat(s.act))} · <b>${esc(S[s.state] || s.state)}</b>${s.note ? " · " + esc(s.note) : ""}</div>
      </div>`).join("") + (j.steps.some((s) => s.state === "handed") ? `<div class="tiny">${esc(t("交给应用的那几步在「设置 → 更新」里看进度，做完后再点「核对记录」。"))}</div>` : "");
    box.classList.remove("hidden");
  }
  async function followFix(visit = setVisit, j) {
    const live = () => setVisible("trouble", visit);
    if (!live()) return;
    clearTimeout(fixTimer);
    j ||= await sameGet("/api/reconcile/fix").catch(() => null);
    if (!live() || !j?.ok) return;
    paintFix(j);
    if (j.running) { fixTimer = setTimeout(() => followFix(visit), 1500); return; }
    const failed = j.steps.filter((s) => s.state === "fail").length;
    // 交给应用的还在做：网关没再核（核了也是旧结果），进度留在这里，不换回旧的核对结果（0.6.11 真机）
    if (j.steps.some((s) => s.state === "handed")) return toast(t("交给应用的步骤还在进行，做完后再点「核对记录」"), !!failed);
    toast(failed ? t("修补结束，有 {n} 步没成", { n: failed }) : t("修补结束"), !!failed);
    // 结果停留几秒给人看清，再换回最新的核对结果（网关已经自动再核过）
    fixTimer = setTimeout(async () => { if (live()) { const r = await loadReconcile(false); if (r && live()) paintReconcile(r, true); } }, failed ? 8000 : 3000);
  }
  $("reconcile-box").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-rcfix]");
    if (!b || b.disabled) return;
    const all = b.dataset.rcfix === "all", box = $("reconcile-box");
    const list = all ? (box._fixable || []) : [{ msg: b.dataset.msg, act: b.dataset.act }];
    const plan = [...new Set(list.map((f) => "· " + f.msg + "\n   → " + fixWhat(f.act)))].join("\n");
    if (!confirm((all ? t("按下面的顺序修补，做完自动再核对一次：") : t("修补这一项：")) + "\n\n" + plan + "\n\n" + t("重装要联网下载；你自己的文件、会话和设置不受影响。继续？"))) return;
    const visit = setVisit;
    b.disabled = true;
    const r = await post("/api/reconcile/fix", { keys: all ? "all" : [b.dataset.rcfix] }).catch((err) => ({ ok: false, message: err.message }));
    if (!r.ok) { b.disabled = false; return toast(r.message || t("失败"), true); }
    if (setVisible("trouble", visit)) { paintFix(r); fixTimer = setTimeout(() => followFix(visit), 1000); }
  });
  async function loadReconcile(run) {
    const visit = setVisit, live = () => setVisible("trouble", visit);
    if (!live()) return;
    const r = await api("/api/reconcile" + (run ? "?run=1" : "")).catch(() => null);
    if (!live()) return;
    if (r) paintReconcile(r, run);
    // 修补还在跑（比如关掉设置再打开）：接着显示进度
    if (r?.supported) sameGet("/api/reconcile/fix").then((j) => { if (j?.ok && j.running) followFix(visit, j); }).catch(() => {});
    return r;
  }
  $("btn-reconcile").addEventListener("click", async () => {
    // 按钮是「核对」：已有结果时点它也要重新核，不能第一次只把面板收起来（195-M.6）
    const visit = setVisit;
    toast(t("正在核对…"));
    const r = await loadReconcile(true);
    if (!setVisible("trouble", visit)) return;
    if (!r) toast(t("核对失败"), true);
    else if (!r.supported) toast(t("这里没有工具包，不用核对"));
  });
  // 本机自检（195-M.1）：看上次结果，点「重新自检」不等过期立刻重跑；跑着的时候每 5 秒刷新一次
  let envFactsTimer = 0;
  function paintEnvFacts(r, visit) {
    $("envfacts-row").classList.toggle("hidden", !r.supported);
    const el = $("envfacts-state"), b = $("btn-envfacts");
    b.disabled = !!r.running;
    const why = { timeout: t("超时了"), empty: t("没有输出") };
    const lines = [];
    if (r.running) lines.push(`<div>${esc(t("正在自检…（要一两分钟）"))}</div>`);
    if (r.at) lines.push(`<div>${esc(t("上次 {time}：通过 {pass} 项，失败 {fail} 项", { time: new Date(r.at).toLocaleString(), pass: r.pass, fail: r.fail.length }))}${r.stale ? " · " + esc(t("工具包或应用更新前测的")) : ""}</div>`);
    else if (!r.running) lines.push(`<div>${esc(t("还没有自检结果"))}</div>`);
    if (r.error && !r.running) lines.push(`<div class="warn">${esc(t("上次没跑出结果：{why}", { why: why[r.error] || r.error }))}</div>`);
    if (r.fail.length) lines.push(`<details><summary>${esc(t("失败项"))}</summary>${r.fail.map((f) => `<div><code>${esc(f)}</code></div>`).join("")}</details>`);
    el.innerHTML = lines.join("");
    clearTimeout(envFactsTimer);
    if (r.running) envFactsTimer = setTimeout(() => { if (setVisible("trouble", visit)) loadEnvFacts(); }, 5000);
  }
  async function loadEnvFacts() {
    const visit = setVisit;
    if (!setVisible("trouble", visit)) return;
    const r = await sameGet("/api/env-facts").catch(() => null);
    if (r && setVisible("trouble", visit)) paintEnvFacts(r, visit);
  }
  $("btn-envfacts").addEventListener("click", async () => {
    const visit = setVisit;
    const r = await post("/api/env-facts/rerun").catch((e) => (toast(e.message, true), null));
    if (r && setVisible("trouble", visit)) paintEnvFacts(r, visit);
  });
  const LEDGER_KIND = () => ({ verify: t("校验"), repair: t("修复"), install: t("安装"), uninstall: t("卸载"), recover: t("恢复"), "safe-mode": t("安全模式"), logs: t("日志") });
  $("btn-ledger").addEventListener("click", async () => {
    const box = $("ledger-list");
    if (!box.classList.contains("hidden")) { box.classList.add("hidden"); return; }
    // 读失败不能显示成「还没有记录」（审查 D-07）
    const r = await api("/api/ledger").catch((e) => ({ items: [], err: e.message }));
    if (r.err) { box.innerHTML = `<div class="tiny">${esc(t("修复账本读取失败：{msg}", { msg: r.err }))}</div>`; box.classList.remove("hidden"); return; }
    const K = LEDGER_KIND();
    box.innerHTML = (r.items || []).map((e) => `<div class="item ledger ${e.ok ? "" : "bad"}">
        <div class="it-meta"><span>${esc(new Date(e.at).toLocaleString())}</span><span class="badge">${esc(K[e.kind] || e.kind)}</span><span>${e.ok ? "✓" : "✗"}</span></div>
        <div class="it-title wrap">${esc(e.msg || "")}</div>
        ${e.detail && e.detail.samples && e.detail.samples.length ? `<div class="tiny mono">${e.detail.samples.slice(0, 5).map((x) => esc(typeof x === "string" ? x : JSON.stringify(x))).join("<br>")}</div>` : ""}
      </div>`).join("") || `<div class="tiny">${r.items === null ? t("这个版本没有修复账本。") : t("还没有记录。安装、校验、修复、启动时的恢复都会记在这里。")}</div>`;
    box.classList.remove("hidden");
  });


  // ── 常用指令（0.4.20）：commands 目录里的 <名字>.md，两个范围（所有项目 / 本项目），和 Hooks 那节一样用小标签切 ──
  const UC = { data: null, scope: localStorage.getItem("cc.cmdScope") || "user", edit: null };
  const ucScope = () => UC.data && UC.data.scopes.find((s) => s.scope === UC.scope);
  async function loadExtCmds() {
    try { UC.data = await api("/api/commands"); } catch (e) { $("ext-cmds").innerHTML = `<div class="tiny">${esc(e.message)}</div>`; return; }
    renderCmds();
  }
  function renderCmds() {
    const d = UC.data; if (!d) return;
    $("ext-c-count").textContent = d.scopes.reduce((a, s) => a + s.items.length, 0);
    const proj = String(d.workspace || "").split("/").pop() || d.workspace;
    const SC = { user: t("所有项目"), project: t("本项目（{name}）", { name: proj }) };
    $("cmd-scope").innerHTML = d.scopes.map((s) => `<button class="idx-chip${s.scope === UC.scope ? " on" : ""}" data-cscope="${esc(s.scope)}">${esc(SC[s.scope])}<span>${+s.items.length || 0}</span></button>`).join("");
    const sc = ucScope();
    if (!sc) return;
    if (sc.error) { $("ext-cmds").innerHTML = `<div class="tiny warn">${esc(sc.error)}</div>`; return; }
    $("ext-cmds").innerHTML = sc.items.map((c, i) => `<div class="item uc-item" data-i="${i}">
        <div class="it-title"><span class="mono">/${esc(c.name)}</span>${c.hint ? ` <span class="uc-hint">${esc(c.hint)}</span>` : ""}</div>
        ${c.description ? `<div class="tiny ext-desc">${esc(c.description)}</div>` : ""}
        <div class="it-snip">${esc(c.body.trim().slice(0, 240))}</div>
        <div class="it-acts"><button data-uc="use">${t("插入输入框")}</button>${c.editable ? `<button data-uc="edit">${t("修改")}</button>` : ""}<button data-uc="del">${t("删除")}</button></div></div>`).join("")
      || `<div class="tiny">${UC.scope === "user" ? t("还没有常用指令。点「新建指令」存一条。") : t("这个项目还没有自己的指令。存在这里的指令保存在项目里，项目进了 git 会跟着仓库走。")}</div>`;
  }
  function ucForm(c) {
    UC.edit = c ? c.name : "";
    const f = $("cmd-form");
    MO.cancel(f);   // 上一次「取消」的退场还没播完：它到点会把这张新表单藏掉、清空（审查 09-04）
    f.innerHTML = `
      <label class="tiny">${t("名字（输入框里打 /名字 调用；字母、数字、- 和 _）")}</label>
      <div class="uc-name"><span class="mono">/</span><input data-f="name" class="mono" maxlength="40" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="issue"></div>
      <label class="tiny">${t("说明（显示在 / 列表里，可不填）")}</label>
      <input data-f="description" maxlength="200" autocomplete="off" placeholder="${esc(t("例如：按议题模板整理问题"))}">
      <label class="tiny">${t("参数提示（可不填）")}</label>
      <input data-f="hint" maxlength="80" autocomplete="off" placeholder="${esc(t("例如：<问题描述>"))}">
      <label class="tiny">${t("指令内容（发给 Antigravity 的话；$ARGUMENTS 换成 /名字 后面跟的内容）")}</label>
      <textarea data-f="body" rows="7" spellcheck="false" placeholder="${esc(t("例如：把下面的问题整理成 GitHub 议题：标题一句话，正文分「现象」「复现步骤」「期望」三段。\n\n$ARGUMENTS"))}"></textarea>
      <div class="row-actions"><button class="btn sm" data-uc="f-save">${c ? t("保存修改") : t("添加")}</button>
        <button class="btn sm ghost" data-uc="f-cancel">${t("取消")}</button></div>`;
    const q = (k) => f.querySelector(`[data-f="${k}"]`);
    if (c) { q("name").value = c.name; q("description").value = c.description || ""; q("hint").value = c.hint || ""; q("body").value = c.body || ""; }
    f.classList.remove("hidden");
    MO.play(f, "mo-in-fade", 1400);
    f.scrollIntoView({ block: "nearest", behavior: "smooth" });
    q(c ? "body" : "name").focus({ preventScroll: true });
  }
  function ucClose() { UC.edit = null; const f = $("cmd-form"); MO.leave(f, "mo-out-fade", 170, () => { f.classList.add("hidden"); f.innerHTML = ""; }); }
  $("ext-c-new").addEventListener("click", () => ucForm(null));
  $("ext-cmd-sec").addEventListener("click", async (e) => {
    const chip = e.target.closest("[data-cscope]");
    if (chip) { UC.scope = chip.dataset.cscope; localStorage.setItem("cc.cmdScope", UC.scope); if (UC.edit != null) ucClose(); return renderCmds(); }
    const b = e.target.closest("[data-uc]"); if (!b) return;
    const sc = ucScope(), it = b.closest(".uc-item"), c = it && sc ? sc.items[+it.dataset.i] : null;
    const act = b.dataset.uc;
    // 发行版把指令经合成插件交给 Antigravity，实际名字是 /user:<名字>；插入裸名会展开不了（195-J.6）
    // 插到光标处，别把还没发的草稿整个盖掉（196 输入框域；insertAtCursor 是输入框统一入口）
    if (act === "use" && c) { closePage(); insertAtCursor((UC.data.sealed ? "/user:" : "/") + c.name); inputEl.focus(); return; }
    if (act === "edit" && c) return ucForm(c);
    if (act === "del" && c) {
      if (!confirm(t("删除指令 /{name}？", { name: c.name }))) return;
      const r = await post("/api/commands/del", { scope: UC.scope, dir: UC.data.workspace, name: c.name }).catch((err) => ({ ok: false, message: err.message }));
      if (!r.ok) return toast(r.message, true);
      if (MO.on() && it.animate) await it.animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateX(${MO.rtl() ? 24 : -24}px)` }], { duration: 155, easing: "cubic-bezier(.4,0,1,1)", fill: "forwards" }).finished.catch(() => {});
      await loadExtCmds(); loadCaps();
      return;
    }
    if (act === "f-cancel") return ucClose();
    if (act === "f-save") {
      const f = $("cmd-form"), q = (k) => f.querySelector(`[data-f="${k}"]`).value;
      const body = { scope: UC.scope, dir: UC.data.workspace, name: q("name").trim().replace(/^\//, ""), description: q("description"), hint: q("hint"), body: q("body") };
      if (UC.edit) { if (UC.edit !== body.name) body.oldName = UC.edit; } else body.fresh = true;
      const r = await post("/api/commands/save", body).catch((err) => ({ ok: false, message: err.message }));
      if (!r.ok) return toast(t("保存失败：{msg}", { msg: t(r.message || "") }), true);
      toast(t("已保存 /{name}，输入框里打 / 就能用", { name: r.name }));
      ucClose(); await loadExtCmds(); loadCaps();
      const row = [...document.querySelectorAll("#ext-cmds .uc-item .mono")].find((x) => x.textContent === "/" + r.name);
      if (row) MO.play(row.closest(".uc-item"), "mo-in-rise", 1400);
    }
  });
