package cc.agyroid;

import android.content.Context;
import java.io.File;
import java.util.Map;

/** 目录布局与子进程环境。前缀以 pin 文件为准：devkit-pin.json / gwpin.json 里钉的 target/base 决定实际前缀与来源
 *  （见 GwRuntime.fetchBase 与 Installer）；别凭这里的注释推断某一版 devkit 是否已发——新 devkit 没发之前，树里的 pin 仍指向上游旧版。 */
final class Env {
    static final int PORT = 8791;
    /** 界面和 App 访问网关用的地址。不用 127.0.0.1：Cookie 不按端口隔离，种在 127.0.0.1 上会被同机别的应用
     *  在任意端口收走（GHSA-hwmm 第 1 项）。网关两个地址都听，终端里的工具照旧走 127.0.0.1 + 令牌头。见 gateway/gw/access.mjs 的 UI_HOST。
     *  个别设备上 127.0.0.2 根本连不通（11-14 一加 PGP110 / Android 17：发往它的 SYN 被静默丢掉，只剩 127.0.0.1 能通）：
     *  核不了身份 → 每 40 秒杀一次网关 → 界面永远「等待网关」。类加载时自连探测一次（checkHost），不通就回退 127.0.0.1；
     *  代价是回退设备上会话 Cookie 落在 127.0.0.1，内置浏览器访问本机 127.0.0.1 别的端口时会带上它（11-14 交接 2.6 明示的安全代价） */
    static volatile String HOST = "127.0.0.2";
    static { checkHost(); }

    /** 这台设备上 127.0.0.2 通不通：先绑一个端口、再连它自己。绑不上、或 SYN 等不到应答（该设备上被静默丢掉）就回退 127.0.0.1。
     *  整个进程只跑这一次，正常设备行为完全不变 */
    private static void checkHost() {
        try (java.net.ServerSocket ss = new java.net.ServerSocket()) {
            ss.setReuseAddress(false);
            ss.bind(new java.net.InetSocketAddress("127.0.0.2", 0));
            try (java.net.Socket s = new java.net.Socket()) {
                s.connect(new java.net.InetSocketAddress("127.0.0.2", ss.getLocalPort()), 300);
            }
        } catch (Exception e) {
            HOST = "127.0.0.1";
            android.util.Log.w("agycodroid", "127.0.0.2 在本机连不通，界面地址回退 127.0.0.1：" + e);
        }
    }

    /** 网关访问令牌（server.mjs 首次启动时生成，0600，存在应用私有目录）。见 server.mjs「访问控制」。
     *  初始值 null：没构造过 Env 就不知道 files 目录在哪，token() 在那之前返回空串；构造器按实际 files 目录填好。
     *  以前这里写死 /data/data/cc.agyroid/files/...，开发版（包名不同）会读错路径 */
    private static volatile File tokenFile = null;

    /** 这次拉起网关时现造的随机数（GatewayService.spawnGateway 经 stdin 交给网关，不落盘）。
     *  证明身份、静态资源签名、Cookie 用「令牌 + 它」派生的钥匙：令牌同 uid 读得到，另起的冒牌网关有令牌也算不出这个（反破甲 11-03，
     *  见 gateway/gw/access.mjs 的 SPAWN） */
    static volatile String spawnKey = "";
    static String key() {
        String t = token(), k = spawnKey;
        // 手里没有随机数（应用进程重来过）就谁也不认：退回令牌的话，能对上的只可能是拿到令牌的冒牌货（DeepSeek 复核必修 1）。
        // 真网关这时证明不了自己，GatewayService 的 squatted() 把它杀掉、带新随机数重起
        if (t.isEmpty() || k.isEmpty()) return "";
        try { return hmac(t, "spawn:" + k); } catch (Exception e) { return ""; }
    }

    static String token() {
        File f = tokenFile;
        if (f == null) return "";   // 还没构造过 Env（L7）：不知道 files 目录在哪，不按写死的包名路径去读
        try { return new String(java.nio.file.Files.readAllBytes(f.toPath()), "UTF-8").trim(); }
        catch (Exception e) { return ""; }
    }

    /** 连本机网关：先核身份，再带上令牌头。网关没起来、没生成令牌、或端口上不是它时抛 IOException，调用方照"没就绪"处理即可 */
    static java.net.HttpURLConnection gateway(String path) throws java.io.IOException { return gateway("GET", path, null); }

    /** 同上，指定方法；body 是之后要写出去的请求体（没有给 null），签名里带它的 sha256，调用方照旧自己 setDoOutput 再写 */
    static java.net.HttpURLConnection gateway(String method, String path, byte[] body) throws java.io.IOException {
        if (!proveGateway()) throw new java.io.IOException(HOST + ":" + PORT + " 上不是 agycodroid 的网关（还没起来，或被别的应用占了）");
        String b = boot;
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL("http://" + HOST + ":" + PORT + path).openConnection();
        c.setInstanceFollowRedirects(false);     // 自定义头会跟着重定向转发出去（审查 10-29 第六份 低5）
        c.setRequestMethod(method);
        // 不发令牌原文，按次签名（GHSA-hwmm 附录 B）：核身份到真正发请求之间网关要是换了人，对方拿到的签名只对这一个请求有效、只能用一次。
        // 签进去的还有核到的启动号、监听地址、方法、请求体哈希：截走的签名到了重启后的网关不认，转发时改方法改体也不认（协议见 gateway/gw/access.mjs 的 sigOk）
        try {
            byte[] nb = new byte[16];
            new java.security.SecureRandom().nextBytes(nb);
            String ts = String.valueOf(System.currentTimeMillis()), n = hex(nb);
            String bh = hex(java.security.MessageDigest.getInstance("SHA-256").digest(body == null ? new byte[0] : body));
            c.setRequestProperty("X-CC-Body", bh);
            c.setRequestProperty("X-CC-Sig", ts + "." + n + "." + hmac(token(), "sig2:" + b + ":" + HOST + ":" + method + ":" + ts + ":" + n + ":" + bh + ":" + path));
        } catch (Exception e) { throw new java.io.IOException(e); }
        return c;
    }

    // ── 核身份（审查 S1）：端口全机共享，交出令牌之前先确认对面是真网关。协议见 gateway/gw/access.mjs 的 proof ──
    private static volatile long provedAt;
    private static volatile String boot = "";
    /** 网关换了一个（启动号变了）时回调，参数是这次的 Cookie 值；MainActivity 拿去种进 WebView */
    static volatile java.util.function.Consumer<String> onBoot;

    /** 忘掉上次核到的启动号：下一次核身份一定回调 onBoot（界面刚接上 onBoot 时用，不然后台服务先核过了，Cookie 就种不上） */
    static void resetBoot() { boot = ""; provedAt = 0; }

    /** 网关作证应答的签名（gateway/gw/access.mjs witnessMac）：按启动随机数派生的钥匙、核到的启动号、监听地址 */
    static boolean witnessOk(String n, int anc, int top, String tok, String mac) {
        String k = key();
        if (k.isEmpty() || mac == null) return false;
        try {
            String want = hmac(k, "witness:" + n + ":" + boot + ":" + HOST + ":" + anc + ":" + top + ":" + tok);
            return java.security.MessageDigest.isEqual(want.getBytes(), mac.getBytes());
        } catch (Exception e) { return false; }
    }

    static boolean proveGateway() { return proveGateway(false); }

    /** force：不吃 3 秒缓存。界面的 /api 请求前要用这一版（0.6.10 审计 199-1-04）：
     *  页面加载完以后网关被杀、端口被别的应用占住的空档里，3 秒缓存正好能放过冒牌的一两个请求 ——
     *  里面可能就是用户刚敲的话。多跑一趟本机请求（几毫秒），换来每个 /api 都当场核一次。 */
    static boolean proveGateway(boolean force) {
        if (!force && System.currentTimeMillis() - provedAt < 3000) return true;    // 刚核过：别每个请求都多跑一趟
        String t = key();
        if (t.isEmpty()) return false;
        try {
            byte[] nb = new byte[16];
            new java.security.SecureRandom().nextBytes(nb);
            String n = hex(nb);
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL("http://" + HOST + ":" + PORT + "/__proof?n=" + n).openConnection();
            c.setConnectTimeout(800); c.setReadTimeout(1500); c.setInstanceFollowRedirects(false); c.setUseCaches(false);
            try {
                if (c.getResponseCode() != 200) return false;
                byte[] buf = new byte[256];
                int len = 0;
                try (java.io.InputStream in = c.getInputStream()) {
                    for (int k; len < buf.length && (k = in.read(buf, len, buf.length - len)) > 0; ) len += k;
                }
                String[] p = new String(buf, 0, len, java.nio.charset.StandardCharsets.UTF_8).trim().split(" ");
                if (p.length != 2 || !p[0].matches("[0-9a-f]{32}")) return false;
                String want = hmac(t, "proof:" + n + ":" + p[0] + ":" + HOST);   // 绑监听地址：冒牌的转发到 127.0.0.1 上的真网关，算出来的对不上
                if (!java.security.MessageDigest.isEqual(want.getBytes(), p[1].getBytes())) return false;
                provedAt = System.currentTimeMillis();
                if (!p[0].equals(boot)) {
                    boot = p[0];
                    java.util.function.Consumer<String> cb = onBoot;
                    if (cb != null) cb.accept(hmac(t, "cookie:" + boot));
                }
                return true;
            } finally { c.disconnect(); }
        } catch (Exception e) { return false; }
    }

    /** 代 WebView 取界面的页面与静态资源（审查 10-29 第六份 中3）。端口全机共享，网关崩溃到重拉的空档里别的应用能占住它；
     *  它给的页面和脚本跟界面同源，能读到桥口令、能调 /api。所以这里带随机数去取，网关用令牌对「随机数 + 请求行 + 内容哈希」
     *  回一个 HMAC（gateway/gw/access.mjs 的 staticMac），对不上就整个不交给 WebView。pq 是路径加查询串，原样发出去 */
    static android.webkit.WebResourceResponse fetchStatic(String pq) {
        if (pq == null) return null;
        String t = key();
        if (t.isEmpty()) return null;
        pq = pq.replaceAll("([?&])k=[0-9a-f]{32}&?", "$1").replaceAll("[?&]$", "");   // 桥口令一律不往外发（审查 M-3）
        try {
            byte[] nb = new byte[16];
            new java.security.SecureRandom().nextBytes(nb);
            String n = hex(nb);
            java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL("http://" + HOST + ":" + PORT + pq).openConnection();
            c.setConnectTimeout(2000); c.setReadTimeout(15000); c.setInstanceFollowRedirects(false); c.setUseCaches(false);
            c.setRequestProperty("X-CC-Nonce", n);
            c.setRequestProperty("Accept-Encoding", "identity");
            try {
                int code = c.getResponseCode();
                if (code != 200) return null;
                java.io.ByteArrayOutputStream bo = new java.io.ByteArrayOutputStream();
                try (java.io.InputStream in = c.getInputStream()) {
                    byte[] buf = new byte[1 << 16];
                    for (int k; (k = in.read(buf)) > 0; ) { bo.write(buf, 0, k); if (bo.size() > (64 << 20)) return null; }
                }
                byte[] body = bo.toByteArray();
                String got = c.getHeaderField("X-CC-Mac");
                String want = hmac(t, "static:" + n + ":" + HOST + ":" + pq + ":" + hex(java.security.MessageDigest.getInstance("SHA-256").digest(body)));
                if (got == null || !java.security.MessageDigest.isEqual(want.getBytes(), got.getBytes())) {
                    android.util.Log.e("agycodroid", "界面资源 " + pq.replaceAll("[?#].*", "") + " 不是本应用网关给的（没有或对不上 X-CC-Mac），不交给界面");
                    return null;
                }
                String ct = c.getContentType(), mime = "application/octet-stream", enc = null;
                if (ct != null) {
                    String[] p = ct.split(";");
                    mime = p[0].trim();
                    for (int i = 1; i < p.length; i++) { String q = p[i].trim(); if (q.toLowerCase(java.util.Locale.ROOT).startsWith("charset=")) enc = q.substring(8); }
                }
                java.util.Map<String, String> h = new java.util.HashMap<>();
                for (String k : new String[]{"Content-Security-Policy", "X-Content-Type-Options", "Referrer-Policy", "Cache-Control"}) {
                    String v = c.getHeaderField(k);
                    if (v != null) h.put(k, v);
                }
                return new android.webkit.WebResourceResponse(mime, enc, 200, "OK", h, new java.io.ByteArrayInputStream(body));
            } finally { c.disconnect(); }
        } catch (Exception e) { return null; }
    }

    /** 端口上有没有人在听（不发任何东西）。网关两个回环地址都听（server.mjs：主服务 127.0.0.1、界面 HOST=127.0.0.2），
     *  只探 HOST 就漏掉 127.0.0.1 被别的应用占住的情况：supervise 当成「没被占」，反复拉起网关、网关反复退出
     *  （0.6.10 审计 199-1-03）。 */
    static boolean portBusy() {
        return listening(HOST) || listening("127.0.0.1");
    }

    private static boolean listening(String host) {
        try (java.net.Socket s = new java.net.Socket()) {
            s.connect(new java.net.InetSocketAddress(host, PORT), 500);
            return true;
        } catch (java.io.IOException e) { return false; }
    }

    private static String hmac(String key, String msg) throws Exception {
        javax.crypto.Mac m = javax.crypto.Mac.getInstance("HmacSHA256");
        m.init(new javax.crypto.spec.SecretKeySpec(key.getBytes(java.nio.charset.StandardCharsets.UTF_8), "HmacSHA256"));
        return hex(m.doFinal(msg.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
    }
    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }

    /** 原生桥（AGApp）的口令：每次进程启动随机生成，只经首页地址交给界面主框架。
     *  addJavascriptInterface 会注入到 WebView 里的每一个 frame（包括 HTML 预览的 iframe），而且分不出是谁在调；
     *  有副作用的方法都要带这个口令，预览页拿不到它（不同源，读不到主框架的地址和 sessionStorage）。10-25 安全审计 H-2 */
    static final String BRIDGE_KEY;
    static {
        byte[] b = new byte[16];
        new java.security.SecureRandom().nextBytes(b);
        StringBuilder sb = new StringBuilder();
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        BRIDGE_KEY = sb.toString();
    }
    static boolean bridgeOk(String k) {
        return k != null && java.security.MessageDigest.isEqual(k.getBytes(), BRIDGE_KEY.getBytes());
    }

    /** WebView 首次加载的地址：#k= 把原生桥口令交给界面。放在 # 后面：只留在 WebView 里，不进请求行，
     *  端口被别人抢占时发过去的请求里也没有它（11-03 审查 M-3）。Cookie 由 MainActivity 在核过身份后直接种（onBoot），地址里不再带令牌 */
    static String uiUrl() {
        return "http://" + HOST + ":" + PORT + "/#k=" + BRIDGE_KEY;
    }

    final File files, usr, home, app, log;
    /** 「经加载器」执行方式：数据目录里的程序一律经 /system/bin/linker64（bionic）或 APK 里的 glibc ld.so 起 */
    final boolean loader;
    /** 要求经加载器（.exec-mode 写了 loader，或 targetSdk ≥ 29）：loader 为 false 时靠它分辨是“本来就直接执行”还是“ld.so 对不上退回来的” */
    final boolean wantLoader;
    /** APK 原生库目录（libldlinux.so 在这里；targetSdk 36 只能 exec 这里的文件） */
    final String nativeLib;
    final String pkg;
    final int targetSdk;
    static final String LINKER = "/system/bin/linker64";

    Env(Context c) {
        files = c.getFilesDir();
        nativeLib = c.getApplicationInfo().nativeLibraryDir;
        pkg = c.getPackageName();
        targetSdk = c.getApplicationInfo().targetSdkVersion;
        usr = new File(files, "usr");
        home = new File(files, "home");
        app = new File(files, "app");
        log = new File(home, "gateway.log");
        tokenFile = new File(home, ".gateway-token");
        wantLoader = useLoader(c);
        loader = wantLoader && (mustLoader(c) || ldsoMatches());   // 放最后：ldsoMatches 要用到 usr
    }

    /**
     * 执行方式。files/.exec-mode 里写 direct / loader，没有就按 targetSdk 定：≥ 29 的包不能直接 exec 数据目录里的文件，只能经加载器。
     * targetSdk ≥ 29 时写了 direct 也不认（那样什么都起不来）。改了要重启网关才生效
     */
    static boolean mustLoader(Context c) { return c.getApplicationInfo().targetSdkVersion >= 29; }
    static String execPref(Context c) {
        try { return new String(java.nio.file.Files.readAllBytes(new File(c.getFilesDir(), ".exec-mode").toPath()), "UTF-8").trim(); }
        catch (Exception e) { return ""; }
    }
    static boolean useLoader(Context c) { return mustLoader(c) || "loader".equals(execPref(c)); }

    /**
     * 实际执行方式（供启动日志/诊断）：direct 还是 loader，以及 ld.so 是否与工具包里的 glibc 同一份。
     * 28 包过渡期 ldsoMatches() 为 false 时：要求经加载器却对不上就退回 direct；36 包没得退，仍经加载器、网关启动自检会报
     */
    String execModeNote() {
        if (loader) return ldsoMatches()
            ? "经加载器，APK 的 ld.so 与工具包 glibc 是同一份"
            : "经加载器，但 APK 的 ld.so 与工具包里的 glibc 不是同一份（APK 先升级、工具包还没跟上；网关启动自检会报）";
        if (wantLoader && !ldsoMatches()) return "直接执行：要求经加载器，但 ld.so 与工具包 glibc 对不上，28 包退回直接执行（先升工具包再升 APK 可避免）";
        return "直接执行";
    }

    /**
     * APK 里的 ld.so 和工具包里现装的是不是同一份。glibc 要求 ld.so 与 libc.so.6 出自同一次构建：
     * APK 先升级、工具包还没跟上时两者会不一致 —— 28 包此时退回直接执行；36 包没得退，网关日志里会报（见 server.mjs 启动自检）
     */
    boolean ldsoMatches() {
        try {
            byte[] a = java.nio.file.Files.readAllBytes(new File(nativeLib, "libldlinux.so").toPath());
            byte[] b = java.nio.file.Files.readAllBytes(new File(usr, "glibc/lib/ld-linux-aarch64.so.1").toPath());
            return java.util.Arrays.equals(a, b);
        } catch (Exception e) { return false; }
    }

    /** 拼要起的命令：经加载器时，数据目录里的 ELF 程序前面加上 linker64 */
    java.util.List<String> cmd(String... argv) {
        java.util.List<String> l = new java.util.ArrayList<>(java.util.Arrays.asList(argv));
        if (l.isEmpty()) return l;
        if (loader && isElf(l.get(0)) && !l.get(0).startsWith("/system/")) l.add(0, LINKER);
        return l;
    }

    private static boolean isElf(String p) {
        try (java.io.FileInputStream in = new java.io.FileInputStream(p)) {
            byte[] h = new byte[4];
            return in.read(h) == 4 && h[0] == 0x7f && h[1] == 'E' && h[2] == 'L' && h[3] == 'F';
        } catch (Exception e) { return false; }
    }

    File bin(String name) { return new File(usr, "bin/" + name); }

    /** APK 原生库目录里的文件（/data/app/…/lib/arm64，安装时系统解出来，应用 uid 只读） */
    String nlib(String name) { return new File(nativeLib, name).getPath(); }

    /** first-run 失败标记（与 .devkit-ok 同一目录；Installer 的 first-run 失败时写，文件名就定这个，这里只读） */
    File devkitFirstrunFailed() { return new File(usr, ".devkit-firstrun-failed"); }

    /** devkitReady() 为 false 时的原因（"" = 就绪）：界面/通知直接拿去显示，省得只写一句“工具链未安装” */
    private volatile String lastProblem = "";
    String devkitProblem() { devkitReady(); return lastProblem; }

    /** 探活失败时回调（GatewayService 挂上：记修复账本 + 让 Updater 把 devkit 标 damaged并发修复通知，界面据此引导修复）；没人挂也不影响返回 false。
     *  注意：Updater 的 devkit "damaged" 状态 + 通知只能由 Updater 自己写（devkit 字段是私有的），这里只发回调、不直接写那边 */
    static volatile java.util.function.Consumer<String> onDevkitDamaged;
    /** 探活缓存：bash --version 这类试跑不要每次 devkitReady() 都跑一遍（supervise 每 3 秒问一次，主界面 onCreate 也在 UI 线程问） */
    private static volatile long probeAtMs;
    private static volatile boolean probeOkCache;
    private static volatile String probeProblem = "";
    private static volatile boolean probeDamagedNoted;
    private static final long PROBE_TTL_MS = 30_000;

    // 经加载器时程序不会被直接执行，只看文件在不在（canExecute 走 access(X_OK)，不该拿它判断能不能跑）
    boolean devkitReady() {
        if (!new File(usr, ".devkit-ok").isFile()) { lastProblem = Tr.t("工具链未安装"); return false; }
        if (devkitFirstrunFailed().isFile()) { lastProblem = Tr.t("开发工具包首次配置没跑完，请在设置里修复工具包"); return false; }
        if (loader ? !bin("node").isFile() : !bin("node").canExecute()) { lastProblem = Tr.t("开发工具包不完整：找不到 node"); return false; }
        if (!probeOk()) { lastProblem = probeProblem; return false; }
        lastProblem = "";
        return true;
    }

    /** 实质探活：bash --version 能跑起来才算就绪（B10：只查 .devkit-ok + node 文件在不在，1.0“就绪却起不来”能原样重现）。
     *  结果缓存 30 秒；bash 起不来时再试 curl --version，分辨是 bash 坏了还是整包坏了。失败只在 ok→失败的翻转时回调一次 onDevkitDamaged */
    private boolean probeOk() {
        long now = System.currentTimeMillis();
        if (now - probeAtMs < PROBE_TTL_MS) return probeOkCache;
        boolean bash = runQuiet(cmd(bin("bash").getPath(), "--version"));
        String problem;
        boolean ok = bash;
        if (!bash) {
            boolean curl = runQuiet(cmd(bin("curl").getPath(), "--version"));
            problem = curl ? Tr.t("bash 起不来（curl 正常），开发工具包可能不完整")
                           : Tr.t("bash、curl 都起不来，开发工具包已损坏，请在设置里修复工具包");
        } else problem = "";
        probeAtMs = now; probeOkCache = ok; probeProblem = problem;
        if (!ok && !probeDamagedNoted) {
            probeDamagedNoted = true;
            java.util.function.Consumer<String> cb = onDevkitDamaged;
            if (cb != null) cb.accept(problem);
        } else if (ok) probeDamagedNoted = false;
        return ok;
    }

    /** 静默试跑一条命令：按 Installer.run 同样的方式起（经加载器时前面加 linker64 + apply 环境），5 秒内退出码 0 算成。
     *  Env 里原来没有执行命令的 helper，Installer.run 要 Progress 且把每行输出报给界面，不适合静默探活，这里只借它的起法 */
    private boolean runQuiet(java.util.List<String> argv) {
        try {
            ProcessBuilder pb = new ProcessBuilder(argv);
            apply(pb.environment());
            pb.directory(home);
            pb.redirectErrorStream(true);
            Process p = pb.start();
            // --version 输出只有几行，管道不会堵：先等退出，再把剩余输出读掉
            if (!p.waitFor(5, java.util.concurrent.TimeUnit.SECONDS)) { p.destroyForcibly(); return false; }
            try (java.io.InputStream in = p.getInputStream()) { byte[] b = new byte[4096]; while (in.read(b) > 0) { } }
            return p.exitValue() == 0;
        } catch (Exception e) { return false; }
    }

    /** 已装工具包的来历（Installer 写的 JSON：base、sha256）。早期版本里只有一行 "ok" → 空对象 */
    org.json.JSONObject devkitInfo() {
        try { return new org.json.JSONObject(new String(java.nio.file.Files.readAllBytes(new File(usr, ".devkit-ok").toPath()), "UTF-8")); }
        catch (Exception e) { return new org.json.JSONObject(); }
    }

    /** Google Antigravity CLI（agy）：install-agy.sh 装好后写下的版本指针 */
    File agy() { return new File(home, ".local/share/agycodroid/agy/current/agy"); }

    boolean agyReady() { return loader ? agy().isFile() : agy().canExecute(); }

    /** 用户在设置里卸了 agy：有这个标记就别自动装回去（启动、换渠道都不装），等用户点「安装…」自己选版本 */
    File agyOffFlag() { return new File(files, ".agy-uninstalled"); }
    boolean agyOff() { return agyOffFlag().isFile(); }

    /**
     * 工作区放在私有目录。/sdcard 是 FUSE：不能执行程序、不能建符号链接、git 嫌属主不对、
     * npm install 建不了 .bin —— 实测在那里几乎干不了开发。私有目录里这些都正常，界面的文件浏览器也看得到。
     */
    File workspace() {
        File p = new File(home, "workspace");
        p.mkdirs();
        return p;
    }

    /** 与别的应用交换文件的地方（交付的 APK、截图之类）。拿不到存储权限时为 null */
    File shared() {
        File w = new File("/sdcard/agycodroid");
        if ((w.isDirectory() || w.mkdirs()) && w.canWrite()) return w;
        return null;
    }

    void apply(Map<String, String> e) {
        e.remove("LD_LIBRARY_PATH");
        e.remove("LD_PRELOAD");
        e.put("PREFIX", usr.getPath());
        e.put("HOME", home.getPath());
        e.put("TMPDIR", new File(usr, "tmp").getPath());
        // app/pre 在最前：pkg / apt（压过工具包里同名的旧说明替身）和 adb（服务改开私有套接字，见 pre/adb）
        e.put("PATH", new File(app, "pre").getPath() + ":" + usr.getPath() + "/bin:" + new File(app, "bin").getPath() + ":/system/bin:/system/xbin");
        e.put("LANG", "en_US.UTF-8");
        e.put("TERM", "xterm-256color");
        // typst 自带的只有拉丁字体，不给它路径中文就渲染成空白方框；安卓的字体都在 /system/fonts
        e.put("TYPST_FONT_PATHS", "/system/fonts");
        e.put("SHELL", bin("bash").getPath());
        // 网关（server.mjs）认的变量
        e.put("AGAPP_PREFIX", usr.getPath());
        e.put("AGAPP_HOME", home.getPath());
        e.put("AGAPP_RUNTIME", files.getPath());
        // 整个应用数据目录（shared_prefs、app_webview… 都在里面）：网关据此把它整个当私有目录（gw/pathguard.mjs，0.6.9 审计 P0-1）
        e.put("AGAPP_DATA_DIR", files.getParent());
        e.put("AGAPP_WORKSPACE", workspace().getPath());
        File sh = shared();
        if (sh != null) e.put("AGAPP_SHARED", sh.getPath());
        e.put("AGAPP_PORT", String.valueOf(PORT));
        e.put("AGAPP_TOKEN_FILE", new File(home, ".gateway-token").getPath());
        e.put("AGAPP_SHELL", bin("bash").getPath());
        e.put("AGAPP_LOADER", new File(usr, "glibc/lib/ld-linux-aarch64.so.1").getPath());
        e.put("AGAPP_GLIBC_LIB", new File(usr, "glibc/lib").getPath());
        e.put("AGAPP_AGY", agy().getPath());
        e.put("AGAPP_ENOSYS_RUN", nlib("libccenosysrun.so"));
        e.put("AGAPP_PTYHOST", nlib("libccptyhost.so"));
        e.put("AGAPP_7ZZ", nlib("libcc7zz.so"));          // 随包的 7-Zip（文件管理器的压缩包、终端里的 7z / 7zz），见 third_party/7zip
        // glibc 程序 --preload 的列表：libccnodump.so —— 带 AGAPP_NODUMP=1 起的发行版程序设不可转储，
        // 别的进程不认这个变量、什么也不做（安全 4 第 3 层，android/native/nodump.c）。经加载器时 applyLoader 再插一个 exec-shim。
        // agy 是 bionic 构建、直接跑，不挂给 claude 用的 seccomp 垫片 libccenosys.so
        e.put("AGAPP_GLIBC_PRELOAD", nlib("libccnodump.so"));
        e.put("AGAPP_LOG", log.getPath());
        e.put("AGAPP_LEDGER", Ledger.file(this).getPath());   // 修复账本：网关记安全模式、界面能翻
        e.put("AGAPP_SEED", new File(home, "seed.json").getPath());
        e.put("AGAPP_BIN", new File(app, "bin").getPath());
        e.put("AGAPP_PRIV_SOCK", new File(files, ".priv.sock").getPath());   // priv 中转（见 Priv.java）   // 应用自带的小工具（priv）
        e.put("AGAPP_TARGET_SDK", String.valueOf(targetSdk));
        e.put("AGAPP_EXEC", loader ? "loader" : "direct");
        e.put("AGAPP_NATIVE_LIB", nativeLib);
        if (loader) applyLoader(e);
    }

    /**
     * 「经加载器」的环境（与直接执行的差别全在这里）：
     *  - bionic：LD_PRELOAD 挂 termux-exec 的 linker 版，exec 数据目录里的程序时自动改成 linker64 起；强制模式，28 包上也照样走（便于验证）
     *  - glibc：devkit 里的 glibc 程序经 APK 里的 libldlinux.so 起，--preload 再加 exec-shim.so，Bun 拉子进程时同样改写（见 native/exec-shim.c）。
     *    agy 是 bionic 构建、直接跑，不走这条路，也不挂 seccomp 垫片 libccenosys.so
     *  - node：经 linker64 起时 process.execPath 是 linker64，execpath.cjs 改回真实路径
     * glibc 进程不能继承 LD_PRELOAD（bionic 库，ld.so 直接报 invalid ELF header）
     */
    private void applyLoader(Map<String, String> e) {
        String ld = new File(nativeLib, "libldlinux.so").getPath();
        // bionic 进程：先过 exec-shim-bionic（glibc 程序 / glibc ld.so 改走 APK 里的 ld.so），其余交给 termux-exec 的 linker 版
        String tx = nlib("libccexecshimb.so") + ":" + new File(usr, "lib/libtermux-exec-linker-ld-preload.so").getPath();
        e.put("AGAPP_LD", ld);
        e.put("AGAPP_LOADER", ld);
        e.put("AGAPP_GLIBC_PRELOAD", nlib("libccexecshim.so") + ":" + nlib("libccnodump.so"));
        e.put("AGAPP_BIONIC_PRELOAD", tx);
        e.put("LD_PRELOAD", tx);
        e.put("TERMUX_APP__DATA_DIR", files.getParent());
        e.put("TERMUX_APP__LEGACY_DATA_DIR", "/data/data/" + pkg);
        e.put("TERMUX_EXEC__SYSTEM_LINKER_EXEC__MODE", "force");
        e.put("NODE_OPTIONS", "--require=" + new File(app, "lib/execpath.cjs").getPath());
    }
}
