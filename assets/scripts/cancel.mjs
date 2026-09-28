// cancel: 取消 run; 不给 run-id 就取消该分支最近一次.

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { fail, info } from "./lib/log.mjs";
import { resolveRunId } from "./lib/gh.mjs";
import { runCmd } from "./lib/run.mjs";

runMain(() => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const explicit = rest[0] || "";
  const runId = explicit || resolveRunId(ctx.repo, ctx.branch, "");
  if (!runId) {
    fail(1, "请给 run-id, 或者传 branch=<harness>/ssh-debug 并在有 origin 的仓库里执行.");
  }
  runCmd("gh", ["api", "--method", "POST", `repos/${ctx.repo}/actions/runs/${runId}/cancel`]);
  info(`已请求取消 run ${runId}`);
  return 0;
});
