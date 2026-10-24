// cancel: 取消 run; 不给 run-id 就取消该分支上调试 workflow 的那条.

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { info } from "./lib/log.mjs";
import { resolveRun } from "./lib/gh.mjs";
import { runCmd } from "./lib/run.mjs";

runMain(() => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const { id: runId, run } = resolveRun(ctx, rest[0] || "");
  if (run) info(`目标是 ${run.path} 的 run ${runId} (${run.event})`);
  runCmd("gh", ["api", "--method", "POST", `repos/${ctx.repo}/actions/runs/${runId}/cancel`]);
  info(`已请求取消 run ${runId}`);
  return 0;
});
