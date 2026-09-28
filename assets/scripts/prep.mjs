// prep: 开临时 worktree, 按参数渲染 workflow 模板, 提交并推送临时分支. 幂等.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { info } from "./lib/log.mjs";
import { runCmd, tryRun } from "./lib/run.mjs";

// 模板里 runs-on 与 timeout-minutes 是占位值, 按目标 CI 覆盖.
function renderTemplate(templatePath, runner, timeout) {
  return readFileSync(templatePath, "utf8")
    .replace(/^ *runs-on:.*$/m, `    runs-on: ${runner}`)
    .replace(/^ *timeout-minutes:.*$/m, `    timeout-minutes: ${timeout}`);
}

runMain(() => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const [runner, ref = "HEAD", timeout = "30"] = rest;

  if (!runner) {
    info("缺 runner label: prep <runner-label> [ref] [timeout-minutes]");
    return 1;
  }
  if (!/^\d+$/.test(timeout)) {
    info(`timeout-minutes 要是整数: ${timeout}`);
    return 1;
  }

  const wtGit = path.join(ctx.wt, ".git");
  if (existsSync(wtGit)) {
    info(`worktree ${ctx.wt} 已存在, 复用`);
  } else {
    mkdirSync(path.dirname(ctx.wt), { recursive: true });
    if (existsSync(ctx.wt)) {
      info(`清掉上次失败留下的 ${ctx.wt}`);
      rmSync(ctx.wt, { recursive: true, force: true });
    }
    tryRun("git", ["fetch", "origin", ctx.branch]);
    const hasRemote = tryRun("git", ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${ctx.branch}`]).ok;
    const hasLocal = tryRun("git", ["rev-parse", "--verify", "--quiet", `refs/heads/${ctx.branch}`]).ok;
    if (hasRemote) {
      info(`远端已有 ${ctx.branch}, 基于它继续 (想从头开始请先 clean)`);
      if (hasLocal) {
        runCmd("git", ["worktree", "add", ctx.wt, ctx.branch]);
      } else {
        runCmd("git", ["worktree", "add", "-b", ctx.branch, ctx.wt, `origin/${ctx.branch}`]);
      }
    } else if (hasLocal) {
      info(`本地已有 ${ctx.branch}, 复用该分支 (想从头开始请先 clean)`);
      runCmd("git", ["worktree", "add", ctx.wt, ctx.branch]);
    } else {
      runCmd("git", ["worktree", "add", "-b", ctx.branch, ctx.wt, ref]);
    }
  }

  const workflowFile = path.join(ctx.wt, ctx.workflowPath);
  mkdirSync(path.dirname(workflowFile), { recursive: true });
  writeFileSync(workflowFile, renderTemplate(ctx.template, runner, timeout));

  runCmd("git", ["-C", ctx.wt, "add", ctx.workflowPath]);
  const staged = tryRun("git", ["-C", ctx.wt, "diff", "--cached", "--quiet"]);
  if (staged.ok) {
    info("workflow 内容没变, 跳过提交");
  } else {
    runCmd("git", ["-C", ctx.wt, "commit", "-m", "debug: add upterm ssh workflow"]);
  }
  runCmd("git", ["-C", ctx.wt, "push", "-u", "origin", ctx.branch]);

  info(`已推送 ${ctx.branch} (runs-on=${runner}, timeout-minutes=${timeout}).`);
  info(`接下来: just -f ${options.skillDir}/justfile -d ${ctx.cwd} branch=${ctx.branch} status`);
  return 0;
});
