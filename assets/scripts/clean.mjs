// clean: 取消还在跑的 run, 删远程临时分支, 移除 worktree, 删本地分支与临时目录.

import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { fail, info } from "./lib/log.mjs";
import { runCmd, tryRun } from "./lib/run.mjs";

// root 是 rm -rf 的目标, 动手前再核一次.
function assertSafeRoot(root) {
  if (!/^\.tmp\/ssh-debug-[^/]*$/.test(root)) {
    fail(7, `拒绝删除 ${root}: 不在预期的 .tmp/ssh-debug-* 之下.`);
  }
}

// 全空的 .tmp/ 是 mkdirSync 留下的, 顺手收掉; 里面还有别的文件就说明是别人的, 不动.
function removeTmpIfEmpty(cwd) {
  const tmp = path.join(cwd, ".tmp");
  try {
    if (readdirSync(tmp).length === 0) {
      rmSync(tmp, { recursive: true, force: true });
    }
  } catch {
    // 目录不存在或读不动都不影响收工.
  }
}

runMain(() => {
  const { options } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  assertSafeRoot(ctx.root);

  info(`将要清理: 远端分支 ${ctx.branch}, worktree ${ctx.wt}, 本地分支 ${ctx.branch}, 目录 ${ctx.root}`);

  const runs = tryRun("gh", [
    "run",
    "list",
    "--repo",
    ctx.repo,
    "--branch",
    ctx.branch,
    "--limit",
    "10",
    "--json",
    "databaseId,status",
    "--jq",
    '.[] | select(.status != "completed") | .databaseId',
  ]);
  for (const id of runs.stdout.split(/\r?\n/).filter(Boolean)) {
    tryRun("gh", ["api", "--method", "POST", `repos/${ctx.repo}/actions/runs/${id}/cancel`]);
  }

  tryRun("git", ["push", "origin", "--delete", ctx.branch]);
  tryRun("git", ["worktree", "remove", "--force", ctx.wt]);
  tryRun("git", ["branch", "-D", ctx.branch]);
  rmSync(ctx.root, { recursive: true, force: true });
  removeTmpIfEmpty(ctx.cwd);

  info(tryRun("git", ["worktree", "list"]).stdout.trimEnd());
  info(`已清理 ${ctx.branch} 与临时目录 ${ctx.root}`);
  return 0;
});
