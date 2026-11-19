package cc.agyroid;

import java.nio.charset.StandardCharsets;

/**
 * M1：文件名白名单 —— emoji（U+1F300–U+1FAFF）与 CJK 扩展 B 区（U+20000–U+2A6DF）原样保留，
 * 范围外的增补平面字符仍换成 _；与网关 files.mjs 的上传白名单同一范围。
 *
 * 只调 MainActivity 的纯静态方法，不碰安卓运行时（用 android.jar 的桩编译即可）。
 * 字符串里的增补平面字符一律用 Unicode 代理对转义写，免得源文件编码抖动。
 */
public class MainActivityNameTest {
    static int fail = 0;
    static void check(String what, boolean ok) { if (!ok) fail++; System.out.println((ok ? "✓ " : "✗ ") + what); }

    /** 逐字符核对代理对配对：高代理后必跟低代理，低代理前必有高代理 */
    static boolean noLoneSurrogate(String s) {
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isHighSurrogate(c)) {
                if (i + 1 >= s.length() || !Character.isLowSurrogate(s.charAt(i + 1))) return false;
                i++;
            } else if (Character.isLowSurrogate(c)) return false;
        }
        return true;
    }

    public static void main(String[] args) {
        // emoji：区内上下界 + 常用字
        check("emoji U+1F600 原样保留",
            MainActivity.safeFileName("报告\ud83d\ude00总结.txt").equals("报告\ud83d\ude00总结.txt"));
        check("emoji U+1F4DA 原样保留",
            MainActivity.safeFileName("\ud83d\udcda笔记.txt").equals("\ud83d\udcda笔记.txt"));
        check("emoji 下界 U+1F300 原样保留",
            MainActivity.safeFileName("\ud83c\udf00.txt").equals("\ud83c\udf00.txt"));
        check("emoji 上界 U+1FAFF 原样保留",
            MainActivity.safeFileName("\ud83e\udeaf.txt").equals("\ud83e\udeaf.txt"));
        // CJK 扩展 B 区：区内上下界
        check("扩展 B 区下界 U+20000 原样保留",
            MainActivity.safeFileName("\ud840\udc00扩展B.txt").equals("\ud840\udc00扩展B.txt"));
        check("扩展 B 区上界 U+2A6DF 原样保留",
            MainActivity.safeFileName("\ud869\udedf扩展B.txt").equals("\ud869\udedf扩展B.txt"));
        check("emoji + 扩展 B 区混合原样保留",
            MainActivity.safeFileName("\ud83d\ude00\ud840\udc00混合.txt").equals("\ud83d\ude00\ud840\udc00混合.txt"));
        // 范围外的增补平面字符仍换成 _
        check("范围外的 U+10000 换成 _",
            MainActivity.safeFileName("\ud800\udc00.txt").equals("_.txt"));
        check("范围外的 U+1F000（麻将牌区，不在 emoji 范围）换成 _",
            MainActivity.safeFileName("\ud83c\udc00.txt").equals("_.txt"));
        // 既有行为不动：假名 / 韩文 / 扩展 A 区 / 常用汉字保留；符号、空格换 _；开头 . 去掉
        check("假名 / 韩文 / 扩展 A 区 / 常用汉字保留",
            MainActivity.safeFileName("\u3042\u30a2\uac00\u3400\u4e2d\u6587.txt").equals("\u3042\u30a2\uac00\u3400\u4e2d\u6587.txt"));
        check("空格与符号换成 _",
            MainActivity.safeFileName("a b@c#d.txt").equals("a_b_c_d.txt"));
        check("开头的点去掉", MainActivity.safeFileName("...abc.txt").equals("abc.txt"));
        check("null 得空串", MainActivity.safeFileName(null).equals(""));
        // 截断不断开 emoji：100 个 😀 + .txt 按 200 字节截，扩展名保住、字节不超、不出孤代理对
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 100; i++) sb.append("\ud83d\ude00");
        sb.append(".txt");
        String clipped = MainActivity.clipFileName(MainActivity.safeFileName(sb.toString()), 200);
        check("长 emoji 文件名截断后仍以 .txt 结尾", clipped.endsWith(".txt"));
        check("长 emoji 文件名截断后不超过 200 字节",
            clipped.getBytes(StandardCharsets.UTF_8).length <= 200);
        check("长 emoji 文件名截断后无孤代理对", noLoneSurrogate(clipped));
        System.out.println(fail == 0 ? "ALL PASS" : (fail + " FAILED"));
        if (fail != 0) System.exit(1);
    }
}
