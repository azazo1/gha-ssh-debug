// check: 只读体检. 目标仓库, .tmp 忽略状态, runs-on 候选, 残留物, 建议的 allow prefix.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { runMain } from "./lib/cli.mjs";
import { parseArgs, repoFromOrigin } from "./lib/context.mjs";
import { info } from "./lib/log.mjs";
import { tryRun } from "./lib/run.mjs";

// 扫 .github/workflows 下所有 yml/yaml, 把 runs-on 的值去重列出来.
function collectRunnerLabels(cwd) {
  const dir = path.join(cwd, ".github", "workflows");
  if (!existsSync(dir)) return { labels: [], found: false };
  const labels = new Set();
  for (const entry of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const text = readFileSync(path.join(dir, entry), "utf8");
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*runs-on:\s*(.+?)\s*$/);
      if (match) labels.add(match[1].replace(/^['"]|['"]$/g, ""));
    }
  }
  return { labels: [...labels].sort(), found: true };
}

runMain(() => {
  const { options } = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();

  const toplevel = tryRun("git", ["rev-parse", "--show-toplevel"]);
  if (!toplevel.ok) {
    info("当前目录不是 git 仓库: 请用 -d <目标 repo 主工作树根目录> 指定.");
    return 3;
  }

  const repo = repoFromOrigin(tryRun("git", ["remote", "get-url", "origin"]).stdout);
  info(`目标仓库: ${repo || "未从 origin 推出来"}`);
  info(`当前目录: ${cwd}`);
  const head = tryRun("git", ["rev-parse", "--short", "HEAD"]).stdout.trim();
  const branchName = tryRun("git", ["rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
  info(`当前 HEAD: ${head} (${branchName})`);

  // 探 .tmp/ 而不是 .tmp: 目录模式 (`.tmp/`) 不匹配被当成文件的路径, 会误报未忽略.
  info(tryRun("git", ["check-ignore", "-q", ".tmp/"]).ok ? ".tmp/ 已被忽略: ok" : ".tmp/ 未被忽略: 先往 .gitignore 加一条 .tmp/, 否则 worktree 会污染 git status");

  const { labels, found } = collectRunnerLabels(cwd);
  info("目标 CI 的 runs-on 候选:");
  if (!found) {
    info("  没找到 .github/workflows/*.yml");
  } else if (labels.length === 0) {
    info("  workflow 里没写 runs-on");
  } else {
    for (const label of labels) info(`  ${label}`);
  }

  info("本地 worktree:");
  info(tryRun("git", ["worktree", "list"]).stdout.trimEnd());

  info("远端带调试分支名的分支:");
  const remote = tryRun("git", ["ls-remote", "--heads", "origin"]);
  const debugHeads = remote.stdout.split(/\r?\n/).filter((line) => line.includes("ssh-debug"));
  if (debugHeads.length === 0) {
    info("  无");
  } else {
    for (const line of debugHeads) info(`  ${line}`);
  }

  const workflowPath = ".github/workflows/ssh-debug-upterm.yml";
  info(`默认分支上是否已有 ${workflowPath}:`);
  const hasWorkflow = tryRun("gh", ["api", `repos/${repo}/contents/${workflowPath}`]).ok;
  info(hasWorkflow ? "  已存在, 先跟 user 确认是复用还是重铺" : "  没有, ok");

  info("本次要用的临时分支名由你自己定, 形如 <你的 harness 名>/ssh-debug.");
  info("建议在 dsh-approve-prefix 里放行这条前缀:");
  info(`  just -f ${options.skillDir}/justfile`);
  return 0;
});
