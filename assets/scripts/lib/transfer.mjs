// scp 传输与落地核验.
//
// 实测过的一个坑: upterm 的 SFTP 通道常常在文件已经完整落地之后仍然返回非零退出码
// (对照过字节数与 sha256). 只看退出码会把成功的传输判成失败, 调用方于是重试或退回手工
// base64, 反而更容易把脚本传坏.
//
// 另一面同样要防: 核验本身也要可靠. 早先的版本只会算"目录递归统计", 一个单文件也要跑
// find + 逐文件 stat, 在负载高的 runner 上慢到超时, 于是核验返回"未知", 又把成功判死.
// 现在单文件走 wc -c, 便宜、快、稳.
//
// 三种结论: 一致 (放过) / 不一致 (报错) / 核验不出来 (由调用方定策略).

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

import { fail, warn } from "./log.mjs";
import { queryRemote } from "./session-run.mjs";
import { sshArgsFor } from "./session.mjs";

// 远端路径要经一次 shell, 单引号包住并把内层单引号转义掉.
function shellQuote(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// scp 的公共选项. -P 指定端口, 其余与 ssh 一致, known_hosts 走临时目录.
export function scpArgs(session, { recursive = false } = {}) {
  const args = [];
  if (recursive) args.push("-r");
  args.push(
    "-P",
    session.port,
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${session.knownHosts}`,
    "-o",
    "ConnectTimeout=10",
  );
  return args;
}

// 跑一次 scp, 不因退出码直接失败, 把判断留给调用方.
export function runScp(args) {
  const result = spawnSync("scp", args, { encoding: "utf8" });
  if (result.error) {
    fail(127, `无法执行 scp: ${result.error.message}`);
  }
  return {
    ok: result.status === 0,
    status: result.status,
    stderr: (result.stderr || "").trim(),
    stdout: (result.stdout || "").trim(),
  };
}

// 统计本地路径下的文件数与总字节数 (目录递归, 单文件按一个算).
export function localStats(target) {
  let stat;
  try {
    stat = statSync(target);
  } catch {
    return null;
  }
  if (stat.isFile()) {
    return { kind: "file", count: 1, bytes: stat.size };
  }
  if (!stat.isDirectory()) {
    return null;
  }
  let count = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        count += 1;
        bytes += statSync(full).size;
      }
    }
  };
  walk(target);
  return { kind: "dir", count, bytes };
}

// runner 上单个文件的字节数; 拿不到返回 null.
//
// 单文件是绝大多数场合 (脚本, pkg, 日志), 所以这条要走最短路径: wc -c 一个命令就完事.
// 重试是因为共享 shell 可能正忙, 一次没回话不代表核验做不了.
export async function remoteFileSize(session, remotePath, { attempts = 3 } = {}) {
  const quoted = shellQuote(remotePath);
  for (let i = 0; i < attempts; i += 1) {
    const output = await queryRemote(sshArgsFor(session, { batch: true }), `wc -c < ${quoted} 2>/dev/null || echo ERR`, {
      beforeMs: 1200,
      holdMs: 6000,
    });
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    // 只认整行都是数字的行: 命令回显里含路径 (路径里有数字), 不会整行是数字.
    const last = lines[lines.length - 1] || "";
    if (/^\d+$/.test(last)) return Number(last);
  }
  return null;
}

// runner 上的目录统计 (文件数与总字节数); 拿不到返回 null.
async function remoteDirStats(session, remotePath, { attempts = 2 } = {}) {
  const quoted = shellQuote(remotePath);
  const script = `find ${quoted} -type f | while IFS= read -r f; do stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null; done | awk '{n++; t+=$1} END {print n+0, t+0}'`;

  for (let i = 0; i < attempts; i += 1) {
    const output = await queryRemote(sshArgsFor(session, { batch: true }), script, { beforeMs: 1200, holdMs: 15000 });
    const lines = output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const match = (lines[lines.length - 1] || "").match(/^(\d+)\s+(\d+)$/);
    if (match) return { kind: "dir", count: Number(match[1]), bytes: Number(match[2]) };
  }
  return null;
}

// runner 上的路径统计.
//
// kind 是本地这一侧的类型 (调用方知道自己在传文件还是目录): 传了就只走对应的那条路,
// 免得单文件问不出大小时又去跑一遍昂贵的目录扫描, 白等一倍时间. 不传就两条都试.
export async function remoteStats(session, remotePath, { kind } = {}) {
  if (kind === "dir") return remoteDirStats(session, remotePath);
  const size = await remoteFileSize(session, remotePath, { attempts: kind === "file" ? 3 : 2 });
  if (size !== null) return { kind: "file", count: 1, bytes: size };
  if (kind === "file") return null;
  return remoteDirStats(session, remotePath);
}

// 退出码非零时的处置.
//
// onInconclusive: 核验不出来时怎么办. "warn" 表示继续 (push / pull 用, 因为 upterm 报假
// 失败太常见, 把已经落地的传输判死更糟); "fail" 表示中止 (run 用, 它必须确认脚本在手).
export function resolveScpResult(result, { remote, local, describe, onInconclusive = "fail" }) {
  if (result.ok) return "ok";

  const detail = describe();
  if (remote && local && remote.count === local.count && remote.bytes === local.bytes) {
    warn(`scp 报了退出码 ${result.status}, 但核验通过: ${detail}.`);
    warn("upterm 的 SFTP 通道收尾时有时这样报错, 文件本身是完整的, 按成功处理.");
    return "verified";
  }

  if (!remote || !local) {
    if (onInconclusive === "warn") {
      warn(`scp 报了退出码 ${result.status}${result.stderr ? `: ${result.stderr}` : ""}, 而且没能核验: ${detail}.`);
      warn("先按成功继续, 但请自己确认落地的文件完整 (比字节数或 sha256).");
      return "inconclusive";
    }
    fail(1, `scp 失败 (退出码 ${result.status}): ${result.stderr || "没有 stderr"}\n核验没做成: ${detail}`);
  }

  fail(1, `scp 失败 (退出码 ${result.status}): ${result.stderr || "没有 stderr"}\n核验不一致: ${detail}`);
}
