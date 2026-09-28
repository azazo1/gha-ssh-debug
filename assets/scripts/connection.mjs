// connection: 下载 upterm-connection-* artifact 到临时目录并打印连接命令.

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { info } from "./lib/log.mjs";
import { ensureConnection } from "./lib/session.mjs";

runMain(() => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const session = ensureConnection(ctx, rest[0]);
  info(session.sshText);
  return 0;
});
