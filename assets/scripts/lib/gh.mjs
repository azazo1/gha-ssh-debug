// 与 gh 打交道的公共部分: 解析 run id, 取 artifact 列表.
//
// gh 并非全都免提权: 公开仓库的 REST 读在沙箱内未认证也能跑, 但 artifact 下载
// (gh run download) 与 GraphQL 必须认证. 所以这些调用都按提权执行.

import { fail } from "./log.mjs";
import { tryRun } from "./run.mjs";

// 指定了就用指定的; 没指定就找该分支最近一条 run.
export function resolveRunId(repo, branch, explicit) {
  if (explicit) return String(explicit);
  const result = tryRun("gh", [
    "run",
    "list",
    "--repo",
    repo,
    "--branch",
    branch,
    "--limit",
    "1",
    "--json",
    "databaseId",
    "--jq",
    ".[0].databaseId",
  ]);
  const id = result.stdout.trim();
  if (!result.ok || !id || id === "null") {
    fail(1, `分支 ${branch} 上还没有 run, 先 prep.`);
  }
  return id;
}

// 最近的 upterm-connection-* artifact 名; 没有就返回空串.
//
// 用 tryRun 而不是 runCmd: 等 artifact 的时候"还没有"是正常状态, 不是失败.
export function findConnectionArtifact(repo, runId) {
  const result = tryRun("gh", [
    "api",
    `repos/${repo}/actions/runs/${runId}/artifacts`,
    "--jq",
    '[.artifacts[] | select(.name | startswith("upterm-connection-"))] | last | .name // ""',
  ]);
  if (!result.ok) return "";
  return result.stdout.trim();
}

// run 的当前状态与结论; 查不到返回 null.
export function runState(repo, runId) {
  const result = tryRun("gh", ["run", "view", String(runId), "--repo", repo, "--json", "status,conclusion"]);
  if (!result.ok) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// 等 upterm-connection-* artifact 出现.
//
// runner 从收到 push 到会话就绪通常要一两分钟, 这段是纯粹的等待, 不该让调用方反复拿
// 自己的 turn 去轮询. run 跑挂时不硬等到超时, 直接报出来.
export async function waitForConnectionArtifact(repo, runId, options = {}) {
  const waitSeconds = options.waitSeconds ?? 300;
  const intervalSeconds = options.intervalSeconds ?? 10;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const deadline = Date.now() + waitSeconds * 1000;

  for (;;) {
    const artifact = findConnectionArtifact(repo, runId);
    if (artifact) return artifact;

    const state = runState(repo, runId);
    if (state && state.status === "completed") {
      fail(1, `run ${runId} 已经结束 (${state.conclusion}) 但没等到 upterm-connection-* artifact, 说明 workflow 没走通: 先 status ${runId} 看是哪一步挂了.`);
    }
    if (Date.now() >= deadline) {
      fail(1, `等了 ${waitSeconds} 秒还没等到 upterm-connection-* artifact: 先 status ${runId} 看步骤到哪了, 或者调大等待时间.`);
    }
    if (options.onTick) options.onTick();
    await sleep(intervalSeconds * 1000);
  }
}

// 解析连接命令 (形如 `ssh user@host` 或 `ssh user@host -p PORT`) 成 scp 能用的三段.
//
// 走 ws/wss 中继时命令是 `ssh -o ProxyCommand=upterm proxy ... user@host:443`, 上游在
// 这种 server 上不提供 SFTP, 直接报错让调用方改走 artifact.
export function parseSshCommand(line) {
  const text = (line || "").trim();
  if (!text) {
    fail(8, "连接命令是空的, 先跑 connection 确认 artifact 下下来了.");
  }
  if (text.includes("ProxyCommand") || text.includes(" -o ")) {
    fail(8, `这条连接走 ws/wss 中继, 上游在这种 server 上不提供 SFTP, 文件传不了.\n连接命令: ${text}\n改用 artifact: 在 workflow 里加 actions/upload-artifact, 收工后 gh run download.`);
  }
  const tokens = text.split(/\s+/);
  if (!tokens[0].endsWith("ssh")) {
    fail(8, `看不懂连接命令: ${text}`);
  }
  const rest = tokens.slice(1);
  let target = "";
  let port = "22";
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "-p") {
      port = rest[i + 1] || port;
      i += 1;
    } else if (!target) {
      target = token;
    }
  }
  const at = target.lastIndexOf("@");
  if (at <= 0 || at === target.length - 1) {
    fail(8, `看不懂连接命令里的 user@host: ${text}`);
  }
  if (!/^\d+$/.test(port)) {
    fail(8, `端口不像数字: ${port}`);
  }
  return { user: target.slice(0, at), host: target.slice(at + 1), port };
}
