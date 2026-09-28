// done: 收工. 先在 runner 上放标记, 再退出会话, 让 run 收尾成 success.
//
// 放标记不会结束会话: 真正结束 job 的是会话结束触发的 post 步骤. 只放标记不 exit,
// job 会一直挂到 timeout-minutes.

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { ensureConnection, sshArgsFor } from "./lib/session.mjs";
import { runInheritAsync } from "./lib/run.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

runMain(async () => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const session = await ensureConnection(ctx, rest[0]);

  // 两行按顺序打进共享 PTY, 中间留出执行时间.
  // 标记放 /tmp: 往检出目录里写文件会让目标仓库的 git status 变脏, 复现出的版本号会带 +.
  const child = runInheritAsync("ssh", sshArgsFor(session));
  child.stdin.write("touch /tmp/ssh-debug-continue\n");
  await sleep(3000);
  child.stdin.write("exit\n");
  await sleep(3000);
  child.stdin.end();
  await child.done;
  return 0;
});
