// ssh: 交互式连进 runner. 人类终端用; agent 用 exec, 不走这条.

import { runMain } from "./lib/cli.mjs";
import { buildContext, parseArgs } from "./lib/context.mjs";
import { ensureConnection, sshArgsFor } from "./lib/session.mjs";
import { runInherit } from "./lib/run.mjs";

runMain(() => {
  const { options, rest } = parseArgs(process.argv.slice(2));
  const ctx = buildContext(options);
  const session = ensureConnection(ctx, rest[0]);
  runInherit("ssh", sshArgsFor(session));
  return 0;
});
