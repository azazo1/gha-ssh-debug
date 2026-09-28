// 执行外部命令的小封装. 只做同步执行, 因为每个 recipe 都是一条线性流程.
//
// runCmd 成功返回 { stdout, stderr }, 失败抛 CliError (带该命令的退出码).
// tryRun 允许失败, 由调用方看 ok 自行判断.

import { spawn, spawnSync } from "node:child_process";

import { CliError, fail } from "./log.mjs";

function describeFailure(command, args, result) {
  const detail = (result.stderr || result.stdout || "").trim();
  const code = result.status === null ? `被信号 ${result.signal} 终止` : `退出码 ${result.status}`;
  return `命令失败 (${code}): ${[command, ...args].join(" ")}${detail ? `\n${detail}` : ""}`;
}

export function runCmd(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    cwd: options.cwd,
    input: options.input,
  });
  if (result.error) {
    fail(127, `无法执行 ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new CliError(result.status ?? 1, describeFailure(command, args, result));
  }
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// 允许失败: 返回 { ok, status, stdout, stderr }.
export function tryRun(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    cwd: options.cwd,
    input: options.input,
  });
  if (result.error) {
    return { ok: false, status: 127, stdout: "", stderr: result.error.message };
  }
  return {
    ok: result.status === 0,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

// 直接接管终端 (scp -r 这种需要透传输出的), 失败即抛.
export function runInherit(command, args = []) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    fail(127, `无法执行 ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new CliError(result.status ?? 1, `命令失败 (退出码 ${result.status}): ${[command, ...args].join(" ")}`);
  }
}

// 需要边跑边往 stdin 喂东西的场合 (done 要连打两行再退出).
// 返回 { stdin, done }: done 在子进程结束时 resolve, 非零退出码抛 CliError.
export function runInheritAsync(command, args = []) {
  const child = spawn(command, args, { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((resolve, reject) => {
    child.on("error", (cause) => reject(new CliError(127, `无法执行 ${command}: ${cause.message}`)));
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new CliError(code ?? 1, `命令失败 (退出码 ${code}): ${[command, ...args].join(" ")}`));
      }
    });
  });
  return { stdin: child.stdin, done };
}
