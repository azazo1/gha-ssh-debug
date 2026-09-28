// 取连接信息的公共部分: 下 artifact, 读 ssh.txt, 解析出 scp 要用的 user/host/port.
//
// connection / pull / push / ssh / done 都要这一段, 所以集中在这里.

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { fail } from "./log.mjs";
import { findConnectionArtifact, parseSshCommand, resolveRunId } from "./gh.mjs";
import { runCmd } from "./run.mjs";

// conn 是推导出来的路径, 这里再核一次: 它是 rm -rf 的目标, 不能落到别处.
export function assertSafeConn(conn) {
  if (!/^\.tmp\/ssh-debug-[^/]*\/upterm$/.test(conn)) {
    fail(7, `拒绝动 ${conn}: 不在预期的 .tmp/ssh-debug-*/upterm 之下.`);
  }
}

// 下载 upterm-connection-* artifact 到 <root>/upterm/, 返回连接信息.
export function ensureConnection(ctx, explicitRunId) {
  assertSafeConn(ctx.conn);
  const runId = resolveRunId(ctx.repo, ctx.branch, explicitRunId);
  const artifact = findConnectionArtifact(ctx.repo, runId);
  if (!artifact) {
    fail(1, `run ${runId} 还没有 upterm-connection-* artifact, 先 status ${runId} 看步骤到哪了.`);
  }
  rmSync(ctx.conn, { recursive: true, force: true });
  mkdirSync(ctx.conn, { recursive: true });
  runCmd("gh", ["run", "download", runId, "-n", artifact, "-D", ctx.conn, "--repo", ctx.repo]);

  const sshText = readFileSync(path.join(ctx.conn, "ssh.txt"), "utf8").trim();
  const target = parseSshCommand(sshText);
  return {
    runId,
    artifact,
    sshText,
    ...target,
    knownHosts: path.join(ctx.root, "known-hosts"),
  };
}

// 交互/批量连进去时的 ssh 参数, ssh / exec / done 共用, 免得三处各写一份.
export function sshArgsFor(session, { batch = false, tty = true } = {}) {
  const args = [];
  if (tty) args.push("-tt");
  args.push("-o", "StrictHostKeyChecking=accept-new", "-o", `UserKnownHostsFile=${session.knownHosts}`, "-o", "ConnectTimeout=10");
  if (batch) args.push("-o", "BatchMode=yes");
  if (session.port && session.port !== "22") {
    args.push("-p", session.port);
  }
  args.push(`${session.user}@${session.host}`);
  return args;
}
