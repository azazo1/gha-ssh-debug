// 往共享 PTY 里喂一段脚本并取回输出.
//
// Upterm 是共享 PTY, 不是普通 sshd: 不能 `ssh host 'remote command'`, 只能把命令打进
// 已经开着的那个 shell. 而且连上会先回放整段终端缓冲, 所以先用一个带时间戳的标记划界,
// 再从**本次**标记往后截取 —— 这些都在这里做掉, 免得每次手工拼管道.

import { spawn } from "node:child_process";

import { CliError } from "./log.mjs";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 把脚本切成行, 逐行喂进去; 空脚本也要发一个换行, 保证 shell 有动静.
function toLines(script) {
  return script.split(/\r?\n/);
}

/**
 * 连上去, 打标记, 喂脚本, 收输出.
 *
 * @param {string[]} sshArgs  已拼好的 ssh 参数 (不含可执行文件名)
 * @param {string}   script   要喂进远端 shell 的脚本内容
 * @param {object}   options  holdMs: 打完命令等多久再断; connectTimeoutMs: 起 ssh 到开始喂的等待
 * @returns {Promise<{output: string, marker: string, exitCode: number|null}>}
 */
export async function runSessionScript(sshArgs, script, options = {}) {
  const holdMs = options.holdMs ?? 12000;
  const marker = `MARKER_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  const child = spawn("ssh", sshArgs, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const closed = new Promise((resolve, reject) => {
    child.on("error", (cause) => reject(new CliError(127, `无法执行 ssh: ${cause.message}`)));
    child.on("close", (code) => resolve(code));
  });

  // 远端 shell 可能开着 history expansion, 命令里的 $! 之类会被改写, 这里不替调用方兜底,
  // 只在文档里提醒.
  const send = (line) => {
    if (!child.stdin.writable) return;
    child.stdin.write(`${line}\n`);
  };

  try {
    send(`echo ${marker}`);
    await sleep(options.beforeMs ?? 1500);
    for (const line of toLines(script)) {
      send(line);
    }
    // 打完就断的话新命令可能根本没执行, 至少停这么久.
    await sleep(holdMs);
    child.stdin.end();
    const exitCode = await closed;
    return { output: cutFromMarker(stdout, marker), raw: stdout, stderr, exitCode };
  } catch (cause) {
    child.kill();
    throw cause;
  }
}

// 从**最后一次**出现标记的那一行往后取. 回放里可能混着历史输出, 取最后一次最稳.
export function cutFromMarker(text, marker) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(marker)) start = i;
  }
  if (start === -1) {
    return text.trim();
  }
  // 标记那一行是远端 echo 出来的, 后面才是真正的结果.
  return lines.slice(start + 1).join("\n").trim();
}
