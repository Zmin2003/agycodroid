package cc.agyroid;

/**
 * NT-14：Updater.cmpVer 与网关 notices.mjs 的 cmpVer 同一规则（semver §11）。
 * 先比数字核心；同核心时带预发布后缀的低于不带的；后缀按 "." 分段比
 * （纯数字段按数值、纯数字段小于字母段、字母段按 ASCII 字典序、段少的小）；
 * "+" 后的构建元数据不参与比较。
 *
 * 只调 Updater 的纯静态方法，不碰安卓运行时（用 android.jar 的桩编译即可）。
 */
public class UpdaterCmpVerTest {
    static int fail = 0;
    static void check(String what, boolean ok) { if (!ok) fail++; System.out.println((ok ? "✓ " : "✗ ") + what); }
    static void lt(String a, String b) {
        check(a + " < " + b, Updater.cmpVer(a, b) < 0);
        check(b + " > " + a, Updater.cmpVer(b, a) > 0);
    }
    static void eq(String a, String b) { check(a + " == " + b, Updater.cmpVer(a, b) == 0); }

    public static void main(String[] args) {
        // 任务点名用例
        lt("1.0.1-alpha", "1.0.1");
        lt("1.0.1", "1.0.2");
        // semver §11 规范链：alpha < alpha.1 < alpha.beta < beta < beta.2 < beta.11 < rc.1 < 正式版
        lt("1.0.0-alpha", "1.0.0-alpha.1");
        lt("1.0.0-alpha.1", "1.0.0-alpha.beta");
        lt("1.0.0-alpha.beta", "1.0.0-beta");
        lt("1.0.0-beta", "1.0.0-beta.2");
        lt("1.0.0-beta.2", "1.0.0-beta.11");
        lt("1.0.0-beta.11", "1.0.0-rc.1");
        lt("1.0.0-rc.1", "1.0.0");
        // 旧注释用例：rc1 用户要能收到正式版
        lt("0.2.0-rc1", "0.2.0");
        // 字母段按字典序：旧实现只比数字段，alpha 与 beta 会判成相等
        lt("1.0.1-alpha", "1.0.1-beta");
        // 字母段是字典序（不是数值序）："rc10" < "rc2"
        lt("1.0.1-rc10", "1.0.1-rc2");
        // 数字核心仍按数值比
        lt("1.2.9", "1.2.10");
        lt("1.9.9", "2.0.0");
        // 相等：同串、构建元数据不参与比较
        eq("1.0.1", "1.0.1");
        eq("1.0.1-alpha", "1.0.1-alpha");
        eq("1.0.1+build", "1.0.1");
        eq("1.0.1-alpha+build", "1.0.1-alpha");
        eq("1.0", "1.0.0");
        System.out.println(fail == 0 ? "ALL PASS" : (fail + " FAILED"));
        if (fail != 0) System.exit(1);
    }
}
