package cc.agyroid;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * first-run 失败记录 / 超时 / 断点续跑（H3、H4、H5、M1、M7）+ 新版救砖路由（BLOCKER）+ 非关键步骤（H2）。
 *
 * 回归 1.0.1 真机：基础块 first-run 在「预编译 Python 标准库与 site-packages」一步 rc=1，
 * 账本只剩 "base（rc=1）"、标记只有包名、输出没落盘、run() 无限 waitFor；
 * 重试时基础块失败重跑全部 first-run，仅模块失败则全量重装（重下几百 MB）；
 * 更糟的是 recover() 重跑磁盘旧脚本注定再失败，boot 直接 abort，新版工具包够不着。
 *
 * 只调 Installer 的静态 helper（不造 Android Context），风格同 InstallerCarryTest。
 * 注意：不要在测试里 new JSONObject / JSONArray——android.jar 的 org.json 是桩，运行时抛 Stub!；
 * 需要 JSON 的地方都走 Installer 的手写字符串 helper（firstRunDetailJson、readFlatStringMap）。
 */
public class InstallerFirstRunTest {
    static int fail = 0;
    static void check(String what, boolean ok) { if (!ok) fail++; System.out.println((ok ? "✓ " : "✗ ") + what); }

    static final Installer.Progress QUIET = new Installer.Progress() {
        public void step(String m) {}
        public void bytes(long done, long total) {}
    };

    static void put(File root, String rel, String text) throws Exception {
        File f = new File(root, rel);
        f.getParentFile().mkdirs();
        Files.write(f.toPath(), text.getBytes(StandardCharsets.UTF_8));
    }

    static Installer.FirstRunFailure baseFailure() {
        return new Installer.FirstRunFailure("base", 1, "预编译 Python 标准库与 site-packages",
            "…tail…", "/data/user/0/cc.agyroid/files/first-run-base.log",
            "/data/user/0/cc.agyroid/files/usr/tmp/first-run-summary.txt",
            "/data/user/0/cc.agyroid/files/usr/tmp/first-run-compileall.log", false, 2400);
    }

    public static void main(String[] args) throws Exception {
        Path tmp = Files.createTempDirectory("agycodroid-firstrun-test-");
        try {
            // ── H3：步骤名 / 尾部 ──
            List<String> lines = Arrays.asList("foo", "▸ python", "bar", "▸ 预编译 Python 标准库与 site-packages", "boom");
            check("H3：失败步骤取最后一条 ▸ 行", "预编译 Python 标准库与 site-packages".equals(Installer.lastStepLine(lines)));
            check("H3：没有 ▸ 行时步骤为空", "".equals(Installer.lastStepLine(Arrays.asList("a", "b"))));
            List<String> many = new ArrayList<>();
            for (int i = 0; i < 30; i++) many.add("line-" + i);
            String tail = Installer.tailText(many, 20, 4000);
            check("H3：尾部只留最后 20 行", tail.contains("line-29") && tail.contains("line-10") && !tail.contains("line-9\n"));
            StringBuilder big = new StringBuilder();
            for (int i = 0; i < 5000; i++) big.append('x');
            String cut = Installer.tailText(Arrays.asList(big.toString()), 20, 4000);
            check("H3：尾部按字符截断", cut.length() <= 4000 + 32 && cut.endsWith(big.substring(big.length() - 100)));

            // ── H3：结构化失败记录 → Ledger detail（JSON 文本，测试不断言 org.json 对象）──
            Map<String, Installer.FirstRunFailure> fails = new LinkedHashMap<>();
            fails.put("base", baseFailure());
            String d = Installer.firstRunDetailJson(fails.values());
            check("H3：detail 有 module", d.contains("\"module\":\"base\""));
            check("H3：detail 有 rc", d.contains("\"rc\":1"));
            check("H3：detail 有失败步骤名", d.contains("\"step\":\"预编译 Python 标准库与 site-packages\""));
            check("H3：detail 有输出尾部", d.contains("\"tail\":\"…tail…\""));
            check("H3：detail 有日志文件路径", d.contains("\"log\":\"/data/user/0/cc.agyroid/files/first-run-base.log\""));
            check("H3：detail 指汇总日志", d.contains("\"summaryLog\":\"/data/user/0/cc.agyroid/files/usr/tmp/first-run-summary.txt\""));
            check("H3：detail 指 compileall 日志", d.contains("\"compileLog\":\"/data/user/0/cc.agyroid/files/usr/tmp/first-run-compileall.log\""));
            fails.put("cli", new Installer.FirstRunFailure("cli", 2, "git-delta", "t", "/x/first-run-cli.log", "", "", false, 100));
            String d2 = Installer.firstRunDetailJson(fails.values());
            check("H3：多失败时 detail 带 failures 数组与 count", d2.contains("\"count\":2") && d2.contains("\"module\":\"cli\""));

            // ── H3：失败步骤以 first-run-summary 行为准（新脚本跑完所有步骤才 exit，最后一条 ▸ 行可能是后头成功的步骤）──
            List<String> sumLines = Arrays.asList("▸ python", "first-run-summary: python rc=0",
                "▸ 预编译 Python 标准库与 site-packages", "first-run-summary: 预编译 Python 标准库与 site-packages rc=1",
                "▸ termux-exec", "first-run-summary: termux-exec rc=0");
            check("H3：汇总行认出真失败的步骤（不是最后一条 ▸ 行）",
                "预编译 Python 标准库与 site-packages".equals(Installer.failedStepFromSummary(sumLines)));
            check("H3：汇总行里全是 rc=0 时没有失败步骤",
                "".equals(Installer.failedStepFromSummary(Arrays.asList("first-run-summary: python rc=0"))));
            check("H3：没有汇总行（旧脚本）时没有失败步骤",
                "".equals(Installer.failedStepFromSummary(Arrays.asList("▸ python", "boom"))));
            check("H3：汇总行 step= 写法也能解析",
                "openssh".equals(Installer.failedStepFromSummary(
                    Arrays.asList("first-run-summary: step=openssh rc=2"))));
            // ── 1.0.2 对接：devkit 侧实际生成的汇总行是单行 `包=rc,包=rc,…`（见 devkit/first-run.mjs），
            //    不是上面那种每步一行的 `步骤 rc=N`。旧解析器在真格式上找不到 "rc="、返回 ""，
            //    调用方回落到最后一条 ▸ 行——新脚本最后一条 ▸ 行是预编译（警告不计 rc），会错认步骤、
            //    连带把关键失败误判成非关键。下面按 first-run.mjs 逐字生成的行断言：
            check("H3：真格式汇总行认出第一个 rc≠0 的包",
                "npm".equals(Installer.failedStepFromSummary(
                    Arrays.asList("▸ android-tools", "▸ npm", "▸ openssh", "▸ python", "▸ python-pip",
                        "▸ termux-exec", "▸ 预编译 Python 标准库与 site-packages",
                        "first-run-summary: android-tools=0,npm=1,openssh=0,python=0,python-pip=0,termux-exec=0"))));
            check("H3：真格式多个失败时取第一个",
                "android-tools".equals(Installer.failedStepFromSummary(
                    Arrays.asList("first-run-summary: android-tools=2,npm=1,openssh=0"))));
            check("H3：真格式全是 0 时没有失败步骤",
                "".equals(Installer.failedStepFromSummary(
                    Arrays.asList("first-run-summary: android-tools=0,npm=0,openssh=0,python=0,python-pip=0,termux-exec=0"))));
            check("H3：真格式无 postinst（无）时没有失败步骤",
                "".equals(Installer.failedStepFromSummary(
                    Arrays.asList("first-run-summary: （无）"))));

            // ── H3：失败标记格式 ──
            String marker = Installer.formatFirstRunFailedMarker(fails);
            check("H3：标记附 rc 与步骤名", marker.contains("base rc=1 step=预编译 Python 标准库与 site-packages"));
            Map<String, Installer.FirstRunFailure> back = Installer.parseFirstRunFailedMarker(marker);
            check("H3：标记能解析回结构", back.containsKey("base") && back.get("base").rc == 1
                && "预编译 Python 标准库与 site-packages".equals(back.get("base").step));
            Map<String, Installer.FirstRunFailure> oldFmt = Installer.parseFirstRunFailedMarker("base\ncli\n");
            check("H3：旧格式标记（只有包名）仍能解析", oldFmt.containsKey("base") && oldFmt.containsKey("cli"));

            // ── H4：runProcess 超时 kill ──
            Installer.RunOutcome o1 = new Installer.RunOutcome();
            ProcessBuilder quick = new ProcessBuilder("sh", "-c", "echo '▸ python'; echo 'first-run-summary: python rc=0'; echo hello; exit 3");
            quick.redirectErrorStream(true);
            int rc1 = Installer.runProcess(quick, QUIET, 10_000, null, o1);
            check("H4：正常命令返回真实 rc", rc1 == 3 && o1.rc == 3 && !o1.timedOut);
            check("H4：正常命令记下失败步骤与尾部", "python".equals(o1.step) && o1.tail.contains("hello"));
            check("H4：汇总行全 rc=0 时 failedStep 为空", "".equals(o1.failedStep));
            Installer.RunOutcome o2 = new Installer.RunOutcome();
            ProcessBuilder hang = new ProcessBuilder("sh", "-c", "sleep 30");
            hang.redirectErrorStream(true);
            long t0 = System.currentTimeMillis();
            int rc2 = Installer.runProcess(hang, QUIET, 500, null, o2);
            long took = System.currentTimeMillis() - t0;
            check("H4：超时返回 124 并标记 timedOut", rc2 == 124 && o2.timedOut);
            check("H4：超时不等满 30 秒就返回", took < 10_000);
            check("H4：超时记下已耗时", o2.ms >= 400 && o2.ms < 10_000);
            Installer.RunOutcome o3 = new Installer.RunOutcome();
            ProcessBuilder hangOut = new ProcessBuilder("sh", "-c", "echo '▸ x-step'; sleep 30");
            hangOut.redirectErrorStream(true);
            File log = new File(tmp.toFile(), "run.log");
            int rc3 = Installer.runProcess(hangOut, QUIET, 500, log, o3);
            check("H4：挂起进程的输出也进了步骤与尾部", rc3 == 124 && "x-step".equals(o3.step) && o3.tail.contains("▸ x-step"));
            check("H4：输出落盘到日志文件", log.isFile()
                && new String(Files.readAllBytes(log.toPath()), StandardCharsets.UTF_8).contains("▸ x-step"));

            // ── H5：断点续跑检查点 ──
            File usr = new File(tmp.toFile(), "usr");
            File script = new File(usr, "libexec/devkit/first-run.sh");
            put(usr, "libexec/devkit/first-run.sh", "#!/bin/sh\necho hi\n");
            Map<String, String> done = new LinkedHashMap<>();
            done.put("base", Installer.sha256(script));
            check("H5：脚本没变时跳过已成功的块", Installer.firstRunDone(done, "base", script));
            put(usr, "libexec/devkit/first-run.sh", "#!/bin/sh\necho changed\n");
            check("H5：脚本变了（新 devkit）不跳过", !Installer.firstRunDone(done, "base", script));
            check("H5：没记录的块不跳过", !Installer.firstRunDone(done, "cli", script));
            Installer.writeFirstRunDone(usr, done);
            Map<String, String> reloaded = Installer.readFirstRunDone(usr);
            check("H5：检查点落盘后能读回", done.equals(reloaded));
            check("H5：没有检查点文件时读回为空", Installer.readFirstRunDone(new File(tmp.toFile(), "nousr")).isEmpty());

            // ── H5：仅模块失败才走 repairFirstRun ──
            File usr2 = new File(tmp.toFile(), "usr2");
            put(usr2, ".devkit-ok", "{}\n");
            Files.write(new File(usr2, ".devkit-firstrun-failed").toPath(),
                "cli rc=2 step=git-delta\n".getBytes(StandardCharsets.UTF_8));
            check("H5：仅模块失败 → 走补跑不重装", Installer.moduleOnlyFirstRunFailure(usr2));
            Files.write(new File(usr2, ".devkit-firstrun-failed").toPath(),
                "base rc=1 step=预编译 Python 标准库与 site-packages\n".getBytes(StandardCharsets.UTF_8));
            check("H5：基础块失败 → 不走补跑", !Installer.moduleOnlyFirstRunFailure(usr2));
            Files.write(new File(usr2, ".devkit-firstrun-failed").toPath(), "base\n".getBytes(StandardCharsets.UTF_8));
            check("H5：旧格式基础块失败 → 不走补跑", !Installer.moduleOnlyFirstRunFailure(usr2));
            new File(usr2, ".devkit-firstrun-failed").delete();
            check("H5：没有失败标记 → 不走补跑", !Installer.moduleOnlyFirstRunFailure(usr2));
            File usr3 = new File(tmp.toFile(), "usr3");
            put(usr3, ".devkit-firstrun-failed", "cli rc=2 step=x\n");
            check("H5：没有 .devkit-ok → 不走补跑", !Installer.moduleOnlyFirstRunFailure(usr3));

            // ── H5：repair 只列已装的非基础块（哪怕没写 .ok）──
            // 规则是纯函数（repairModuleIncluded），不走 org.json：android.jar 的 org.json 是桩
            File usr4 = new File(tmp.toFile(), "usr4");
            new File(usr4, "libexec/devkit/modules/cli").mkdirs();   // 装了但 first-run 失败，没写 .ok
            check("H5：repair 包含已装但没 .ok 的失败模块",
                Installer.repairModuleIncluded("module", "libexec/devkit/modules/cli", usr4));
            check("H5：repair 不含基础块",
                !Installer.repairModuleIncluded("base", "libexec/devkit", usr4));
            check("H5：repair 不含目录不在的模块",
                !Installer.repairModuleIncluded("module", "libexec/devkit/modules/node", usr4));

            // ── H5：boot 分支决策（仅模块失败 → 补跑，不全量重装）──
            check("H5：仅模块失败 → boot 补跑", "repair-modules".equals(Installer.bootDevkitAction(false, true, false)));
            check("H5：仅模块失败（即使 devkitReady 误报 true）→ boot 补跑", "repair-modules".equals(Installer.bootDevkitAction(true, true, false)));
            check("H5：未就绪且无模块失败 → boot 安装", "install".equals(Installer.bootDevkitAction(false, false, false)));
            check("H5：就绪 + first-run 漏跑 → boot 补跑", "repair-missed".equals(Installer.bootDevkitAction(true, false, true)));
            check("H5：就绪且无事 → boot 不动", "none".equals(Installer.bootDevkitAction(true, false, false)));

            // ── BLOCKER：卡住的设备——磁盘旧脚本 + 新 pin → 跳过注定失败的重跑，走更新安装 ──
            File usrB = new File(tmp.toFile(), "usrB");
            put(usrB, ".devkit-pending",
                "{\"base\":\"https://github.com/Zmin2003/agycodroid/releases/download/devkit-2026.11.19/\","
                + "\"sha256\":\"aaa\",\"modules\":[\"base\",\"cli\"],\"snapshot\":\"2026.11.19\"}\n");
            String pinTagNew = "devkit-2026.11.20",
                pinBaseNew = "https://github.com/Zmin2003/agycodroid/releases/download/devkit-2026.11.20/";
            String pinTagOld = "devkit-2026.11.19",
                pinBaseOld = "https://github.com/Zmin2003/agycodroid/releases/download/devkit-2026.11.19/";
            check("BLOCKER：旧 pending + 新 pin → 判定为可跳过重跑",
                Installer.pendingDevkitOlderThanPin(usrB, pinTagNew, pinBaseNew));
            check("BLOCKER：旧 pending + 同版 pin → 不跳过（照旧 abort，等 APK 更新带新 pin）",
                !Installer.pendingDevkitOlderThanPin(usrB, pinTagOld, pinBaseOld));
            check("BLOCKER：旧 pending + 更旧的 pin → 不跳过（不静默降级）",
                !Installer.pendingDevkitOlderThanPin(usrB, "devkit-2026.11.18",
                    "https://github.com/Zmin2003/agycodroid/releases/download/devkit-2026.11.18/"));
            check("BLOCKER：没有 pending → 不跳过",
                !Installer.pendingDevkitOlderThanPin(new File(tmp.toFile(), "nousr"), pinTagNew, pinBaseNew));
            check("BLOCKER：没有 pin → 不跳过",
                !Installer.pendingDevkitOlderThanPin(usrB, null, null));
            check("BLOCKER：基础块 first-run 失败 + 新 pin → 走更新安装而不是死循环",
                Installer.shouldSkipDoomedFirstRunRetry(usrB, pinTagNew, pinBaseNew, true));
            check("BLOCKER：基础块没失败 → 不触发跳过",
                !Installer.shouldSkipDoomedFirstRunRetry(usrB, pinTagNew, pinBaseNew, false));
            check("BLOCKER：基础块失败但 pin 同版 → 不触发跳过",
                !Installer.shouldSkipDoomedFirstRunRetry(usrB, pinTagOld, pinBaseOld, true));
            // PENDING 里带数组值（modules）时扁平解析不丢 base
            Map<String, String> pend = Installer.readFlatStringMap(new File(usrB, ".devkit-pending"));
            check("BLOCKER：扁平解析跳过数组值、仍读到 base",
                "https://github.com/Zmin2003/agycodroid/releases/download/devkit-2026.11.19/".equals(pend.get("base")));
            check("BLOCKER：扁平解析读到 snapshot",
                "2026.11.19".equals(pend.get("snapshot")));

            // ── H2：非关键 postinst / compileall 失败不挡住就绪 ──
            check("H2：compileall 失败是非关键（不挡住进软件）",
                Installer.nonCriticalFirstRunFailure("预编译 Python 标准库与 site-packages", false));
            check("H2：openssh postinst 失败是非关键",
                Installer.nonCriticalFirstRunFailure("openssh", false));
            check("H2：6 个 base postinst 都属非关键",
                Installer.nonCriticalFirstRunFailure("android-tools", false)
                && Installer.nonCriticalFirstRunFailure("npm", false)
                && Installer.nonCriticalFirstRunFailure("python", false)
                && Installer.nonCriticalFirstRunFailure("python-pip", false)
                && Installer.nonCriticalFirstRunFailure("termux-exec", false));
            check("H2：超时一律按关键处理（挂住的步骤状态未知）",
                !Installer.nonCriticalFirstRunFailure("openssh", true));
            check("H2：认不出的步骤一律按关键处理（fail closed）",
                !Installer.nonCriticalFirstRunFailure("some-new-step", false)
                && !Installer.nonCriticalFirstRunFailure("", false));

            // ── H3：devkit 侧日志路径（有文件才记，旧脚本没有不强求）──
            File usrL = new File(tmp.toFile(), "usrL");
            check("H3：旧脚本没写汇总日志时路径为空",
                "".equals(Installer.firstRunSummaryLog(usrL)) && "".equals(Installer.firstRunCompileLog(usrL)));
            put(usrL, "tmp/first-run-summary.txt", "python rc=0\n");
            put(usrL, "tmp/first-run-compileall.log", "compile error\n");
            check("H3：新脚本的汇总日志路径指 $PREFIX/tmp/first-run-summary.txt",
                Installer.firstRunSummaryLog(usrL).endsWith("tmp/first-run-summary.txt"));
            check("H3：新脚本的 compileall 日志路径指 $PREFIX/tmp/first-run-compileall.log",
                Installer.firstRunCompileLog(usrL).endsWith("tmp/first-run-compileall.log"));

            // ── M1：Guile touch 不再吞错误 ──
            String touchCmd = Installer.guileTouchCommand();
            check("M1：touch 命令不再 2>/dev/null", !touchCmd.contains("2>/dev/null"));
            check("M1：touch 命令不再 ; true", !touchCmd.contains("; true"));
            check("M1：touch 命令仍找 .go 文件", touchCmd.contains("-name '*.go'") && touchCmd.contains("touch"));
            File usr5 = new File(tmp.toFile(), "usr5");
            put(usr5, "lib/guile/a.go", "x");
            put(usr5, "lib/guile/b.go", "x");
            new File(usr5, "lib/guile/a.go").setLastModified(System.currentTimeMillis());
            new File(usr5, "lib/guile/b.go").setLastModified(System.currentTimeMillis() - 7200_000L);
            int stale = Installer.countStaleGuileCache(usr5, System.currentTimeMillis() - 60_000L);
            check("M1：touch 后抽查 mtime 能数出没碰到的文件", stale == 1);

            // ── M7：pruneManifest 只在块成功时重定基线 ──
            File usr6 = new File(tmp.toFile(), "usr6");
            put(usr6, "bin/keep", "keep-v1");
            put(usr6, "bin/gone", "gone");
            String keepSha = Installer.sha256(new File(usr6, "bin/keep"));
            String goneSha = Installer.sha256(new File(usr6, "bin/gone"));
            File man = new File(usr6, "MANIFEST");
            put(usr6, "MANIFEST", keepSha + " 7 bin/keep\n" + goneSha + " 4 bin/gone\n");
            Map<String, long[]> snap = new LinkedHashMap<>();
            snap.put("bin/keep", new long[]{ new File(usr6, "bin/keep").lastModified(), 7 });
            snap.put("bin/gone", new long[]{ new File(usr6, "bin/gone").lastModified(), 4 });
            new File(usr6, "bin/gone").delete();
            File outOk = new File(usr6, "MANIFEST.local");
            Installer.pruneManifest(usr6, man, outOk, snap, QUIET, true);
            String outText = new String(Files.readAllBytes(outOk.toPath()), StandardCharsets.UTF_8);
            check("M7：成功时重定基线（删掉的文件剔除）", outText.contains("bin/keep") && !outText.contains("bin/gone"));
            File outFail = new File(usr6, "MANIFEST.failed");
            Installer.pruneManifest(usr6, man, outFail, snap, QUIET, false);
            check("M7：失败时不重定基线", !outFail.isFile());
        } finally {
            try (java.util.stream.Stream<Path> s = Files.walk(tmp)) {
                s.sorted(Comparator.reverseOrder()).forEach((p) -> { try { Files.delete(p); } catch (Exception ignored) {} });
            }
        }
        System.out.println(fail == 0 ? "ALL PASS" : (fail + " FAILED"));
        if (fail != 0) System.exit(1);
    }
}
