// exec: 往已经开着的会话里喂一段脚本, 取回这段的输出.
//
// 这是 agent 在会话里干活的标准路径. Upterm 是共享 PTY, 不能 `ssh host '命令'`, 只能
// 把命令打进那个 shell; 打标记和截输出都在脚本里做, 于是调用方发出去的命令始终是一条
// 干净的 argv, 不会被管道或重定向弄掉 allow prefix.

import { readFileSync } from "node:fs";

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { fail, info } from "./lib/log.mjs";
import { ensureConnection, sshArgsFor } from "./lib/session.mjs";
import { runSessionScript } from "./lib/session-run.mjs";

runMain(async () => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const [scriptPath, runId] = rest;

  if (!scriptPath) {
    fail(1, "缺脚本路径: exec <本地脚本文件> [run-id]. 脚本内容会逐行喂给会话里的 shell.");
  }

  let script;
  try {
    script = readFileSync(scriptPath, "utf8");
  } catch (cause) {
    fail(1, `读不到脚本 ${scriptPath}: ${cause.message}`);
  }
  if (script.trim() === "") {
    fail(1, `脚本 ${scriptPath} 是空的.`);
  }

  const session = ensureConnection(ctx, runId);
  const args = sshArgsFor(session, { batch: true });
  const result = await runSessionScript(args, script, {
    holdMs: options.holdMs ? Number(options.holdMs) : undefined,
  });

  const output = result.output;
  if (output) {
    info(output);
  } else {
    info("(这一段没有输出)");
  }
  // 远端 shell 的退出码拿不到, 只能报 ssh 自己的; 非零说明连接层就出问题了.
  if (result.exitCode !== 0 && result.stderr.trim()) {
    fail(1, `ssh 退出码 ${result.exitCode}:\n${result.stderr.trim()}`);
  }
  return 0;
});
