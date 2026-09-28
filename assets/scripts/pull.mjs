// pull: 会话还活着时从 runner 上 scp 拉取文件或目录.
//
// upterm 从 v0.22.0 起在直连 ssh:// 的 server 上提供 SFTP; action-upterm 又以 --accept
// 启动会话 (自动放行, 不弹审批), 所以无显示器的 CI 里 scp 照样能用.

import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { fail, info } from "./lib/log.mjs";
import { ensureConnection } from "./lib/session.mjs";
import { runInherit } from "./lib/run.mjs";

runMain(() => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const [remote, localDir, runId] = rest;

  if (!remote) {
    fail(1, "缺 runner 上的路径: pull <runner 上的路径> [本地目录] [run-id]");
  }

  const session = ensureConnection(ctx, runId);
  const dest = localDir || path.join(ctx.root, "pull");
  mkdirSync(dest, { recursive: true });

  info(`从 ${session.user}@${session.host}:${session.port} 拉取: ${remote} -> ${dest}`);
  runInherit("scp", [
    "-r",
    "-P",
    session.port,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${session.knownHosts}`,
    "-o",
    "ConnectTimeout=10",
    `${session.user}@${session.host}:${remote}`,
    `${dest}${path.sep}`,
  ]);

  info(`已拉到 ${dest}:`);
  if (existsSync(dest)) {
    for (const entry of readdirSync(dest)) {
      const stat = statSync(path.join(dest, entry));
      info(`  ${stat.isDirectory() ? "dir " : "file"} ${entry}`);
    }
  }
  return 0;
});
