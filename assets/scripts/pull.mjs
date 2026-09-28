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
import { handleScpFailure, localStats, remoteStats, runScp, scpArgs } from "./lib/transfer.mjs";

function describeDir(dir) {
  if (!existsSync(dir)) return "  (空)";
  const entries = readdirSync(dir);
  if (entries.length === 0) return "  (空)";
  return entries
    .map((entry) => {
      const stat = statSync(path.join(dir, entry));
      const size = stat.isDirectory() ? "-" : `${stat.size}`;
      return `  ${stat.isDirectory() ? "dir " : "file"} ${entry} ${size}`;
    })
    .join("\n");
}

runMain(async () => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const [remote, localDir, runId] = rest;

  if (!remote) {
    fail(1, "缺 runner 上的路径: pull <runner 上的路径> [本地目录] [run-id]");
  }

  const session = await ensureConnection(ctx, runId);
  const dest = localDir || path.join(ctx.root, "pull");
  mkdirSync(dest, { recursive: true });

  info(`从 ${session.user}@${session.host}:${session.port} 拉取: ${remote} -> ${dest}`);
  const result = runScp([...scpArgs(session, { recursive: true }), `${session.user}@${session.host}:${remote}`, `${dest}${path.sep}`]);

  if (!result.ok) {
    // 这一趟的落点按 scp 的语义推: 目录会落成 dest/<basename>, 单文件也是 dest/<basename>.
    const landed = path.join(dest, path.basename(remote.replace(/\/+$/, "")));
    const remote2 = await remoteStats(session, remote);
    const local2 = localStats(existsSync(landed) ? landed : dest);
    handleScpFailure(result, {
      remote: remote2,
      local: local2,
      describe: () =>
        `runner 上 ${remote} 是 ${remote2 ? `${remote2.kind} ${remote2.count} 个文件 / ${remote2.bytes} 字节` : "未知"}, 本地 ${local2 ? `${local2.count} 个文件 / ${local2.bytes} 字节` : "未知"}`,
    });
  }

  info(`已拉到 ${dest}:`);
  info(describeDir(dest));
  return 0;
});
