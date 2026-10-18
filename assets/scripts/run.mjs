// run: 把本地脚本推到 runner 上后台跑, 内建轮询, 结束时给出退出码与日志.
//
// 存在的理由: 以前这一步要 agent 手工拼 "上传脚本 + nohup + sleep + tail" 的循环, 而在
// shell 里加 `sleep 120 && just ...` 会让命令形态掉出 allow prefix, 加管道截日志同理.
// 轮询是等待而不是工作, 本来就该由脚本做掉.
//
// 脚本走 scp 上传 (不是打进共享 PTY), 于是长脚本不受 PTY 行长上限的影响.

import { existsSync, statSync } from "node:fs";

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { fail, info, warn } from "./lib/log.mjs";
import { ensureConnection, sshArgsFor } from "./lib/session.mjs";
import { queryRemote } from "./lib/session-run.mjs";
import { localSha256, remoteFileExists, remoteFileSize, remoteSha256, runScp, scpArgs } from "./lib/transfer.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 轮询一次: 报告日志当前长度与退出码, 并把新增的那一段日志带回来.
//
// 三个量分开报, 是因为"任务结束"要看退出码文件, 而"有没有新输出"要看日志长度.
function buildPollScript(token, job, offset) {
  return [
    `echo ${token}-SIZE $(wc -c < ${job.log} 2>/dev/null || echo 0)`,
    `echo ${token}-EXIT $(cat ${job.exit} 2>/dev/null || echo -)`,
    `echo ${token}-LOG`,
    `tail -c +${offset} ${job.log} 2>/dev/null || true`,
  ].join("\n");
}

// 从轮询输出里拆出 (日志长度, 退出码, 新增日志).
//
// 共享 PTY 会把输入的命令回显一遍, 所以每个标记都可能有两次, 取最后一次出现.
function parsePoll(output, token) {
  const lines = output.split(/\r?\n/);
  let size = null;
  let exitCode = null;
  let logStart = -1;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const sizeMatch = line.match(new RegExp(`^${token}-SIZE (\\d+)$`));
    if (sizeMatch) size = Number(sizeMatch[1]);
    const exitMatch = line.match(new RegExp(`^${token}-EXIT (\\d+|-)$`));
    if (exitMatch) exitCode = exitMatch[1] === "-" ? null : Number(exitMatch[1]);
    if (line === `${token}-LOG`) logStart = i;
  }

  return {
    size,
    exitCode,
    log: logStart === -1 ? "" : lines.slice(logStart + 1).join("\n"),
  };
}

runMain(async () => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const [scriptPath, runId, timeoutArg, intervalArg] = rest;

  if (!scriptPath) {
    fail(1, "缺脚本路径: run <本地脚本> [run-id] [timeout-seconds] [轮询间隔秒]");
  }
  if (!existsSync(scriptPath) || !statSync(scriptPath).isFile()) {
    fail(1, `本地脚本不存在: ${scriptPath}`);
  }
  const timeoutSeconds = Number(timeoutArg || options.timeout || 3600);
  const intervalSeconds = Number(intervalArg || options.interval || 15);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    fail(1, `timeout 要是正数秒: ${timeoutArg}`);
  }
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    fail(1, `轮询间隔要是正数秒: ${intervalArg}`);
  }

  const session = await ensureConnection(ctx, runId);
  const stamp = `${Date.now()}`;
  const job = {
    script: `/tmp/ssh-debug-run-${stamp}.sh`,
    wrapper: `/tmp/ssh-debug-run-${stamp}.wrapper.sh`,
    log: `/tmp/ssh-debug-run-${stamp}.log`,
    exit: `/tmp/ssh-debug-run-${stamp}.exit`,
  };
  const sshBatch = sshArgsFor(session, { batch: true });

  // 1. 传脚本. 走 scp 而不是 PTY, 免得长行被折行截断.
  info(`上传脚本 ${scriptPath} -> ${session.host}:${job.script}`);
  const localSize = statSync(scriptPath).size;
  const localHash = localSha256(scriptPath);
  const upload = runScp([...scpArgs(session), scriptPath, `${session.user}@${session.host}:${job.script}`]);
  if (!upload.ok) {
    // upterm 的 SFTP 通道经常在文件已完整落地后返回非零; 不能只看退出码.
    // 先用 sha256 判, 拿不到再比大小, 最差也确认文件是否存在且非空.
    const remoteHash = await remoteSha256(session, job.script);
    if (remoteHash !== null) {
      if (remoteHash !== localHash) {
        fail(
          1,
          `scp 报退出码 ${upload.status}, 且脚本 sha256 不一致: 本地 ${localHash}, runner 上 ${remoteHash}.\n` +
            `脚本可能被截断, 重试 run 或换 push + exec 手工上传.`,
        );
      }
      warn(`scp 报退出码 ${upload.status}, 但脚本 sha256 一致, 按上传成功继续.`);
    } else {
      const remoteSize = await remoteFileSize(session, job.script);
      if (remoteSize !== null) {
        if (remoteSize !== localSize) {
          fail(
            1,
            `scp 报退出码 ${upload.status}, 且脚本大小不一致: 本地 ${localSize} 字节, runner 上 ${remoteSize} 字节.\n` +
              `脚本可能被截断, 重试 run.`,
          );
        }
        warn(`scp 报退出码 ${upload.status}, 但脚本大小一致 (${localSize} 字节), 按上传成功继续.`);
      } else {
        const present = await remoteFileExists(session, job.script);
        if (present !== true) {
          fail(
            1,
            `scp 失败 (退出码 ${upload.status}) 且无法确认脚本已落地: ${upload.stderr || "没有 stderr"}\n` +
              `本地脚本 ${localSize} 字节. 可以重试 run, 或先用 exec 检查 ${job.script}.`,
          );
        }
        warn(`scp 报退出码 ${upload.status}, 大小核验不可用, 但脚本存在; 按上传成功继续.`);
      }
    }
  }

  // 2. 起后台任务. 退出码单独写文件, 这样才能跟日志分开判断.
  //    包一层 wrapper 而不是直接 nohup 用户脚本, 是为了在脚本跑完后把退出码留下来.
  //    内容只有三行, 用 base64 单行写过去 (heredoc 在共享 PTY 里靠不住).
  //
  //    setsid 只在 Linux 上有; macOS 没有这个命令 (它不是 POSIX 的一部分), runner 上直接
  //    报 setsid: command not found, 后台任务根本起不来. 所以有就用, 没有就靠 nohup + disown.
  const wrapperBody = ["#!/usr/bin/env bash", `bash ${job.script}`, `echo $? > ${job.exit}`].join("\n");
  const wrapperB64 = Buffer.from(wrapperBody, "utf8").toString("base64");
  const launchScript = [
    `echo ${wrapperB64} | base64 -d > ${job.wrapper}`,
    `chmod +x ${job.wrapper}`,
    "SETSID=''",
    "command -v setsid >/dev/null 2>&1 && SETSID=setsid",
    `$SETSID nohup bash ${job.wrapper} > ${job.log} 2>&1 < /dev/null &`,
    "disown 2>/dev/null || true",
    "echo LAUNCHED",
  ].join("\n");

  const launched = await queryRemote(sshBatch, launchScript, { holdMs: 5000 });
  if (!launched.includes("LAUNCHED")) {
    fail(1, `没能起后台任务, 远端回的是:\n${launched}`);
  }
  info(`已在 runner 上后台启动. 日志 ${job.log}, 每 ${intervalSeconds} 秒看一次, 上限 ${timeoutSeconds} 秒.`);

  // 3. 轮询. 每轮只取新增的日志, 不重复搬整份.
  const deadline = Date.now() + timeoutSeconds * 1000;
  let seenBytes = 0;
  let lastOutputAt = Date.now();
  let exitCode = null;

  while (Date.now() < deadline) {
    await sleep(intervalSeconds * 1000);
    const token = `TOK${Math.random().toString(36).slice(2, 10)}`;
    const output = await queryRemote(sshBatch, buildPollScript(token, job, seenBytes + 1));
    const parsed = parsePoll(output, token);

    if (parsed.log.trim()) {
      info(parsed.log.trimEnd());
      lastOutputAt = Date.now();
    }
    if (typeof parsed.size === "number" && parsed.size > seenBytes) {
      seenBytes = parsed.size;
    }
    if (parsed.exitCode !== null) {
      exitCode = parsed.exitCode;
      break;
    }
    if (Date.now() - lastOutputAt > 180000) {
      warn("已经 3 分钟没有新日志了, 任务可能卡住 (不中断, 继续等到超时).");
      lastOutputAt = Date.now();
    }
  }

  if (exitCode === null) {
    fail(1, `等满 ${timeoutSeconds} 秒还没结束. 会话还活着, 任务可能仍在跑: 可以再 run 一次, 或手工连上去看 ${job.log}.`);
  }

  // 远端退出码原样带出来, 让调用方拿它当构建结果; 0 才是成功.
  info(`任务结束, 退出码 ${exitCode}. 完整日志: runner 上的 ${job.log}`);
  return exitCode;
});
