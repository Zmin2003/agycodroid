package cc.agyroid;

/**
 * H6：127.0.0.2 探测的异常分类与回退规则（见 Env.checkHost）。
 * 只把 ConnectException / 超时当“不通”才回退 127.0.0.1；NetworkOnMainThreadException
 * （主线程上根本没发包）与别的异常都不回退，只记结论。
 * 用安卓桩（android.jar）编译运行，不碰安卓运行时；探测本身是真 socket。
 */
public class EnvHostProbeTest {
    static int fail = 0;
    static void check(String what, boolean ok) { if (!ok) fail++; System.out.println((ok ? "✓ " : "✗ ") + what); }

    /** android.jar 的桩：NetworkOnMainThreadException 的构造器在桌面 JVM 上直接抛 Stub!，
     *  用 Unsafe 绕过构造器拿一个实例（只为测 classifyHostProbe 的 instanceof 分支，生产代码不动） */
    static android.os.NetworkOnMainThreadException newNotMainThread() throws Exception {
        java.lang.reflect.Field f = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
        f.setAccessible(true);
        sun.misc.Unsafe u = (sun.misc.Unsafe) f.get(null);
        return (android.os.NetworkOnMainThreadException) u.allocateInstance(android.os.NetworkOnMainThreadException.class);
    }

    public static void main(String[] a) throws Exception {
        // ── 分类 ──
        check("ConnectException 是不通", Env.PROBE_UNREACHABLE.equals(Env.classifyHostProbe(new java.net.ConnectException())));
        check("SocketTimeoutException 是不通", Env.PROBE_UNREACHABLE.equals(Env.classifyHostProbe(new java.net.SocketTimeoutException())));
        check("BindException 是不通", Env.PROBE_UNREACHABLE.equals(Env.classifyHostProbe(new java.net.BindException())));
        check("NetworkOnMainThreadException 是探测未执行",
            Env.PROBE_NOT_EXECUTED.equals(Env.classifyHostProbe(newNotMainThread())));
        check("普通 IOException 结论不明", Env.PROBE_UNKNOWN.equals(Env.classifyHostProbe(new java.io.IOException("boom"))));
        check("普通 RuntimeException 结论不明", Env.PROBE_UNKNOWN.equals(Env.classifyHostProbe(new RuntimeException("boom"))));
        check("null 结论不明", Env.PROBE_UNKNOWN.equals(Env.classifyHostProbe(null)));

        // ── 回退规则：只有“不通”才回退 ──
        Env.resetHostProbeForTest();
        Env.noteProbe(Env.PROBE_NOT_EXECUTED, newNotMainThread());
        check("探测未执行不回退 127.0.0.1", "127.0.0.2".equals(Env.HOST));
        check("探测未执行记下结论", Env.PROBE_NOT_EXECUTED.equals(Env.hostProbe()));
        Env.noteProbe(Env.PROBE_UNKNOWN, new java.io.IOException("boom"));
        check("结论不明不回退", "127.0.0.2".equals(Env.HOST));
        Env.noteProbe(Env.PROBE_UNREACHABLE, new java.net.ConnectException());
        check("不通才回退 127.0.0.1", "127.0.0.1".equals(Env.HOST));
        check("回退记下结论", Env.PROBE_UNREACHABLE.equals(Env.hostProbe()));
        check("回退记下原因", Env.hostProbeDetail() != null && Env.hostProbeDetail().contains("ConnectException"));

        // ── 真探测：同步跑一次，结论一定是终态（ok 或 unreachable），且 HOST 与结论一致 ──
        Env.resetHostProbeForTest();
        Env.probeHostNow();
        String st = Env.hostProbe();
        check("同步探测跑出终态结论", Env.PROBE_OK.equals(st) || Env.PROBE_UNREACHABLE.equals(st));
        check("HOST 与探测结论一致",
            (Env.PROBE_OK.equals(st) && "127.0.0.2".equals(Env.HOST))
            || (Env.PROBE_UNREACHABLE.equals(st) && "127.0.0.1".equals(Env.HOST)));
        // 再跑一次不重复探测（结论不变）
        Env.probeHostNow();
        check("第二次同步探测不再重跑", st.equals(Env.hostProbe()));
        Env.resetHostProbeForTest();
        System.out.println(fail == 0 ? "ALL PASS" : (fail + " FAILED"));
        if (fail != 0) System.exit(1);
    }
}
