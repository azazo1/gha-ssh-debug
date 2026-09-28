// 统一的输出出口. 命令脚本一律走这里, 不要散落 console.log.
//
// 约定: info 写 stdout (给 user 和 agent 看的进度与结果), warn/error 写 stderr.

// 下游提前关掉管道 (`... | head`) 时 write 会抛 EPIPE, 那是正常收尾而不是错误,
// 不处理的话会漏一坨栈追踪出来. 这里记下状态, 顶层据此安静退出.
let brokenPipe = false;

export function pipeBroken() {
  return brokenPipe;
}

function write(stream, message) {
  if (brokenPipe) return;
  try {
    stream.write(`${message}\n`);
  } catch (cause) {
    if (cause && cause.code === "EPIPE") {
      brokenPipe = true;
      return;
    }
    throw cause;
  }
}

// stdout 被关闭时 node 会在 stream 上发 error 事件, 不吞掉就是未捕获异常.
process.stdout.on("error", (cause) => {
  if (cause && cause.code === "EPIPE") {
    brokenPipe = true;
    return;
  }
  throw cause;
});
process.stderr.on("error", () => {});

export function info(message) {
  write(process.stdout, message);
}

export function warn(message) {
  write(process.stderr, message);
}

export function error(message) {
  write(process.stderr, message);
}

// 带退出码的失败: 交给顶层统一处理, 不要在各处直接 process.exit.
export class CliError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CliError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new CliError(code, message);
}
