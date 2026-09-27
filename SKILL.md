---
name: gha-ssh-debug
description: 用 GitHub Actions 开 SSH 连 GitHub-hosted runner. 适用于要调试 CI, 在 runner 上复现构建, 或用 Upterm 拿交互 shell 时.
---

# GitHub Actions SSH 调试

参考实现: 本仓库 `.github/workflows/ssh-upterm.yml`.

默认仓库: `azazo1/gha-ssh-debug`. 换仓库时替换 `OWNER/REPO`.

## 何时用

- 用户要 SSH 进 GitHub-hosted job.
- 要在 runner 上跑另一份 CI / 构建, 又不想改对方仓库.

不要把这个当长期云电脑. 公开仓库无月限额, 但仍受单次 job 超时和 fair use 约束.

## 方法: Upterm detached + artifact

GitHub-hosted runner 没有入站端口, 不能直接开 sshd 等人连. 要用反向中继.

用 `owenthereal/action-upterm@v2`.

不要用 attached 模式. 进行中的 job 常常拿不到 step 日志 (`gh run view --log` 会说等完成; jobs logs API 可能 `BlobNotFound`). 连接命令必须在 job 还活着时做成 artifact.

workflow 要点:

- `workflow_dispatch`
- `detached: true`
- `limit-access-to-actor: true` (本机 SSH 私钥要对应触发者 GitHub 公钥)
- 把 `steps.upterm.outputs.ssh-command` 写进 `ssh.txt` 并 `upload-artifact`
- 用 `until [ -f continue ]; do sleep 5; done` 挂住 job
- `timeout-minutes` 按任务设. 本仓库现在是 30. GitHub-hosted 上限 6 小时.
- `runs-on` 必须和要复现的 CI 一致. `macos-15` 编不了依赖 macOS 26 SDK 的代码.

连这个临时 CI 的 Upterm SSH 是特例: 在沙箱内执行, 不提权. 不要套用 AGENTS 里 "ssh 必须提权" 的一般规则.

## 操作流程

把 `OWNER/REPO` 换成目标仓库.

每条命令写成单条 argv: 不用 `|` / `&&` / `||` / `;` / 重定向 / 后台 / 子 shell. JSON 直接看命令输出, 不要再重定向. 二进制落盘用该命令自己的目录参数 (例如 `gh run download -D`), 不要 `>`, 也不要给 `gh api` 加不存在的 `--output`. 轮询拆成多次工具调用, 不要 `for; sleep; done` 包成一条. 这是为了能被会话里的 allow prefix 直接吃掉; 吃不到就正常提权, 不要为了蹭 prefix 改命令.

### 1. 触发

```shell
gh api --method POST repos/OWNER/REPO/actions/workflows/ssh-upterm.yml/dispatches -f ref=main
```

或:

```shell
gh workflow run ssh-upterm.yml --repo OWNER/REPO
```

### 2. 认领 run

不要只拿 "最新一条" 当唯一依据, 并发时会拿错. 对照 `created_at` / `head_sha` / `event`.

```shell
gh api "repos/OWNER/REPO/actions/workflows/ssh-upterm.yml/runs?per_page=5"
```

记下 `id`.

### 3. 等到 artifact

多次独立调用, 不要塞进一条长循环里死等.

```shell
gh api repos/OWNER/REPO/actions/runs/<id> --jq "{status,conclusion}"
gh api repos/OWNER/REPO/actions/runs/<id>/jobs --jq ".jobs[].steps[]|{name,status,conclusion}"
gh api repos/OWNER/REPO/actions/runs/<id>/artifacts
```

`Wait for continue marker` 为 `in_progress` 且 artifacts 里出现 `upterm-connection` 就可以下.

### 4. 下载连接命令

```shell
gh run download <run_id> -n upterm-connection -D .tmp/upterm --repo OWNER/REPO
```

只指定一个 `-n` 时, 文件直接进 `-D`, 不会再套一层 artifact 名. 连接命令在 `.tmp/upterm/ssh.txt`.

### 5. SSH

沙箱内执行, 不提权. known_hosts 放到工作区 `.tmp`, 不要写用户 `~/.ssh`.

```shell
ssh -tt \
  -o StrictHostKeyChecking=accept-new \
  -o UserKnownHostsFile=.tmp/upterm-known-hosts \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  USER@uptermd.upterm.dev
```

Upterm 是共享 PTY, 不是普通 sshd:

- 不要指望 `ssh host 'remote command'` 稳定执行.
- 用管道往已有 shell 打命令.
- 命令前打一个不会碰撞的标记, 例如 `echo MARKER_<ts>`.
- 连上会先回放整段终端缓冲, 打完命令后 `sleep 10` 以上再关管道, 否则新命令根本没执行.
- 关 SSH 客户端 / 管道结束 = 断开, 会话还在.
- **禁止** 在远程打 `exit` 或 `Ctrl-D`: 会结束 Upterm 会话, job 可能还在空等 `continue`.
- 远程 bash 可能开着 history expansion. 不要发送 `$!`, 改用 `echo STARTED` + `ps`.
- 长任务: 把脚本 base64 打过去, `nohup bash /tmp/job.sh > /tmp/job.log 2>&1 &` 然后 `disown`. 日志写文件, 不要刷共享终端.
- 查进度: 再连, 打标记, `tail` 日志文件, 在本地输出里从最后一个标记截取.

收工:

```shell
touch "$GITHUB_WORKSPACE/continue"
```

本仓库 workspace 一般是 `/Users/runner/work/gha-ssh-debug/gha-ssh-debug`. 不要 `exit`.

### 6. 取消

```shell
gh api --method POST repos/OWNER/REPO/actions/runs/<id>/cancel
```

## 在 runner 上复现别人的 CI

不改对方仓库, 也不改本仓库文件时:

1. 开 SSH.
2. clone 到 `/Users/runner/<project>`, 不要动 gha-ssh-debug 工作区 (除了最后的 `continue`).
3. 按对方 workflow **原样** 跑命令. `fetch-depth: 0` 的就全量 clone (版本号脚本可能 `git rev-list --count`).
4. `runs-on` 对不上就不要硬跑: 官方 `macos-26` 的 Flutter/macOS 构建在 `macos-15` 上会因为 SDK API (例如 `NWPath.isUltraConstrained`) 直接 `BUILD FAILED`.
5. 官方 CI 自己改工作副本 (patch, 写 `pili_release.json`) 可以; 不要 commit / push 回去.
6. 产物想带回来: scp 或重新上传 artifact. 本仓库 Upterm workflow 默认只传 `ssh.txt`.

## 踩坑

- **拿不到连接命令**: attached 模式; 或等 `gh run view --log`. 必须 detached + artifact.
- **`gh run watch`**: 在 agent 无 TTY 后台会空转, 成功了也不退出. 人类终端才用. 轮询用多次 `gh api` / `gh run view --json`.
- **命令形态被拼坏**: `gh api foo > file`, `gh api foo | jq`, `for i in; do gh api; done` 都不再是单条 argv, allow prefix 吃不到, 每次都要审批. 拆调用. `gh api` 没有 `--output`, 二进制用 `gh run download -D`.
- **误杀会话**: 管道末尾 `exit`, 或 `Ctrl-D`. 表现为随后 `Permission denied (publickey)`, 同时 job 还在 `Wait for continue marker`.
- **history expansion**: `echo STARTED $!` 变成 `bash: !: event not found`, 后台脚本根本没起来.
- **heredoc 在共享 PTY 里乱**: 回放 + 折行会把脚本写坏. 用 base64 单行传输.
- **回放缓冲淹没轮询**: 每次 SSH 先倒整屏历史, `rfind("MARKER_")` 会命中旧标记. 用带时间戳的完整标记, 从 **本次** 标记往后截.
- **macos 版本**: runner 镜像 != 目标 CI 的 `runs-on`, 编译期就会挂, 不是缺依赖那么简单.
- **30 分钟不够**: Flutter macOS release 含 xcodebuild, 很容易顶满. 需要更长就改 `timeout-minutes`, 那是改文件.
- **月限额**: 公开仓库不扣分钟. 私有才有 (Free 约 2000 分钟/月, macOS 10 倍). 真正绑死的是 `timeout-minutes`.
- **密钥**: `limit-access-to-actor: true` 时, 本机默认 key 必须已登记在触发者 GitHub 账号.

## 不要做

- 不要为了 SSH 去改目标项目的 workflow (除非用户明确允许).
- 不要把这条特例扩到别的 ssh/scp. 只有连这个临时 CI 的 Upterm 可以沙箱内不提权.
- 不要 `gh run watch` 当后台等待.
- 不要安装用户级软件; runner 上为了跑 CI 装项目依赖可以.
- 不要读对方仓库的密钥 / `*password*` / 未授权配置. CI 自己生成的 `pili_release.json` 这种版本文件除外, 仍尽量少读内容.

## 人类侧 justfile

`justfile` 面向人在自己终端用 (`just run`, `just ssh`). agent 不要用 `just watch`, 它会卡住 `gh run watch`.
