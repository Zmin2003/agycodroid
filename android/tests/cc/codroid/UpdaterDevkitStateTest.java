package cc.agyroid;

/**
 * M2：devkit 状态区分“进行中 / 失败（附原因）”（见 Updater.devkitStateFor），
 * verify 失败账本带 detail（期望 target、实际 target、来源，见 Updater.verifyLedgerDetail）。
 * 用安卓桩（android.jar）编译运行，只调纯逻辑，不碰安卓运行时。
 */
public class UpdaterDevkitStateTest {
    static int fail = 0;
    static void check(String what, boolean ok) { if (!ok) fail++; System.out.println((ok ? "✓ " : "✗ ") + what); }

    public static void main(String[] a) throws Exception {
        // ── 状态区分 ──
        String[] failed = Updater.devkitStateFor("base\n", "开发工具包首次配置没跑完，请在设置里修复工具包");
        check("有 first-run 失败标记就是 error", "error".equals(failed[0]));
        check("失败文案带标记里的包名", failed[1].contains("base"));
        check("失败文案带原因", failed[1].contains("首次配置没跑完"));
        String[] failedMulti = Updater.devkitStateFor("base\npython\n", "原因");
        check("多包失败文案都带上", failedMulti[1].contains("base") && failedMulti[1].contains("python"));
        String[] progress = Updater.devkitStateFor("", "工具链未安装");
        check("没标记、没就绪就是进行中", "uptodate".equals(progress[0]));
        check("进行中文案是首次安装进行中", progress[1].contains("首次安装进行中"));
        String[] blank = Updater.devkitStateFor("  \n", "工具链未安装");
        check("只有空白的标记当没有标记", "uptodate".equals(blank[0]));

        // ── verify 账本 detail ──
        org.json.JSONObject d = Updater.verifyLedgerDetail("cc.agyroid", "cc.agyroid",
            "devkit-pin.json（APK 内置）", "devkit-2026.11.19", "devkit-2026.11.19",
            100, 2, 3, new org.json.JSONArray().put("缺失 bin/x"));
        check("detail 有期望 target", "cc.agyroid".equals(d.optString("expectedTarget")));
        check("detail 有实际 target", "cc.agyroid".equals(d.optString("actualTarget")));
        check("detail 有来源", d.optString("source").contains("devkit-pin.json"));
        check("detail 有期望版本", "devkit-2026.11.19".equals(d.optString("expectedBase")));
        check("detail 有实际版本", "devkit-2026.11.19".equals(d.optString("installedBase")));
        check("detail 有缺失数", d.optInt("missing") == 2);
        check("detail 有改动数", d.optInt("changed") == 3);
        check("detail 有总数", d.optInt("total") == 100);
        check("detail 有样本", d.optJSONArray("samples") != null && d.optJSONArray("samples").length() == 1);

        System.out.println(fail == 0 ? "ALL PASS" : (fail + " FAILED"));
        if (fail != 0) System.exit(1);
    }
}
