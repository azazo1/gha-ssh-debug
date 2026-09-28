// 脚本入口的统一包装: 把 CliError 翻成退出码与 stderr 输出, 别让栈追踪漏给 user.

import { CliError, error, pipeBroken } from "./log.mjs";

export function runMain(fn) {
  Promise.resolve()
    .then(fn)
    .then((code) => {
      process.exitCode = typeof code === "number" ? code : 0;
    })
    .catch((cause) => {
      if (cause instanceof CliError) {
        error(cause.message);
        process.exitCode = cause.code;
        return;
      }
      error(`未预期的错误: ${cause && cause.stack ? cause.stack : cause}`);
      process.exitCode = 1;
    })
    .finally(() => {
      // 下游已经不看输出了, 别再报错打扰调用方.
      if (pipeBroken()) process.exitCode = 0;
    });
}
