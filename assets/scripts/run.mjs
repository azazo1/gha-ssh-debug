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
import { remoteFileSize, resolveScpResult, runScp, scpArgs } from "./lib/transfer.mjs";

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
  const upload = runScp([...scpArgs(session), scriptPath, `${session.user}@${session.host}:${job.script}`]);
  if (!upload.ok) {
    // 这里不能像 push 那样"核验不出来也放过": 脚本没到手后面一定跑不起来, 得当场说清.
    const remoteSize = await remoteFileSize(session, job.script);
    resolveScpResult(upload, {
      remote: remoteSize === null ? null : { count: 1, bytes: remoteSize },
      local: { count: 1, bytes: localSize },
      describe: () => `本地脚本 ${localSize} 字节, runner 上 ${job.script} ${remoteSize === null ? "读不到大小" : `${remoteSize} 字节`}`,
      onInconclusive: "fail",
    });
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
