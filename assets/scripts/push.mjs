// push: 会话还活着时把本地文件送进 runner, 供 CI 复现使用.

import { existsSync, statSync } from "node:fs";

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { fail, info } from "./lib/log.mjs";
import { ensureConnection } from "./lib/session.mjs";
import { localStats, remoteStats, resolveScpResult, runScp, scpArgs } from "./lib/transfer.mjs";

runMain(async () => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const [localPath, remote, runId] = rest;

  if (!localPath || !remote) {
    fail(1, "缺参数: push <本地路径> <runner 上的路径> [run-id]");
  }
  if (!existsSync(localPath)) {
    fail(1, `本地路径不存在: ${localPath}`);
  }
  if (!statSync(localPath).isFile()) {
    fail(1, `push 只支持单个本地文件: ${localPath}`);
  }

  const session = await ensureConnection(ctx, runId);
  info(`推送 ${localPath} -> ${session.user}@${session.host}:${remote}`);
  const result = runScp([...scpArgs(session), localPath, `${session.user}@${session.host}:${remote}`]);

  if (!result.ok) {
    // 本地这一侧知道是文件还是目录, 把它告诉核验, 免得它两条路都试一遍.
    const local2 = localStats(localPath);
    const remote2 = await remoteStats(session, remote, { kind: local2 && local2.kind });
    resolveScpResult(result, {
      remote: remote2,
      local: local2,
      describe: () =>
        `本地 ${local2 ? `${local2.count} 个文件 / ${local2.bytes} 字节` : "未知"}, runner 上 ${remote} 是 ${remote2 ? `${remote2.kind} ${remote2.count} 个文件 / ${remote2.bytes} 字节` : "未知"}`,
      onInconclusive: "warn",
    });
  }

  info(`已推送到 ${session.user}@${session.host}:${remote}`);
  return 0;
});
