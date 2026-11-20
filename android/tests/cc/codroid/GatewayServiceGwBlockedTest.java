package cc.agyroid;

/**
 * M3：网关运行库对不上、没起网关时说明页的文案按失败类型写
 * （见 GatewayService.gwBlockedText），校验 / 读盘问题不再说成“联网后会自动再试”。
 * 用安卓桩（android.jar）编译运行，只调纯逻辑，不碰安卓运行时。
 */
public class GatewayServiceGwBlockedTest {
    static int fail = 0;
    static void check(String what, boolean ok) { if (!ok) fail++; System.out.println((ok ? "✓ " : "✗ ") + what); }

    public static void main(String[] a) {
        String reason = "node 取回来以后对不上";
        String network = GatewayService.gwBlockedText("network", reason);
        check("网络问题说联网后会自动再试", network.contains("联网后会自动再试"));
        check("文案带上原因", network.contains(reason));

        String verify = GatewayService.gwBlockedText("verify", reason);
        check("校验问题不说联网后会自动再试", !verify.contains("联网后会自动再试"));
        check("校验问题明说不是网络问题", verify.contains("不是网络问题"));
        check("校验问题给修复动作", verify.contains("检查更新"));

        String io = GatewayService.gwBlockedText("io", reason);
        check("读盘问题不说联网后会自动再试", !io.contains("联网后会自动再试"));
        check("读盘问题明说本地文件读不出来", io.contains("本地文件读不出来"));

        String nospace = GatewayService.gwBlockedText("nospace", reason);
        check("空间不足说清理出空间后会自动再试", nospace.contains("清理出空间后会自动再试"));
        check("空间不足不说联网后会自动再试", !nospace.contains("联网后会自动再试"));

        String unknown = GatewayService.gwBlockedText(null, reason);
        check("未知类型默认按网络问题写", unknown.contains("联网后会自动再试"));

        System.out.println(fail == 0 ? "ALL PASS" : (fail + " FAILED"));
        if (fail != 0) System.exit(1);
    }
}
