---
name: gha-ssh-debug
description: 在正在工作的仓库里借一个 GitHub-hosted runner 开 Upterm SSH 会话, 用于调试 CI, 在 runner 上复现构建, 或要一个和目标 CI 一致的交互 shell. 需要能向该仓库推分支.
---

# GitHub Actions SSH 调试

## 思路

GitHub-hosted runner 没有入站端口, 从外面连不进去. 唯一的办法是让 workflow 自己起一条反向中继 (Upterm), 本机再 ssh 连中继.

做法是把 `assets/ssh-debug-upterm.yml` 复制到**正在工作的那个 repo** 的临时分支上 push, push 事件把 job 拉起来; 连进去时 runner 的工作目录就是这个 repo 在该分支上的检出, 目标代码已经就位, 不用再 clone 一遍.

两条实测出来的约束决定了模板长成现在这样:

- `workflow_dispatch` 只对"文件已存在于默认分支"的 workflow 生效. 只在临时分支上放文件再 dispatch, 会拿到 `404 workflow xxx not found on the default branch`. 所以首次必须靠 push 触发.
- 同一个路径的 workflow 成功跑过一次之后就被注册了, 之后可以 dispatch 再开会话, 不用重复 push.

动作都收在 `assets/justfile` 里, 于是 agent 只有一种命令形态要执行: `just ...`. 这样既能被 allow prefix 自动放行 (适合在夜间模式里无人值守跑), 也省得每次手拼一长串 gh/git 命令.

## 前置条件

- 目标 repo 你有 push 权限, `gh` 已登录该账号.
- 本机 SSH 私钥已登记在触发者 GitHub 账号上: 模板里 `limit-access-to-actor: true` 只放触发者本人的公钥进来, 否则连上会被 `Permission denied (publickey)` 挡住.
- 目标 repo 没关 Actions, 要复现的 job 跑在 GitHub-hosted runner 上.
- 对没有 push 权限的第三方仓库用不了 (流程要在对方仓库推临时分支), 那种情况只能先 fork 到自己账号再走同样流程.
- 私有仓库扣分钟数 (macOS runner 10 倍), 公开仓库不扣. 硬上限是 `timeout-minutes` 和单 job 6 小时.

## 临时分支名由你自己定

分支名不要用固定值: 不同 harness 都会用这个 skill, 名字撞了会互相踩. 形如 `<你的 harness 名>/ssh-debug`, 例如 `dsh/ssh-debug`, `claude/ssh-debug`. 下文用 `<branch>` 指它, 通过 `branch=` 传给 recipe (也可以用环境变量 `SSH_DEBUG_BRANCH` 传).

worktree 与临时目录都跟着这个名字走 (`.tmp/ssh-debug-<branch 去掉斜杠>/`), 所以两个 harness 同时调试同一个 repo 也不会撞路径.

## 开工前: 提醒 user 配 allow prefix

这些 recipe 要写目标 repo 的 `.git` 并读 gh 凭据, 所以调用时要提权. 为了让它在夜间模式里不弹窗, 动手前提醒 user 在 dsh-approve-prefix 里放行这条前缀:

```
just -f <本 skill 目录>/assets/justfile
```

- `<本 skill 目录>` 用**你实际调用时的绝对路径字面量**: 自己解析出来, 提醒 user 时用同一个字面量, 否则前缀匹配不上. 所以你自己调用时也一律用绝对路径 (`-f` 后面不要写相对路径).
- 命令必须**整条就只是那一条 `just ...`**: 不要在前面加 `cd`, 不要在后面接 `;` 或 `echo` 之类第二件事, 也不要夹管道和重定向. 要指定目录就用工具自己的工作目录参数.
- 之所以不建议用宽前缀 `just`: 那样任何以 `just` 开头的命令都会自动放行, 等于把提权执行任意命令的授权交出去.
- 前缀没配也不影响功能, 只是每次调用都要 user 点一次审批. 不要为了绕开审批去改命令形态.

## 操作流程

下文 `<skill>` 指本 skill 目录的绝对路径.

### 0. 体检

```shell
just -f <skill>/assets/justfile -d <目标 repo 主工作树> check
```

它打印: 目标仓库 (从 origin 推导), `.tmp/` 有没有被 gitignore, 目标 CI 里出现过的 `runs-on` 候选, 本地 worktree, 远端残留的调试分支, 默认分支上有没有同名 workflow, 以及建议放行的那条前缀. 按它的输出定 `runs-on` 和 `timeout-minutes`.

如果目标 repo 里有 "任意分支 push 都会跑" 的 workflow (即 `on: push` 且没写 `branches` 过滤), 推临时分支会连带把它们唤醒, 先跟 user 说一声.

### 1. 铺模板并触发

```shell
just -f <skill>/assets/justfile -d <目标 repo 主工作树> branch=<branch> prep <runner-label> [ref] [timeout-minutes]
```

它开临时 worktree (默认从 `HEAD`), 按参数生成 workflow, 提交并推送临时分支. 主工作树与默认分支全程不动. 幂等: 想换 runner 就再跑一次, 那是重新生成再推一次 (旧 run 记得取消).

### 2. 等 artifact

```shell
just -f <skill>/assets/justfile -d <目标 repo> branch=<branch> status
just -f <skill>/assets/justfile -d <目标 repo> branch=<branch> status <run-id>
```

第二条打印该 run 的状态, 各步骤结论与 artifact 列表. `Wait for continue marker` 变成 `in_progress` (说明前面步骤都过了) 并且出现 `upterm-connection-*`, 就可以连了. 进行中的 job 读不到 step 日志, 别去 `gh run view --log`.

### 3. 取连接命令

```shell
just -f <skill>/assets/justfile -d <目标 repo> branch=<branch> connection
```

下载到 `.tmp/ssh-debug-<slug>/upterm/ssh.txt` 并打印, 内容是 `ssh <user>@uptermd.upterm.dev`.

### 4. SSH 连进去 (agent)

这一步**在沙箱内执行, 不提权**, 所以命令形态不受 allow prefix 限制, 管道随便用. 连临时 CI 的 Upterm 是本 skill 的特例, 不要套用 AGENTS 里 "ssh 必须提权" 的一般规则.

```shell
{ printf 'echo MARKER_<ts>\n'; printf '<命令>\n'; sleep 12; } | ssh -tt \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile=<你能写的目录>/.tmp/ssh-debug-known-hosts \
  -o BatchMode=yes \
  -o ConnectTimeout=10 <user@host>
```

known_hosts 放在你自己能写的目录 (例如会话工作区的 `.tmp/`), 不要写 `~/.ssh`, 也不要想写目标 repo 的 `.tmp/` (沙箱不允许).

### 5. 在会话里干活

Upterm 是共享 PTY, 不是普通 sshd:

- 不要指望 `ssh host 'remote command'` 稳定执行, 用管道把命令打进已经开着的 shell.
- 连上会先回放整段终端缓冲. 命令前打一个带时间戳的标记 (`echo MARKER_<ts>`), 在本地输出里从**本次**标记往后截取.
- 打完命令别马上关管道, 停 10 秒以上再关, 否则新命令可能根本没执行.
- 关掉本地 ssh 客户端 != 关会话, 会话还在, 随时可以重连.
- **工作途中不要 `exit` / `Ctrl-D`**: 会话一结束就彻底没了, 只能重新开一次 run 从头来. 断开客户端是安全的, 结束会话不是.
- 远程 bash 可能开着 history expansion, 不要发 `$!`.
- 长任务: 脚本 base64 成单行打过去, `nohup bash /tmp/job.sh > /tmp/job.log 2>&1 &` 再加 `disown`, 日志写文件不要刷共享终端. 查进度就重连, 打标记, `tail` 日志文件, 在本地输出里从本次标记往后截取.

### 6. 收工

```shell
just -f <skill>/assets/justfile -d <目标 repo> branch=<branch> done
just -f <skill>/assets/justfile -d <目标 repo> branch=<branch> clean
```

顺序不能反, 原因在两条机制上:

- `done` 先在 runner 上 `touch "$GITHUB_WORKSPACE/.ssh-debug-continue"`, 让 `Wait for continue marker` 那一步过去, 再 `exit` 结束会话. **放标记不会结束会话**, 真正结束 job 的是会话结束触发的 post 步骤; 只放标记不 exit, job 会一直挂到 `timeout-minutes`.
- `clean` 先移除 worktree, 本地分支才删得掉 (worktree 里可能有未跟踪的东西, 所以带 `--force`), 顺带取消这批 run 里还没结束的, 并把 `.tmp/ssh-debug-<slug>/` 整块删掉.

卡住的 run 单独取消:

```shell
just -f <skill>/assets/justfile -d <目标 repo> branch=<branch> cancel [run-id]
```

不给 run-id 就取消该分支最近一条. 被取消时 action 的 post 步骤会被跳过, job 立刻收尾 (实测变成 `completed / cancelled`).

`clean` 不动 Actions 历史: run 记录会留着, artifact 90 天后自动过期. 想连 artifact 一起删:

```shell
gh api --method DELETE repos/OWNER/REPO/actions/artifacts/<artifact-id>
```

## recipe 一览

| recipe | 作用 |
| --- | --- |
| `check` | 只读体检: 目标仓库, `.tmp/` 忽略状态, 目标 CI 的 `runs-on` 候选, 残留物, 建议的 allow prefix |
| `prep <runner> [ref] [timeout-minutes]` | 开临时 worktree, 生成 workflow (替换 `runs-on` 与 `timeout-minutes`), 提交并推送 |
| `status [run-id]` | 不带 id 列该分支最近的 run; 带 id 打印状态, 步骤结论与 artifact |
| `connection [run-id]` | 下载 `upterm-connection-*` artifact 到临时目录并打印连接命令 |
| `done` | 收工: 放标记并退出会话, 让 run 收尾成 `success` |
| `cancel [run-id]` | 取消 run |
| `clean` | 取消残留 run, 删远程分支, 移除 worktree, 删本地分支与临时目录 |
| `ssh` | 交互式连进去, 人类终端用 (agent 走沙箱内的 ssh 管道) |

调用形态统一是 `just -f <skill>/assets/justfile -d <目标 repo 主工作树> branch=<branch> <recipe> [参数]`.

## 踩坑

- **dispatch 报 404 `not found on the default branch`**: 只在临时分支上放了文件. 首次必须 push.
- **dispatch 报 422 `Workflow does not have 'workflow_dispatch' trigger`**: 这份文件没声明 dispatch 触发器; 模板里声明了, 别删掉.
- **run 一直不结束**: 只放了标记没结束会话, post 步骤在等它. 用 `cancel` 收掉.
- **会话突然没了**: 多半是在远程打了 `exit` 或 `Ctrl-D`. 只能重新开一个 run.
- **拿不到连接命令**: 走 artifact; 在 job 进行中读 step 日志只会得到 `BlobNotFound`.
- **输出被回放淹没**: 用带时间戳的完整标记, 从本次标记往后截, 不要拿上一次的标记位置.
- **heredoc 在共享 PTY 里被弄坏**: 回放和折行会破坏脚本, 用 base64 单行传输.
- **推临时分支连带唤醒目标 repo 的 CI**: 目标 repo 里有不过滤分支的 `on: push` workflow 就会这样.
- **`prep` 报 `.tmp/` 未被忽略**: worktree 会污染主工作树的 `git status`. 先往目标 repo 的 `.gitignore` 补一条 `.tmp/` (这个改动要 user 点头).
- **`prep` 报 `-d` 指到了 worktree**: recipe 要的是主工作树根目录 (`-d` 的值等于 `git rev-parse --show-toplevel`, 且该目录下 `.git` 是目录而不是文件).
- **前缀匹配不上**: 提醒 user 时用的路径字面量必须和你调用 `-f` 时用的完全一致, 所以自己一律用绝对路径. 路径里有空格也会让匹配变复杂, 尽量别放这种目录.
- **`gh` 并非全都免提权**: 公开仓库的 REST 读 (`gh run list`, `gh api repos/...`) 在沙箱内未认证也能跑, 但 artifact 下载 (`gh run download`) 与 GraphQL (`gh repo view`) 必须认证. 所以 recipe 一律按提权执行, 不要自作主张降级到沙箱.
- **别用命令行覆盖派生变量**: `root` / `wt` / `conn` / `workflow_path` / `template` 都是按 `branch` 推导出来的, 而 just 允许覆盖任何顶层变量; 一旦覆盖, `clean` 里的 `rm -rf` 就可能落到别处. `guard` 会重新推导一遍并拒绝不一致的调用 (exit 6), 看到这个错不要绕, 要换路径就改 justfile.
- **命令形态被拼坏**: `gh api foo > file`, `gh api foo | jq`, `for i in; do gh api; done` 都不是单条 argv, 会话里的 allow prefix 吃不到, 每次都要审批. 需要提权的动作走 recipe, 不要临时拼长命令.
- **标记文件撞名**: 目标 repo 里正好有 `.ssh-debug-continue` 的话, job 起来就会直接收工; 遇到就换名字并同步改 workflow 里那行.
- **月限额**: 只有私有仓库扣分钟 (Free 约 2000 分钟/月, macOS 10 倍), 公开仓库不扣.

## 不要做

- 不要把调试文件提交到目标 repo 的默认分支.
- 不要动目标 repo 自己的 CI (除非 user 明确允许), 也不要 commit / push 与调试无关的改动.
- 不要用固定分支名, 也不要在同一 repo 里同时留两份调试 worktree.
- 不要把这条 ssh 特例扩到别的 ssh / scp.
- 不要 `gh run watch` 当后台等待.
- 不要安装用户级软件; runner 上为了跑 CI 装项目依赖可以.
- 不要读目标 repo 的密钥 / `*password*` / 未授权配置.
- 收工后不要留下临时分支, worktree, 或者还在空转的 run.
