// push: 会话还活着时把本地文件送进 runner, 供 CI 复现使用.

import { existsSync, statSync } from "node:fs";

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { fail, info, warn } from "./lib/log.mjs";
import { ensureConnection } from "./lib/session.mjs";
import { localSha256, remoteFileExists, remoteFileSize, remoteSha256, runScp, scpArgs } from "./lib/transfer.mjs";

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
  const localSize = statSync(localPath).size;
  const localHash = localSha256(localPath);
  const result = runScp([...scpArgs(session), localPath, `${session.user}@${session.host}:${remote}`]);

  if (!result.ok) {
    // 与 run 一致: upterm 的 SFTP 收尾经常假失败. 先比 sha256, 再比大小, 最差查存在.
    const remoteHash = await remoteSha256(session, remote);
    if (remoteHash !== null) {
      if (remoteHash !== localHash) {
        fail(1, `scp 报退出码 ${result.status}, 且 sha256 不一致: 本地 ${localHash}, runner 上 ${remoteHash}.`);
      }
      warn(`scp 报退出码 ${result.status}, 但文件 sha256 一致, 按推送成功继续.`);
    } else {
      const remoteSize = await remoteFileSize(session, remote);
      if (remoteSize !== null) {
        if (remoteSize !== localSize) {
          fail(1, `scp 报退出码 ${result.status}, 且大小不一致: 本地 ${localSize} 字节, runner 上 ${remoteSize} 字节.`);
        }
        warn(`scp 报退出码 ${result.status}, 但文件大小一致 (${localSize} 字节), 按推送成功继续.`);
      } else {
        const present = await remoteFileExists(session, remote);
        if (present !== true) {
          fail(1, `scp 失败 (退出码 ${result.status}) 且无法确认文件已落地: ${result.stderr || "没有 stderr"}`);
        }
        warn(`scp 报退出码 ${result.status}, 大小核验不可用, 但文件存在; 按推送成功继续.`);
      }
    }
  }

  info(`已推送到 ${session.user}@${session.host}:${remote}`);
  return 0;
});
