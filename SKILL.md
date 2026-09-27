---
name: gha-ssh-debug
description: 在当前正在工作的仓库里借一个 GitHub-hosted runner 开 Upterm SSH 会话, 用于调试 CI, 在 runner 上复现构建, 或要一个和目标 CI 一致的交互 shell. 需要能向该仓库推分支.
---

# GitHub Actions SSH 调试

## 思路

GitHub-hosted runner 没有入站端口, 从外面连不进去. 唯一的办法是让 workflow 自己起一条反向中继 (Upterm), 本机再 ssh 连中继.

workflow 模板在 `assets/ssh-debug-upterm.yml`. 用的时候把它复制到**正在工作的那个 repo** 的临时分支上 push, push 事件会把 job 拉起来; 连进去时 runner 的工作目录就是这个 repo 在该分支上的检出, 目标代码已经就位, 不用再 clone 一遍.

两条实测出来的约束决定了模板长成现在这样:

- `workflow_dispatch` 只对"文件已存在于默认分支"的 workflow 生效. 只在临时分支上放文件再 dispatch, 会拿到 `404 workflow xxx not found on the default branch`. 所以首次必须靠 push 触发.
- 同一个路径的 workflow 成功跑过一次之后就被注册了, 之后可以 `gh workflow run ... --ref <临时分支>` 直接再开会话, 不用重复 push.

## 前置条件

- 目标 repo 你有 push 权限, `gh` 已登录该账号.
- 本机 SSH 私钥已登记在触发者 GitHub 账号上: 模板里 `limit-access-to-actor: true` 只放触发者本人的公钥进来, 否则连上会被 `Permission denied (publickey)` 挡住.
- 目标 repo 没关 Actions, 要复现的 job 跑在 GitHub-hosted runner 上.
- 对没有 push 权限的第三方仓库用不了 (本流程要在对方仓库推临时分支), 那种情况只能先 fork 到自己账号再走同样流程.
- 私有仓库扣分钟数 (macOS runner 10 倍), 公开仓库不扣. 真正的硬上限是 `timeout-minutes` 和单 job 6 小时.

## 操作流程

下文用 `OWNER/REPO` 指目标仓库, `REF` 指要调试的分支或 tag 或 commit.

### 0. 先侦察

- 读目标 repo 的 `.github/workflows/*.yml`, 找到要复现的 job 的 `runs-on`, 模板必须用同一个 label. 顺手看 `fetch-depth`, `submodules`, 装依赖的步骤, 估个时间.
- 看目标 repo 有没有 "任意分支 push 都会跑" 的 workflow (即 `on: push` 且没写 `branches` 过滤). 有的话, 推临时分支会连带把它们唤醒, 先跟 user 说一声.
- 看有没有上次的残留: `dsh/ssh-debug` 分支, 或者默认分支上多出来的 `.github/workflows/ssh-debug-upterm.yml`.

### 1. 在目标 repo 里开一个 worktree

主工作树和默认分支全程不动, 本次改动只落在 worktree 里. 分支名沿用 `dsh/<name>` 这个约定.

```shell
git worktree add -b dsh/ssh-debug .tmp/ssh-debug <REF>
```

- 确认 `.tmp/` 被目标 repo 的 `.gitignore` 覆盖, 没有就补一条, 免得 `git status` 被 worktree 目录污染.
- 开工前记录主工作树的 HEAD 和脏状态, 汇报给 user.
- 万一 `dsh/ssh-debug` 已经存在 (上次没收干净), 先确认没有活着的 run 再删掉重建.

### 2. 铺模板, 按目标 CI 改参数

```shell
mkdir -p .tmp/ssh-debug/.github/workflows
cp <本 skill 目录>/assets/ssh-debug-upterm.yml .tmp/ssh-debug/.github/workflows/ssh-debug-upterm.yml
```

文件头部注释列了要改的位置: `runs-on` (必改), `timeout-minutes`, `fetch-depth`, 需要子模块时 `submodules`.

### 3. push 触发

```shell
git -C .tmp/ssh-debug add .github/workflows/ssh-debug-upterm.yml
git -C .tmp/ssh-debug commit -m "debug: add upterm ssh workflow"
git -C .tmp/ssh-debug push -u origin dsh/ssh-debug
```

push 完立刻就有 run. 同一条分支再 push 会再起一个会话, 别在旧会话还活着时重复 push.

### 4. 认领 run

并发时会拿错, 别只看"最新一条", 对照 `headSha`:

```shell
gh run list --repo OWNER/REPO --branch dsh/ssh-debug --limit 5 --json databaseId,event,headSha,status,createdAt
```

### 5. 等 artifact

```shell
gh api repos/OWNER/REPO/actions/runs/<id>/jobs --jq '.jobs[].steps[] | "\(.name) \(.status)"'
gh api repos/OWNER/REPO/actions/runs/<id>/artifacts
```

`Wait for continue marker` 变成 `in_progress` (说明前面步骤都过了) 并且 artifacts 里出现 `upterm-connection-1`, 就可以连. 进行中的 job 读不到 step 日志, 别去 `gh run view --log`. 轮询拆成多次独立调用, 不要 `for; sleep; done` 包成一条长循环.

### 6. 下载连接命令

```shell
gh run download <id> -n upterm-connection-1 -D .tmp/upterm --repo OWNER/REPO
```

后缀是 run attempt: 新开的 run 恒为 `1`, 重跑过 (rerun) 会变成 `2` (旧 attempt 的 artifact 会被替换掉). 拿不准就先看 `/artifacts` 里的实际名字. 只给一个 `-n` 时文件直接进 `-D`, 不会再套一层目录; 连接命令在 `.tmp/upterm/ssh.txt`.

### 7. SSH 连进去

```shell
ssh -tt -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=.tmp/ssh-debug-known-hosts -o BatchMode=yes -o ConnectTimeout=10 USER@uptermd.upterm.dev
```

- 这条 ssh **在沙箱内执行, 不提权**. 连临时 CI 的 Upterm 是本 skill 的特例, 不要套用 AGENTS 里 "ssh 必须提权" 的一般规则.
- known_hosts 放工作区 `.tmp`, 不要写 `~/.ssh`.
- `USER@uptermd.upterm.dev` 从 `ssh.txt` 里取.

### 8. 在会话里干活

Upterm 是共享 PTY, 不是普通 sshd:

- 不要指望 `ssh host 'remote command'` 稳定执行, 用管道把命令打进已经开着的 shell.
- 连上会先回放整段终端缓冲. 命令前打一个带时间戳的标记 (`echo MARKER_<ts>`), 在本地输出里从**本次**标记往后截取.
- 打完命令别马上关管道, 停 10 秒以上再关, 否则新命令可能根本没执行.
- 关掉本地 ssh 客户端 != 关会话, 会话还在, 随时可以重连.
- **工作途中不要 `exit` / `Ctrl-D`**: 会话一结束就彻底没了, 只能重新开一次 run 从头来. 断开客户端是安全的, 结束会话不是.
- 远程 bash 可能开着 history expansion, 不要发 `$!`.
- 长任务: 脚本 base64 成单行打过去, `nohup bash /tmp/job.sh > /tmp/job.log 2>&1 &` 再加 `disown`, 日志写文件不要刷共享终端. 查进度就重连, 打标记, `tail` 日志文件, 在本地输出里从本次标记往后截取.

### 9. 收工

顺序不能反:

1. 先把结果拿完 (日志 tail 出来, 产物 scp 回本机或者重新上传 artifact).
2. 在 runner 上放标记:

```shell
touch "$GITHUB_WORKSPACE/.ssh-debug-continue"
```

   这一步只是让 `Wait for continue marker` 那一步过去, **不会**结束会话. `GITHUB_WORKSPACE` 在会话里是可用的.

3. 在会话里 `exit` (或 `Ctrl-D`): 这一步才真正结束 upterm 会话, 会话一结束 post 步骤立刻收尾, run 变 `success`. 只放标记不 exit, job 会一直挂在 post 步骤上, 直到 `timeout-minutes` 用完.
4. run 卡着不动 (忘了 exit, 或者客户端掉了) 就直接取消:

```shell
gh run view <id> --repo OWNER/REPO --json status,conclusion
gh api --method POST repos/OWNER/REPO/actions/runs/<id>/cancel
```

   被取消时 action 的 post 步骤会被跳过, job 立刻收尾 (实测变成 `completed / cancelled`).

5. 清理现场:

```shell
git -C .tmp/ssh-debug push origin --delete dsh/ssh-debug
git worktree remove --force .tmp/ssh-debug
git branch -D dsh/ssh-debug
```

   后两条在主仓库根目录执行. 顺序有意义: 先移除 worktree, 本地分支才删得掉 (worktree 里可能有未跟踪的产物, 所以要 `--force`). 远程分支删掉之后, 这条分支上的调试记录也随之消失.

### 重复开会话

- 文件已经跑过一次之后: `gh workflow run ssh-debug-upterm.yml --ref dsh/ssh-debug --repo OWNER/REPO`, 不用再 push.
- 重跑同一次 run: `gh run rerun <id> --repo OWNER/REPO`, 只能对已经结束的 run 用.
- 想换参数 (换 runner, 加超时) 就改文件再 push, 那是新的一次 run; 先把旧的取消掉.

## 在 runner 上复现别的 CI

- workspace 就是目标 repo 在临时分支上的检出, 目标代码已经就位, 不需要再 clone 到别处, 也不要去动 git 历史.
- 按目标 CI 的步骤原样跑. `fetch-depth: 0` 已经给全量历史, 版本号脚本里那种 `git rev-list --count` 才跑得通.
- 只改工作副本 (打补丁, 生成版本文件) 可以; 不要 commit / push 回上游.
- 产物想带回来: scp, 或者往当前 run 再传一个 artifact.
- runner 版本对不上就别硬跑: 官方 `macos-26` 上的 Flutter/macOS 构建放到 `macos-15` 上会因为缺 SDK API 直接 BUILD FAILED, 那不是缺依赖那么简单.

## 人类终端用法

命令和 agent 侧一样, 差别只有两点:

- 看实时进度可以用 `gh run watch <id> --repo OWNER/REPO`; agent 不要用, 它没有 TTY 时会空转, 成功了也不退出.
- 连进去可以省一点:

```shell
ssh -tt \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile=.tmp/ssh-debug-known-hosts \
  -o ConnectTimeout=10 \
  "$(sed 's/^ssh //' .tmp/upterm/ssh.txt)"
```

收工一样: 在会话里 `touch "$GITHUB_WORKSPACE/.ssh-debug-continue"`, 然后 `exit`.

## 踩坑

- **dispatch 报 404 `not found on the default branch`**: 只在临时分支上放了文件. 首次必须 push.
- **dispatch 报 422 `Workflow does not have 'workflow_dispatch' trigger`**: 这份文件没声明 dispatch 触发器; 模板里声明了, 别删掉.
- **run 一直不结束**: 只放了标记没 `exit`, post 步骤在等会话结束. 取消它.
- **会话突然没了**: 多半是在远程打了 `exit` 或 `Ctrl-D`. 只能重新开一个 run.
- **拿不到连接命令**: 去 artifact 拿; 在 job 进行中读 step 日志只会得到 `BlobNotFound`.
- **输出被回放淹没**: 用带时间戳的完整标记, 从本次标记往后截, 不要拿上一次的标记位置.
- **heredoc 在共享 PTY 里被弄坏**: 回放和折行会破坏脚本, 用 base64 单行传输.
- **推临时分支连带唤醒目标 repo 的 CI**: 目标 repo 里有不过滤分支的 `on: push` workflow 就会这样.
- **命令形态被拼坏**: `gh api foo > file`, `gh api foo | jq`, `for i in; do gh api; done` 都不是单条 argv, 会话里的 allow prefix 吃不到, 每次都要审批. 拆成多次调用; `gh api` 没有 `--output`, 二进制用 `gh run download -D`.
- **标记文件撞名**: 目标 repo 里正好有 `.ssh-debug-continue` 的话, job 起来就会直接收工; 遇到就换名字并同步改 workflow 里那行.
- **月限额**: 只有私有仓库扣分钟 (Free 约 2000 分钟/月, macOS 10 倍), 公开仓库不扣.

## 不要做

- 不要把调试文件提交到目标 repo 的默认分支.
- 不要动目标 repo 自己的 CI (除非 user 明确允许), 也不要 commit / push 与调试无关的改动.
- 不要把这条 ssh 特例扩到别的 ssh / scp.
- 不要 `gh run watch` 当后台等待.
- 不要安装用户级软件; runner 上为了跑 CI 装项目依赖可以.
- 不要读目标 repo 的密钥 / `*password*` / 未授权配置.
- 收工后不要留下临时分支, worktree, 或者还在空转的 run.
