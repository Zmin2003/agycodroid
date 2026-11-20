package cc.agyroid;

import android.system.Os;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.BufferedReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.zip.GZIPInputStream;
import org.json.JSONObject;

/** 首次安装：把 devkit tar 解到 files/ 下、跑 first-run、再装官方 Antigravity CLI。全程只写本应用私有目录。 */
final class Installer {
    interface Progress { void step(String msg); void bytes(long done, long total); }

    private final Env env;
    private final Progress ui;

    Installer(Env env, Progress ui) { this.env = env; this.ui = ui; }
    void step(String m) { ui.step(m); }

    /** 下载中途被取消（点了停止 / 服务停住）：不是网络错，不重试、不换源，直接中断（gateway L3） */
    static final class Cancelled extends IOException { Cancelled() { super("cancelled"); } }

    /** 下载取消钩子：网关取回时 GwRuntime 挂上 () -> stopping || paused；其他下载（工具包更新等）不挂，不影响 */
    volatile java.util.function.BooleanSupplier cancelCheck;
    private boolean cancelled() { java.util.function.BooleanSupplier c = cancelCheck; return c != null && c.getAsBoolean(); }

    // ── devkit 下载 ────────────────────────────────────────────────────
    /** 没有自己的镜像站：这个常量不再指向镜像，只是拼 GitHub Release 目录的另一种写法
     *  （GwRuntime 取回网关运行库时仍在引用它，先留着名字；拼出来的地址与 devkit-pin.json 的 base 是同一份文件，照样核 sha256）。
     *  工具包的下载源以 devkit-pin.json 的 base 为准。 */
    static final String DEVKIT_MIRROR = "https://github.com/" + Updater.REPO + "/releases/download/";

    /**
     * 首次安装：按 APK 自带的清单（assets/devkit-pin.json：gz 的文件名、大小、sha256）下载 .tar.gz 到私有目录 ——
     * 断点续传（Range）、失败重试，首选地址连着失败就换备用地址接着同一个 .part 续传，sha256 对上才交给 installDevkit。
     * 校验值来自 APK 本身，所以镜像不需要被信任。先落盘再解压：边下边解的话网络一断就得从头来。
     * @param primary/alt 首选与备用的完整下载地址（GitHub / 镜像，按用户选的顺序）
     * @return 校验过的本地 .tar.gz
     */
    File downloadDevkit(JSONObject pin, String primary, String alt) throws IOException {
        JSONObject gz = pin.optJSONObject("gz"), tarInfo = pin.optJSONObject("tar");
        if (gz == null) throw new IOException(Tr.t("APK 里的工具包清单坏了"));
        String name = gz.optString("file"), sha = gz.optString("sha256");
        long size = gz.optLong("bytes");
        File done = new File(env.files, name), part = new File(env.files, name + ".part");
        lastBase = pin.optString("base"); lastSha = sha;
        lastTarSha = tarInfo != null ? tarInfo.optString("sha256", null) : null;
        // 空间先算清再下：下到一半才报「No space left」，用户白等十分钟还看不懂。
        // 峰值 = 还没下完的压缩包 + 解开后的全部文件（压缩包解完才删）+ Antigravity CLI 与余量
        long have = done.isFile() ? done.length() : part.length();
        long tarBytes = tarInfo != null ? tarInfo.optLong("bytes", 0) : 0;
        long need = Math.max(0, size - have) + (tarBytes > 0 ? tarBytes : size * 3) + (400L << 20);
        long free = new android.os.StatFs(env.files.getPath()).getAvailableBytes();
        if (free < need) throw new NoSpace(need, free);
        ui.step(Tr.t("下载来源：") + host(primary));
        ui.step(String.format(Tr.t("下载开发工具包 %.0f MB%s…"), size / 1048576.0, part.length() > 0 ? String.format(Tr.t("（续传，已有 %.0f MB）"), part.length() / 1048576.0) : ""));
        File f = download(primary, alt, done, size, sha);
        ui.step(Tr.t("✓ sha256 与清单一致"));
        return f;
    }

    static String host(String url) {
        try { return new URL(url).getHost(); } catch (Exception e) { return url; }
    }

    /** 存储空间不够：消息直接给用户看，写清要多少、还剩多少 */
    static final class NoSpace extends IOException {
        NoSpace(long need, long free) {
            super(String.format(java.util.Locale.ROOT, Tr.t("存储空间不够：安装需要约 %.1f GB，手机里目前只剩 %.1f GB。清理出空间后点「重试」即可（已下载的部分会保留）。"),
                need / 1073741824.0, free / 1073741824.0));
        }
    }

    /** 最近一次 downloadDevkit 用的 Release 目录、gz 与 tar 的 sha256（installDevkit 记进 .devkit-ok，更新检查据此比对） */
    String lastBase, lastSha, lastTarSha;

    /**
     * 通用下载：断点续传 + 重试 + sha256（sha 为 null 则不校验）。.part 旁边的 .sha256 记着它属于哪个版本，
     * 换了版本就作废重下，别把两个版本拼在一起。
     */
    File download(String url, File done, long size, String sha) throws IOException { return download(url, (String) null, done, size, sha); }

    /** alt：备用地址（同一个文件的镜像）。主地址连着失败两次就换过去，接着同一个 .part 续传；内容由 sha256 把关，镜像不需要被信任 */
    File download(String url, String alt, File done, long size, String sha) throws IOException { return download(url, new String[]{ alt }, done, size, sha); }

    /** alts：按顺序的备用地址（空的跳过）；全换完了最后还有 gh-proxy 兜底 */
    File download(String url, String[] alts, File done, long size, String sha) throws IOException {
        if (done.isFile() && (size <= 0 || done.length() == size) && (sha == null || sha.equals(sha256(done)))) return done;
        File part = new File(done.getPath() + ".part"), tag = new File(done.getPath() + ".sha256"), seg = new File(part.getPath() + ".seg");
        done.getParentFile().mkdirs();
        String id = sha != null ? sha : url;
        if (!tag.isFile() || !id.equals(new String(java.nio.file.Files.readAllBytes(tag.toPath()), StandardCharsets.UTF_8).trim())) {
            part.delete(); seg.delete();
            write(tag, id + "\n");
        }
        // 候选来源：主地址、备用地址，最后是 GitHub 地址经 gh-proxy.com 加速（第三方，内容照样按 sha256 把关）。
        // 主地址和备用地址不再按写死的顺序排：先各要一小段测速，谁快谁当主，其余按快慢备用（群友 10-31：不开代理时 GitHub 卡住，镜像却通）。
        // gh-proxy 不参与测速、始终垫底：第三方，前面的都不行才去碰它
        java.util.List<String> cands = new java.util.ArrayList<>();
        cands.add(url);
        String proxy = ghProxy(url);
        for (String a : alts) if (a != null && !cands.contains(a)) { cands.add(a); if (proxy == null) proxy = ghProxy(a); }
        if (cands.size() > 1 && (hostRank != null || size >= PROBE * 4)) {
            if (hostRank == null) ui.step("  " + Tr.t("测速中…"));
            cands = rank(cands, size);
        }
        if (proxy != null && !cands.contains(proxy)) cands.add(proxy);
        // 这个 Installer 里给过校验不对的文件的主机：往后的文件（工具包按模块连着下）不再先找它，只留作最后的兜底
        java.util.List<String> good = new java.util.ArrayList<>(), shunned = new java.util.ArrayList<>();
        for (String c : cands) (badHosts.contains(host(c)) ? shunned : good).add(c);
        if (!good.isEmpty()) { good.addAll(shunned); cands = good; }
        url = cands.get(0);
        if (cands.size() > 1) ui.step("  " + Tr.t("下载来源：") + host(url));
        java.util.ArrayDeque<String> left = new java.util.ArrayDeque<>(cands.subList(1, cands.size()));
        java.util.Set<String> tried = new java.util.HashSet<>();
        tried.add(url);
        boolean noRange = false;   // 来源不认 Range 后退回单线：本次下载只回退一次，避免删段→重建→再删的死循环
        for (int attempt = 1; ; ) {
            if (cancelled()) throw new Cancelled();
            for (; size <= 0 || part.length() < size || seg.isFile(); attempt++) {
                try { if (size >= 2 * MIN_SEG && !noRange && (seg.isFile() || rangeOk(url))) fetchSegmented(url, part, seg, size); else { fetchRange(url, part, size); if (size <= 0) break; } }
                catch (IOException e) {
                    if (e instanceof Cancelled) throw e;   // 点了停止 / 停住：直接中断，别当成网络错重试换源
                    // 残留 .part.seg 但来源不认 Range（回 200）：fetchSegmented 每段都要求 206，会永远失败。
                    // 删掉分段状态，退回单线 fetchRange，别让更新永久卡住（审查 11-05）
                    String em = String.valueOf(e.getMessage());
                    if (!noRange && seg.isFile() && em.startsWith("HTTP ") && !em.startsWith("HTTP 206")) { noRange = true; seg.delete(); part.delete(); continue; }
                    String next = left.peek();
                    if (next != null && attempt < 12) {      // 出一次错就换下一个，换下来的排到队尾，轮着来
                        ui.step("  " + Tr.f("{0} 下载不顺（{1}），改从 {2} 续传…", host(url), e.getMessage(), host(next)));
                        left.add(url);
                        url = left.poll();
                        // 一圈都试过了还不行：多半是网断了，歇一会儿再轮
                        if (!tried.add(url)) try { Thread.sleep(Math.min(attempt * 2000L, 20000L)); } catch (InterruptedException ie) { throw new IOException(ie); }
                        continue;
                    }
                    if (next != null) throw e;
                    // 慢但没断、又没别的来源可换：不算失败次数，接着续传（已下的不丢）——总比报错强
                    if (e instanceof SlowException) {
                        attempt--;
                        ui.step("  " + Tr.f("{0} 很慢（{1}），没有别的来源可换，接着下…", host(url), e.getMessage()));
                        continue;
                    }
                    if (attempt >= 8) throw e;
                    ui.step("  " + Tr.f("网络中断（{0}），{1} 秒后续传…", e.getMessage(), attempt * 3));
                    try { Thread.sleep(attempt * 3000L); } catch (InterruptedException ie) { throw new IOException(ie); }
                }
            }
            if (sha == null) break;
            String got = sha256(part);
            if (sha.equals(got)) break;
            part.delete(); seg.delete();
            IOException bad = new IOException(Tr.f("sha256 不符（期望 {0}…，实得 {1}…）", head12(sha), got.substring(0, 12)));
            // 大小对、内容不对：这一份是谁给的说不准（中途可能换过源），至少当前这个不再用；换下一个从头下，都换完了才报错。
            // 坏来源装不进去这一点不变，只是别让它把重试也吃死
            String next = left.poll();
            if (next == null || attempt >= 12) throw bad;
            ui.step("  " + Tr.f("{0} 下来的文件校验不对，改从 {1} 重下…", host(url), host(next)));
            badHosts.add(host(url));
            url = next;
            attempt++;
        }
        done.delete();
        if (!part.renameTo(done)) throw new IOException(Tr.t("换名失败: ") + part);
        tag.delete();
        lastHost = host(url);
        return done;
    }

    private final java.util.Set<String> badHosts = new java.util.HashSet<>();

    /** 最近一次 download 最后是从哪台主机下完的（更新页写明来源） */
    String lastHost;

    // ── 来源测速 ──
    // 每个来源同时要头 256 KB，按收完的用时排；第一个测完后最多再等 3 秒，没测完的排在测完的后面。
    // 连不上的排到最后（可能只是一时不通，留作兜底）；回的总大小对不上的直接剔除（指错了文件）。
    // 同一个 Installer 下多个文件（工具包按模块下）只测第一次，后面照这个名次排
    static final int PROBE = 256 << 10;
    private java.util.List<String> hostRank;

    private java.util.List<String> rank(java.util.List<String> cands, long size) throws IOException {
        if (hostRank != null) {
            java.util.List<String> r = new java.util.ArrayList<>(cands);
            java.util.Collections.sort(r, (a, b) -> Integer.compare(rankOf(a), rankOf(b)));     // 稳定排序：没测过的主机保持原顺序排在后面
            return r;
        }
        final int n = cands.size();
        final long[] ms = new long[n];
        final boolean[] fin = new boolean[n];
        final Object lk = new Object();
        for (int i = 0; i < n; i++) {
            final int k = i;
            Thread t = new Thread(() -> {
                long v = probe(cands.get(k), size);
                synchronized (lk) { ms[k] = v; fin[k] = true; lk.notifyAll(); }
            }, "probe-" + i);
            t.setDaemon(true);
            t.start();
        }
        long t0 = System.currentTimeMillis(), firstOk = 0;
        synchronized (lk) {
            for (;;) {
                if (cancelled()) throw new Cancelled();   // 测速最多等 15 秒：点了停止别等满
                boolean all = true;
                for (int i = 0; i < n; i++) { all &= fin[i]; if (fin[i] && ms[i] > 0 && firstOk == 0) firstOk = System.currentTimeMillis(); }
                long now = System.currentTimeMillis();
                if (all || now - t0 >= 15000 || firstOk > 0 && now - firstOk >= 3000) break;
                try { lk.wait(250); } catch (InterruptedException e) { break; }
            }
            java.util.List<Integer> ok = new java.util.ArrayList<>(), pending = new java.util.ArrayList<>(), down = new java.util.ArrayList<>();
            for (int i = 0; i < n; i++) {
                if (!fin[i]) pending.add(i);
                else if (ms[i] > 0) ok.add(i);
                else if (ms[i] == -1) down.add(i);         // -2 大小不符：剔除
            }
            java.util.Collections.sort(ok, (a, b) -> Long.compare(ms[a], ms[b]));
            java.util.List<String> r = new java.util.ArrayList<>();
            StringBuilder log = new StringBuilder();
            for (java.util.List<Integer> g : java.util.Arrays.asList(ok, pending, down)) for (int i : g) r.add(cands.get(i));
            for (int i = 0; i < n; i++) log.append(host(cands.get(i))).append('=').append(!fin[i] ? "?" : ms[i] > 0 ? (ms[i] % NO_RANGE) + (ms[i] >= NO_RANGE ? "ms/no-range" : "ms") : ms[i] == -1 ? "down" : "mismatch").append(' ');
            android.util.Log.i("Installer", "来源测速 " + log.toString().trim());
            if (r.isEmpty()) return cands;      // 全都对不上大小：多半是清单写错了，按原顺序下，最后由 sha256 说话
            if (!ok.isEmpty()) { hostRank = new java.util.ArrayList<>(); for (String u : r) hostRank.add(host(u)); }
            return r;
        }
    }

    private int rankOf(String url) {
        int i = hostRank.indexOf(host(url));
        return i < 0 ? hostRank.size() : i;
    }

    static final long NO_RANGE = 1_000_000;

    /** 要头 PROBE 字节，返回收完的毫秒数（至少 1，不认 Range 的另加 NO_RANGE）；连不上/出错 -1；总大小与清单不符 -2 */
    static long probe(String url, long size) {
        long t0 = System.currentTimeMillis();
        HttpURLConnection c = null;
        try {
            c = open(url);
            c.setConnectTimeout(10000);
            c.setReadTimeout(10000);
            c.setRequestProperty("Range", "bytes=0-" + (PROBE - 1));
            int code = code(c, url);
            if (code == 206) {
                String cr = c.getHeaderField("Content-Range");
                int slash = cr == null ? -1 : cr.lastIndexOf('/');
                if (size > 0 && slash >= 0 && !"*".equals(cr.substring(slash + 1).trim()) && Long.parseLong(cr.substring(slash + 1).trim()) != size) return -2;
            } else if (code == 200) {
                long len = c.getContentLengthLong();
                if (size > 0 && len >= 0 && len != size) return -2;
            } else return -1;
            long want = size > 0 ? Math.min(PROBE, size) : PROBE, got = 0;
            byte[] buf = new byte[1 << 15];
            try (InputStream in = c.getInputStream()) {
                for (int r; got < want && (r = in.read(buf)) > 0; ) got += r;
            }
            if (got < want) return -1;
            // 不认 Range 的（回 200）排在认的后面：大文件分段下、续传都用不了它，轮到它就得从头来
            return Math.max(1, System.currentTimeMillis() - t0) + (code == 200 ? NO_RANGE : 0);
        } catch (IOException | RuntimeException e) {
            return -1;
        } finally { if (c != null) c.disconnect(); }
    }

    static byte[] httpGetSmall(String url) throws IOException { return httpGetSmall(url, 0); }
    /** timeoutMs > 0：连接和读都按它掐（总预算剩多少给多少），0 = 默认的 20 / 60 秒 */
    static byte[] httpGetSmall(String url, int timeoutMs) throws IOException {
        HttpURLConnection c = open(url);
        if (timeoutMs > 0) { c.setConnectTimeout(timeoutMs); c.setReadTimeout(timeoutMs); }
        try {
            if (code(c, url) != 200) throw new IOException("HTTP " + c.getResponseCode() + " " + url);
            // 只用来拿发布清单、锁文件、校验和这类小东西：读超过 32 MB 就是地址指错了或者对面出了问题，不往内存里塞（审查 v0.5.7 L10）
            if (c.getContentLengthLong() > SMALL_MAX) throw new IOException(Tr.t("响应太大，不像清单文件：") + url);
            try (InputStream in = c.getInputStream()) { return readAllBytes(in, SMALL_MAX); }
        } finally { c.disconnect(); }
    }
    static final long SMALL_MAX = 32L << 20;

    // ── 分段并行下载 ──
    // 单个连接常被限速（实测单线 2.7 MB/s，4 路并行 14 MB/s）：文件够大、服务器认 Range 时，
    // 把没下的部分切成几段、各开一条连接同时下，按偏移写进同一个 .part（先占满到总大小）。
    // 每段进度记在 .part.seg（每行「起 止 已下」，每秒落盘，只会比实际写入的少），被打断、换来源后按它续传；
    // 几个来源是逐字节同一份文件，最后照样核 sha256。和 gw/pget.mjs 是同一套做法
    static final int SEGS = 4;
    static final long MIN_SEG = 8L << 20;

    static String ghProxy(String url) {
        return url != null && url.startsWith("https://github.com/") ? "https://gh-proxy.com/" + url.substring("https://".length()) : null;
    }

    /** 认不认 Range：要 1 个字节，回 206 才算 */
    static boolean rangeOk(String url) {
        try {
            HttpURLConnection c = open(url);
            c.setRequestProperty("Range", "bytes=0-0");
            try { return c.getResponseCode() == 206; } finally { c.disconnect(); }
        } catch (IOException e) { return false; }
    }

    private void fetchSegmented(String url, File part, File segF, long size) throws IOException {
        long[][] segs = null;
        if (segF.isFile() && part.length() == size) {
            try {
                String[] ls = new String(java.nio.file.Files.readAllBytes(segF.toPath()), StandardCharsets.UTF_8).trim().split("\n");
                segs = new long[ls.length][];
                for (int i = 0; i < ls.length; i++) { String[] t = ls[i].trim().split(" "); segs[i] = new long[]{ Long.parseLong(t[0]), Long.parseLong(t[1]), Long.parseLong(t[2]) }; }
                if (segs.length == 0 || segs[segs.length - 1][1] != size - 1) segs = null;
            } catch (RuntimeException e) { segs = null; }
        }
        if (segs == null) {
            // .seg 坏了或和 .part 对不上：作废；以前单线下了一截的 .part（没有 .seg）从它末尾往后切
            long from = segF.isFile() ? 0 : Math.min(part.length(), size);
            if (segF.isFile()) { segF.delete(); part.delete(); }
            long left = size - from;
            int k = (int) Math.max(1, Math.min(SEGS, left / MIN_SEG));
            segs = new long[k][];
            for (int i = 0; i < k; i++) segs[i] = new long[]{ from + left * i / k, from + left * (i + 1) / k - 1, 0 };
            saveSegs(segF, segs);
        }
        try (java.io.RandomAccessFile raf = new java.io.RandomAccessFile(part, "rw")) { raf.setLength(size); }
        final long[][] S = segs;
        final IOException[] err = new IOException[1];
        Thread[] ts = new Thread[S.length];
        for (int i = 0; i < S.length; i++) {
            final long[] sg = S[i];
            ts[i] = new Thread(() -> {
                for (int a = 0; sg[2] < sg[1] - sg[0] + 1; a++) {
                    try { fetchPiece(url, part, sg); }
                    catch (IOException e) {
                        if (e instanceof Cancelled) { synchronized (err) { if (err[0] == null) err[0] = e; } return; }   // 点了停止：立即收手，别睡两秒再重试
                        if (a >= 2) { synchronized (err) { if (err[0] == null) err[0] = e; } return; }
                        try { Thread.sleep(2000L * (a + 1)); } catch (InterruptedException ie) { return; }
                    }
                }
            }, "seg-" + i);
            ts[i].start();
        }
        for (boolean alive = true; alive; ) {
            alive = false;
            for (Thread t : ts) { try { t.join(1000); } catch (InterruptedException e) { throw new IOException(e); } alive |= t.isAlive(); }
            if (cancelled()) throw new Cancelled();   // 段线程在 fetchPiece 里也会查到，自己停；这里不等它们慢慢下完
            saveSegs(segF, S);
            long left = 0; for (long[] sg : S) left += sg[1] - sg[0] + 1 - sg[2];
            ui.bytes(size - left, size);
        }
        if (err[0] != null) throw err[0];
        segF.delete();
    }

    private static void saveSegs(File f, long[][] segs) {
        StringBuilder b = new StringBuilder();
        synchronized (segs) { for (long[] s : segs) b.append(s[0]).append(' ').append(s[1]).append(' ').append(s[2]).append('\n'); }
        try { write(f, b.toString()); } catch (IOException ignored) {}
    }

    /** 下一段：从 sg 已下的位置接着要到段尾，按偏移写进 part */
    private void fetchPiece(String url, File part, long[] sg) throws IOException {
        HttpURLConnection c = open(url);
        c.setRequestProperty("Range", "bytes=" + (sg[0] + sg[2]) + "-" + sg[1]);
        try {
            if (code(c, url) != 206) throw new IOException("HTTP " + c.getResponseCode());
            try (InputStream in = new BufferedInputStream(c.getInputStream(), 1 << 16);
                 java.io.RandomAccessFile raf = new java.io.RandomAccessFile(part, "rw")) {
                byte[] buf = new byte[1 << 16];
                Slow slow = new Slow();
                for (int r; (r = in.read(buf)) > 0; ) {
                    if (cancelled()) throw new Cancelled();   // 每 64 KB 查一次：点了停止就中断这段，别等整段下完
                    slow.add(r);
                    long room = sg[1] - sg[0] + 1 - sg[2];
                    int n = (int) Math.min(r, room);
                    raf.seek(sg[0] + sg[2]);
                    raf.write(buf, 0, n);
                    sg[2] += n;
                    if (sg[2] >= sg[1] - sg[0] + 1) break;
                }
            }
            if (sg[2] < sg[1] - sg[0] + 1) throw new IOException(Tr.t("连接提前结束"));
        } finally { c.disconnect(); }
    }

    /** 从 part 现有长度续传到结束；服务器不认 Range（回 200）就从头写 */
    private void fetchRange(String url, File part, long size) throws IOException {
        long have = part.length();
        HttpURLConnection c = open(url);
        if (have > 0) c.setRequestProperty("Range", "bytes=" + have + "-");
        try {
            int code = code(c, url);
            boolean append = code == 206;
            if (code != 200 && code != 206) throw new IOException("HTTP " + code);
            if (!append) have = 0;
            try (InputStream in = new BufferedInputStream(c.getInputStream(), 1 << 16);
                 OutputStream out = new FileOutputStream(part, append)) {
                byte[] buf = new byte[1 << 16];
                long tick = 0;
                Slow slow = new Slow();
                for (int r; (r = in.read(buf)) > 0; ) {
                    out.write(buf, 0, r);
                    have += r;
                    slow.add(r);
                    // 每秒报一次进度：以前每 2 MB 报一次，慢的时候界面一直停在 0%，看着像死了
                    long now = System.currentTimeMillis();
                    if (now - tick >= 1000) { tick = now; ui.bytes(have, size); if (cancelled()) throw new Cancelled(); }
                }
            }
            ui.bytes(have, size);
            // 对面干脆利落地提前关了连接：当作出错，好走重试/换源的计数，别无声无息地一遍遍重连
            if (size > 0 && have < size) throw new IOException(Tr.t("连接提前结束"));
        } finally { c.disconnect(); }
    }

    /**
     * 低速判定：每 30 秒一窗，这一窗不到 600 KB（平均 20 KB/s）就抛错，交给上面的重试 / 换来源。
     * 读超时只管「一个字节都不来」；连接不断、却一点点往下滴的（群友报的 GitHub 挂着梯子也是这样）会一直耗着不换源。
     * 与 install-agy.mjs 的规则一致
     */
    static final class SlowException extends IOException { SlowException(String m) { super(m); } }

    static final class Slow {
        static final long WINDOW = 30_000, MIN = 600L << 10;
        long t0 = System.currentTimeMillis(), n;
        void add(int r) throws IOException {
            n += r;
            long now = System.currentTimeMillis();
            if (now - t0 < WINDOW) return;
            if (n < MIN) throw new SlowException(Tr.f("太慢（30 秒只下了 {0} KB）", n >> 10));
            t0 = now; n = 0;
        }
    }

    /** 取响应码；https 被重定向成了 http 就不认：内容有哈希兜底，但下了什么会被路上看见（审查 10-29 L14） */
    static int code(HttpURLConnection c, String url) throws IOException {
        int code = c.getResponseCode();
        if (url.startsWith("https:") && !"https".equals(c.getURL().getProtocol())) throw new IOException(Tr.t("下载地址被重定向到了不加密的 http，没有下载"));
        return code;
    }

    static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setInstanceFollowRedirects(true);      // GitHub Release 会 302 到 objects.githubusercontent.com
        c.setConnectTimeout(20000);
        c.setReadTimeout(60000);                 // 60 秒没来一个字节就当断了，交给续传
        return c;
    }

    static String sha256(File f) throws IOException {
        try (InputStream in = new FileInputStream(f)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 20];
            for (int r; (r = in.read(buf)) > 0; ) md.update(buf, 0, r);
            return hex(md.digest());
        } catch (java.security.NoSuchAlgorithmException e) { throw new IOException(e); }
    }

    private static byte[] readAllBytes(InputStream in, long max) throws IOException {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int r; (r = in.read(buf)) > 0; ) {
            if (b.size() + (long) r > max) throw new IOException(Tr.t("响应太大，不像清单文件"));
            b.write(buf, 0, r);
        }
        return b.toByteArray();
    }

    // ── devkit ─────────────────────────────────────────────────────────
    //
    // 替换分四步，每一步被打断（进程被杀、APK 升级重启、没电）都能在下次启动时由 recover() 收拾干净：
    //   1. 解到 usr.new/，边解边算 tar 的 sha256，和清单对不上就整个丢掉 —— 旧工具包一根毫毛不动
    //   2. 校验通过后在 usr.new/ 里写 .devkit-pending（要装成哪一版）
    //   3. usr → usr.old，usr.new → usr（两次换名）
    //   4. finish()：搬用户自装的东西、first-run、写 .devkit-ok、删 usr.old
    // .devkit-ok 是最后写的：没有它，网关不会启动，更新检查也不会把这份工具包当成装好了。
    static final String PENDING = ".devkit-pending";
    File usrNew() { return new File(env.files, "usr.new"); }
    File usrOld() { return new File(env.files, "usr.old"); }

    void installDevkit(String source) throws IOException { installDevkit(source, lastBase, lastSha, lastTarSha); }

    /** @param base/sha/tarSha 这份工具包来自哪个 Release、gz 与 tar 的 sha256（本地文件安装时可为 null）—— 写进 .devkit-ok，更新检查拿它比 */
    void installDevkit(String source, String base, String sha, String tarSha) throws IOException {
        // 本地文件没给 sha：自己算一个。已装记录里有了内容身份，更新检查才不会把它误认成别的版本
        if (sha == null && !source.startsWith("http")) { ui.step(Tr.t("计算工具包校验和…")); sha = sha256(new File(source)); }
        InputStream raw; long total;
        if (source.startsWith("http")) {
            HttpURLConnection c = (HttpURLConnection) new URL(source).openConnection();
            c.setInstanceFollowRedirects(true);
            raw = c.getInputStream(); total = c.getContentLengthLong();
        } else {
            File f = new File(source);
            raw = new FileInputStream(f); total = f.length();
        }
        installDevkit(raw, total, source.endsWith(".gz"), base, sha, tarSha);
    }

    /** 本地文件（系统文件选择器给的 content://）的来源：要读两遍（先认身份、再解包），所以给个能重开的入口 */
    interface Source { InputStream open() throws IOException; }

    /** 认本地包：读一遍算 sha256，看开头是不是 gzip（content:// 不一定有文件名）。返回 {sha256, "gz"|"tar"} */
    String[] scanLocal(Source src, long total) throws IOException {
        ui.step(Tr.t("核对文件…"));
        try (InputStream in = new BufferedInputStream(src.open(), 1 << 20)) {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 20];
            long n = 0, tick = 0;
            int b0 = -1, b1 = -1;
            for (int r; (r = in.read(buf)) > 0; ) {
                if (n == 0 && r >= 2) { b0 = buf[0] & 0xff; b1 = buf[1] & 0xff; }
                md.update(buf, 0, r);
                n += r;
                if (n - tick > (8 << 20)) { tick = n; ui.bytes(n, total); }
            }
            ui.bytes(n, total);
            if (n < 1024) throw new IOException(Tr.t("文件太小，不是工具包"));
            return new String[]{hex(md.digest()), b0 == 0x1f && b1 == 0x8b ? "gz" : "tar"};
        } catch (java.security.NoSuchAlgorithmException e) { throw new IOException(e); }
    }

    /** 从流解包安装。tarSha 非空时边解边核，对不上整个丢掉、旧工具包不动（读两遍之间文件被换掉也拦得住） */
    void installDevkit(InputStream raw, long total, boolean gzip, String base, String sha, String tarSha) throws IOException {
        // 入口校验（H2/M4）：没有来源记录（base 为空）的包不装；没解压的 .tar 又没有 tar 校验值时也不装 ——
        // .gz 的 tar 是从已核过 sha256 的 gz 里解出来的，内容有间接保证；.tar 没有这层保证
        if (base == null || base.isEmpty()) throw new IOException(Tr.t("工具包没有来源记录（不知道是哪一版），不安装"));
        if (!gzip && (tarSha == null || tarSha.isEmpty())) throw new IOException(Tr.t("工具包清单里没有 tar 校验值，不安装"));
        ui.step(Tr.t("解包开发工具包…"));
        File tmp = usrNew();
        deleteTree(tmp);
        tmp.mkdirs();
        String got = extractInto(tmp, raw, total, gzip, tarSha);
        JSONObject p = new JSONObject();
        try { p.put("base", base == null ? "" : base).put("sha256", sha == null ? "" : sha).put("tarSha256", got); }
        catch (org.json.JSONException ignored) {}
        write(new File(tmp, PENDING), p + "\n");
        swapIn(tmp);
        finish();
    }

    /** 解一个 tar(.gz) 到 dir（叠加，不先清空），边解边算 tar 的 sha256；tarSha 非空时对不上就整个删掉 dir、抛错。返回实得的 sha256 */
    String extractInto(File dir, InputStream raw, long total, boolean gzip, String tarSha) throws IOException {
        return extractInto(dir, raw, total, gzip, tarSha, null);
    }

    /** @param only 非空时只解包里解包后相对路径在 only 里的条目（网关取回：只要 missing 的 45 个文件，不解整包）。
     *  跳过的条目照样从流里读过去，tar 的 sha256 校验不受影响（skip 是读不是跳）。目录条目跳过无妨，文件条目自己建父目录 */
    String extractInto(File dir, InputStream raw, long total, boolean gzip, String tarSha, java.util.Set<String> only) throws IOException {
        Counting in = new Counting(new BufferedInputStream(raw, 1 << 20), total);
        MessageDigest md;
        try { md = MessageDigest.getInstance("SHA-256"); } catch (java.security.NoSuchAlgorithmException e) { throw new IOException(e); }
        java.security.DigestInputStream s = new java.security.DigestInputStream(gzip ? new GZIPInputStream(in, 1 << 16) : in, md);
        try {
            untar(s, dir, "usr/", only);
            byte[] sink = new byte[1 << 16];
            while (s.read(sink) > 0) { }            // tar 末尾的填充块也算进校验和
        } catch (IOException | RuntimeException e) {     // 畸形包抛的运行时异常也要清掉半成品（审查 v0.5.7 L9）
            deleteTree(dir);
            throw new IOException(Tr.t("解包失败，旧工具包未改动：") + e.getMessage(), e);
        } finally { s.close(); }
        String got = hex(md.digest());
        if (tarSha != null && !tarSha.isEmpty() && !tarSha.equals(got)) {
            deleteTree(dir);
            throw new IOException(Tr.f("解出来的内容与清单不符（tar sha256 期望 {0}…，实得 {1}…），旧工具包未改动", head12(tarSha), got.substring(0, 12)));
        }
        return got;
    }

    // ── 模块化工具包（0.3.9 起）：基础块 + 选中的模块一起解到 usr.new，全部核过才换上 ──
    // modules.json 来自 APK 的钉子（首装）或 GitHub Release（更新，验过 ed25519 签名），里面有每块 gz / tar 的 sha256；下载源不需要被信任。
    // 每块的 first-run 与 MANIFEST 在它的 dir（基础块是 libexec/devkit，其余 libexec/devkit/modules/<id>）；
    // 装好的块在 dir 里写 .ok。之后单个模块的加装 / 卸载由网关（gw/modules.mjs）做。
    static final String MODULES_JSON = "libexec/devkit/modules.json";

    /** 依赖闭包，按依赖顺序（基础块在最前）。不认识的 id 抛错 */
    static java.util.List<JSONObject> moduleOrder(JSONObject mj, java.util.Collection<String> want) throws IOException {
        java.util.Map<String, JSONObject> by = new java.util.LinkedHashMap<>();
        org.json.JSONArray all = mj.optJSONArray("modules");
        if (all == null) throw new IOException(Tr.t("模块清单坏了"));
        for (int i = 0; i < all.length(); i++) { JSONObject m = all.optJSONObject(i); if (m != null) by.put(m.optString("id"), m); }
        java.util.LinkedHashSet<String> out = new java.util.LinkedHashSet<>();
        java.util.List<String> todo = new java.util.ArrayList<>();
        for (JSONObject m : by.values()) if (m.optBoolean("required")) todo.add(m.optString("id"));
        todo.addAll(want);
        for (String id : todo) addWithDeps(by, id, out, new java.util.HashSet<>());
        java.util.List<JSONObject> r = new java.util.ArrayList<>();
        for (String id : out) r.add(by.get(id));
        return r;
    }
    private static void addWithDeps(java.util.Map<String, JSONObject> by, String id, java.util.Set<String> out, java.util.Set<String> path) throws IOException {
        if (out.contains(id)) return;
        JSONObject m = by.get(id);
        if (m == null) throw new IOException(Tr.f("模块清单里没有：{0}", id));
        if (!path.add(id)) throw new IOException(Tr.f("模块依赖成环：{0}", id));
        org.json.JSONArray d = m.optJSONArray("deps");
        if (d != null) for (int i = 0; i < d.length(); i++) addWithDeps(by, d.optString(i), out, path);
        out.add(id);
    }

    /**
     * 装模块化工具包（首装，或整包 / 旧快照换成这一份）。
     * @param mjBytes modules.json 原文（调用方已核过来源：钉子的 sha256 或 modules.json.sig 签名）
     * @param want 用户勾的模块（基础块和依赖自动带上）
     * @param base Release 目录（GitHub）；identity 这份快照整包 gz 的 sha256（写进 .devkit-ok，组件按它匹配）
     */
    void installModules(byte[] mjBytes, java.util.Collection<String> want, String base, String identity) throws IOException {
        JSONObject mj;
        try { mj = new JSONObject(new String(mjBytes, StandardCharsets.UTF_8)); } catch (org.json.JSONException e) { throw new IOException(Tr.t("模块清单坏了"), e); }
        // 入口校验（H2）：模块清单必须指明是给本应用的，错 target / 接口版本直接拒装
        if (!env.pkg.equals(mj.optString("target")) || mj.optInt("compat", 1) != Updater.DEVKIT_COMPAT)
            throw new IOException(Tr.f("模块清单不是给本应用的（target 是 {0}），不安装", mj.optString("target")));
        java.util.List<JSONObject> order = moduleOrder(mj, want);
        long dl = 0, unpacked = 0;
        for (JSONObject m : order) {
            JSONObject gz = m.optJSONObject("gz"), tar = m.optJSONObject("tar");
            if (gz == null || tar == null) throw new IOException(Tr.t("模块清单坏了"));
            File have = new File(env.files, gz.optString("file"));
            if (!have.isFile()) dl += gz.optLong("bytes") - new File(have.getPath() + ".part").length();
            unpacked += tar.optLong("bytes");
        }
        // 峰值：还要下的 + 已下的压缩包（解完一块删一块，按全部算）+ 解开后的全部 + 余量
        long need = Math.max(0, dl) + unpacked + (400L << 20);
        long free = new android.os.StatFs(env.files.getPath()).getAvailableBytes();
        if (free < need) throw new NoSpace(need, free);
        java.util.List<File> gzs = new java.util.ArrayList<>();
        for (JSONObject m : order) {
            JSONObject gz = m.optJSONObject("gz");
            String file = gz.optString("file"), gh = base + file;
            ui.step(Tr.f("下载模块「{0}」{1} MB…", moduleName(m), String.valueOf(gz.optLong("bytes") >> 20)));
            gzs.add(download(gh, new File(env.files, file), gz.optLong("bytes"), gz.optString("sha256")));
        }
        File tmp = usrNew();
        deleteTree(tmp);
        tmp.mkdirs();
        org.json.JSONArray ids = new org.json.JSONArray();
        for (int i = 0; i < order.size(); i++) {
            JSONObject m = order.get(i);
            ui.step(Tr.f("解包「{0}」…", moduleName(m)));
            File gz = gzs.get(i);
            extractInto(tmp, new FileInputStream(gz), gz.length(), true, m.optJSONObject("tar").optString("sha256"));
            ids.put(m.optString("id"));
        }
        write(new File(tmp, MODULES_JSON), new String(mjBytes, StandardCharsets.UTF_8));
        JSONObject p = new JSONObject();
        try { p.put("base", base).put("sha256", identity == null ? "" : identity).put("modules", ids).put("snapshot", mj.optString("snapshot")); }
        catch (org.json.JSONException ignored) {}
        write(new File(tmp, PENDING), p + "\n");
        swapIn(tmp);
        finish();
        for (File gz : gzs) gz.delete();          // 解完就删
    }

    static String moduleName(JSONObject m) {
        JSONObject n = m.optJSONObject("name");
        if (n == null) return m.optString("id");
        String s = n.optString(Tr.lang().startsWith("zh") ? "zh" : "en", "");
        return s.isEmpty() ? n.optString("zh", m.optString("id")) : s;
    }

    /** 两次换名把新版换上；第二次失败就把旧版换回来 */
    private void swapIn(File tmp) throws IOException {
        File old = usrOld();
        deleteTree(old);
        if (env.usr.exists() && !env.usr.renameTo(old)) throw new IOException(Tr.t("换名失败: ") + env.usr);
        if (!tmp.renameTo(env.usr)) {
            if (old.exists()) old.renameTo(env.usr);
            throw new IOException(Tr.t("换名失败: ") + tmp);
        }
    }

    /** 基础块在 modules.json 里的 id（devkit.json 里 required 的那个模块） */
    static final String BASE_MODULE_ID = "base";
    /** 最近一次 firstRuns 里失败的包：包名 → 结构化失败记录（H3）。B10：记入修复账本，基础块失败时 finish() 不写 .devkit-ok */
    final java.util.Map<String, FirstRunFailure> firstRunFailed = new java.util.LinkedHashMap<>();
    /** .devkit-ok 旁边的 first-run 失败标记（J2 的 devkitReady 读它）：每行一个失败，`包名 rc=返回码 step=失败步骤名` */
    static final String FIRSTRUN_FAILED = ".devkit-firstrun-failed";
    /** first-run 成功的检查点（H5）：usr 根下的 JSON，包名 → 跑通的那份 first-run.sh 的 sha256。重试时脚本没变就跳过 */
    static final String FIRSTRUN_DONE = ".devkit-firstrun-done";
    /** 单步超时（H4）：first-run 这类长步骤 10 分钟没跑完就杀掉，不再无限 waitFor */
    static final long RUN_TIMEOUT_MS = 10 * 60 * 1000L;
    /** 超时时 run() 的返回码（timeout(1) 的 124，first-run.sh 自己不会返回它） */
    static final int TIMEOUT_RC = 124;
    /** 失败记录里留的输出尾部：最后 20 行、最多 4000 字 */
    static final int TAIL_LINES = 20, TAIL_MAX_CHARS = 4000;

    /** 一次 first-run 失败的全部信息（H3）：步骤名是输出里最后一条 `▸ …` 行或 `first-run-summary:` 行，
     *  tail 是输出尾部，log 是落盘的完整输出，summaryLog / compileLog 是新版 first-run.sh 在 $PREFIX/tmp/ 留的汇总与 compileall 日志 */
    static final class FirstRunFailure {
        final String module; final int rc; final String step; final String tail; final String log;
        final String summaryLog; final String compileLog;
        final boolean timedOut; final long ms;
        FirstRunFailure(String module, int rc, String step, String tail, String log,
                String summaryLog, String compileLog, boolean timedOut, long ms) {
            this.module = module; this.rc = rc; this.step = step == null ? "" : step;
            this.tail = tail == null ? "" : tail; this.log = log == null ? "" : log;
            this.summaryLog = summaryLog == null ? "" : summaryLog;
            this.compileLog = compileLog == null ? "" : compileLog;
            this.timedOut = timedOut; this.ms = ms;
        }
        /** Ledger detail 用的 JSON 文本（手写，不用 org.json：测试跑的是 android.jar 的桩，new JSONObject() 会抛 Stub!） */
        String toJsonString() {
            return "{\"module\":" + jsonQuote(module) + ",\"rc\":" + rc + ",\"step\":" + jsonQuote(step)
                + ",\"tail\":" + jsonQuote(tail) + ",\"log\":" + jsonQuote(log)
                + ",\"summaryLog\":" + jsonQuote(summaryLog) + ",\"compileLog\":" + jsonQuote(compileLog)
                + ",\"timedOut\":" + timedOut + ",\"ms\":" + ms + "}";
        }
    }

    /** JSON 字符串引用的最小转义（配合上面的手写 JSON） */
    static String jsonQuote(String s) {
        if (s == null) return "\"\"";
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    /** 输出里最后一条 `▸ …` 行去掉前缀就是正在跑的步骤（first-run.sh 每步先 echo 一个） */
    static String lastStepLine(java.util.List<String> lines) {
        String step = "";
        for (String l : lines) if (l != null && l.startsWith("▸ ")) step = l.substring(2).trim();
        return step;
    }

    /** 输出尾部：最后 maxLines 行、最多留 maxChars 字（超了从前面截，留一个 …） */
    static String tailText(java.util.List<String> lines, int maxLines, int maxChars) {
        int from = Math.max(0, lines.size() - maxLines);
        StringBuilder sb = new StringBuilder();
        for (int i = from; i < lines.size(); i++) { if (sb.length() > 0) sb.append('\n'); sb.append(lines.get(i)); }
        String t = sb.toString();
        if (t.length() > maxChars) t = "…" + t.substring(t.length() - maxChars);
        return t;
    }

    /** 失败记录的 Ledger detail（H3）：第一条失败平铺在顶层，全部失败另放 failures 数组。返回 JSON 文本，
     *  调用方再包成 JSONObject（Ledger.add 要 JSONObject；这里返回文本是为测试能跑——android.jar 的 org.json 是桩） */
    static String firstRunDetailJson(java.util.Collection<FirstRunFailure> failures) {
        StringBuilder sb = new StringBuilder("{");
        FirstRunFailure first = null;
        StringBuilder arr = new StringBuilder("[");
        boolean firstArr = true;
        for (FirstRunFailure f : failures) {
            if (first == null) first = f;
            if (!firstArr) arr.append(',');
            firstArr = false;
            arr.append(f.toJsonString());
        }
        arr.append(']');
        if (first != null) {
            sb.append("\"module\":").append(jsonQuote(first.module))
                .append(",\"rc\":").append(first.rc)
                .append(",\"step\":").append(jsonQuote(first.step))
                .append(",\"tail\":").append(jsonQuote(first.tail))
                .append(",\"log\":").append(jsonQuote(first.log))
                .append(",\"summaryLog\":").append(jsonQuote(first.summaryLog))
                .append(",\"compileLog\":").append(jsonQuote(first.compileLog))
                .append(",\"timedOut\":").append(first.timedOut)
                .append(",\"ms\":").append(first.ms).append(',');
        }
        sb.append("\"count\":").append(failures.size()).append(",\"failures\":").append(arr).append('}');
        return sb.toString();
    }

    /** Ledger detail：firstRunDetailJson 包成 JSONObject；包不出来就 null（账本不为此丢整行） */
    private static JSONObject detailOrNull(java.util.Collection<FirstRunFailure> failures) {
        try { return new JSONObject(firstRunDetailJson(failures)); } catch (Exception e) { return null; }
    }

    /** 失败标记的一行：`包名 rc=返回码 step=失败步骤名`（步骤名可含空格，取行尾全部） */
    static String formatFirstRunFailedMarker(java.util.Map<String, FirstRunFailure> failed) {
        StringBuilder sb = new StringBuilder();
        for (FirstRunFailure f : failed.values())
            sb.append(f.module).append(" rc=").append(f.rc).append(" step=").append(f.step).append('\n');
        return sb.toString();
    }

    /** 解析失败标记：新格式按上，旧格式（每行只有一个包名）也认，rc 记 -1、步骤空 */
    static java.util.Map<String, FirstRunFailure> parseFirstRunFailedMarker(String text) {
        java.util.Map<String, FirstRunFailure> r = new java.util.LinkedHashMap<>();
        if (text == null) return r;
        for (String line : text.split("\n")) {
            line = line.trim();
            if (line.isEmpty()) continue;
            String id = line, step = "";
            int rc = -1;
            int sp = line.indexOf(' ');
            if (sp > 0) {
                id = line.substring(0, sp);
                int ri = line.indexOf(" rc=", sp);
                if (ri >= 0) {
                    int end = line.indexOf(" step=", ri);
                    try { rc = Integer.parseInt(line.substring(ri + 4, end < 0 ? line.length() : end).trim()); }
                    catch (NumberFormatException ignored) {}
                    if (end >= 0) step = line.substring(end + 6);
                }
            }
            r.put(id, new FirstRunFailure(id, rc, step, "", "", "", "", false, 0));
        }
        return r;
    }

    /** 某块 first-run 输出的落盘文件（files/ 下，诊断包能带上） */
    static String firstRunLogFileName(String moduleId) { return "first-run-" + moduleId + ".log"; }

    /** 读 first-run 成功检查点：没有 / 坏了都当成空（宁可重跑，别跳过没跑过的） */
    static java.util.Map<String, String> readFirstRunDone(File usr) {
        return readFlatStringMap(new File(usr, FIRSTRUN_DONE));
    }

    /** 写检查点（firstRuns 末尾，成功的那几块） */
    static void writeFirstRunDone(File usr, java.util.Map<String, String> done) {
        try {
            StringBuilder sb = new StringBuilder("{");
            boolean first = true;
            for (java.util.Map.Entry<String, String> e : done.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                sb.append(jsonQuote(e.getKey())).append(':').append(jsonQuote(e.getValue()));
            }
            write(new File(usr, FIRSTRUN_DONE), sb.append("}\n").toString());
        } catch (Exception ignored) {}
    }

    /** 读只有一层字符串值的 JSON 对象（检查点、.devkit-pending 都是这种）；文件没有 / 坏了都当成空。
     *  手写解析：测试跑的是 android.jar 的桩，org.json 在 JVM 里是 Stub。非字符串值（数组、对象、数字）跳过 */
    static java.util.Map<String, String> readFlatStringMap(File f) {
        java.util.Map<String, String> r = new java.util.LinkedHashMap<>();
        String text;
        try { text = new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); }
        catch (Exception e) { return r; }
        int n = text.length(), i = 0;
        while (i < n) {
            int q = text.indexOf('"', i);
            if (q < 0) break;
            int[] end = new int[1];
            String key = parseJsonString(text, q, end);
            if (key == null) break;
            i = end[0];
            while (i < n && Character.isWhitespace(text.charAt(i))) i++;
            if (i >= n || text.charAt(i) != ':') continue;
            i++;
            while (i < n && Character.isWhitespace(text.charAt(i))) i++;
            if (i < n && text.charAt(i) == '"') {
                String val = parseJsonString(text, i, end);
                if (val == null) break;
                r.put(key, val);
                i = end[0];
            } else {
                i = skipJsonValue(text, i);
            }
        }
        return r;
    }

    private static String parseJsonString(String text, int start, int[] end) {
        StringBuilder sb = new StringBuilder();
        int i = start + 1, n = text.length();
        while (i < n) {
            char c = text.charAt(i);
            if (c == '"') { end[0] = i + 1; return sb.toString(); }
            if (c == '\\' && i + 1 < n) {
                char e = text.charAt(i + 1);
                switch (e) {
                    case '"': sb.append('"'); i += 2; continue;
                    case '\\': sb.append('\\'); i += 2; continue;
                    case '/': sb.append('/'); i += 2; continue;
                    case 'n': sb.append('\n'); i += 2; continue;
                    case 'r': sb.append('\r'); i += 2; continue;
                    case 't': sb.append('\t'); i += 2; continue;
                    case 'u':
                        if (i + 5 < n) {
                            try { sb.append((char) Integer.parseInt(text.substring(i + 2, i + 6), 16)); i += 6; continue; }
                            catch (NumberFormatException ignored) {}
                        }
                        i += 2; continue;
                    default: sb.append(e); i += 2; continue;
                }
            }
            sb.append(c);
            i++;
        }
        return null;
    }

    private static int skipJsonValue(String text, int i) {
        int n = text.length(), depth = 0;
        boolean inStr = false;
        while (i < n) {
            char c = text.charAt(i);
            if (inStr) {
                if (c == '\\') i++;
                else if (c == '"') inStr = false;
            } else if (c == '"') inStr = true;
            else if (c == '[' || c == '{') depth++;
            else if (c == ']' || c == '}') {
                if (depth == 0) return i;
                depth--;
                if (depth == 0) return i + 1;
            } else if (c == ',' && depth == 0) return i + 1;
            i++;
        }
        return n;
    }

    /** 这块的 first-run.sh 跑通过、且和现在盘上的同一份（sha 对得上）→ 重试时跳过（H5）。
     *  脚本不存在 / 变了（新 devkit）→ 不跳过：新版脚本必须跑一次 */
    static boolean firstRunDone(java.util.Map<String, String> done, String id, File script) {
        if (done == null || script == null || !script.isFile()) return false;
        String want = done.get(id);
        if (want == null || want.isEmpty()) return false;
        try { return want.equals(sha256(script)); } catch (IOException e) { return false; }
    }

    /** 仅可选模块的 first-run 失败（.devkit-ok 在、标记里没有 base）：补跑 first-run 就够，别全量重装（H5） */
    boolean moduleOnlyFirstRunFailure() { return moduleOnlyFirstRunFailure(env.usr); }
    static boolean moduleOnlyFirstRunFailure(File usr) {
        if (!new File(usr, ".devkit-ok").isFile()) return false;
        File f = new File(usr, FIRSTRUN_FAILED);
        if (!f.isFile()) return false;
        try {
            java.util.Map<String, FirstRunFailure> m = parseFirstRunFailedMarker(
                new String(java.nio.file.Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8));
            return !m.isEmpty() && !m.containsKey(BASE_MODULE_ID);
        } catch (Exception e) { return false; }
    }

    /** H5：boot() 首次配置分支决策（纯函数，供 JVM 测试）：仅模块失败 → "repair-modules"；
     *  未就绪 → "install"；漏跑 → "repair-missed"；否则 "none"。顺序重要：模块失败时
     *  devkitReady() 为 false（失败标记在），必须先判模块失败，否则会全量重装。 */
    static String bootDevkitAction(boolean devkitReady, boolean moduleOnly, boolean firstRunMissed) {
        if (moduleOnly) return "repair-modules";
        if (!devkitReady) return "install";
        if (firstRunMissed) return "repair-missed";
        return "none";
    }

    /** 补跑 first-run 的模块：modules.json 里除基础块外、目录还在的（H5）。
     *  以前只认写了 .ok 的——first-run 失败的模块恰恰没写 .ok，补跑时就被漏掉了 */
    static java.util.List<JSONObject> repairModuleList(JSONObject mj, File usr) {
        java.util.List<JSONObject> r = new java.util.ArrayList<>();
        org.json.JSONArray all = mj == null ? null : mj.optJSONArray("modules");
        if (all == null) return r;
        for (int i = 0; i < all.length(); i++) {
            JSONObject m = all.optJSONObject(i);
            if (m == null) continue;
            if (repairModuleIncluded(m.optString("kind"), m.optString("dir"), usr)) r.add(m);
        }
        return r;
    }

    /** 补跑的入选规则（纯逻辑，repairModuleList 的实体）：非基础块、且目录还在 */
    static boolean repairModuleIncluded(String kind, String dir, File usr) {
        return !"base".equals(kind) && dir != null && !dir.isEmpty() && new File(usr, dir).isDirectory();
    }

    /** 卡住的这份工具包（.devkit-pending 里的 base）比 APK 钉的旧：重跑磁盘上的旧脚本注定再失败（BLOCKER）。
     *  比的是 Release（base URL 里带的 tag，devkit-YYYY.MM.DD）；base 对不上又比不出新旧时也算旧——
     *  钉的版本就是 APK 带来的那版，装它不会比卡住更糟，装之前用户还要在来源页点一下 */
    static boolean pendingDevkitOlderThanPin(File usr, String pinTag, String pinBase) {
        if (pinTag == null && pinBase == null) return false;
        java.util.Map<String, String> pend = readFlatStringMap(new File(usr, PENDING));
        String haveBase = pend.get("base");
        if (haveBase == null || haveBase.isEmpty()) return false;
        String haveTag = Updater.tagOf(haveBase);
        if (pinTag != null && pinTag.startsWith("devkit-") && haveTag != null && haveTag.startsWith("devkit-"))
            return Updater.cmpVer(pinTag.substring(7), haveTag.substring(7)) > 0;
        return pinBase != null && !pinBase.isEmpty() && !pinBase.equals(haveBase);
    }

    /** recover() 在重跑旧 first-run.sh 时失败，但 APK 钉的已是新版工具包：这轮重跑注定失败，跳过它走更新安装（BLOCKER） */
    static boolean shouldSkipDoomedFirstRunRetry(File usr, String pinTag, String pinBase, boolean baseFirstRunFailed) {
        return baseFirstRunFailed && pendingDevkitOlderThanPin(usr, pinTag, pinBase);
    }

    /** 新版 first-run.sh 在 $PREFIX/tmp/ 留的汇总与 compileall 日志（有才记，没有是旧脚本，不强求；汇总是追加的） */
    static String firstRunSummaryLog(File usr) {
        File f = new File(usr, "tmp/first-run-summary.txt");
        return f.isFile() ? f.getPath() : "";
    }
    static String firstRunCompileLog(File usr) {
        File f = new File(usr, "tmp/first-run-compileall.log");
        return f.isFile() ? f.getPath() : "";
    }

    /** `first-run-summary: <包>=<返回码>,<包>=<返回码>,…`（devkit/first-run.mjs 生成的新版
     *  first-run.sh 在末尾回的一行，各 postinst 的 rc 逗号分隔；没 postinst 时是 `（无）`）：
     *  第一个 rc≠0 的包就是真失败的步骤。旧脚本没有这种行，返回 ""，调用方回落到最后一条 ▸ 行。
     *  注意：新脚本跑完所有步骤才 exit FR_RC，最后一条 ▸ 行可能是后头成功的步骤，不能拿它当失败步骤。
     *  兼容旧写法（解析器先落地时 devkit 侧还没定格式）：`first-run-summary: <步骤> rc=<n>` 与
     *  `first-run-summary: step=<步骤> rc=<n>`，同样取第一个 rc≠0 的。 */
    static String failedStepFromSummary(java.util.List<String> lines) {
        for (String l : lines) {
            if (l == null || !l.startsWith("first-run-summary:")) continue;
            String rest = l.substring("first-run-summary:".length()).trim();
            if (rest.isEmpty() || "（无）".equals(rest)) continue;
            // 新格式：android-tools=0,npm=1,openssh=0,…——第一个 rc≠0 的包
            String hit = firstNonZeroPkgEq(rest);
            if (hit != null) return hit;
            if (looksLikePkgEqSummary(rest)) continue; // 全是 rc=0：这行没失败，继续看别的行
            int rcIdx = rest.indexOf("rc=");
            if (rcIdx < 0) continue;
            int rc = -1;
            try {
                int e = rcIdx + 3;
                while (e < rest.length() && Character.isDigit(rest.charAt(e))) e++;
                rc = Integer.parseInt(rest.substring(rcIdx + 3, e));
            } catch (NumberFormatException ignored) { continue; }
            if (rc == 0) continue;
            int stIdx = rest.indexOf("step=");
            if (stIdx >= 0) {
                int e = stIdx + 5;
                while (e < rest.length() && !Character.isWhitespace(rest.charAt(e))) e++;
                return rest.substring(stIdx + 5, e);
            }
            String step = rest.substring(0, rcIdx).trim();
            while (!step.isEmpty() && " :—–-".indexOf(step.charAt(step.length() - 1)) >= 0)
                step = step.substring(0, step.length() - 1).trim();
            return step;
        }
        return "";
    }

    /** `包=返回码,包=返回码,…` 里的第一个 rc≠0 的包；没有非零的返回 null（全零与“不是这格式”都返回 null，
     *  由 looksLikePkgEqSummary 区分）。包名不含 `=`、`,`、空白，rc 是十进制数。 */
    static String firstNonZeroPkgEq(String rest) {
        for (String tok : rest.split(",")) {
            String t = tok.trim();
            int eq = t.lastIndexOf('=');
            if (eq <= 0) return null;
            String name = t.substring(0, eq).trim();
            String num = t.substring(eq + 1).trim();
            if (name.isEmpty() || num.isEmpty() || name.indexOf(' ') >= 0) return null;
            int rc;
            try { rc = Integer.parseInt(num); } catch (NumberFormatException e) { return null; }
            if (rc != 0) return name;
        }
        return null;
    }

    /** 整行是否就是 `包=返回码,包=返回码,…` 的新格式（哪怕全是 0） */
    static boolean looksLikePkgEqSummary(String rest) {
        String[] toks = rest.split(",");
        if (toks.length == 0) return false;
        for (String tok : toks) {
            String t = tok.trim();
            int eq = t.lastIndexOf('=');
            if (eq <= 0) return false;
            String name = t.substring(0, eq).trim();
            String num = t.substring(eq + 1).trim();
            if (name.isEmpty() || num.isEmpty() || name.indexOf(' ') >= 0) return false;
            try { Integer.parseInt(num); } catch (NumberFormatException e) { return false; }
        }
        return true;
    }

    /** 非关键的 first-run 步骤（H2）：失败了也记下来、报出来，但不挡住进软件。
     *  devkit 侧已核查：base 的 6 个 postinst（android-tools、npm、openssh、python、python-pip、termux-exec）
     *  没有一个对“进到可用状态”是关键的；末尾的 compileall 也一样（Python 没 .pyc 照样跑，只是首次 import 慢）。
     *  判定靠失败步骤名（新脚本的 first-run-summary 行 / 旧脚本的最后一条 ▸ 行）；
     *  超时、或步骤名认不出来时一律按关键处理（fail closed） */
    static final java.util.Set<String> NON_CRITICAL_FIRST_RUN_STEPS = new java.util.HashSet<>(java.util.Arrays.asList(
        "android-tools", "npm", "openssh", "python", "python-pip", "termux-exec",
        "预编译 Python 标准库与 site-packages"));
    static boolean nonCriticalFirstRunFailure(String step, boolean timedOut) {
        return !timedOut && step != null && NON_CRITICAL_FIRST_RUN_STEPS.contains(step);
    }

    /** Guile 缓存 touch 的命令（M1）：失败要看得见——不吞 stderr、不拿 `; true` 把返回码抹成 0 */
    static String guileTouchCommand() {
        return "find \"$PREFIX/lib/guile\" -name '*.go' -exec touch {} +";
    }

    /** touch 后抽查：lib/guile 下 *.go 里 mtime 还停在 touchedAfterMs 之前的个数（M1：包里 mtime 都是 0，碰过的就是现在） */
    static int countStaleGuileCache(File usr, long touchedAfterMs) {
        int[] n = new int[1];
        countStaleGuileCache(new File(usr, "lib/guile"), touchedAfterMs, n);
        return n[0];
    }
    private static void countStaleGuileCache(File dir, long touchedAfterMs, int[] n) {
        File[] kids = dir == null ? null : dir.listFiles();
        if (kids == null) return;
        for (File k : kids) {
            if (k.isDirectory()) countStaleGuileCache(k, touchedAfterMs, n);
            else if (k.getName().endsWith(".go") && k.lastModified() < touchedAfterMs) n[0]++;
        }
    }

    /** 一次 run() 的结果：返回码、是否超时、耗时、最后跑到的步骤、输出尾部、汇总行认出的真失败步骤 */
    static final class RunOutcome {
        int rc = -1; boolean timedOut; long ms; String step = ""; String tail = ""; String failedStep = "";
    }

    /**
     * 跑一条命令：输出逐行报给界面（`▸ …` 的行记成当前步骤）、同时落盘到 logFile（H3）、
     * 攒最后 TAIL_LINES 行当尾部；timeoutMs 内没跑完就杀掉进程、返回 TIMEOUT_RC（H4）。
     * timeoutMs <= 0 = 不设超时（installAgy 下 CLI 用，网慢也可能超过 10 分钟）。
     * 读输出在单独的线程里：主线程只等退出，进程挂住不出输出时超时才掐得住。
     */
    static int runProcess(ProcessBuilder pb, Progress ui, long timeoutMs, File logFile, RunOutcome out) throws IOException {
        long t0 = System.currentTimeMillis();
        Process p = pb.start();
        java.util.List<String> lines = java.util.Collections.synchronizedList(new java.util.ArrayList<>());
        java.io.OutputStream logOut = null;
        if (logFile != null) {
            if (logFile.getParentFile() != null) logFile.getParentFile().mkdirs();
            logOut = new java.io.FileOutputStream(logFile, false);
        }
        final java.io.OutputStream log = logOut;
        Thread reader = new Thread(() -> {
            try (BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8))) {
                for (String l; (l = r.readLine()) != null; ) {
                    lines.add(l);
                    if (log != null) { try { log.write((l + "\n").getBytes(StandardCharsets.UTF_8)); } catch (IOException ignored) {} }
                    if (l.startsWith("@progress ")) {
                        String[] p2 = l.split(" ");
                        try { ui.bytes(Long.parseLong(p2[1]), Long.parseLong(p2[2])); } catch (Exception ignored) {}
                        continue;
                    }
                    ui.step(l);
                }
            } catch (IOException ignored) {}
            finally { if (log != null) try { log.close(); } catch (IOException ignored) {} }
        }, "installer-run-reader");
        reader.setDaemon(true);
        reader.start();
        boolean finished;
        try {
            if (timeoutMs > 0) finished = p.waitFor(timeoutMs, java.util.concurrent.TimeUnit.MILLISECONDS);
            else { p.waitFor(); finished = true; }
        } catch (InterruptedException e) { throw new IOException(e); }
        if (!finished) {
            p.destroyForcibly();
            try { p.waitFor(); } catch (InterruptedException e) { throw new IOException(e); }
            out.timedOut = true;
        }
        try { reader.join(5000); } catch (InterruptedException e) { throw new IOException(e); }
        out.ms = System.currentTimeMillis() - t0;
        out.step = lastStepLine(lines);
        out.tail = tailText(lines, TAIL_LINES, TAIL_MAX_CHARS);
        out.failedStep = failedStepFromSummary(lines);
        if (logFile != null) {
            try (java.io.OutputStream o = new java.io.FileOutputStream(logFile, true)) {
                o.write(("# rc=" + (out.timedOut ? TIMEOUT_RC : p.exitValue()) + " ms=" + out.ms
                    + (out.timedOut ? " TIMEOUT" : "") + "\n").getBytes(StandardCharsets.UTF_8));
            } catch (IOException ignored) {}
        }
        out.rc = out.timedOut ? TIMEOUT_RC : p.exitValue();
        return out.rc;
    }

    /** 基础块和给出的各模块依次跑 first-run，再按 first-run 前后的快照剔除本机校验基线（见 pruneManifest）。返回各模块的目录。
     *  H5：上次跑通的块（检查点里 first-run.sh 的 sha 对得上）跳过，失败的块重跑——不是「没进失败记录就跳过」：
     *  中途被杀时后头的块既没成功也没失败，只认成功检查点才不会漏跑 */
    private java.util.List<File> firstRuns(java.util.List<JSONObject> modList, String ledgerKind) throws IOException {
        // L3：不用时间窗口了 —— first-run 之前先给各份清单里的文件拍个快照（mtime + 大小），跑完按快照比对，
        // 改过的文件才重算哈希记进基线。时钟跳变、时间戳粒度粗都不会再漏记或误记
        java.util.Map<String, long[]> snapBase = snapshotManifest(new File(env.usr, MANIFEST));
        java.util.Map<String, java.util.Map<String, long[]>> snapMods = new java.util.HashMap<>();
        for (JSONObject m : modList) snapMods.put(m.optString("id"), snapshotManifest(new File(new File(env.usr, m.optString("dir")), "MANIFEST")));
        firstRunFailed.clear();
        java.util.Map<String, String> done = readFirstRunDone(env.usr);
        java.util.Map<String, String> doneNow = new java.util.LinkedHashMap<>(done);
        ui.step(Tr.t("首次运行配置…"));
        File baseScript = new File(env.usr, "libexec/devkit/first-run.sh");
        File baseLog = new File(env.files, firstRunLogFileName(BASE_MODULE_ID));
        if (firstRunDone(done, BASE_MODULE_ID, baseScript)) {
            ui.step(Tr.t("（基础块首次配置已完成，跳过）"));
        } else {
            int rc = run(RUN_TIMEOUT_MS, baseLog, env.bin("bash").getPath(), baseScript.getPath());
            if (rc != 0) {
                // 失败步骤：汇总行（新脚本）优先——它认的是真失败的那步；没有汇总行（旧脚本）才用最后一条 ▸ 行
                String failedStep = !lastOutcome.failedStep.isEmpty() ? lastOutcome.failedStep : lastOutcome.step;
                recordFirstRunFailure(new FirstRunFailure(BASE_MODULE_ID, rc, failedStep,
                    lastOutcome.tail, baseLog.getPath(), firstRunSummaryLog(env.usr), firstRunCompileLog(env.usr),
                    lastOutcome.timedOut, lastOutcome.ms), Tr.t("基础块"), ledgerKind, doneNow, baseScript);
            } else {
                try { doneNow.put(BASE_MODULE_ID, sha256(baseScript)); } catch (IOException ignored) {}
            }
        }
        java.util.List<File> modDirs = new java.util.ArrayList<>();
        for (JSONObject m : modList) {
            File dir = new File(env.usr, m.optString("dir"));
            modDirs.add(dir);
            File fr = new File(dir, "first-run.sh");
            if (!fr.isFile()) continue;
            String id = m.optString("id");
            File modLog = new File(env.files, firstRunLogFileName(id));
            if (firstRunDone(done, id, fr)) {
                ui.step(Tr.f("（「{0}」首次配置已完成，跳过）", moduleName(m)));
                continue;
            }
            ui.step(Tr.f("「{0}」首次配置…", moduleName(m)));
            int r2 = run(RUN_TIMEOUT_MS, modLog, env.bin("bash").getPath(), fr.getPath());
            if (r2 != 0) {
                String failedStep = !lastOutcome.failedStep.isEmpty() ? lastOutcome.failedStep : lastOutcome.step;
                // 汇总与 compileall 日志是基础块 first-run.sh 写的，只给基础块的失败记（模块脚本没写这两个文件）
                recordFirstRunFailure(new FirstRunFailure(id, r2, failedStep,
                    lastOutcome.tail, modLog.getPath(), "", "",
                    lastOutcome.timedOut, lastOutcome.ms), "「" + moduleName(m) + "」", ledgerKind, doneNow, fr);
            } else {
                try { doneNow.put(id, sha256(fr)); } catch (IOException ignored) {}
            }
        }
        // Guile 的编译缓存必须比源码新（哪怕包里两者同一秒），否则 gdb 启动时陷入重编译死循环
        // M1：失败要看得见——不吞 stderr、不拿 `; true` 抹返回码；跑完再抽查一遍 mtime
        long touchT0 = System.currentTimeMillis();
        int touchRc = run(env.bin("bash").getPath(), "-c", guileTouchCommand());
        int stale = countStaleGuileCache(env.usr, touchT0);
        if (touchRc != 0 || stale > 0) {
            ui.step(Tr.f("（警告：Guile 编译缓存没碰全（返回 {0}，{1} 个文件还是旧时间），gdb 第一次启动可能要重编译一次）", touchRc, stale));
            android.util.Log.w("Installer", "Guile 缓存 touch 返回 " + touchRc + "，还有 " + stale + " 个 .go 没碰到");
        }
        // M7：只给跑通了的块重定基线；失败的块不按半成品记，.local 原样不动
        pruneManifest(env.usr, new File(env.usr, MANIFEST), new File(env.usr, LOCAL_MANIFEST), snapBase, ui,
            !firstRunFailed.containsKey(BASE_MODULE_ID));
        for (JSONObject m : modList) {
            File dir = new File(env.usr, m.optString("dir"));
            pruneManifest(env.usr, new File(dir, "MANIFEST"), new File(dir, "MANIFEST.local"), snapMods.get(m.optString("id")), ui,
                !firstRunFailed.containsKey(m.optString("id")));
        }
        // H5：跑通的块写检查点（脚本 sha）；下次重试时脚本没变就跳过。失败的块不写（非关键步骤例外，见 recordFirstRunFailure）
        writeFirstRunDone(env.usr, doneNow);
        if (!firstRunFailed.isEmpty())
            Ledger.add(env, ledgerKind, false, Tr.f("首次配置失败：{0}", firstRunFailedText()), detailOrNull(firstRunFailed.values()));
        return modDirs;
    }

    /** 记一次 first-run 失败（H2/H3）：关键失败进 firstRunFailed（挡住就绪）；非关键步骤只记账本 + 报出来，
     *  不挡住、不写失败标记，检查点照写（这份脚本跑完了，确定性失败重跑也没用；新版脚本 sha 变了会重跑）。
     *  瞒报与卡死都不取：非关键失败的账本行照样是 ok=false、带完整 detail，界面也报一行警告 */
    private void recordFirstRunFailure(FirstRunFailure f, String who, String ledgerKind,
            java.util.Map<String, String> doneNow, File script) {
        if (nonCriticalFirstRunFailure(f.step, f.timedOut)) {
            Ledger.add(env, ledgerKind, false,
                Tr.f("首次配置非关键步骤失败（不影响使用，下次工具包更新时会重跑）：{0}", firstRunFailedTextOne(f)),
                detailOrNull(java.util.Collections.singletonList(f)));
            ui.step(Tr.f("（{0}首次配置里「{1}」这步失败了，但不影响使用）", who, f.step));
            try { doneNow.put(f.module, sha256(script)); } catch (IOException ignored) {}
            return;
        }
        firstRunFailed.put(f.module, f);
        ui.step(f.timedOut
            ? Tr.f("（{0}首次配置超时（{1} 分钟没跑完），已终止）", who, RUN_TIMEOUT_MS / 60000)
            : Tr.f("（{0}首次配置失败，返回 {1}）", who, f.rc));
    }

    /** 一条失败的人话写法：包名（rc=返回码，步骤：…，日志：…）。日志优先指汇总文件（最易读），没有再指完整输出 */
    private static String firstRunFailedTextOne(FirstRunFailure f) {
        StringBuilder sb = new StringBuilder();
        sb.append(f.module).append("（rc=").append(f.rc);
        if (f.timedOut) sb.append("，超时");
        if (!f.step.isEmpty()) sb.append("，步骤：").append(f.step);
        String log = !f.summaryLog.isEmpty() ? f.summaryLog : f.log;
        if (!log.isEmpty()) sb.append("，日志：").append(log);
        sb.append("）");
        return sb.toString();
    }

    /** firstRunFailed 的账本写法：一条条 firstRunFailedTextOne，用顿号隔开 */
    private String firstRunFailedText() {
        StringBuilder sb = new StringBuilder();
        for (FirstRunFailure f : firstRunFailed.values()) {
            if (sb.length() > 0) sb.append("、");
            sb.append(firstRunFailedTextOne(f));
        }
        return sb.toString();
    }

    /** 给界面 / 异常用的失败摘要（第一条），没有失败时为空 */
    String firstRunFailureSummary() {
        if (firstRunFailed.isEmpty()) return "";
        FirstRunFailure f = firstRunFailed.values().iterator().next();
        String log = !f.summaryLog.isEmpty() ? f.summaryLog : f.log;
        return f.module + "（rc=" + f.rc + (f.timedOut ? "，超时" : "")
            + (f.step.isEmpty() ? "" : "，步骤：" + f.step)
            + (log.isEmpty() ? "" : "，日志：" + log) + "）";
    }

    /** 同步 first-run 失败标记（.devkit-ok 同目录）：有失败就写上包名 + rc + 步骤，没失败就清掉旧的 */
    void syncFirstRunFailedMarker() {
        File f = new File(env.usr, FIRSTRUN_FAILED);
        if (firstRunFailed.isEmpty()) { f.delete(); return; }
        try { write(f, formatFirstRunFailedMarker(firstRunFailed)); }
        catch (Exception ignored) {}
    }

    /** 清单里每个文件的 first-run 前快照（mtime + 大小）：pruneManifest 靠它认出 first-run 改过的文件，不再用时间窗口（L3） */
    private java.util.Map<String, long[]> snapshotManifest(File man) {
        java.util.Map<String, long[]> snap = new java.util.HashMap<>();
        if (!man.isFile()) return snap;
        try {
            for (String l : java.nio.file.Files.readAllLines(man.toPath(), StandardCharsets.UTF_8)) {
                String[] f = l.split(" ", 3);
                if (f.length != 3) continue;
                File file = new File(env.usr, f[2]);
                if (file.isFile()) snap.put(f[2], new long[]{ file.lastModified(), file.length() });
            }
        } catch (IOException ignored) {}
        return snap;
    }

    /** 0.4.17 及以前：36 的包首次安装时，first-run 跑在「部署界面与网关」之前，LD_PRELOAD 要的 app/lib/exec-shim-bionic.so
     *  还不在，bash 一起来就报 CANNOT LINK，first-run 整个没跑（postinst、Guile 缓存都缺）。
     *  判据：openssh 的 postinst 在缺主机钥匙时一定会生成 —— 有 openssh、却一把主机钥匙都没有，就是没跑过 */
    boolean firstRunMissed() {
        if (!new File(env.usr, "libexec/devkit/postinst/openssh").isFile()) return false;
        File[] k = new File(env.usr, "etc/ssh").listFiles((d, n) -> n.startsWith("ssh_host_") && n.endsWith("_key"));
        return k == null || k.length == 0;
    }
    /** 补跑一次：基础块 + 已装好的各模块（目录还在的——失败的模块没写 .ok，不能只认 .ok，见 repairModuleList） */
    void repairFirstRun() throws IOException {
        firstRuns(repairModuleList(readModules(), env.usr), "repair");
        syncFirstRunFailedMarker();
        if (firstRunFailed.containsKey(BASE_MODULE_ID))
            throw new IOException(Tr.f("首次配置失败（{0}），下次启动会从没跑完的块接着重跑", firstRunFailedText()));
    }

    /** 换名之后的几步。可重入：中途被打断，下次启动 recover() 会再跑一遍 */
    private void finish() throws IOException {
        File old = usrOld(), pend = new File(env.usr, PENDING);
        JSONObject p;
        try { p = new JSONObject(new String(java.nio.file.Files.readAllBytes(pend.toPath()), StandardCharsets.UTF_8)); }
        catch (Exception e) { p = new JSONObject(); }
        if (old.isDirectory()) carryOverOnce(old, sameDevkit(old, p), p.optString("sha256", ""));
        // M1：Python 小版本变了、整棵 lib/python3.X 没搬的，在账本里记一笔（升级后自检能看到）
        if (!carryPythonSkipped.isEmpty())
            Ledger.add(env, "install", true, Tr.f("Python 小版本变了，没搬 {0}（里面的扩展要重装）", android.text.TextUtils.join("、", carryPythonSkipped)), null);
        new File(env.usr, "tmp").mkdirs();
        env.home.mkdirs();

        // 模块化：其余各块按依赖顺序跑自己的 first-run，再写 .ok（网关据此认「已装」）
        java.util.List<JSONObject> modList = new java.util.ArrayList<>();
        org.json.JSONArray mods = p.optJSONArray("modules");
        JSONObject mj = readModules();
        if (mods != null && mj != null) for (int i = 0; i < mods.length(); i++) {
            JSONObject m = moduleById(mj, mods.optString(i));
            if (m != null && !"base".equals(m.optString("kind"))) modList.add(m);
        }
        java.util.List<File> modDirs = firstRuns(modList, "install");
        // B10：基础块首次配置失败时不写 .devkit-ok、不删 .devkit-pending，下次启动 recover() 重跑；只留失败标记。
        // H5：重试时已配好的块按检查点跳过，从没跑完的块接着来
        if (firstRunFailed.containsKey(BASE_MODULE_ID)) {
            syncFirstRunFailedMarker();
            throw new IOException(Tr.f("开发工具包首次配置失败（{0}），下次启动会从没跑完的块接着重跑（已配好的块会跳过）", firstRunFailedText()));
        }
        writeResolvConf();
        for (int i = 0; i < modList.size(); i++) {
            // H5：first-run 失败的模块不写 .ok——写了就看着像装好了，repair 时还会按 .ok 漏掉它
            if (firstRunFailed.containsKey(modList.get(i).optString("id"))) continue;
            write(new File(modDirs.get(i), ".ok"), "{\"at\":" + System.currentTimeMillis() + "}\n");
        }
        try { p.put("at", System.currentTimeMillis()); } catch (org.json.JSONException ignored) {}
        // 这一版的 carryOver 已经按相对路径认主了：告诉网关别对这份工具包做「旧版残留」清理（见 gw/orphans.mjs）
        write(new File(env.files, ".orphans-v1"), "{\"by\":\"installer\",\"at\":" + System.currentTimeMillis() + "}\n");
        write(new File(env.usr, ".devkit-ok"), p + "\n");       // 从这一刻起才算装好
        syncFirstRunFailedMarker();   // 只有可选模块失败时留标记；全成功就清掉旧标记
        pend.delete();
        new File(env.files, CARRY_TRY).delete();
        if (old.exists()) { ui.step(Tr.t("清理旧版本…")); deleteTree(old); }
    }

    /** 搬用户自装包的「进行中」标记：放在 files/ 下（不在 usr 里），搬完删掉 */
    static final String CARRY_TRY = ".carry-try", CARRY_KEPT = "usr.old-kept";
    /** 这次收尾跳过了搬家时为 true（给修复账本用） */
    boolean carrySkipped;

    /**
     * 新旧是不是同一版工具包（修复、核对页「修补」都是同版本重装）：看旧目录 .devkit-ok 与这次 .devkit-pending 的 sha256。
     * 同一版时组件照样能用，要跟着搬过去；以前一律当工具包的东西删掉，组件记录却还认这一版是「已装好」，
     * 核对页就报组件缺几千个文件，再点修补又重装工具包、又删一遍（0.6.11 真机）
     */
    static boolean sameDevkit(File old, JSONObject pending) {
        String neu = pending.optString("sha256", "");
        if (neu.isEmpty()) return false;
        try {
            JSONObject ok = new JSONObject(new String(java.nio.file.Files.readAllBytes(new File(old, ".devkit-ok").toPath()), StandardCharsets.UTF_8));
            return neu.equals(ok.optString("sha256", ""));
        // 旧标识读不出（损坏 / 缺失）：按同版本处理，宁可多搬。按「不搬」走会把组件文件跟旧 usr 一起删掉，
        // 而新 .devkit-ok 的 sha 又和组件记录里的 base 相同，界面还报「已安装」—— 静默损坏（群友核对报告 05）
        } catch (Exception e) { return true; }
    }

    /**
     * carryOver 只试一次（群友报修，0.4.17 魅族 18 / Flyme）：有的机器上 f2fs 的 rename 会卡在内核里不返回（D 状态，
     * 同一时间别的应用的 rename 也卡），进程杀不掉、成了僵尸，App 再也打不开；而 .devkit-pending 还在，下次启动 recover()
     * 又从 carryOver 开始，又卡 —— 自己把自己锁死。rename 没法设超时，所以改成：进去之前落个标记，上一次带着标记死了，
     * 这次就不搬了 —— 旧目录整个换名留给用户（一次顶层 rename），工具包照常装完。搬的只是用户自己 pip / npm -g 装的包，
     * 跳过不影响工具包本身能用。
     */
    private void carryOverOnce(File old, boolean keepComponents, String identity) throws IOException {
        File tryF = new File(env.files, CARRY_TRY);
        if (tryF.exists()) {
            carrySkipped = true;
            File kept = new File(env.files, CARRY_KEPT);
            if (kept.exists()) deleteTree(kept);      // 更早留下的那份：工具包已经又换过一版，没用了
            boolean ok = old.renameTo(kept);
            ui.step(ok ? Tr.f("上次搬你自己装的 pip / npm 包时卡住了，这次跳过；原来的目录留在 {0}", kept.getPath())
                       : Tr.t("上次搬你自己装的 pip / npm 包时卡住了，这次跳过"));
            tryF.delete();
            return;
        }
        try (java.io.FileOutputStream o = new java.io.FileOutputStream(tryF)) {
            o.write(("{\"at\":" + System.currentTimeMillis() + "}\n").getBytes(StandardCharsets.UTF_8));
            o.getFD().sync();                          // 要在卡住之前落到盘上，否则下次看不见
        }
        carryOver(old, env.usr, keepComponents, identity);
        tryF.delete();
    }

    /**
     * 启动时先调：上次装工具包被打断的话，把目录收拾到一致状态。
     * @return 动过东西（接着装完了，或者退回了旧版）
     */
    /** 卸载工具包时先换名到这里再删：不能借用 usr.old，那是 recover() 眼里「退回旧版」的信号 */
    File usrTrash() { return new File(env.files, "usr.trash"); }

    /**
     * 卸载开发工具包（设置页「卸载」）：整个 usr 连同装在里面的组件、模块、pip / npm -g 装的东西一起删，
     * 组件记录也删（文件都在 usr 里）。home 里的会话、工作区、登录、设置不动。调用方负责先停网关，删完走首装流程。
     */
    void uninstallDevkit() throws IOException {
        File trash = usrTrash();
        if (trash.exists()) deleteTree(trash);
        if (env.usr.exists() && !env.usr.renameTo(trash)) throw new IOException(Tr.t("换名失败: ") + env.usr);
        ui.step(Tr.t("删除开发工具包文件…"));
        deleteTree(trash);
        deleteTree(new File(env.files, "components"));
        deleteTree(new File(env.files, "devkit-stage"));
    }

    /** 卸载删到一半被打断留下的 usr.trash：启动时顺手删掉 */
    void dropTrash() { deleteTree(usrTrash()); }

    /** 卸载 agy：删掉 install-agy.mjs 装的各个版本，记下「用户卸了」（不再自动装回）。
     *  home 里的登录（agyapp-providers.json）、会话（agyapp-sessions/）、设置（agyapp-settings.json）不动。
     *  FL-14：旧注释说的 ~/.claude 是 Claude 时代的路径，agy 不用它；agy CLI 自身凭据的落盘位置尚未在真机确认（LG-08），这里只写网关侧已确认的路径 */
    void uninstallAgy() throws IOException {
        write(env.agyOffFlag(), "{\"at\":" + System.currentTimeMillis() + "}\n");
        deleteTree(new File(env.home, ".local/share/agycodroid/agy"));
    }

    /** 有没有上次中断留下要收拾的东西。只看不动 —— 没有就别去停网关 */
    boolean needsRecovery() {
        File neu = usrNew(), old = usrOld();
        return neu.exists() || old.exists() || new File(env.usr, PENDING).isFile();
    }

    /** recover() 这次做了什么（给修复账本用）；什么都没做时为 null */
    String recovered;

    boolean recover() throws IOException {
        File neu = usrNew(), old = usrOld();
        boolean did = false;
        recovered = null;
        // 断在两次换名之间：旧版已换下、新版（校验过的）还没换上
        if (!env.usr.exists() && neu.isDirectory() && new File(neu, PENDING).isFile()) {
            if (!neu.renameTo(env.usr)) throw new IOException(Tr.t("换名失败: ") + neu);
            did = true;
            recovered = Tr.t("两次换名之间被打断：把已校验的新版换上");
        }
        if (new File(env.usr, PENDING).isFile()) {
            ui.step(Tr.t("上次的开发工具包更新被打断了，接着完成…"));
            finish();
            recovered = (recovered == null ? "" : recovered + Tr.t("；")) + Tr.t("上次更新在收尾阶段被打断：重跑首次配置并写好校验基线");
            if (carrySkipped) recovered += Tr.t("；上次搬用户自装包时卡住，这次跳过，旧目录留在 usr.old-kept");
            return true;
        }
        if (!env.usr.exists() && old.isDirectory()) { old.renameTo(env.usr); did = true; recovered = Tr.t("新版没换上：退回旧版"); }   // 新版没成：退回旧版
        if (neu.exists()) { deleteTree(neu); did = true; recovered = (recovered == null ? "" : recovered + Tr.t("；")) + Tr.t("删掉解到一半的新版"); }   // 解到一半的残骸
        if (old.exists() && new File(env.usr, ".devkit-ok").isFile()) deleteTree(old);
        return did;
    }

    // ── 完整性：工具包里的 libexec/devkit/MANIFEST 记着每个文件的 sha256 与大小 ──
    static final String MANIFEST = "libexec/devkit/MANIFEST", LOCAL_MANIFEST = ".devkit-manifest";

    /**
     * 本机校验基线：包里的清单 + first-run 的改动。postinst 会删掉个别文件（剔除），也会现场重写一些
     * （例如 git-delta 重新生成补全脚本 —— 按 first-run 前后的快照认出来，按实际内容重记）。
     * 只看 mtime + 大小，不逐个算哈希：没动过的文件不碰；动过的再算一次哈希二次确认（L3）。
     * M7：ok=false（这块的 first-run 失败了）时不重定基线——半成品不配当基线，.local 原样不动，
     * 核对时回落到包里原清单，不会把失败的产物洗成「正常」。
     */
    static void pruneManifest(File usrRoot, File man, File out, java.util.Map<String, long[]> snap, Progress ui, boolean ok) {
        if (!ok) { if (ui != null) ui.step(Tr.t("（这块首次配置失败，校验基线不按失败的产物记）")); return; }
        if (!man.isFile()) return;
        try {
            StringBuilder sb = new StringBuilder();
            int dropped = 0, rebased = 0;
            for (String l : java.nio.file.Files.readAllLines(man.toPath(), StandardCharsets.UTF_8)) {
                String[] f = l.split(" ", 3);
                if (f.length != 3) continue;
                File file = new File(usrRoot, f[2]);
                if (!file.isFile()) { dropped++; continue; }
                // 快照里没有（first-run 新建的）或 mtime/大小变了，才是 first-run 动过的文件：重算哈希二次确认，内容没变就不改行
                long[] s = snap == null ? null : snap.get(f[2]);
                boolean touched = s == null || file.lastModified() != s[0] || file.length() != s[1];
                if (touched) {
                    String h = sha256(file);
                    if (!h.equals(f[0])) { l = h + " " + file.length() + " " + f[2]; rebased++; }
                }
                sb.append(l).append('\n');
            }
            write(out, sb.toString());
            if (dropped + rebased > 0 && ui != null) ui.step(Tr.f("（首次配置删掉 {0} 个、改写 {1} 个文件，校验基线已按实际情况记下）", dropped, rebased));
        } catch (IOException e) { if (ui != null) ui.step(Tr.f("（校验基线没写成：{0}）", e.getMessage())); }
    }

    /** modules.json 里 kind=="base" 的那块的 gz sha256（按块装时的工具包身份，见 Updater L1）；没有返回 null */
    static String baseModuleSha(JSONObject mj) {
        org.json.JSONArray all = mj == null ? null : mj.optJSONArray("modules");
        if (all == null) return null;
        for (int i = 0; i < all.length(); i++) {
            JSONObject m = all.optJSONObject(i);
            if (m == null || !"base".equals(m.optString("kind"))) continue;
            JSONObject gz = m.optJSONObject("gz");
            String sha = gz == null ? "" : gz.optString("sha256", "");
            return sha.matches("[0-9a-f]{64}") ? sha : null;
        }
        return null;
    }

    /** 已装工具包的 modules.json；整包工具包没有，返回 null */
    JSONObject readModules() {
        try { return new JSONObject(new String(java.nio.file.Files.readAllBytes(new File(env.usr, MODULES_JSON).toPath()), StandardCharsets.UTF_8)); }
        catch (Exception e) { return null; }
    }
    static JSONObject moduleById(JSONObject mj, String id) {
        org.json.JSONArray a = mj.optJSONArray("modules");
        if (a != null) for (int i = 0; i < a.length(); i++) { JSONObject m = a.optJSONObject(i); if (m != null && id.equals(m.optString("id"))) return m; }
        return null;
    }

    /** 用户可能自己动的地方：配置、pip / npm 装的包。改了不算坏，只有"缺了"才算 */
    private static boolean userTouchable(String rel) {
        return rel.startsWith("etc/") || rel.startsWith("glibc/etc/") || rel.startsWith("var/")
            || rel.matches("lib/python3\\.\\d+/site-packages/.*") || rel.startsWith("lib/node_modules/");
    }

    /**
     * 核对已装工具包。full=false 只看文件在不在（几秒）；full=true 逐个算 sha256（一两分钟）。
     * @return {manifest, total, missing, changed, samples[]}；manifest=false 表示这一版工具包没带清单
     */
    JSONObject verifyDevkit(boolean full) throws Exception {
        JSONObject r = new JSONObject();
        File man = new File(env.usr, LOCAL_MANIFEST);
        if (!man.isFile()) man = new File(env.usr, MANIFEST);
        if (!man.isFile()) return r.put("manifest", false);
        java.util.List<String> lines = new java.util.ArrayList<>(java.nio.file.Files.readAllLines(man.toPath(), StandardCharsets.UTF_8));
        // 模块化：再加上已装各块的清单（first-run 改过的按 MANIFEST.local）
        JSONObject mj = readModules();
        org.json.JSONArray all = mj == null ? null : mj.optJSONArray("modules");
        if (all != null) for (int k = 0; k < all.length(); k++) {
            JSONObject m = all.optJSONObject(k);
            if (m == null || "base".equals(m.optString("kind"))) continue;
            File dir = new File(env.usr, m.optString("dir"));
            if (!new File(dir, ".ok").isFile()) continue;
            File mf = new File(dir, "MANIFEST.local");
            if (!mf.isFile()) mf = new File(dir, "MANIFEST");
            if (mf.isFile()) lines.addAll(java.nio.file.Files.readAllLines(mf.toPath(), StandardCharsets.UTF_8));
        }
        int missing = 0, changed = 0, i = 0;
        long bytes = 0, doneBytes = 0;
        for (String l : lines) { String[] f = l.split(" ", 3); if (f.length == 3) bytes += Long.parseLong(f[1]); }
        org.json.JSONArray samples = new org.json.JSONArray();
        for (String l : lines) {
            String[] f = l.split(" ", 3);
            if (f.length != 3) continue;
            i++;
            String rel = f[2];
            long size = Long.parseLong(f[1]);
            File file = new File(env.usr, rel);
            boolean bad = false, gone = !file.isFile();
            if (userTouchable(rel)) gone = false;
            else if (gone) { missing++; bad = true; }
            else if (full && !userTouchable(rel) && (file.length() != size || !f[0].equals(sha256(file)))) { changed++; bad = true; }
            if (bad && samples.length() < 12) samples.put((gone ? Tr.t("缺失 ") : Tr.t("改动 ")) + rel);
            doneBytes += full ? size : 0;
            if ((i & 255) == 0) ui.bytes(full ? doneBytes : i, full ? bytes : lines.size());
        }
        return r.put("manifest", true).put("total", i).put("missing", missing).put("changed", changed).put("samples", samples);
    }

    static String hex(byte[] d) {
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    /**
     * 更新工具包时，把用户自己装进 $PREFIX 的东西搬到新目录：pip（不带 --user）、npm -g 装的包和它们的命令，
     * 以及用户自己在 etc / share / var / opt 这些地方放的文件（0.6.9 审计 14-02：以前只搬 bin、lib/node_modules、
     * site-packages 三处，其余位置的用户内容随着旧目录一起删掉了）。
     * 判断"用户自己装的"：不在旧工具包的任何一份清单里 —— dpkg 的 var/lib/dpkg/info/*.list、底座与各模块的
     * FILES / MANIFEST / MANIFEST.local、组件的 MANIFEST 与界面那边的安装记录（files/components/*.json）。
     * 口径照网关的 gw/orphans.mjs baseOwnedPaths：旧工具包的文件一个都不能当用户内容搬进新版。
     * Python 小版本变了就不搬 lib/python3.X（编译过的扩展对不上新解释器）；tmp 与安装器自己的标记不搬。
     */
    private void carryOver(File old, File neu, boolean keepComponents, String identity) {
        carryOver(old, neu, env.files, keepComponents, identity, ui, "cc.codroid", env.pkg);
        carryPythonSkipped = new java.util.ArrayList<>(lastCarryPythonSkipped);
        if (!carryPythonSkipped.isEmpty() && ui != null)
            ui.step(Tr.f("Python 小版本变了，没搬 {0}（里面的扩展要重装）", android.text.TextUtils.join("、", carryPythonSkipped)));
    }

    /** 这次 carryOver 里因 Python 小版本变了而没搬的目录（finish() 记进账本，升级后自检能看到） */
    java.util.List<String> carryPythonSkipped = new java.util.ArrayList<>();
    /** 这次静态 carryOver 搬过来的相对路径（给前缀改写用）与因 Python 小版本变了没搬的目录 */
    static final java.util.List<String> lastCarryMoved = new java.util.ArrayList<>();
    static final java.util.List<String> lastCarryPythonSkipped = new java.util.ArrayList<>();

    /** carryOver 的实体。静态、只收目录：回归测试直接调，不用造 Android Context。
     *  identity 是本版工具包的身份（.devkit-pending 的 sha256）；keepComponents 时只认领这个身份上的组件记录。
     *  oldPkg/newPkg：1.0 的包名 → 现在的包名；都给且等长时，搬过来的文本文件里嵌的旧前缀会改写成新的 */
    static void carryOver(File old, File neu, File filesDir, boolean keepComponents, String identity, Progress ui) {
        carryOver(old, neu, filesDir, keepComponents, identity, ui, "cc.codroid", null);
    }

    static void carryOver(File old, File neu, File filesDir, boolean keepComponents, String identity, Progress ui, String oldPkg, String newPkg) {
        lastCarryMoved.clear();
        lastCarryPythonSkipped.clear();
        // 组件记录 / 包内 MANIFEST 认领的路径：同一版重装时要跟着搬；换版本时要当旧工具包的东西删掉。
        // 以前同一版重装只跳过了「把它们加进 owned」这一步，但组件自己的 dpkg 清单（gh.list 等）仍被当成底座，
        // 清单里的文件照样不搬 —— gh 这类经 dpkg 装的组件重装后仍然是坏的（0.6.11 补丁漏的就是这条路径）
        java.util.Set<String> compFiles = new java.util.HashSet<>();
        addComponents(compFiles, old, filesDir, keepComponents ? identity : null);
        java.util.Set<String> owned = new java.util.HashSet<>();
        // dpkg 清单：写的是 /data/data/<包名>/files/usr/…，而 env.usr 是 /data/user/0/…：只比 usr/ 之后的相对路径。
        // 0.3.9 及以前直接拿绝对路径比，一条都对不上，旧工具包和旧组件 bin/ 下的东西全被当成用户的搬了过来
        File[] lists = new File(old, "var/lib/dpkg/info").listFiles((d, n) -> n.endsWith(".list"));
        if (lists != null) for (File l : lists) {
            // 同一版重装：组件自己带的包清单不算底座的，否则它列的文件全被留在旧目录里删掉
            if (keepComponents && compFiles.contains("var/lib/dpkg/info/" + l.getName())) continue;
            try {
                for (String line : java.nio.file.Files.readAllLines(l.toPath())) addOwned(owned, line);
            }
            catch (IOException ignored) {}
        }
        // 底座与各模块自己的清单（MANIFEST 行是「sha 大小 相对路径」，FILES 是纯路径）
        addManifest(owned, new File(old, MANIFEST));
        addManifest(owned, new File(old, LOCAL_MANIFEST));
        addPaths(owned, new File(old, "libexec/devkit/FILES"));
        File[] ms = new File(old, "libexec/devkit/modules").listFiles();
        if (ms != null) for (File m : ms) {
            addPaths(owned, new File(m, "FILES"));
            for (String f : new String[]{"MANIFEST", "MANIFEST.local"}) addManifest(owned, new File(m, f));
        }
        // 换版本：组件文件是旧工具包上的，不能搬（新工具包里的同名文件也照旧不覆盖）；同一版重装：不认领，留给 moveUser 搬
        if (!keepComponents) owned.addAll(compFiles);
        // 整棵都没人认领的目录一次 rename 搬走，不用逐个文件走（lib / share 下动辄几万个文件）
        java.util.Set<String> ownedDirs = new java.util.HashSet<>();
        for (String rel : owned) for (int i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) ownedDirs.add(rel.substring(0, i));
        int n = moveUser(old, neu, "", owned, ownedDirs);
        if (n > 0 && ui != null) ui.step(Tr.f("保留了你自己装进工具包的 {0} 项", n));
        int rewritten = rewritePrefixes(neu, lastCarryMoved, oldPkg, newPkg);
        if (rewritten > 0 && ui != null) ui.step(Tr.f("把搬过来的 {0} 个文件里的旧包名改成了新的", rewritten));
    }

    /**
     * 搬过来的文件里嵌的旧包名前缀（/data/data/&lt;旧包名&gt;、/data/user/0/&lt;旧包名&gt;）改写成新包名。
     * 等长改写，文件大小不变；只改文本文件（二进制文件不动，免得改坏编译产物）；只走这次搬过来的路径，不碰新工具包自己的文件。
     * 新旧包名不等长时没法等长改写，直接跳过（cc.codroid 与 cc.agyroid 都是 10 字符，正常走改写）。
     */
    private static int rewritePrefixes(File neu, java.util.List<String> moved, String oldPkg, String newPkg) {
        if (oldPkg == null || newPkg == null || oldPkg.length() != newPkg.length() || oldPkg.equals(newPkg)) return 0;
        byte[] oldData = ("/data/data/" + oldPkg).getBytes(StandardCharsets.UTF_8);
        byte[] oldUser = ("/data/user/0/" + oldPkg).getBytes(StandardCharsets.UTF_8);
        byte[] newData = ("/data/data/" + newPkg).getBytes(StandardCharsets.UTF_8);
        byte[] newUser = ("/data/user/0/" + newPkg).getBytes(StandardCharsets.UTF_8);
        int n = 0;
        for (String rel : moved) n += rewritePrefixesIn(new File(neu, rel), oldData, newData, oldUser, newUser);
        return n;
    }

    private static int rewritePrefixesIn(File f, byte[] oldData, byte[] newData, byte[] oldUser, byte[] newUser) {
        if (f == null || isSymlink(f)) return 0;
        if (f.isDirectory()) {
            int n = 0;
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) n += rewritePrefixesIn(k, oldData, newData, oldUser, newUser);
            return n;
        }
        if (!f.isFile() || f.length() > (64L << 20)) return 0;   // 超大文件不碰，免得全读进内存
        try {
            byte[] b = java.nio.file.Files.readAllBytes(f.toPath());
            if (!looksText(b)) return 0;
            if (!containsBytes(b, oldData) && !containsBytes(b, oldUser)) return 0;
            replaceBytes(b, oldData, newData);
            replaceBytes(b, oldUser, newUser);
            java.nio.file.Files.write(f.toPath(), b);
            return 1;
        } catch (Exception ignored) { return 0; }
    }

    /** 文本文件启发式判断：前 8 KB 里没有 NUL 字节（和网关侧判断二进制的口径一致） */
    private static boolean looksText(byte[] b) {
        int n = Math.min(b.length, 8192);
        for (int i = 0; i < n; i++) if (b[i] == 0) return false;
        return true;
    }

    private static boolean containsBytes(byte[] b, byte[] needle) { return indexOfBytes(b, needle, 0) >= 0; }

    private static int indexOfBytes(byte[] b, byte[] needle, int from) {
        outer: for (int i = from; i + needle.length <= b.length; i++) {
            for (int j = 0; j < needle.length; j++) if (b[i + j] != needle[j]) continue outer;
            return i;
        }
        return -1;
    }

    private static void replaceBytes(byte[] b, byte[] old, byte[] neu) {
        int at = 0;
        while ((at = indexOfBytes(b, old, at)) >= 0) { System.arraycopy(neu, 0, b, at, neu.length); at += neu.length; }
    }

    /** 组件认领的路径：包内 MANIFEST + 界面那边的安装记录（files/components/<id>.json 的 files / shared）。
     *  onlyBase 非空时只收这个工具包身份上的记录（旧工具包留下的记录不能拿来认领）。 */
    private static void addComponents(java.util.Set<String> owned, File old, File filesDir, String onlyBase) {
        File[] cs = new File(old, "libexec/devkit/components").listFiles();
        if (cs != null) for (File cmp : cs) addManifest(owned, new File(cmp, "MANIFEST"));
        File[] recs = new File(filesDir, "components").listFiles((d, n) -> n.endsWith(".json"));
        if (recs != null) for (File r : recs) {
            try {
                JSONObject j = new JSONObject(new String(java.nio.file.Files.readAllBytes(r.toPath()), StandardCharsets.UTF_8));
                if (onlyBase != null) {
                    String base = j.optString("base", "");
                    if (!base.isEmpty() && !base.equals(onlyBase)) continue;
                }
                for (String k : new String[]{"files", "shared"}) {
                    org.json.JSONArray a = j.optJSONArray(k);
                    if (a != null) for (int i = 0; i < a.length(); i++) addOwned(owned, a.optString(i, ""));
                }
            } catch (Exception ignored) {}
        }
    }

    /** 清单里的一行 → 相对 $PREFIX 的路径：绝对路径取出 /files/usr/ 之后的部分，去掉 ./ 与结尾的 / */
    private static void addOwned(java.util.Set<String> owned, String line) {
        if (line == null) return;
        line = line.trim();
        int i = line.indexOf("/files/usr/");
        if (i >= 0) line = line.substring(i + 11);
        else if (line.startsWith("./")) line = line.substring(2);
        while (line.endsWith("/")) line = line.substring(0, line.length() - 1);
        if (line.isEmpty() || line.startsWith("/") || line.contains("../")) return;
        owned.add(line);
    }

    /** MANIFEST 格式：每行「sha256 大小 相对路径」（路径里允许有空格，取剩下的全部） */
    private static void addManifest(java.util.Set<String> owned, File f) {
        try {
            for (String line : java.nio.file.Files.readAllLines(f.toPath())) {
                String[] p = line.split(" ", 3);
                if (p.length == 3) addOwned(owned, p[2]);
            }
        } catch (Exception ignored) {}
    }

    /** FILES 格式：每行一个相对路径 */
    private static void addPaths(java.util.Set<String> owned, File f) {
        try { for (String line : java.nio.file.Files.readAllLines(f.toPath())) addOwned(owned, line); }
        catch (Exception ignored) {}
    }

    /** 搬 old 里没人认领的文件到 neu。整棵没人认领、新工具包也没有同名的目录一次 rename；同名的目录下钻，只搬里面多出来的 */
    private static int moveUser(File old, File neu, String relDir, java.util.Set<String> owned, java.util.Set<String> ownedDirs) {
        File[] kids = new File(old, relDir).listFiles();
        if (kids == null) return 0;
        int n = 0;
        for (File k : kids) {
            String rel = relDir.isEmpty() ? k.getName() : relDir + "/" + k.getName();
            // 安装器自己的东西：tmp、完成标记、清单，以及各模块的 .ok / MANIFEST.local（新版 first-run 会重写；
            // 搬过去会让没装的模块看着像装好了）。dpkg 数据库也不搬：里面的包清单只用来认主。
            // first-run 检查点与失败标记也是旧版的：搬进新版会让新版跳过没跑过的步骤（H5），或把旧失败当成新版的
            if (rel.equals("tmp") || rel.equals(".devkit-ok") || rel.equals(".devkit-manifest") || rel.equals(".devkit-relocated")
                || rel.equals(FIRSTRUN_DONE) || rel.equals(FIRSTRUN_FAILED)
                || rel.equals("var/lib/dpkg") || rel.equals("libexec/devkit/modules.json")
                || (rel.startsWith("libexec/devkit/modules/") && (rel.endsWith("/.ok") || rel.endsWith("/MANIFEST.local")))) continue;
            // 解释器小版本变了：编译过的扩展搬过去也加载不了，整棵 lib/python3.X 不动（和以前的 site-packages 口径一致）
            if (rel.matches("lib/python3\\.\\d+") && !new File(neu, rel).isDirectory()) { lastCarryPythonSkipped.add(rel); continue; }
            boolean dir = k.isDirectory() && !isSymlink(k);
            boolean mine = !owned.contains(rel) && !(dir && ownedDirs.contains(rel));
            File to = new File(neu, rel);
            if (mine && !to.exists() && !isSymlink(to)) {
                File p = to.getParentFile();
                if (p != null) p.mkdirs();
                if (k.renameTo(to)) { lastCarryMoved.add(rel); n++; continue; }
            }
            if (dir) n += moveUser(old, neu, rel, owned, ownedDirs);
        }
        return n;
    }

    /** glibc 版程序（官方 Antigravity CLI）解析域名靠它；安卓没有 /etc/resolv.conf */
    private void writeResolvConf() throws IOException {
        File etc = new File(env.usr, "glibc/etc");
        etc.mkdirs();
        write(new File(etc, "resolv.conf"), "nameserver 8.8.8.8\nnameserver 1.1.1.1\nnameserver 223.5.5.5\n");
        File hosts = new File(etc, "hosts");
        if (!hosts.exists()) write(hosts, "127.0.0.1 localhost\n::1 localhost\n");
    }

    // ── 官方 Antigravity CLI ───────────────────────────────────────────────
    /** ver：latest / 具体版本号 —— 按设置里选的装，别先装个最新版再让自动更新换掉（白下一次） */
    void installAgy(File script, String ver) throws IOException {
        ui.step(Tr.t("从官方渠道下载 Antigravity CLI…"));
        // 下载 CLI 可能超过 10 分钟（网慢）：这里不设单步超时，超时只掐 first-run 这类本地步骤
        int rc = run(0, null, env.bin("bash").getPath(), script.getPath(), ver);
        if (rc != 0 || !env.agyReady()) throw new IOException(Tr.f("Antigravity CLI 安装失败（rc={0}）", rc));
    }

    /** 最近一次 run() 的结果（步骤 / 尾部 / 是否超时），给 firstRuns 记结构化失败用 */
    RunOutcome lastOutcome = new RunOutcome();

    int run(String... cmd) throws IOException {
        return run(RUN_TIMEOUT_MS, null, cmd);
    }

    /** timeoutMs <= 0 = 不设超时；logFile 非空时输出全文落盘（H3）。超时杀掉进程、返回 TIMEOUT_RC（H4） */
    int run(long timeoutMs, File logFile, String... cmd) throws IOException {
        ProcessBuilder pb = new ProcessBuilder(env.cmd(cmd));
        env.apply(pb.environment());
        pb.directory(env.home);
        pb.redirectErrorStream(true);
        RunOutcome o = new RunOutcome();
        int rc = runProcess(pb, ui, timeoutMs, logFile, o);
        lastOutcome = o;
        return rc;
    }

    // ── tar（ustar + GNU 长名 + pax）────────────────────────────────────
    private void untar(InputStream in, File root, String strip) throws IOException { untar(in, root, strip, null); }

    /** @param only 非空时只解出解包后相对路径在 only 里的条目，其余跳过（不写盘、不建链接） */
    private void untar(InputStream in, File root, String strip, java.util.Set<String> only) throws IOException {
        byte[] h = new byte[512];
        String longName = null, longLink = null;
        String rootPath = root.getCanonicalPath();
        while (true) {
            if (!readFully(in, h)) break;
            if (allZero(h)) break;
            long size = octal(h, 124, 12);
            if (size < 0) throw new IOException(Tr.t("tar 损坏：头记录大小不对"));
            char type = (char) (h[156] == 0 ? '0' : h[156]);
            int mode = (int) Math.max(0, octal(h, 100, 8));
            long mtime = Math.max(0, octal(h, 136, 12));
            if (type == 'L' || type == 'K' || type == 'x' || type == 'g') {
                byte[] body = readBody(in, size);
                if (type == 'L') longName = cstr(body, 0, body.length);
                else if (type == 'K') longLink = cstr(body, 0, body.length);
                else if (type == 'x') {
                    // 长度是字节数（含中文的路径一个字三字节）：在字节上往前走，切出一条再按 UTF-8 解（#104 05-006）
                    for (int i = 0; i < body.length; ) {
                        int sp = i, len;
                        while (sp < body.length && body[sp] != ' ') sp++;
                        // 每条是「长度 空格 键=值 换行」：长度读不出、不往前走、越过结尾都算坏包，抛 IOException 走清理
                        try { len = Integer.parseInt(new String(body, i, sp - i, StandardCharsets.US_ASCII)); } catch (RuntimeException e) { throw new IOException(Tr.t("tar 损坏：pax 记录格式不对")); }
                        if (sp >= body.length || len <= sp - i + 1 || i + len > body.length) throw new IOException(Tr.t("tar 损坏：pax 记录格式不对"));
                        String kv = new String(body, sp + 1, i + len - 1 - (sp + 1), StandardCharsets.UTF_8);
                        int eq = kv.indexOf('=');
                        if (kv.startsWith("path=")) longName = kv.substring(eq + 1);
                        if (kv.startsWith("linkpath=")) longLink = kv.substring(eq + 1);
                        i += len;
                    }
                }
                continue;
            }
            String prefix = cstr(h, 345, 155);
            String name = longName != null ? longName : (prefix.isEmpty() ? "" : prefix + "/") + cstr(h, 0, 100);
            String link = longLink != null ? longLink : cstr(h, 157, 100);
            longName = longLink = null;
            if (name.startsWith("./")) name = name.substring(2);
            if (!name.startsWith(strip)) { skip(in, size); continue; }
            name = name.substring(strip.length());
            if (name.isEmpty() || name.equals("/")) { skip(in, size); continue; }
            if (only != null && !only.contains(name)) { skip(in, size); continue; }   // 白名单外不解，只跳过
            File f = new File(root, name);
            // 比前缀要带上分隔符：只比 rootPath 的话 usr.newEvil/x 也算在 usr 里头（审查 低5）
            // 链接条目查的是它「放在哪」（父目录），指向哪不限：工具包里本来就有指到 usr 外的链接，顺着它写文件时上面这条照样拦（审查 10-29 L11）
            if (!inside(type == '2' ? f.getParentFile() : f, rootPath)) throw new IOException(Tr.t("越界条目: ") + name);
            try {
                switch (type) {
                    case '5':
                        f.mkdirs();
                        Os.chmod(f.getPath(), (mode & 0777) | 0700);
                        break;
                    case '2':
                        f.getParentFile().mkdirs();
                        f.delete();
                        Os.symlink(link, f.getPath());
                        break;
                    case '1': {
                        String target = link.startsWith("./") ? link.substring(2) : link;
                        if (target.startsWith(strip)) target = target.substring(strip.length());
                        File tf = new File(root, target);
                        if (!inside(tf, rootPath)) throw new IOException(Tr.t("越界条目: ") + name);
                        // 白名单模式：硬链接的目标可能没解出来（不在 only 里），Os.link 会抛错导致整个取回失败；
                        // 跳过这一条，调用方解包后的逐个核对会报出缺了哪个文件（全量安装时 only 为 null，目标一定在，不受影响）
                        if (only != null && !tf.isFile()) { android.util.Log.w("Installer", "跳过硬链接 " + name + "：目标 " + target + " 不在白名单里"); break; }
                        f.getParentFile().mkdirs();
                        f.delete();
                        Os.link(tf.getPath(), f.getPath());
                        break;
                    }
                    case '0': case '7': {
                        f.getParentFile().mkdirs();
                        try (OutputStream o = new FileOutputStream(f)) { copy(in, o, size); }
                        pad(in, size);
                        Os.chmod(f.getPath(), (mode & 0777) | 0600);
                        // 保留包里的修改时间。不保留的话一律是解包那一刻，先后全凭解包顺序 ——
                        // gdb 内嵌的 Guile 一看 .scm 比编译好的 .go 新，就逐个重编译（而编译器本身用不了），
                        // 表现为 gdb 任何参数都无输出、原地空转烧 CPU。make 之类按时间戳判断的工具也会被搅乱。
                        if (mtime > 0) f.setLastModified(mtime * 1000);
                        continue;
                    }
                    default:
                        break;
                }
            } catch (android.system.ErrnoException e) {
                throw new IOException(name + ": " + e.getMessage());
            }
            skip(in, size);
        }
    }

    private static boolean inside(File f, String rootPath) throws IOException {
        String p = f.getCanonicalPath();
        return p.equals(rootPath) || p.startsWith(rootPath + File.separator);
    }

    private static boolean readFully(InputStream in, byte[] b) throws IOException {
        int off = 0;
        while (off < b.length) {
            int n = in.read(b, off, b.length - off);
            if (n < 0) { if (off == 0) return false; throw new IOException(Tr.t("tar 截断")); }
            off += n;
        }
        return true;
    }
    // 长名 / pax 记录读进内存：大小先夹住。负数、超大的直接当坏包（以前 (int) 截断成负数抛的是
    // NegativeArraySizeException，不是 IOException，躲过了解包失败时的清理，审查 v0.5.7 L9）
    private static byte[] readBody(InputStream in, long size) throws IOException {
        if (size < 0 || size > 1 << 20) throw new IOException(Tr.t("tar 损坏：头记录大小不对"));
        byte[] b = new byte[(int) size];
        readFully(in, b);
        pad(in, size);
        return b;
    }
    private static void copy(InputStream in, OutputStream o, long size) throws IOException {
        byte[] buf = new byte[1 << 16];
        while (size > 0) {
            int n = in.read(buf, 0, (int) Math.min(buf.length, size));
            if (n < 0) throw new IOException(Tr.t("tar 截断"));
            o.write(buf, 0, n);
            size -= n;
        }
    }
    private static void skip(InputStream in, long size) throws IOException {
        long n = (size + 511) / 512 * 512;
        byte[] buf = new byte[8192];
        while (n > 0) { int r = in.read(buf, 0, (int) Math.min(buf.length, n)); if (r < 0) throw new IOException(Tr.t("tar 截断")); n -= r; }
    }
    private static void pad(InputStream in, long size) throws IOException {
        long r = size % 512;
        if (r != 0) { byte[] z = new byte[(int) (512 - r)]; readFully(in, z); }
    }
    private static boolean allZero(byte[] b) { for (byte x : b) if (x != 0) return false; return true; }
    private static long octal(byte[] b, int off, int len) {
        long v = 0;
        for (int i = off; i < off + len; i++) {
            int c = b[i];
            if (c == 0 || c == ' ') { if (v != 0) break; else continue; }
            if (c < '0' || c > '7') return -1;           // 不是八进制数字（或 GNU 的 base-256 大文件编码）：交给调用处当坏包
            v = v * 8 + (c - '0');
        }
        return v;
    }
    /** 清单里的 sha 可能短于 12 位（手写错）：只取前 12 位，短的原样给，不抛 */
    private static String head12(String s) { return s == null ? "" : s.length() > 12 ? s.substring(0, 12) : s; }

    private static String cstr(byte[] b, int off, int len) {
        int end = off;
        while (end < off + len && b[end] != 0) end++;
        return new String(b, off, end - off, StandardCharsets.UTF_8);
    }

    static void write(File f, String s) throws IOException {
        try (OutputStream o = new FileOutputStream(f)) { o.write(s.getBytes(StandardCharsets.UTF_8)); }
    }

    static void deleteTree(File f) {
        if (f == null || !f.exists() && !isSymlink(f)) return;
        if (f.isDirectory() && !isSymlink(f)) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        f.delete();
    }
    private static boolean isSymlink(File f) {
        try { return (Os.lstat(f.getPath()).st_mode & 0170000) == 0120000; }
        catch (Exception e) { return false; }
    }

    /** 统计已读字节，给进度条用 */
    private final class Counting extends InputStream {
        private final InputStream in; private final long total; private long done, lastTick;
        Counting(InputStream in, long total) { this.in = in; this.total = total; }
        @Override public int read() throws IOException { int b = in.read(); if (b >= 0) tick(1); return b; }
        @Override public int read(byte[] b, int o, int l) throws IOException { int n = in.read(b, o, l); if (n > 0) tick(n); return n; }
        private void tick(int n) {
            done += n;
            if (done - lastTick > (4 << 20) || done == total) { lastTick = done; ui.bytes(done, total); }
        }
        @Override public void close() throws IOException { in.close(); }
    }
}
