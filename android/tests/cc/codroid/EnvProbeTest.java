package cc.agyroid;

/**
 * M5：探活失败要分得清缺库（linker 错）、超时还是别的错（见 Env.runProbe）。
 * runQuiet 只返回 boolean，runProbe 记 exit 值 / 超时 / stderr 首行（截断）。
 * 用安卓桩（android.jar）编译运行，只调 java.* 进程接口，不碰安卓运行时。
 */
public class EnvProbeTest {
    static int fail = 0;
    static void check(String what, boolean ok) { if (!ok) fail++; System.out.println((ok ? "✓ " : "✗ ") + what); }

    public static void main(String[] a) throws Exception {
        // ── 分类（纯逻辑）──
        check("exit 0 是 ok", "ok".equals(Env.classifyProbe(0, false, "", null)));
        check("exit 非 0 是 nonzero", "nonzero".equals(Env.classifyProbe(3, false, "", null)));
        check("CANNOT LINK 是 linker", "linker".equals(Env.classifyProbe(127, false,
            "CANNOT LINK EXECUTABLE \"/data/user/0/cc.agyroid/files/usr/bin/bash\": library \"libandroid-support.so\" not found", null)));
        check("超时是 timeout", "timeout".equals(Env.classifyProbe(-1, true, "", null)));
        check("起不来是 io", "io".equals(Env.classifyProbe(-1, false, "", new java.io.IOException("boom"))));
        check("超时优先于 exit 值", "timeout".equals(Env.classifyProbe(0, true, "CANNOT LINK EXECUTABLE x", null)));

        // ── 真跑命令 ──
        Env.ProbeResult r = Env.runProbeCmd(java.util.Arrays.asList("sh", "-c", "echo FIRST; echo second; exit 3"), null, null, 5000);
        check("exit 3 不算成", !r.ok);
        check("记下 exit 值", r.exit == 3);
        check("记下 stderr/输出首行", "FIRST".equals(r.firstLine));
        check("exit 3 分到 nonzero", "nonzero".equals(r.kind));

        Env.ProbeResult l = Env.runProbeCmd(java.util.Arrays.asList("sh", "-c",
            "echo 'CANNOT LINK EXECUTABLE \"/x/bash\": library \"libandroid-support.so\" not found'; exit 127"), null, null, 5000);
        check("linker 错分到 linker", "linker".equals(l.kind));
        check("linker 错记下 exit 值", l.exit == 127);

        Env.ProbeResult t = Env.runProbeCmd(java.util.Arrays.asList("sleep", "5"), null, null, 300);
        check("超时不算成", !t.ok);
        check("超时记下来", t.timedOut);
        check("超时分到 timeout", "timeout".equals(t.kind));

        Env.ProbeResult ok = Env.runProbeCmd(java.util.Arrays.asList("sh", "-c", "echo ok; exit 0"), null, null, 5000);
        check("exit 0 算成", ok.ok);
        check("exit 0 分到 ok", "ok".equals(ok.kind));

        String longLine = "A".repeat(500);
        Env.ProbeResult trunc = Env.runProbeCmd(java.util.Arrays.asList("sh", "-c", "echo " + longLine + "; exit 1"), null, null, 5000);
        check("首行截断到 200 字以内", trunc.firstLine.length() <= 200 && trunc.firstLine.length() > 0);
        check("截断不断章取义（还是 A）", trunc.firstLine.chars().allMatch(c -> c == 'A'));

        Env.ProbeResult missing = Env.runProbeCmd(java.util.Arrays.asList("/definitely/not/a/program-xyz"), null, null, 5000);
        check("起不来的命令不算成", !missing.ok);
        check("起不来分到 io", "io".equals(missing.kind));

        System.out.println(fail == 0 ? "ALL PASS" : (fail + " FAILED"));
        if (fail != 0) System.exit(1);
    }
}
