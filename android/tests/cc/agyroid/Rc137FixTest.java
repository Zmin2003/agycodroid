package cc.agyroid;

/**
 * R1：Meizu 18 / Android 13 上 Antigravity CLI 安装失败 rc=137 的根因修复回归。
 *
 * 根因（见 ~/workspace/agycodroid-agy-adaptation/R1-rc137-investigation-fix.md）：
 * 安装子进程（bash → node install-agy.mjs → curl/tar）经 Installer.run 继承了
 * Env.apply() 塞进来的 AGAPP_TOKEN_FILE，而 GatewayService.squatted() 的兜底清理按
 * 这个变量认「网关留下的进程」直接 SIGKILL——安装进行中、端口又被别的应用占着时，
 * 清理线程和安装线程并发跑，安装子进程被自己人杀掉，bash 退出码 137。
 * 修复：① 安装器子进程不再带 AGAPP_TOKEN_FILE（Env.applyForInstaller）；
 * ② squatted() 按 cmdline 再认一次安装器子进程，跳过不杀（GatewayService.isInstallerCmd）；
 * ③ installAgy 输出落盘 files/install-agy.log，诊断包收进去（Share）；
 * ④ rc=137 单独诊断与重试指引（MainActivity.humanize）；
 * ⑤ 更新检查内部 id "claude" → "agy"，旧 id 只作入境兼容别名（Updater.normalizeItemId）。
 *
 * 只调纯静态方法 / 真文件，不碰安卓运行时（用 android.jar 的桩编译即可）。
 */
public class Rc137FixTest {
    static int fail = 0;
    static void check(String what, boolean ok) { if (!ok) fail++; System.out.println((ok ? "✓ " : "✗ ") + what); }

    public static void main(String[] a) throws Exception {
        // ── (d) 内部 id：新 id 是 "agy"，旧 "claude" 只作入境兼容 ──
        check("旧 id claude 归一化成 agy", "agy".equals(Updater.normalizeItemId("claude")));
        check("新 id agy 保持不变", "agy".equals(Updater.normalizeItemId("agy")));
        check("app 不动", "app".equals(Updater.normalizeItemId("app")));
        check("devkit 不动", "devkit".equals(Updater.normalizeItemId("devkit")));
        check("null 归一化是 null", Updater.normalizeItemId(null) == null);
        check("空串归一化是空串", "".equals(Updater.normalizeItemId("")));
        check("未知 id 原样返回", "other".equals(Updater.normalizeItemId("other")));

        // ── 根因修复 ②：squatted() 按 cmdline 认安装器子进程 ──
        check("install-agy.sh 是安装器子进程",
            GatewayService.isInstallerCmd("/data/data/cc.agyroid/files/usr/bin/bash\0/data/data/cc.agyroid/files/app/scripts/install-agy.sh\0latest\0"));
        check("install-agy.mjs（bash exec 成 node 后）是安装器子进程",
            GatewayService.isInstallerCmd("/data/data/cc.agyroid/files/usr/bin/node\0/data/data/cc.agyroid/files/app/scripts/install-agy.mjs\0latest\0"));
        check("first-run.sh 是安装器子进程",
            GatewayService.isInstallerCmd("bash\0/data/data/cc.agyroid/files/usr/libexec/devkit/first-run.sh\0"));
        check("网关 server.mjs 不是安装器子进程",
            !GatewayService.isInstallerCmd("node\0/data/data/cc.agyroid/files/app/server.mjs\08791\0"));
        check("网关 boot.mjs 不是安装器子进程",
            !GatewayService.isInstallerCmd("node\0--input-type=module\0-e\0/data/data/cc.agyroid/files/app\08791\0"));
        check("普通 curl 不是安装器子进程",
            !GatewayService.isInstallerCmd("curl\0-fsSL\0https://example.invalid/x.tgz\0"));
        check("null cmdline 不是安装器子进程", !GatewayService.isInstallerCmd(null));
        check("空 cmdline 不是安装器子进程", !GatewayService.isInstallerCmd(""));

        // ── 根因修复 ①：安装器环境不带令牌标记 ──
        java.util.Map<String, String> env = new java.util.HashMap<>();
        env.put("PREFIX", "/data/data/cc.agyroid/files/usr");
        env.put("HOME", "/data/data/cc.agyroid/files/home");
        env.put("AGAPP_PORT", "8791");
        env.put("AGAPP_TOKEN_FILE", "/data/data/cc.agyroid/files/home/.gateway-token");
        Env.stripTokenMarker(env);
        check("安装器环境去掉 AGAPP_TOKEN_FILE", !env.containsKey("AGAPP_TOKEN_FILE"));
        check("安装器环境其余变量保留", "/data/data/cc.agyroid/files/usr".equals(env.get("PREFIX"))
            && "/data/data/cc.agyroid/files/home".equals(env.get("HOME")) && "8791".equals(env.get("AGAPP_PORT")));
        java.util.Map<String, String> empty = new java.util.HashMap<>();
        Env.stripTokenMarker(empty);   // 本来就没有也不抛
        check("没有令牌标记时去掉也不抛", empty.isEmpty());

        // ── (b) rc=137 单独诊断 ──
        String h137 = MainActivity.humanize(new java.io.IOException("Antigravity CLI 安装失败（rc=137）"));
        check("rc=137 说清是安装进程被系统结束", h137.contains("137") && h137.contains("被系统结束"));
        check("rc=137 指引保持应用在前台", h137.contains("前台"));
        check("rc=137 指引重试会断点续传", h137.contains("续传"));
        String h1 = MainActivity.humanize(new java.io.IOException("Antigravity CLI 安装失败（rc=1）"));
        check("rc=1 不套用 137 的文案", !h1.contains("被系统结束") && !h1.contains("前台"));

        // ── (c) 安装日志文件名与诊断包收录 ──
        check("安装日志文件名是 install-agy.log", "install-agy.log".equals(Installer.AGY_INSTALL_LOG_FILE));
        java.io.File dir = java.nio.file.Files.createTempDirectory("agylog").toFile();
        try {
            check("没有安装日志就明说", Share.agyInstallLogTail(dir, 50).contains("没有安装日志"));
            java.io.File log = new java.io.File(dir, "install-agy.log");
            java.nio.file.Files.write(log.toPath(),
                ("最新版 1.5.13（来自官方 manifest）\n▸ 下载…\n  下载断了（curl 137），续传重试…\n"
                    + "✓ sha512 与官方 manifest 一致\n▸ 解包…\n").getBytes(java.nio.charset.StandardCharsets.UTF_8));
            String tail = Share.agyInstallLogTail(dir, 50);
            check("安装日志尾部带文件名", tail.contains("install-agy.log"));
            check("安装日志尾部带最后步骤", tail.contains("▸ 解包") && tail.contains("sha512"));
            String tail2 = Share.agyInstallLogTail(dir, 2);
            check("安装日志尾部只取最后 2 行", tail2.contains("▸ 解包") && !tail2.contains("最新版 1.5.13"));
        } finally {
            for (java.io.File f : dir.listFiles()) f.delete();
            dir.delete();
        }
        check("filesDir 为 null 不抛", Share.agyInstallLogTail(null, 50).contains("没有安装日志"));

        System.out.println(fail == 0 ? "ALL PASS" : (fail + " FAILED"));
        if (fail != 0) System.exit(1);
    }
}
