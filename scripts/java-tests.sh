#!/bin/sh
# Java 侧的纯逻辑回归（不依赖安卓运行时）：Ed25519 验签向量、特权命令确认规则、硬件密钥认证验链。
# 编译产物放私有缓存目录，不进仓库。用法：sh scripts/java-tests.sh
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT=${TMPDIR:-$HOME/.cache}/agycodroid-java-tests
rm -rf "$OUT"; mkdir -p "$OUT"
javac -nowarn -d "$OUT" "$ROOT/android/tests/stub/android/util/Base64.java" "$ROOT/android/java/cc/agyroid/Ed25519.java" "$ROOT/android/tests/cc/codroid/Ed25519Vectors.java"
java -cp "$OUT" cc.agyroid.Ed25519Vectors
javac -nowarn -d "$OUT" "$ROOT/android/java/cc/agyroid/PrivRules.java" "$ROOT/android/tests/cc/codroid/PrivRulesTest.java"
java -cp "$OUT" cc.agyroid.PrivRulesTest
javac -nowarn -d "$OUT" "$ROOT/android/java/cc/agyroid/KeyAttest.java" "$ROOT/android/tests/cc/codroid/KeyAttestTest.java"
java -cp "$OUT" cc.agyroid.KeyAttestTest
# 更新说明挑版本：WhatsNew 引了安卓类，编译要 android.jar（平板 ~/.bldtools，或 ANDROID_JAR）；pick 本身不碰安卓接口
AJAR=${ANDROID_JAR:-$HOME/.bldtools/android.jar}
if [ -f "$AJAR" ]; then
  javac -nowarn -d "$OUT" -cp "$AJAR:$(ls "$ROOT"/third_party/shizuku/*.jar | tr '\n' ':')" $(find "$ROOT/android/java" -name '*.java') "$ROOT/android/tests/cc/codroid/WhatsNewPickTest.java"
  java -cp "$OUT:$AJAR" cc.agyroid.WhatsNewPickTest
  # 第二份稳定性报告 l 组（BUG-A01/A02/A03/A04/A05 的纯逻辑；只调基本类型判断，不碰安卓运行时）
  javac -nowarn -d "$OUT" -cp "$OUT:$AJAR" "$ROOT/android/tests/cc/codroid/Stab2LHostTest.java"
  java -cp "$OUT:$AJAR" cc.agyroid.Stab2LHostTest
  # 05-工具包重装丢组件：同一版重装时组件自己 dpkg 包清单里的文件要跟着搬（只造 MANIFEST，不碰 org.json）
  javac -nowarn -d "$OUT" -cp "$OUT:$AJAR" "$ROOT/android/tests/cc/codroid/InstallerCarryTest.java"
  java -cp "$OUT:$AJAR" cc.agyroid.InstallerCarryTest
  # 网关取回：put(swap) 流式改前缀（GwRuntime.swapCopy），不整文件读内存
  javac -nowarn -d "$OUT" -cp "$OUT:$AJAR" "$ROOT/android/tests/cc/codroid/GwRuntimeSwapTest.java"
  java -cp "$OUT:$AJAR" cc.agyroid.GwRuntimeSwapTest
  # M1 文件名白名单（emoji / CJK 扩展 B 区）、NT-14 cmpVer 预发布比较、ST-07 诊断包脱敏
  javac -nowarn -d "$OUT" -cp "$OUT:$AJAR" "$ROOT/android/tests/cc/codroid/MainActivityNameTest.java"
  java -cp "$OUT:$AJAR" cc.agyroid.MainActivityNameTest
  javac -nowarn -d "$OUT" -cp "$OUT:$AJAR" "$ROOT/android/tests/cc/codroid/UpdaterCmpVerTest.java"
  java -cp "$OUT:$AJAR" cc.agyroid.UpdaterCmpVerTest
  javac -nowarn -d "$OUT" -cp "$OUT:$AJAR" "$ROOT/android/tests/cc/codroid/ShareScrubTest.java"
  java -cp "$OUT:$AJAR" cc.agyroid.ShareScrubTest
else echo "跳过 WhatsNewPickTest（没有 android.jar）"; fi
