package cc.agyroid;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.security.MessageDigest;
import java.util.Arrays;

/** GwRuntime.swapCopy 的纯逻辑回归：流式改前缀与旧的整文件做法语义一致（最左、不重叠），且跨 1 MB 块边界的匹配不丢。
 *  不碰安卓运行时，只调 java.io / java.security，见 scripts/java-tests.sh。 */
public final class GwRuntimeSwapTest {
    public static void main(String[] a) throws Exception {
        byte[] from = "/data/data/cc.codroid/".getBytes("UTF-8");
        byte[] to = "/data/data/cc.agyroid/".getBytes("UTF-8");
        check(new byte[0], from, to);   // 空输入
        check("hello world".getBytes("UTF-8"), from, to);   // 无匹配
        check(("/data/data/cc.codroid/bin/node and /data/data/cc.codroid/lib/x and tail /data/data/cc.codroid/").getBytes("UTF-8"), from, to);
        check("/data/data/cc.cod".getBytes("UTF-8"), from, to);   // 尾部半个前缀，不成匹配，原样保留
        check("aaa".getBytes("UTF-8"), "aa".getBytes("UTF-8"), "X".getBytes("UTF-8"));   // 重叠：最左一次替换 + 剩一个 a
        check("aaaa".getBytes("UTF-8"), "aa".getBytes("UTF-8"), "X".getBytes("UTF-8"));
        // 匹配正好横跨 1 MB 块边界（swapCopy 每轮读 1 MB）
        byte[] big = new byte[(1 << 20) + 64];
        Arrays.fill(big, (byte) 'z');
        System.arraycopy(from, 0, big, (1 << 20) - 2, from.length);   // 从块尾前 2 字节开始，横跨边界
        System.arraycopy(from, 0, big, (1 << 20) + 30, from.length);  // 第二块里再来一次
        check(big, from, to);
        // 随机数据对拍（与旧的整文件做法逐字节一致）
        java.util.Random rnd = new java.util.Random(20261119L);
        for (int t = 0; t < 20; t++) {
            byte[] in = new byte[rnd.nextInt(3000)];
            rnd.nextBytes(in);
            for (int k = 0; k < 5; k++) {
                int p = rnd.nextInt(in.length + 1 - from.length);
                System.arraycopy(from, 0, in, p, from.length);
            }
            check(in, from, to);
        }
        System.out.println("GwRuntimeSwapTest OK");
    }

    private static void check(byte[] in, byte[] a, byte[] b) throws Exception {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        GwRuntime.swapCopy(new ByteArrayInputStream(in), o, md, a, b);
        byte[] got = o.toByteArray(), want = ref(in, a, b);
        if (!Arrays.equals(got, want)) throw new AssertionError("swapCopy mismatch: in=" + in.length + " got=" + got.length + " want=" + want.length);
        if (!Arrays.equals(md.digest(), MessageDigest.getInstance("SHA-256").digest(want))) throw new AssertionError("swapCopy digest mismatch");
    }

    /** 旧的整文件做法（readAll + swapInPlace）的语义：最左、不重叠 */
    private static byte[] ref(byte[] in, byte[] a, byte[] b) {
        ByteArrayOutputStream o = new ByteArrayOutputStream();
        outer:
        for (int i = 0; i < in.length; ) {
            if (i + a.length <= in.length) {
                for (int j = 0; j < a.length; j++) if (in[i + j] != a[j]) { o.write(in[i]); i++; continue outer; }
                o.write(b, 0, b.length); i += a.length; continue;
            }
            o.write(in[i]); i++;
        }
        return o.toByteArray();
    }
}
