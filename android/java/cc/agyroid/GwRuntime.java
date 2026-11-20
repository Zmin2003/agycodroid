package cc.agyroid;

import android.content.Context;
import android.system.Os;
import android.system.OsConstants;
import android.util.Log;

import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * 网关自己的运行库（安全 4 第 2 层）：网关的 node 和它加载的库、网关起 claude 用的 glibc，单独放一份在 files/gw，
 * 起网关前逐个按安装包钉住的 sha256 核（assets/gwpin.json，build.sh 从钉住那版工具包的基础模块包算出来，见 devkit.mjs gwpin）。
 *
 * 为什么另放一份：$PREFIX 里的 node、libssl、libicu、glibc 和会话里跑的命令同一个 uid，换掉它们网关 / claude 就跑别人的代码；
 * 而且用户 pkg upgrade 会合法地换掉这些库，按哈希核 $PREFIX 就会把正常升级当成篡改。files/gw 不归 pkg、工具包更新也不动（在 usr 外面），
 * 只有这里按钉子写进来。
 *
 * 对不上的先从 $PREFIX 里对得上的那份拷（刚装好的工具包、没升级过的库）；$PREFIX 里也对不上（升级过、被改过）就联网取钉住那版的基础模块包，
 * 一路按 devkit-pin.json → modules.json → 包的 sha256 核下来，解出要的几个文件。都不成：发行版不起网关（GatewayService），开发版退回用 $PREFIX 的。
 * 目录里多出来的文件一律删掉（别让人往网关的库目录里塞一个同名库）。
 *
 * 剩下的边界（SECURITY.md）：核完到 node / ld.so 真正映射进来之间有几毫秒的窗口；网关跑着时 files/gw/glibc 被换，
 * 网关起 claude 前会再核（gateway/gw/gwpin.mjs），对不上那一轮不起、网关退出让这里重新核。
 */
final class GwRuntime {
    private static final String TAG = "agycodroid.gw";

    final File dir, glibc;
    private final Env env;
    private final Context ctx;

    GwRuntime(Context c, Env env) {
        this.ctx = c; this.env = env;
        dir = new File(env.files, "gw");
        glibc = new File(dir, "glibc");
    }

    File node() { return new File(dir, "node"); }
    File loader() { return new File(glibc, "ld-linux-aarch64.so.1"); }

    /** 安装包钉的那份（assets/gwpin.json）；没有返回 null */
    static JSONObject pin(Context c) {
        String s = AppFiles.assetText(c, "gwpin.json");
        if (s == null) return null;
        try { return new JSONObject(s); } catch (Exception e) { return null; }
    }

    /** 发行版（gateway/gw/edition.mjs 里的 SEALED）：读安装包里那份原文，不认盘上的、不认任何开关 */
    static boolean sealed(Context c) {
        String s = AppFiles.assetText(c, "app/gw/edition.mjs");
        return s == null || !java.util.regex.Pattern.compile("(?m)^let SEALED = false;").matcher(s).find();   // 认不出按发行版，宁严勿松
    }

    /** gw 那组的钉子（文件名 → sha256），交给网关在起 claude 前再核。
     *  拿不到有效钉子返回 null（不是 ""）：网关侧 GWPIN 为 null 时按 fail-closed 处理，这一轮不起
     *  Antigravity CLI（见 gwpin.mjs 的 gw 组缺钉子分支，和 glibc 组同一条路，只是不调 APP.restart）；
     *  钉子一到就按它复核 files/gw 下的 node、libz 等 13 个文件 */
    String gwPin() {
        JSONObject p = pin(ctx);
        JSONObject g = p == null ? null : p.optJSONObject("gw");
        if (g == null) return null;
        JSONObject o = new JSONObject();
        try { for (java.util.Iterator<String> it = g.keys(); it.hasNext(); ) { String k = it.next(); o.put(k, g.getJSONObject(k).getString("sha256")); } }
        catch (Exception e) { return null; }
        return o.toString();
    }

    /** glibc 那组的钉子（文件名 → sha256），交给网关在起 claude 前再核。
     *  拿不到有效钉子返回 null（不是 ""）："" 在网关侧会被当成“没有钉子、直接放行”，null 由网关按 fail-closed 处理 */
    String glibcPin() {
        JSONObject p = pin(ctx);
        JSONObject g = p == null ? null : p.optJSONObject("glibc");
        if (g == null) return null;
        JSONObject o = new JSONObject();
        try { for (java.util.Iterator<String> it = g.keys(); it.hasNext(); ) { String k = it.next(); o.put(k, g.getJSONObject(k).getString("sha256")); } }
        catch (Exception e) { return null; }
        return o.toString();
    }

    /** 进度（通知栏、启动页上的那行字）；可为 null。bytes：下载的字节进度 */
    interface Say { void say(String s); default void bytes(long done, long total) {} }

    /** 这次 ensure() 是否真的尝试过联网取回（进过 fetchBase）；GatewayService 据此决定要不要记一次取回节流——
     *  整理阶段就失败（put 拷失败之类）不算取回，别一次 put 失败就锁 30 分钟 */
    boolean fetchAttempted;
    /** 取回失败的原因（M3，按错误类型分级）：null=没试或成功，"nospace"=空间不足，"network"=网络或其他联网错，
     *  "verify"=校验类（哈希 / 签名对不上、钉的文件 404），"io"=本地读盘错 */
    static final String FETCH_NETWORK = "network", FETCH_NOSPACE = "nospace", FETCH_VERIFY = "verify", FETCH_IO = "io";
    String fetchFailKind;
    /** 这次缺 / 对不上的文件与原因（"node：哈希不符；libz.so.1：缺失"），给诊断与账本用 */
    String fetchFailDetail;
    /** 取回因空间不足失败时：需要 / 当时可用（字节），给界面写明数字用 */
    long fetchNeedBytes, fetchFreeBytes;
    /** 停止 / 停住时中断下载：GatewayService.spawnGateway 在 ensure() 前挂上 () -> stopping || paused */
    volatile java.util.function.BooleanSupplier cancelCheck;

    /**
     * 让 files/gw 和钉子一致。返回 null 表示好了；否则是给人看的原因。
     * @param fetch 本地凑不齐时可以联网取钉住那版的基础模块包
     * @throws Installer.Cancelled 下载中途点了停止 / 服务停住：不是取回失败，直接中断，调用方别记节流
     */
    String ensure(boolean fetch, Say say) throws Installer.Cancelled {
        fetchAttempted = false; fetchFailKind = null; fetchFailDetail = null; fetchNeedBytes = fetchFreeBytes = 0;
        JSONObject p = pin(ctx);
        if (p == null) return Tr.t("安装包里没有网关运行库的清单（gwpin.json）");
        if (!ctx.getPackageName().equals(p.optString("target"))) return Tr.f("网关运行库的清单是给 {0} 的", p.optString("target"));
        JSONObject gw = p.optJSONObject("gw"), gl = p.optJSONObject("glibc");
        if (gw == null || gl == null || !gw.has("node")) return Tr.t("网关运行库的清单坏了");
        dir.mkdirs(); glibc.mkdirs();
        java.util.List<String[]> missing = new java.util.ArrayList<>();   // {目标路径, 源相对路径, sha256}
        java.util.List<String> missingWhy = new java.util.ArrayList<>();  // 与 missing 一一对应：缺失 / 哈希不符 / 读不到
        try {
            prune(dir, gw, true);
            prune(glibc, gl, false);
            for (Object[] grp : new Object[][] { { dir, gw }, { glibc, gl } }) {
                File d = (File) grp[0]; JSONObject g = (JSONObject) grp[1];
                for (java.util.Iterator<String> it = g.keys(); it.hasNext(); ) {
                    String name = it.next();
                    JSONObject e = g.getJSONObject(name);
                    File dst = new File(d, name);
                    String want = e.getString("sha256"), src = e.getString("src");
                    String state = shaState(dst, want);
                    if ("ok".equals(state)) continue;
                    File from = new File(env.usr, src);
                    if ("ok".equals(shaState(from, want))) {
                        try { put(from, dst, want, null); continue; }
                        catch (Exception ex) {
                            // M6：一个文件拷失败就整个放弃、连 fetchBase 都不跑 —— 改成记入 missing，扫完统一取回
                            Log.w(TAG, "从 $PREFIX 拷 " + name + " 失败，改走联网取回", ex);
                        }
                    }
                    missing.add(new String[] { dst.getPath(), src, want });
                    // M3：缺失、哈希不符、读不到是三种不同的原因，别都笼统记成“对不上”
                    missingWhy.add(name + "："
                        + ("missing".equals(state) ? "缺失" : "mismatch".equals(state) ? "哈希不符" : "读不到"));
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "整理 files/gw 失败", e);
            return Tr.t("整理网关运行库失败：") + e.getMessage();
        }
        if (missing.isEmpty()) return null;
        Log.w(TAG, "files/gw 缺 " + missing.size() + " 个，$PREFIX 里也对不上");
        fetchFailDetail = android.text.TextUtils.join("；", missingWhy);
        if (!fetch) return Tr.f("网关运行库有 {0} 个文件和安装包对不上", missing.size());
        try {
            fetchBase(missing, say);
            return null;
        } catch (Installer.Cancelled e) {
            throw e;
        } catch (Exception e) {
            Log.w(TAG, "联网取网关运行库失败", e);
            fetchFailKind = resolveFetchFailKind(fetchFailKind, e);
            return Tr.t("网关运行库和安装包对不上，联网取回也没成：") + e.getMessage();
        }
    }

    /** M3：取回失败 kind 的最终判定（纯函数，供 JVM 测试）：fetchBase 空间预检已定 kind 时保留它（预设优先），
     *  否则按异常分类。ensure() 的 catch 不能无条件覆盖预设——预检抛出的逐字消息不含任何分类子串，
     *  会被 classifyFetchFailure 误判成 network，导致空间不足走了网络退避（B2）。 */
    static String resolveFetchFailKind(String preset, Throwable e) {
        if (preset != null) return preset;
        return classifyFetchFailure(e);
    }

    /** 取回失败按错误类型分级（M3）：nospace 空间不足；verify 校验类（哈希 / 签名对不上、钉的文件 404）；
     *  io 本地读盘错；network 联网错（连不上 / 超时 / 解析失败 / 服务端 5xx）。校验类失败不再被当成网络问题，
     *  也不走网络退避（见 GatewayService）。未知异常默认 network，保持旧行为 */
    static String classifyFetchFailure(Throwable e) {
        if (e == null) return FETCH_NETWORK;
        if (isNoSpace(e)) return FETCH_NOSPACE;
        String m = String.valueOf(e.getMessage());
        if (m.contains("对不上") || m.contains("签名")) return FETCH_VERIFY;
        if (m.contains("HTTP 404") || m.contains("HTTP 410")) return FETCH_VERIFY;
        if (m.contains("No such file") || m.contains("Permission denied") || m.contains("Read-only")
                || m.contains("EACCES") || m.contains("EIO") || m.contains("Input/output error")
                || m.contains("Is a directory")) return FETCH_IO;
        return FETCH_NETWORK;
    }

    /** 空间不足吗：Installer.NoSpace，或解包/写盘时报的 ENOSPC（No space left on device） */
    private static boolean isNoSpace(Throwable e) {
        if (e instanceof Installer.NoSpace) return true;
        String m = String.valueOf(e.getMessage());
        return m.contains("No space") || m.contains("ENOSPC") || m.contains("存储空间不够");
    }

    /** 删掉目录里钉子以外的东西（top：网关目录，glibc 子目录留着） */
    private static void prune(File d, JSONObject keep, boolean top) {
        File[] fs = d.listFiles();
        if (fs == null) return;
        for (File f : fs) {
            String n = f.getName();
            if (top && n.equals("glibc") && f.isDirectory() && !isLink(f)) continue;
            if (keep.has(n) && f.isFile() && !isLink(f)) continue;
            Installer.deleteTree(f);
        }
    }

    private static boolean isLink(File f) {
        try { return android.system.OsConstants.S_ISLNK(Os.lstat(f.getPath()).st_mode); } catch (Exception e) { return false; }
    }

    /**
     * 拷进来：写到随机名的临时文件、核过再换名；swap 非空时边拷边改前缀（等长）。
     * 目录同 uid 可写，写的时候别人能抢先放符号链接、写完换成别的文件（DeepSeek 复核 v067 必修 1）：
     * 临时文件 O_CREAT|O_EXCL 新建（不跟已有的链接），权限用 fchmod 打在自己打开的那个上，
     * 换名前后都按 inode 认是不是自己写的那个，不是就删掉报错（下次起网关重来）
     */
    private static void put(File from, File dst, String want, byte[][] swap) throws IOException {
        File tmp = new File(dst.getPath() + ".tmp-" + Long.toHexString(new java.security.SecureRandom().nextLong() & Long.MAX_VALUE));
        MessageDigest md = md();
        java.io.FileDescriptor fd;
        try { fd = Os.open(tmp.getPath(), OsConstants.O_WRONLY | OsConstants.O_CREAT | OsConstants.O_EXCL | OsConstants.O_NOFOLLOW, 0600); }
        catch (android.system.ErrnoException e) { throw new IOException(e.getMessage()); }
        long ino;
        try (InputStream in = new FileInputStream(from); FileOutputStream o = new FileOutputStream(fd)) {
            if (swap == null) { byte[] b = new byte[1 << 20]; for (int n; (n = in.read(b)) > 0; ) { md.update(b, 0, n); o.write(b, 0, n); } }
            else swapCopy(in, o, md, swap[0], swap[1]);   // L1：边读边换，不把整个文件读进内存
            o.flush();
            Os.fsync(fd);
            Os.fchmod(fd, 0700);
            ino = Os.fstat(fd).st_ino;
        } catch (android.system.ErrnoException e) {
            tmp.delete(); throw new IOException(e.getMessage());
        } finally {
            try { Os.close(fd); } catch (Exception ignored) {}
        }
        String got = Installer.hex(md.digest());
        if (!want.equals(got)) { tmp.delete(); throw new IOException(Tr.f("{0} 拷过来以后对不上", dst.getName())); }
        try {
            android.system.StructStat t = Os.lstat(tmp.getPath());
            if (!OsConstants.S_ISREG(t.st_mode) || t.st_ino != ino) { tmp.delete(); throw new IOException(Tr.f("{0} 拷过来以后对不上", dst.getName())); }
            Os.rename(tmp.getPath(), dst.getPath());
            android.system.StructStat d = Os.lstat(dst.getPath());
            if (!OsConstants.S_ISREG(d.st_mode) || d.st_ino != ino) { dst.delete(); throw new IOException(Tr.f("{0} 拷过来以后对不上", dst.getName())); }
        } catch (android.system.ErrnoException e) {
            tmp.delete(); throw new IOException(Tr.t("换名失败: ") + dst);
        }
        CACHE.remove(dst.getPath());
    }

    /**
     * 联网取钉住那版工具包的基础模块包（devkit-pin.json 钉 modules.json 的 sha256，modules.json 钉包的 sha256 与 tar 的 sha256），
     * 解到 files/gw-stage，取出要的文件按钉子核过放进来。解出的 stage 当场删；下载的 gz 在 45 个文件全部落盘核对通过后才删，
     * 中途失败留着，下次重试直接复用/续传，不重下 655 MB（B7）。只解 missing 里那 45 个条目，不解整包（M1）。
     */
    private void fetchBase(java.util.List<String[]> missing, Say say) throws Exception {
        fetchAttempted = true;
        JSONObject dp = Updater.devkitPin(ctx);
        JSONObject mref = dp == null ? null : dp.optJSONObject("modules");
        if (mref == null) throw new IOException(Tr.t("安装包里的工具包清单没有模块表"));
        String base = dp.optString("base"), tag = dp.optString("tag");
        String mjUrl = base + mref.optString("file", "modules.json");
        byte[] mj;
        try { mj = Installer.httpGetSmall(mjUrl); }
        catch (IOException e) { mj = Installer.httpGetSmall(Installer.DEVKIT_MIRROR + tag + "/" + mref.optString("file", "modules.json")); }
        if (!mref.optString("sha256").equals(Installer.hex(md().digest(mj)))) throw new IOException(Tr.t("模块表和安装包钉的对不上"));
        JSONObject baseMod = null;
        org.json.JSONArray mods = new JSONObject(new String(mj, StandardCharsets.UTF_8)).optJSONArray("modules");
        for (int i = 0; mods != null && i < mods.length(); i++) if ("base".equals(mods.getJSONObject(i).optString("kind"))) baseMod = mods.getJSONObject(i);
        JSONObject gz = baseMod == null ? null : baseMod.optJSONObject("gz"), tar = baseMod == null ? null : baseMod.optJSONObject("tar");
        if (gz == null || tar == null) throw new IOException(Tr.t("模块表里没有基础模块"));
        Installer ins = new Installer(env, new Installer.Progress() {
            public void step(String m) { if (say != null) say.say(m); }
            public void bytes(long done, long total) { if (say != null) say.bytes(done, total); }
        });
        ins.cancelCheck = () -> cancelCheck != null && cancelCheck.getAsBoolean();
        String file = gz.optString("file");
        File dest = new File(env.files, "gw-" + file);
        // M1：门槛不再按整包算（gz 655 MB + tar 1810 MB + 100 MB ≈ 2.5 GiB）。只解 missing 的 45 个文件，
        // pin 里没有单文件大小：45 个文件解开后约 100 MB 出头（node、ICU、glibc），按 150 MB 估 + 100 MB 余量。
        // 已下好的 gz / .part 不再重复算（download() 会复用），空间不够时直接报“需要约 X MB、当前可用 Y MB”
        long have = dest.isFile() && dest.length() == gz.optLong("bytes") ? gz.optLong("bytes")
            : new File(dest.getPath() + ".part").length();
        long need = Math.max(0, gz.optLong("bytes") - have) + (150L << 20) + (100L << 20);
        long free = new android.os.StatFs(env.files.getPath()).getAvailableBytes();
        if (free < need) {
            fetchFailKind = "nospace"; fetchNeedBytes = need; fetchFreeBytes = free;
            throw new IOException(Tr.f("取回网关运行库需要约 {0} MB，手机里目前只剩 {1} MB。清理出空间后会再试（已下载的部分会保留）。",
                String.valueOf(need >> 20), String.valueOf(free >> 20)));
        }
        if (say != null) say.say(Tr.f("取回网关运行库：下载 {0} MB…", String.valueOf(gz.optLong("bytes") >> 20)));
        File got = ins.download(Installer.DEVKIT_MIRROR + tag + "/" + file, base + file, dest, gz.optLong("bytes"), gz.optString("sha256"));
        File stage = new File(env.files, "gw-stage");
        Installer.deleteTree(stage);
        boolean ok = false;
        try {
            stage.mkdirs();
            if (say != null) say.say(Tr.t("取回网关运行库：解包…"));
            // M1：白名单，只解 missing 里那 45 个条目（untar 里按解包后相对 usr/ 的路径比对，即 pin 里的 src）
            java.util.Set<String> only = new java.util.HashSet<>();
            for (String[] m : missing) only.add(m[1]);
            ins.extractInto(stage, new FileInputStream(got), got.length(), true, tar.optString("sha256"), only);
            // 包是给 devkit-pin 的目标包名做的；本应用包名不同（开发版）就等长改前缀，和 devkit.mjs gwpin 算钉子时一样
            String from = dp.optString("target"), to = ctx.getPackageName();
            byte[][] swap = null;
            if (!from.isEmpty() && !from.equals(to)) {
                byte[] a = ("/data/data/" + from + "/").getBytes(StandardCharsets.UTF_8), b = ("/data/data/" + to + "/").getBytes(StandardCharsets.UTF_8);
                if (a.length != b.length) throw new IOException(Tr.t("包名长度不同，没法改前缀"));
                swap = new byte[][] { a, b };
            }
            for (String[] m : missing) put(new File(stage, m[1]), new File(m[0]), m[2], swap);
            // B7：全部落盘后再逐个核对，通过了才算取回成功；没通过就留着 gz 下次重试，不重下
            for (String[] m : missing) {
                if (!m[2].equals(shaCached(new File(m[0])))) throw new IOException(Tr.f("{0} 取回来以后对不上", new File(m[0]).getName()));
            }
            ok = true;
        } finally {
            Installer.deleteTree(stage);
            if (ok) { got.delete(); new File(got.getPath() + ".sha256").delete(); }
        }
    }

    // ── 哈希缓存：同一个文件（inode、大小、修改时间、ctime 都没变）不重算。ctime 用户态改不了，换内容一定会变 ──
    private static final java.util.Map<String, String[]> CACHE = new java.util.concurrent.ConcurrentHashMap<>();

    /** 文件的 sha256；读不到（没有、不是普通文件、读盘错）返回 null —— 不是 ""：调用方要分清“读不到”与“哈希不符”（M3）。
     *  以前任何异常都返回 ""，和哈希不符混在一起，取回失败就被当成网络问题 */
    static String shaCached(File f) {
        try {
            android.system.StructStat s = Os.lstat(f.getPath());
            if (!android.system.OsConstants.S_ISREG(s.st_mode)) return null;
            String fp = s.st_ino + ":" + s.st_size + ":" + s.st_mtime + ":" + s.st_ctime;   // minSdk 26 没有 st_mtim / st_ctim（纳秒要 API 27）
            String[] c = CACHE.get(f.getPath());
            // 刚改过的不信缓存：时间戳只到秒，同一秒里写两遍、大小不变，指纹就一样
            if (c != null && c[0].equals(fp) && System.currentTimeMillis() / 1000 - s.st_ctime > 2) return c[1];
            String h = Installer.sha256(f);
            CACHE.put(f.getPath(), new String[] { fp, h });
            return h;
        } catch (Exception e) { return null; }
    }

    /** 文件相对钉子的状态（M3）："ok" 对上；"missing" 没有这个文件；"unreadable" 在但哈希算不出来（读盘错）；
     *  "mismatch" 在但哈希对不上 */
    static String shaState(File f, String want) {
        if (f == null || !f.isFile()) return "missing";
        return classifySha(shaCached(f), want, true);
    }

    /** sha 状态的纯逻辑映射：文件不存在时一定是 missing，不管哈希值是什么 */
    static String classifySha(String got, String want, boolean exists) {
        if (!exists) return "missing";
        if (got == null) return "unreadable";
        return want.equals(got) ? "ok" : "mismatch";
    }

    private static MessageDigest md() {
        try { return MessageDigest.getInstance("SHA-256"); } catch (java.security.NoSuchAlgorithmException e) { throw new RuntimeException(e); }
    }

    /**
     * 边读边改前缀（等长）：一次只留一个 1 MB 块 + 不到一个前缀长度的尾巴在内存里，不整文件读进来
     * （L1：node 几十 MB，整文件读内存有 OOM 风险）。语义与以前的整文件做法完全一致（最左、不重叠）：
     * 只有凑满一个前缀长度才能确认一个位置是不是匹配，所以每轮只处理到 buf.length - a.length，
     * 剩下的尾巴留到下一轮；流尾不足一个前缀长度，不可能再有匹配，原样写出。md 按换过的内容算。
     */
    static void swapCopy(InputStream in, OutputStream o, MessageDigest md, byte[] a, byte[] b) throws IOException {
        if (a.length == 0) { byte[] buf = new byte[1 << 20]; for (int n; (n = in.read(buf)) > 0; ) { md.update(buf, 0, n); o.write(buf, 0, n); } return; }
        byte[] chunk = new byte[1 << 20];
        byte[] tail = new byte[0];   // 上一轮末尾、还不能确认的字节（不到 a.length 个）
        for (int r; (r = in.read(chunk)) > 0; ) {
            byte[] buf = new byte[tail.length + r];
            System.arraycopy(tail, 0, buf, 0, tail.length);
            System.arraycopy(chunk, 0, buf, tail.length, r);
            int limit = buf.length - a.length + 1;   // 起始位置 < limit 的都能判定（a.length 个字节都在）
            int i = 0, run = 0;   // run：还没写出的连续原样段起点
            while (i < limit) {
                if (matchAt(buf, i, a)) {
                    if (i > run) { md.update(buf, run, i - run); o.write(buf, run, i - run); }
                    md.update(b); o.write(b);
                    i += a.length; run = i;
                } else i++;
            }
            if (i > run) { md.update(buf, run, i - run); o.write(buf, run, i - run); }
            // [i, buf.length) 不足 a.length 个字节，留到下一轮再判定
            tail = java.util.Arrays.copyOfRange(buf, i, buf.length);
        }
        md.update(tail); o.write(tail);
    }

    private static boolean matchAt(byte[] buf, int i, byte[] a) {
        for (int j = 0; j < a.length; j++) if (buf[i + j] != a[j]) return false;
        return true;
    }
}
