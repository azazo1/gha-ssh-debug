// status: 不带 run-id 列该分支最近的 run; 带 run-id 打印状态, 步骤结论与 artifact.

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { info } from "./lib/log.mjs";
import { runCmd } from "./lib/run.mjs";

runMain(() => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const runId = rest[0] || "";

  if (!runId) {
    const out = runCmd("gh", [
      "run",
      "list",
      "--repo",
      ctx.repo,
      "--branch",
      ctx.branch,
      "--limit",
      "5",
      "--json",
      "databaseId,event,headSha,status,conclusion,createdAt",
      "--jq",
      '.[] | "\\(.databaseId) \\(.event) \\(.status)/\\(.conclusion // "-") \\(.headSha[0:7]) \\(.createdAt)"',
    ]);
    info(out.stdout.trimEnd());
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
