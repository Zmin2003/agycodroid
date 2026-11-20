package cc.agyroid;

/**
 * M3：网关运行库取回失败按错误类型分级（见 GwRuntime.classifyFetchFailure），
 * shaCached 区分“读不到”与“哈希不符”（见 GwRuntime.shaState）。
 * 用安卓桩（android.jar）编译运行，不碰安卓运行时；shaState 的缺失分支走真文件检查。
 */
public class GwRuntimeClassifyTest {
    static int fail = 0;
    static void check(String what, boolean ok) { if (!ok) fail++; System.out.println((ok ? "✓ " : "✗ ") + what); }

    public static void main(String[] a) throws Exception {
        // ── 取回失败分级 ──
        check("空间不足是 nospace", "nospace".equals(GwRuntime.classifyFetchFailure(new Installer.NoSpace(100L, 50L))));
        check("ENOSPC 文案是 nospace", "nospace".equals(GwRuntime.classifyFetchFailure(new java.io.IOException("No space left on device"))));
        check("存储空间不够文案是 nospace", "nospace".equals(GwRuntime.classifyFetchFailure(new java.io.IOException("存储空间不够"))));
        check("B2：预设 nospace 时逐字预检消息不被覆盖", "nospace".equals(GwRuntime.resolveFetchFailKind("nospace", new java.io.IOException("取回网关运行库需要约 655 MB，手机里目前只剩 120 MB。清理出空间后会再试（已下载的部分会保留）。"))));
        check("B2：无预设时按异常分类", "network".equals(GwRuntime.resolveFetchFailKind(null, new java.net.SocketTimeoutException())));
        check("B2：无预设时 NoSpace 仍是 nospace", "nospace".equals(GwRuntime.resolveFetchFailKind(null, new Installer.NoSpace(100L, 50L))));
        check("哈希对不上是 verify", "verify".equals(GwRuntime.classifyFetchFailure(new java.io.IOException("模块表和安装包钉的对不上"))));
        check("取回后对不上是 verify", "verify".equals(GwRuntime.classifyFetchFailure(new java.io.IOException("node 取回来以后对不上"))));
        check("签名对不上是 verify", "verify".equals(GwRuntime.classifyFetchFailure(new java.io.IOException("签名对不上"))));
        check("HTTP 404 是 verify（钉的文件不存在，不是网络问题）",
            "verify".equals(GwRuntime.classifyFetchFailure(new java.io.IOException("HTTP 404 https://github.com/x/y.gz"))));
        check("HTTP 410 是 verify", "verify".equals(GwRuntime.classifyFetchFailure(new java.io.IOException("HTTP 410 https://github.com/x/y.gz"))));
        check("连接超时是 network", "network".equals(GwRuntime.classifyFetchFailure(new java.net.SocketTimeoutException())));
        check("连不上是 network", "network".equals(GwRuntime.classifyFetchFailure(new java.net.ConnectException())));
        check("解析不到是 network", "network".equals(GwRuntime.classifyFetchFailure(new java.net.UnknownHostException("github.com"))));
        check("HTTP 500 是 network", "network".equals(GwRuntime.classifyFetchFailure(new java.io.IOException("HTTP 500 https://github.com/x"))));
        check("权限不够是 io（读盘）", "io".equals(GwRuntime.classifyFetchFailure(new java.io.IOException("Permission denied"))));
        check("文件不存在是 io（读盘）", "io".equals(GwRuntime.classifyFetchFailure(new java.io.IOException("No such file or directory"))));
        check("读盘错是 io", "io".equals(GwRuntime.classifyFetchFailure(new java.io.IOException("Input/output error"))));
        check("未知异常默认 network（保持旧行为）", "network".equals(GwRuntime.classifyFetchFailure(new java.io.IOException("something weird"))));
        check("null 默认 network", "network".equals(GwRuntime.classifyFetchFailure(null)));

        // ── sha 状态区分（纯逻辑映射）──
        check("哈希对上是 ok", "ok".equals(GwRuntime.classifySha("abc", "abc", true)));
        check("哈希不对是 mismatch", "mismatch".equals(GwRuntime.classifySha("def", "abc", true)));
        check("文件在但读不到哈希是 unreadable", "unreadable".equals(GwRuntime.classifySha(null, "abc", true)));
        check("文件不在是 missing", "missing".equals(GwRuntime.classifySha(null, "abc", false)));
        check("文件不在时哈希值不影响结论", "missing".equals(GwRuntime.classifySha("abc", "abc", false)));

        // ── shaState 真文件分支：不存在的文件是 missing ──
        check("不存在的文件 shaState 是 missing",
            "missing".equals(GwRuntime.shaState(new java.io.File("/definitely/not/here-xyz/nope"), "abc")));

        System.out.println(fail == 0 ? "ALL PASS" : (fail + " FAILED"));
        if (fail != 0) System.exit(1);
    }
}
