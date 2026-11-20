package cc.agyroid;

/**
 * diagnostics 缺口（见 Share）：读并写出 .devkit-firstrun-failed 标记内容，
 * 附上最近一次 first-run 的账本记录与日志尾部；verify 聚合两条校验线的结果
 * （开发工具包文件校验 / 网关运行库清单校验），并标注它们是两个不同的检查。
 * 用安卓桩（android.jar）编译运行，只调纯逻辑与真文件，不碰安卓运行时。
 */
public class ShareDiagTest {
    static int fail = 0;
    static void check(String what, boolean ok) { if (!ok) fail++; System.out.println((ok ? "✓ " : "✗ ") + what); }

    public static void main(String[] a) throws Exception {
        // ── first-run 失败标记 ──
        check("标记内容原样读出", Share.formatFirstrunMarker("base\npython\n").contains("base")
            && Share.formatFirstrunMarker("base\npython\n").contains("python"));
        check("空标记是空串", Share.formatFirstrunMarker("").isEmpty());
        check("null 标记是空串", Share.formatFirstrunMarker(null).isEmpty());
        check("只有空白的标记是空串", Share.formatFirstrunMarker("  \n ").isEmpty());

        // ── 日志尾部（取最后 N 行）──
        java.io.File tmp = java.io.File.createTempFile("diag", ".log");
        try {
            java.nio.file.Files.write(tmp.toPath(),
                "line1\nline2\nline3\nline4\nline5\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            String tail = Share.tailLines(tmp, 2);
            check("尾部只取最后 2 行", tail.contains("line4") && tail.contains("line5") && !tail.contains("line3"));
            check("尾部多取也不越界", Share.tailLines(tmp, 50).contains("line1"));
        } finally { tmp.delete(); }
        check("不存在的文件尾部是空串", Share.tailLines(new java.io.File("/definitely/not/here-xyz.log"), 50).isEmpty());

        // ── verify 聚合：两条线分别标注 ──
        String ledger = "{\"at\":1795111699000,\"kind\":\"verify\",\"ok\":true,\"msg\":\"快速自检：100 个文件完好\"}\n"
            + "{\"at\":1795111700000,\"kind\":\"verify\",\"ok\":false,\"msg\":\"网关运行库：网关运行库和安装包对不上，联网取回也没成：HTTP 404 https://x/y.gz\"}\n"
            + "{\"at\":1795111701000,\"kind\":\"install\",\"ok\":true,\"msg\":\"别的记录\"}\n";
        String sum = Share.verifySummary(ledger);
        check("聚合里有开发工具包文件校验线", sum.contains("开发工具包文件校验"));
        check("聚合里有网关运行库清单校验线", sum.contains("网关运行库清单校验"));
        check("聚合标明两条是不同的检查", sum.contains("两个不同的检查") || sum.contains("不同"));
        check("聚合带上网关校验的失败原因", sum.contains("HTTP 404"));
        check("聚合带上开发工具包校验的结果", sum.contains("100 个文件完好"));
        check("聚合不把无关记录当校验", !sum.contains("别的记录"));

        String empty = Share.verifySummary("");
        check("没有校验记录就明说还没校验过", empty.contains("还没校验过"));

        String onlyDevkit = Share.verifySummary(
            "{\"at\":1,\"kind\":\"verify\",\"ok\":false,\"msg\":\"完整校验：缺 2 个、内容不对 3 个\"}\n");
        check("只有一条线时另一条写明没有记录", onlyDevkit.contains("开发工具包文件校验") && onlyDevkit.contains("网关运行库清单校验")
            && onlyDevkit.contains("没有记录"));

        // ── first-run 账本记录 ──
        String ledger2 = "{\"at\":1795111699000,\"kind\":\"install\",\"ok\":false,\"msg\":\"首次配置失败：base（rc=1）\"}\n"
            + "{\"at\":1795111700000,\"kind\":\"verify\",\"ok\":true,\"msg\":\"快速自检：100 个文件完好\"}\n";
        String fr = Share.ledgerFirstRunLines(ledger2, 3);
        check("first-run 账本记录被挑出来", fr.contains("首次配置失败") && fr.contains("rc=1"));
        check("first-run 账本不带无关记录", !fr.contains("快速自检"));
        check("没有 first-run 记录就明说", Share.ledgerFirstRunLines("", 3).contains("没有"));

        // ── first-run 日志尾部（每块一个文件）──
        java.io.File dir = java.nio.file.Files.createTempDirectory("firstrun").toFile();
        try {
            java.io.File baseLog = new java.io.File(dir, "first-run-base.log");
            java.nio.file.Files.write(baseLog.toPath(),
                "b1\nb2\nb3\nb4\nb5\n".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            String tails = Share.firstRunLogTails(dir, "base\n", 2);
            check("first-run 日志取失败包的最后 2 行", tails.contains("b4") && tails.contains("b5") && !tails.contains("b3"));
            check("first-run 日志标明是哪个包的", tails.contains("first-run-base.log"));
            check("标记里没有的包不读", Share.firstRunLogTails(dir, "python\n", 2).isEmpty());
            check("标记为空不读", Share.firstRunLogTails(dir, "", 2).isEmpty());
            check("标记里的 ../ 拼不出路径", Share.firstRunLogTails(dir, "../secret\n", 2).isEmpty());
            check("新格式标记（包 rc=N step=…）也能读到日志", Share.firstRunLogTails(dir, "base rc=1 step=预编译 Python 标准库与 site-packages\n", 2).contains("b5"));
            check("新格式标记里的 ../ 拼不出路径", Share.firstRunLogTails(dir, "../secret rc=1 step=x\n", 2).isEmpty());
        } finally {
            for (java.io.File f : dir.listFiles()) f.delete();
            dir.delete();
        }

        System.out.println(fail == 0 ? "ALL PASS" : (fail + " FAILED"));
        if (fail != 0) System.exit(1);
    }
}
