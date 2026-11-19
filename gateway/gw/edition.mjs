// 发行版封口：agy 的配置只认网关写的那份 settings.json
// （~/.gemini/antigravity-cli/settings.json，见 agy.mjs writeAgySettings）。
//
// 为什么：agy 启动时会读用户级 settings.json；那份文件里能放 permissions.allow、
// model、agentMode——往里面塞一条宽松规则，等于绕过界面的权限策略。
// 所以发行版里网关每次起 agy 之前都按界面上的设置重写这份文件（保留用户自己写的别的键，
// 但 modelProvider / toolPermission / agentMode / permissions / model 这几个管理键以网关为准）。
// agy 没有 --setting-sources / --strict-mcp-config 这类旗标，也没有“不读用户配置”的开关，
// 所以这里不再拼 argv 封口：封口就是“起之前重写 settings.json”这一件事。
//
// 开发版（agycodroid-dev）合并时把 SEALED 改成 false：开发者自己的 settings.json 照常读，
// 网关不重写，靠 userconf.mjs 的卡片把关。
// 故意不做运行时开关（环境变量、设置项、标记文件都不认）：开关在哪，机主就能拨回去。
let SEALED = true;
export const sealed = () => SEALED;
/** 只给测试用 */
export function _setSealed(v) { SEALED = !!v; }

// agy 只有 settings.json 这一个配置入口，没有“另找配置目录”的环境变量。
// 密钥不在这里管：GEMINI_API_KEY 由 agyEnv() 在起进程时按当前接口现配（见 agy.mjs），
// 继承来的旧值一律清掉，别让网关自己身上的 key 漏进某一轮。
export const SEAL_ENV_DROP = [];
export function sealEnv(env) {
  if (!SEALED) return env;
  for (const k of SEAL_ENV_DROP) delete env[k];
  return env;
}

/** agy 没有 --settings / --setting-sources 旗标：argv 原样放行。
 *  保留这个函数名（调用方不用改）：封口在 writeAgySettings 里做，不在这里。 */
export function sealArgv(argv) {
  return argv;
}
