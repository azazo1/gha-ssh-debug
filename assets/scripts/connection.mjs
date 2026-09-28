// connection: 等会话就绪, 下载 upterm-connection-* artifact 到临时目录并打印连接命令.
//
// 默认会等到 artifact 出现 (runner 铺会话要一两分钟), 免得调用方自己轮询 status.

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { info } from "./lib/log.mjs";
import { ensureConnection } from "./lib/session.mjs";

runMain(async () => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const [runId, waitArg] = rest;

  const waitSeconds = Number(waitArg || options.wait || process.env.SSH_DEBUG_WAIT || 300);
  if (!Number.isFinite(waitSeconds) || waitSeconds < 0) {
    info(`等待秒数要是个非负数: ${waitArg}`);
    return 1;
  }

  const session = await ensureConnection(ctx, runId, { waitSeconds });
  info(session.sshText);
  return 0;
});
