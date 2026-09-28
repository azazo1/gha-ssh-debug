// scp 传输与核验.
//
// 实测过的一个坑: upterm 的 SFTP 通道有时在收尾时报非零退出码, 而文件其实已经完整落地
// (对照过字节数与 sha256). 只看退出码会把成功的传输判成失败, 调用方于是重试或退回手工
// base64, 反而更容易把脚本传坏.
//
// 策略: 正常路径只看退出码; 退出码非零时**核验落地结果**, 一致就当作成功并说明原因,
// 不一致才报错. 这样既不为每次传输付一次往返, 也不会被假失败带偏.

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
    return { count: 1, bytes: stat.size };
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
  return { count, bytes };
}

// 在 runner 上统计同一个路径. 远端 find/stat 的写法兼顾 GNU 与 BSD:
// 先试 macOS 的 stat -f%z, 失败再试 Linux 的 stat -c%s.
//
// 输出形如 `dir 5 1234567`, 取最后一行是因为共享 PTY 会把输入的命令回显一遍.
export async function remoteStats(session, remotePath) {
  const quoted = shellQuote(remotePath);
  const script = [
    `k=file; [ -d ${quoted} ] && k=dir`,
    `echo "$k $(find ${quoted} -type f | while IFS= read -r f; do stat -f%z "$f" 2>/dev/null || stat -c%s "$f" 2>/dev/null; done | awk '{n++; t+=$1} END {print n+0, t+0}')"`,
  ].join("\n");

  const output = await queryRemote(sshArgsFor(session, { batch: true }), script);
  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const match = (lines[lines.length - 1] || "").match(/^(file|dir)\s+(\d+)\s+(\d+)$/);
  if (!match) return null;
  return { kind: match[1], count: Number(match[2]), bytes: Number(match[3]) };
}

// 退出码非零时的核验: 落地结果与 runner 上一致就放过, 否则报错.
//
// describe() 返回给 user 的一行对账信息, 让"为什么放过"是可核查的而不是一句安慰.
export function handleScpFailure(result, { remote, local, describe }) {
  const detail = describe();
  if (remote && local && remote.count === local.count && remote.bytes === local.bytes) {
    warn(`scp 报了退出码 ${result.status}, 但核验通过: ${detail}.`);
    warn("upterm 的 SFTP 通道收尾时有时这样报错, 文件本身是完整的, 按成功处理.");
    return true;
  }
  fail(1, `scp 失败 (退出码 ${result.status}): ${result.stderr || "没有 stderr"}\n核验未通过: ${detail}`);
}
