// 每个 recipe 都要的那几件事: 解析命令行, 校验 branch 与 cwd, 推导派生路径.
//
// justfile 只负责决定调哪个脚本, 这些规则全在这里, 免得两边各写一半.

import { existsSync, statSync } from "node:fs";
import path from "node:path";

import { fail } from "./log.mjs";
import { tryRun } from "./run.mjs";

// 去掉一层引号: 参数里带空格时 just 会原样传, 但也允许调用方自己包引号.
// Windows 的 cmd 不会剥掉双引号, 所以这步在所有平台上都要做.
function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

// --skill-dir 写成 options.skillDir, 免得调用方记两种拼法.
function toCamelCase(name) {
  return name.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
}

// 解析 --key=value / --flag 形式的参数; 位置参数按顺序收进 rest. 单独的 -- 只是分隔符, 忽略.
export function parseArgs(argv) {
  const options = {};
  const rest = [];
  for (const raw of argv) {
    if (raw === "--") continue;
    if (raw.startsWith("--")) {
      const body = raw.slice(2);
      const eq = body.indexOf("=");
      if (eq === -1) {
        options[toCamelCase(body)] = true;
      } else {
        options[toCamelCase(body.slice(0, eq))] = unquote(body.slice(eq + 1));
      }
    } else {
      rest.push(unquote(raw));
    }
  }
  return { options, rest };
}

// 从 origin 推 OWNER/REPO. 认 https / ssh / git@ 三种写法.
export function repoFromOrigin(origin) {
  if (!origin) return "";
  let value = origin.trim();
  const scpLike = value.match(/^[^@/]+@([^:]+):(.+)$/);
  if (scpLike) {
    value = scpLike[2];
  } else {
    try {
      const url = new URL(value);
      value = url.pathname.replace(/^\//, "");
    } catch {
      value = value.replace(/^[a-z+]+:\/\//i, "").replace(/^[^/]+\//, "");
    }
  }
  return value.replace(/\.git$/, "").replace(/\/+$/, "");
}

// 校验 branch 与 cwd, 并推导 root/wt/conn. 退出码沿用旧 bash 版 guard 的约定.
export function buildContext(options = {}) {
  const branch = options.branch || process.env.SSH_DEBUG_BRANCH || "";
  if (!branch) {
    fail(1, "未指定临时分支名: 请传 branch=<harness>/ssh-debug, 例如 branch=claude/ssh-debug.");
  }
  if (/[^A-Za-z0-9._/-]/.test(branch)) {
    fail(5, `分支名只允许字母, 数字和 . _ / - : ${branch}`);
  }

  const cwd = process.cwd();
  const toplevel = tryRun("git", ["rev-parse", "--show-toplevel"]);
  const repo = repoFromOrigin(tryRun("git", ["remote", "get-url", "origin"]).stdout);
  if (!repo) {
    fail(2, "从 origin 推不出 OWNER/REPO: 先给目标 repo 配好 origin remote, 或者用 -d 指对目录.");
  }
  if (!toplevel.ok || path.resolve(toplevel.stdout.trim()) !== path.resolve(cwd)) {
    fail(3, "当前目录不是仓库根目录: 请用 -d <目标 repo 主工作树根目录> 指定.");
  }
  // 主工作树的 .git 是目录; worktree 里 .git 是个文件.
  const dotGit = path.join(cwd, ".git");
  if (!existsSync(dotGit) || !statSync(dotGit).isDirectory()) {
    fail(4, "当前目录是个 worktree, 不是主工作树: 请把 -d 指到主工作树根目录.");
  }

  const slug = branch.replace(/\//g, "-");
  const root = `.tmp/ssh-debug-${slug}`;
  return {
    branch,
    slug,
    root,
    wt: `${root}/worktree`,
    conn: `${root}/upterm`,
    workflowPath: ".github/workflows/ssh-debug-upterm.yml",
    template: path.join(options.skillDir, "ssh-debug-upterm.yml"),
    repo,
    cwd,
  };
}
