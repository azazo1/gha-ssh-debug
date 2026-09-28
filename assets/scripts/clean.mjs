// clean: 取消还在跑的 run, 删远程临时分支, 移除 worktree, 删本地分支与临时目录.

import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { error, fail, info } from "./lib/log.mjs";
import { tryRun } from "./lib/run.mjs";

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

function worktreeRegistered(list, ctx) {
  const target = path.resolve(ctx.cwd, ctx.wt);
  return list.stdout.split(/\r?\n/).some((line) =>
    line.startsWith("worktree ") && path.resolve(ctx.cwd, line.slice("worktree ".length)) === target,
  );
}

function recordFailure(failures, action, result) {
  const detail = (result.stderr || result.stdout).trim();
  failures.push(`${action} 失败 (退出码 ${result.status})${detail ? `: ${detail}` : ""}`);
}

runMain(() => {
  const { options } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  assertSafeRoot(ctx.root);

  info(`将要清理: 远端分支 ${ctx.branch}, worktree ${ctx.wt}, 本地分支 ${ctx.branch}, 目录 ${ctx.root}`);

  const failures = [];
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
  if (!runs.ok) {
    recordFailure(failures, "查询未结束的 run", runs);
  } else {
    for (const id of runs.stdout.split(/\r?\n/).filter(Boolean)) {
      const cancelled = tryRun("gh", ["api", "--method", "POST", `repos/${ctx.repo}/actions/runs/${id}/cancel`]);
      if (!cancelled.ok) recordFailure(failures, `取消 run ${id}`, cancelled);
    }
  }

  const remote = tryRun("git", ["push", "origin", "--delete", ctx.branch]);
  if (!remote.ok) {
    const remaining = tryRun("git", ["ls-remote", "--exit-code", "--heads", "origin", ctx.branch]);
    if (remaining.status !== 2) recordFailure(failures, `删除远端分支 ${ctx.branch}`, remote);
  }

  const pruned = tryRun("git", ["worktree", "prune"]);
  if (!pruned.ok) recordFailure(failures, "清理失效 worktree 记录", pruned);
  const worktrees = tryRun("git", ["worktree", "list", "--porcelain"]);
  let worktreeRemoved = false;
  if (!worktrees.ok) {
    recordFailure(failures, "查询 worktree", worktrees);
  } else if (worktreeRegistered(worktrees, ctx)) {
    const removed = tryRun("git", ["worktree", "remove", "--force", ctx.wt]);
    if (!removed.ok) {
      recordFailure(failures, `移除 worktree ${ctx.wt}`, removed);
    } else {
      worktreeRemoved = true;
    }
  } else if (existsSync(path.join(ctx.wt, ".git"))) {
    failures.push(`${ctx.wt} 包含未注册的 .git, 保留目录供检查, 请修复后重试 clean`);
  } else {
    worktreeRemoved = true;
  }

  if (worktreeRemoved) {
    const after = tryRun("git", ["worktree", "list", "--porcelain"]);
    if (!after.ok) {
      recordFailure(failures, "确认 worktree 已移除", after);
    } else if (worktreeRegistered(after, ctx)) {
      failures.push(`${ctx.wt} 仍注册为 worktree, 保留临时目录; 如果路径已不存在, 请检查 git worktree prune 后重试 clean`);
    } else {
      const branch = tryRun("git", ["branch", "-D", ctx.branch]);
      const remaining = branch.ok ? null : tryRun("git", ["show-ref", "--verify", "--quiet", `refs/heads/${ctx.branch}`]);
      if (!branch.ok && remaining.status !== 1) {
        recordFailure(failures, `删除本地分支 ${ctx.branch}`, branch);
      } else {
        try {
          rmSync(ctx.root, { recursive: true, force: true });
          removeTmpIfEmpty(ctx.cwd);
        } catch (cause) {
          failures.push(`删除临时目录 ${ctx.root} 失败: ${cause.message}`);
        }
      }
      info(after.stdout.trimEnd());
    }
  }

  if (failures.length) {
    for (const failure of failures) error(failure);
    error(`清理未完成: ${ctx.branch}; 请处理上述问题后重试 clean`);
    return 1;
  }
  info(`已清理 ${ctx.branch} 与临时目录 ${ctx.root}`);
  return 0;
});
