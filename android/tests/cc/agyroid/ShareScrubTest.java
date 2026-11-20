package cc.agyroid;

/**
 * ST-07：诊断包脱敏 —— Share.scrub 要抹掉三种原生 Google token 形态
 * （AIza… 39 位 API Key、ya29.… OAuth 访问令牌、1//… OAuth 刷新令牌），
 * 裸 token 不带键名时 JSON 键名规则够不着。
 *
 * 只调 Share 的纯静态方法，不碰安卓运行时（用 android.jar 的桩编译即可）。
 */
public class ShareScrubTest {
    static int fail = 0;
    static void check(String what, boolean ok) { if (!ok) fail++; System.out.println((ok ? "✓ " : "✗ ") + what); }

    public static void main(String[] args) {
        String apiKey = "AIza" + "A".repeat(35);          // 39 位
        String access = "ya29.a0AfH6SMBx1234567890abcdefghij";
        String refresh = "1//0eAbCdEfGh1234567890abcdefghij";

        check("AIza 裸 token 被抹掉", !Share.scrub("got " + apiKey + " here").contains(apiKey));
        check("AIza 被抹掉后留抹去标记", Share.scrub("got " + apiKey + " here").contains("«已抹去»"));
        check("AIza 短于 39 位不误抹（长度下限）",
            Share.scrub("got AIza" + "A".repeat(10) + " here").contains("AIza" + "A".repeat(10)));
        check("ya29 裸 token 被抹掉", !Share.scrub("access " + access + " end").contains(access));
        check("ya29 短 token 不误抹",
            Share.scrub("access ya29.abcde end").contains("ya29.abcde"));
        check("1// 裸 token 被抹掉（含斜杠不断开）", !Share.scrub("refresh " + refresh + " end").contains(refresh));
        check("1// 短 token 不误抹",
            Share.scrub("refresh 1//short end").contains("1//short"));
        check("普通文本里的 1//2 不动（无 token 形态）",
            Share.scrub("version 1//2 ok").equals("version 1//2 ok"));
        check("Bearer 里的 ya29 仍被抹掉（既有规则）",
            !Share.scrub("Authorization: Bearer " + access).contains(access));
        check("JSON 键名里的 ya29 仍被抹掉（既有规则）",
            !Share.scrub("{\"access_token\": \"" + access + "\"}").contains(access));
        check("既有 sk- 规则不动", !Share.scrub("key sk-abc1234567").contains("sk-abc1234567"));
        check("普通文本不动", Share.scrub("hello world 1.0.1").equals("hello world 1.0.1"));
        System.out.println(fail == 0 ? "ALL PASS" : (fail + " FAILED"));
        if (fail != 0) System.exit(1);
    }
}
