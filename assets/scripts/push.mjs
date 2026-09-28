// push: 会话还活着时把本地文件送进 runner, 供 CI 复现使用.

import { existsSync } from "node:fs";

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { fail, info } from "./lib/log.mjs";
import { ensureConnection } from "./lib/session.mjs";
import { runInherit } from "./lib/run.mjs";

runMain(() => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const [localPath, remote, runId] = rest;

  if (!localPath || !remote) {
    fail(1, "缺参数: push <本地路径> <runner 上的路径> [run-id]");
  }
  if (!existsSync(localPath)) {
    fail(1, `本地路径不存在: ${localPath}`);
  }

  const session = ensureConnection(ctx, runId);
  info(`推送 ${localPath} -> ${session.user}@${session.host}:${remote}`);
  runInherit("scp", [
    "-P",
    session.port,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${session.knownHosts}`,
    "-o",
    "ConnectTimeout=10",
    localPath,
    `${session.user}@${session.host}:${remote}`,
  ]);
  info(`已推送到 ${session.user}@${session.host}:${remote}`);
  return 0;
});
