// first-run.mjs —— 生成打进工具包的 first-run.sh（App 解包后跑一次，参数与 dpkg 一致：configure）
//
// 单独成文件的原因：devkit.mjs 顶层有 `await loadIndex(...)`（约 5 秒、走网络），
// 测试直接 import 它会又慢又依赖网络；这里是纯函数，无副作用。
//
// 历史（1.0.1）：旧脚本以 `… -m compileall -q -j 0 "…" >/dev/null 2>&1` 收尾。
// compileall 在建 ProcessPoolExecutor + forkserver 池时抛未捕获异常、0.4 秒 rc=1；
// 又是脚本末行，退出码直接变成脚本的退出码，Java 侧（Installer.firstRuns）据此判
// 首次配置失败、.devkit-ok 不写、下次启动重跑同一份旧脚本——确定性死循环。1.0.2 起：
//   - H1：compileall 串行（-j 0 拿掉，彻底绕开 multiprocessing/forkserver/命名信号量），
//     输出进 $PREFIX/tmp/first-run-compileall.log，失败只警告继续，不决定脚本退出码；
//     内层取 stdlib 路径失败时单独警告，不静默产生空路径；
//   - H2：每个 postinst 的 rc 记进 first-run-summary（stdout 一行 + $PREFIX/tmp/first-run-summary.txt），
//     脚本末尾 exit 第一个非零 postinst rc（compileall 不计入；Java 侧据此重试，见下）；
//   - M6：cd $HOME 失败警告不静默；无 python3 时明说跳过。
// 注意：脚本里不出现 >/dev/null——输出丢了就没法排障；tail/mkdir 的失败也直接让它报出来。
// 另注意：exit 累计 rc 是有意的——Java 的 firstRunFailed 分支本来就是这么设计的
// （失败重试下次启动）。代价是 postinst 确定性失败时会挡住 devkitReady：
// base 现有的 6 个 postinst（android-tools、npm、openssh、python、python-pip、termux-exec）
// 里没有哪个对“进到可用状态”是关键的（openssh 只是生成主机钥匙、pip 只是关版本检查、
// termux-exec 的 LD_PRELOAD 设置已被应用自己的 exec-shim/加载器取代），所以这里不设
// “关键 postinst”白名单；若以后某个 postinst 确实关键或确实爱失败，再由 Java 侧
// 决定是只认关键失败还是加重试上限——不要在脚本里悄悄把失败吞掉。
//
// 参数：prefix 是 R.to（"/data/data/<包名>/"，含末尾斜杠）；libexec 是 first-run.sh
// 所在的相对路径（"usr/libexec/devkit" 或 "usr/libexec/devkit/modules/<id>"）；
// pkgs 是 postinst 包名（按打包顺序）；extras 为真时追加 Python 预编译段（只跟基础块走）。
export function buildFirstRunScript({ prefix, libexec, pkgs, extras }) {
  const py = `${prefix}files/usr/bin/python3`;
  const lines = [
    `#!${prefix}files/usr/bin/sh`,
    `# devkit 首次运行：各包 postinst 里除 alternatives 外的步骤`,
    `FR_RC=0`,
    `FR_SUMMARY=""`,
    `FR_SUMMARY_FILE="$PREFIX/tmp/first-run-summary.txt"`,
    `mkdir -p "$PREFIX/tmp" || echo "（警告：建 $PREFIX/tmp 失败，rc=$?）"`,
    `cd "$HOME" || echo "（警告：cd $HOME 失败，rc=$?，继续在当前目录跑）"`,
  ];
  for (const pkg of pkgs) {
    const p = `${libexec}/postinst/${pkg}`;
    lines.push(
      `echo "▸ ${pkg}"`,
      `"${prefix}files/${p}" configure`,
      `_rc=$?`,
      `FR_SUMMARY="\${FR_SUMMARY}${pkg}=\${_rc},"`,
      `if [ "$_rc" -ne 0 ]; then echo "  （${pkg} 的 postinst 失败，rc=$_rc）"; if [ "$FR_RC" -eq 0 ]; then FR_RC=$_rc; fi; fi`,
    );
  }
  if (extras) {
    lines.push(
      `FR_LOG="$PREFIX/tmp/first-run-compileall.log"`,
      `if [ -x "${py}" ]; then`,
      `  echo "▸ 预编译 Python 标准库与 site-packages"`,
      `  _stdlib="$(LD_PRELOAD= "${py}" -c "import sysconfig; print(sysconfig.get_path(\x27stdlib\x27))" 2>"$FR_LOG")"`,
      `  if [ -z "$_stdlib" ]; then`,
      `    echo "（警告：取 Python stdlib 路径失败，跳过预编译，详见 $FR_LOG）"`,
      `  else`,
      `    LD_PRELOAD= "${py}" -m compileall -q "$_stdlib" >"$FR_LOG" 2>&1 || {`,
      `      _rc=$?`,
      `      echo "（警告：预编译 Python 失败，rc=$_rc，详见 $FR_LOG）"`,
      `      tail -n 20 "$FR_LOG" || true`,
      `    }`,
      `  fi`,
      `else`,
      `  echo "跳过预编译：无 python3"`,
      `fi`,
    );
  }
  lines.push(
    `FR_SUMMARY="\${FR_SUMMARY%,}"`,
    `echo "first-run-summary: \${FR_SUMMARY:-（无）}"`,
    `echo "first-run-summary: \${FR_SUMMARY:-（无）}" >>"$FR_SUMMARY_FILE" || true`,
    `exit "$FR_RC"`,
  );
  return lines.join("\n") + "\n";
}
