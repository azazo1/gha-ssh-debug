// pull-large: 大文件分块拉取.
//
// upterm 的 scp 通道在文件较大时经常提前断开, 但普通 pull 只看退出码或最多比一次大小,
// 很容易把截断的文件当成功. 这里按固定大小在 runner 上 split, 逐块拉回并逐块核大小,
// 最后合并并核对 sha256. 20MB 分块在实测里能稳定通过中继.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { fail, info, warn } from "./lib/log.mjs";
import { ensureConnection, sshArgsFor } from "./lib/session.mjs";
import { queryRemote } from "./lib/session-run.mjs";
import { localSha256, remoteFileSize, remoteSha256, runScp, scpArgs, shellQuote } from "./lib/transfer.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseChunkMb(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 1024) {
    fail(1, `分块大小要是 1-1024 的整数 (MB): ${raw}`);
  }
  return value;
}

runMain(async () => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const [remote, localDir, chunkArg, runId] = rest;

  if (!remote) {
    fail(1, "缺 runner 上的路径: pull-large <runner 上的路径> [本地目录] [分块 MB] [run-id]");
  }
  const chunkMb = parseChunkMb(chunkArg || "20");
  const chunkBytes = chunkMb * 1024 * 1024;

  const session = await ensureConnection(ctx, runId);
  const dest = localDir || path.join(ctx.root, "pull");
  mkdirSync(dest, { recursive: true });
  const base = path.basename(remote.replace(/\/+$/, ""));
  const target = path.join(dest, base);

  const size = await remoteFileSize(session, remote);
  if (size === null) {
    fail(1, `读不到 ${remote} 的大小. 先检查路径是否存在, 或改用 exec 手工确认.`);
  }
  if (size === 0) {
    fail(1, `${remote} 是空文件, 不需要分块拉取.`);
  }

  const parts = Math.ceil(size / chunkBytes);
  info(`准备拉取 ${remote} (${size} 字节, 分 ${parts} 块, 每块 ${chunkMb}MB) -> ${target}`);

  // 小块没必要 split, 直接走普通 scp 并核对大小.
  if (parts === 1) {
    info("文件小于一个分块, 直接单次拉取.");
    const result = runScp([...scpArgs(session), `${session.user}@${session.host}:${remote}`, target]);
    const actual = existsSync(target) ? statSync(target).size : 0;
    if (actual !== size) {
      fail(1, `单次拉取不完整: runner 上 ${size} 字节, 本地 ${actual} 字节. ${result.stderr || ""}`);
    }
    const remoteHash = await remoteSha256(session, remote);
    const localHash = localSha256(target);
    if (remoteHash !== null && remoteHash !== localHash) {
      fail(1, `sha256 不一致: 本地 ${localHash}, runner 上 ${remoteHash}.`);
    }
    info(`已拉到 ${target}, sha256=${localHash}${remoteHash === null ? " (远端哈希不可用)" : " (一致)"}.`);
    return 0;
  }

  const remoteDir = `/tmp/ssh-debug-pull-${Date.now()}`;
  const batch = sshArgsFor(session, { batch: true });
  const splitScript = [
    `rm -rf ${shellQuote(remoteDir)}`,
    `mkdir -p ${shellQuote(remoteDir)}`,
    `split -b ${chunkBytes} -d -a 3 ${shellQuote(remote)} ${shellQuote(`${remoteDir}/part.`)} && echo SPLIT_OK`,
    `ls -1 ${shellQuote(remoteDir)}`,
  ].join("\n");
  const listing = await queryRemote(batch, splitScript, { beforeMs: 1800, holdMs: 10000 });
  if (!listing.includes("SPLIT_OK")) {
    fail(1, `runner 上分块失败, 回显:\n${listing}`);
  }
  // ls 在宽终端里会把多个名字挤在一行, 所以按空白切 token, 不要按行取.
  const names = [...new Set(listing.match(/part\.\d{3}/g) || [])].sort();
  if (names.length !== parts) {
    fail(1, `分块数量不对: 期望 ${parts}, 实际 ${names.length} (${names.join(", ")}).\nrunner 回显:\n${listing}`);
  }

  const tempDir = path.join(dest, `.${base}.parts-${Date.now()}`);
  mkdirSync(tempDir, { recursive: true });
  let completed = false;
  try {
    for (let i = 0; i < names.length; i += 1) {
      const part = names[i];
      const expected = i === names.length - 1 ? size - chunkBytes * i : chunkBytes;
      const localPart = path.join(tempDir, part);
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        if (existsSync(localPart)) unlinkSync(localPart);
        const result = runScp([...scpArgs(session), `${session.user}@${session.host}:${remoteDir}/${part}`, localPart]);
        const actual = existsSync(localPart) ? statSync(localPart).size : 0;
        if (actual === expected) {
          ok = true;
          break;
        }
        warn(`第 ${i + 1} 块第 ${attempt} 次不完整: 期望 ${expected}, 实际 ${actual}${result.stderr ? ` (${result.stderr})` : ""}`);
        await sleep(800);
      }
      if (!ok) {
        fail(1, `第 ${i + 1}/${names.length} 块拉取失败, 已保留 ${tempDir} 供检查.`);
      }
      info(`分块 ${i + 1}/${names.length} 完成 (${expected} 字节)`);
    }

    rmSync(target, { force: true });
    for (const part of names) {
      appendFileSync(target, readFileSync(path.join(tempDir, part)));
    }
    const actualSize = statSync(target).size;
    if (actualSize !== size) {
      fail(1, `合并后大小不对: 期望 ${size}, 实际 ${actualSize}.`);
    }
    const remoteHash = await remoteSha256(session, remote);
    const localHash = localSha256(target);
    if (remoteHash !== null && remoteHash !== localHash) {
      fail(1, `合并后 sha256 不一致: 本地 ${localHash}, runner 上 ${remoteHash}.`);
    }
    info(`已分块拉到 ${target} (${actualSize} 字节), sha256=${localHash}${remoteHash === null ? " (远端哈希不可用)" : " (一致)"}.`);
    completed = true;
  } finally {
    if (completed) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  await queryRemote(batch, `rm -rf ${shellQuote(remoteDir)}`, { holdMs: 3000 }).catch(() => {});
  return 0;
});
