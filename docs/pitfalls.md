# 出错对照

## 触发与会话

- **dispatch 报 404 `not found on the default branch`**: 只在临时分支上放了文件. `workflow_dispatch` 只对"文件已存在于默认分支"的 workflow 生效, 所以首次必须靠 push 触发; 同一个路径成功跑过一次之后就被注册了, 之后才能 dispatch.
- **dispatch 报 422 `Workflow does not have 'workflow_dispatch' trigger`**: 这份文件没声明 dispatch 触发器; 模板里声明了, 别删掉.
- **拿不到连接命令**: 走 artifact. 在 job 进行中读 step 日志只会得到 `BlobNotFound`. `connection` 默认会等到 artifact 出现, 也可以调大等待秒数.
- **会话突然没了**: 多半是在远程打了 `exit` 或 `Ctrl-D`. 只能重新开一个 run.
- **run 一直不结束**: 只放了标记没结束会话, post 步骤在等它. 用 `cancel` 收掉.

## 前缀与命令形态

- **提醒 user 配的前缀匹配不上**: 前缀里的路径必须是**你实际调用 `-f` 时用的那串绝对路径字面量**. 自己一律用绝对路径, 路径里有空格会让匹配更复杂, 尽量别放这种目录.
- **建议不要用宽前缀 `just`**: 那样任何以 `just` 开头的命令都会自动放行, 等于把提权执行任意命令的授权交出去.
- **命令形态被拼坏**: `gh api foo > file`, `gh api foo | jq`, `for i in; do gh api; done`, 以及前面加 `cd` / `sleep` 都不是单条 argv, allow prefix 吃不到, 每次都要审批 (无人值守时直接卡住). 需要提权的动作走 recipe. 同理, **自己验证 recipe 时也不要为了看图方便加 `| head` / `2>&1`**.
- **`gh` 并非全都免提权**: 公开仓库的 REST 读 (`gh run list`, `gh api repos/...`) 未认证也能跑, 但 artifact 下载 (`gh run download`) 与 GraphQL (`gh repo view`) 必须认证. 所以 recipe 一律按提权执行.

## 目录与残留

- **`prep` 报 `.tmp/` 未被忽略**: worktree 会污染主工作树的 `git status`. 先往目标 repo 的 `.gitignore` 补一条 `.tmp/` (这个改动要 user 点头).
- **`-d` 指错了**: 要指**主工作树根目录**, 不是 `.tmp` 下的 worktree (`-d` 的值应等于 `git rev-parse --show-toplevel`, 且该目录下 `.git` 是目录而不是文件).
- **想从命令行改路径**: `root` / `wt` / `conn` 这些派生路径只由 `branch` 推导, 全在 `assets/scripts/lib/context.mjs` 里算出来, 命令行传不进去. 所以 `clean` 的删除目标不会被外部改到别处; 要换路径就改那个文件.
- **推临时分支连带唤醒目标 repo 的 CI**: 目标 repo 里有不过滤分支的 `on: push` workflow 就会这样, 动手前先跟 user 说一声.
- **`clean` 不动 Actions 历史**: run 记录会留着, artifact 90 天后自动过期. 想连 artifact 一起删:

  ```shell
  gh api --method DELETE repos/OWNER/REPO/actions/artifacts/<artifact-id>
  ```

## 文件传输

- **`pull` / `push` 报 exit 8**: 会话走的是 `ws://` / `wss://` 中继 (连接命令里带 `ProxyCommand`), 上游在这种 server 上不提供 SFTP. 换直连 `ssh://` 的 server, 或者改走 artifact.
- **`pull` / `push` 报 scp 退出码非零, 但脚本说核验通过**: 这是 upterm 的 SFTP 通道收尾时报的假失败, 文件是完整的, 按成功处理即可.
- **scp 报 publickey 被拒**: 通道用的还是触发者那把私钥, 和 ssh 会话同一套限制, 本机私钥得登记在触发者账号上.
- **会话结束后才想起来取产物**: SFTP 通道已经没了. 回到 artifact 那条路: 在模板里加一个 `actions/upload-artifact` 步骤, 收工后用 `gh run download` 拉下来 (`connection` 里就是这么下载 `ssh.txt` 的).

## 复现构建

- **产物和真实 CI 不一致**: 先看目标 CI 有没有依赖"干净工作区"的判断 (例如 `git status --porcelain` 决定版本号后缀). 调试脚手架本身不该往检出目录里写东西 —— 模板已经把连接信息和收工标记都放到 `/tmp` 了; 万一你另加了步骤写 workspace, 记得改掉.

## 其他

- **不要 `gh run watch` 当后台等待**: 它在没有 tty 的环境里不会收尾, run 早就 `completed` 了进程还在空转.
- **月限额**: 只有私有仓库扣分钟 (Free 约 2000 分钟/月, macOS runner 10 倍), 公开仓库不扣. 硬上限是 `timeout-minutes` 与单 job 6 小时.
- **不要安装用户级软件**: runner 上为了跑 CI 装项目依赖可以, 本机装 CLI/SDK 不行.
- **不要读目标 repo 的密钥** / `*password*` / 未授权配置.
