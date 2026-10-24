// status: 不带 run-id 列该分支的 run (标出哪条是调试 workflow); 带 run-id 打印状态, 步骤结论与 artifact.

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { info } from "./lib/log.mjs";
import { listBranchRuns } from "./lib/gh.mjs";
import { runCmd } from "./lib/run.mjs";

// workflow 路径太长, 只取文件名; 哪条是调试 run 由前面的标记说.
function baseName(filePath) {
  return String(filePath || "").split("/").pop();
}

runMain(() => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const runId = rest[0] || "";

  if (!runId) {
    const listed = listBranchRuns(ctx.repo, ctx.branch, 5);
    if (!listed.ok) {
      info(`查询分支 ${ctx.branch} 上的 run 失败: ${listed.detail || "gh api 调用失败"}`);
      return 1;
    }
    if (listed.runs.length === 0) {
      info(`分支 ${ctx.branch} 上还没有 run, 先 prep.`);
      return 0;
    }
    for (const run of listed.runs) {
      const tag = run.path === ctx.workflowPath ? "调试" : "其他";
      info(`${run.id} [${tag}] ${baseName(run.path)} ${run.event} ${run.status}/${run.conclusion ?? "-"} ${(run.headSha || "").slice(0, 7)} ${run.createdAt}`);
    }
    return 0;
  }

  info(runCmd("gh", ["run", "view", runId, "--repo", ctx.repo, "--json", "status,conclusion,attempt,url"]).stdout.trimEnd());
  info(
    runCmd("gh", [
      "api",
      `repos/${ctx.repo}/actions/runs/${runId}/jobs`,
      "--jq",
      '.jobs[] | .name, (.steps[] | "  \\(.number) \\(.name) \\(.status) \\(.conclusion // "-")")',
    ]).stdout.trimEnd(),
  );
  info(
    runCmd("gh", [
      "api",
      `repos/${ctx.repo}/actions/runs/${runId}/artifacts`,
      "--jq",
      '.artifacts[] | "artifact: \\(.name), \\(.size_in_bytes) bytes"',
    ]).stdout.trimEnd(),
  );
  return 0;
});
