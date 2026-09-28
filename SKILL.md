---
name: gha-ssh-debug
description: 在正在工作的仓库里借一个 GitHub-hosted runner 开 Upterm SSH 会话, 用于调试 CI, 在 runner 上复现构建, 把 runner 上的构建产物 scp 拉回本地, 或要一个和目标 CI 一致的交互 shell. 需要能向该仓库推分支.
---

# GitHub Actions SSH 调试

在**正在工作的那个仓库**里借一个 GitHub-hosted runner: 推一个临时分支把 workflow 拉起来, 它会起一条 Upterm 反向中继, 本机 ssh 连进中继就落到 runner 上, 工作目录就是该分支的检出.

动作全收在 `assets/justfile` 里, agent 只有一种命令形态: `just ...`.

## 最短路径

前置: 目标 repo 你有 push 权限, `gh` 已登录, 本机有 `just` 与 `node`.

下文 `<skill>` 指本 skill 目录的绝对路径, `<branch>` 指你自定的临时分支名 (形如 `<你的 harness 名>/ssh-debug`).

```shell
just -f <skill>/assets/justfile -d <目标 repo> check
just -f <skill>/assets/justfile -d <目标 repo> branch=<branch> prep <runner-label>
just -f <skill>/assets/justfile -d <目标 repo> branch=<branch> connection
just -f <skill>/assets/justfile -d <目标 repo> branch=<branch> exec <本地脚本>   # 短命令, 看即时输出
just -f <skill>/assets/justfile -d <目标 repo> branch=<branch> run <本地脚本>    # 长任务, 内建轮询
just -f <skill>/assets/justfile -d <目标 repo> branch=<branch> pull <runner 上的路径>
just -f <skill>/assets/justfile -d <目标 repo> branch=<branch> done
just -f <skill>/assets/justfile -d <目标 repo> branch=<branch> clean
```

- `check` 只读, 报目标仓库, `.tmp/` 忽略状态, 目标 CI 的 `runs-on` 候选, 残留物, 以及建议放行的前缀. runner label 就取它的输出.
- `prep` 幂等: 换 runner 再跑一次即可 (记得取消旧 run).
- `connection` 会等到 artifact 出现才打印连接命令, 拿到就能干活.
- 收工顺序不能反: 先 `done` 再 `clean`.

## recipe 一览

| recipe | 作用 |
| --- | --- |
| `check` | 只读体检: 目标仓库, `.tmp/` 忽略状态, `runs-on` 候选, 残留物, 建议的 allow prefix |
| `prep <runner> [ref] [timeout-minutes]` | 开临时 worktree, 生成 workflow, 提交并推送临时分支 |
| `status [run-id]` | 不带 id 列该分支最近的 run; 带 id 打印状态, 步骤结论与 artifact |
| `connection [run-id] [等待秒数]` | 等会话就绪 (默认最多 300 秒), 下载 `upterm-connection-*` artifact 并打印连接命令 |
| `exec <本地脚本> [run-id]` | 把脚本喂进会话并取回这段输出, 适合短命令 |
| `run <本地脚本> [run-id] [timeout] [间隔]` | 推到 runner 后台跑, 内建轮询, 结束时给出退出码与新增日志 |
| `pull <runner 路径> [本地目录] [run-id]` | 会话活着时把 runner 上的文件或目录 scp 拉回本地 |
| `push <本地路径> <runner 路径> [run-id]` | 反过来把本地文件送进 runner |
| `done [run-id]` | 收工: 放标记并退出会话, 让 run 收尾成 `success` |
| `cancel [run-id]` | 取消 run; 不带 id 就取消该分支最近一条 |
| `clean` | 取消残留 run, 删远程分支, 移除 worktree, 删本地分支与临时目录 |
| `ssh [run-id]` | 交互式连进去, 人类终端用 (agent 走 `exec`) |

## 硬约束

这五条破了不是"麻烦一点", 而是会在无人值守时直接卡死或者毁掉结果.

1. **命令形态**: 每条命令整条就只是一条 `just ...`. 不要在前后接 `cd`, `sleep`, `&&`, `;`, 不要夹管道和重定向. 要指定目录用 `-d`. allow prefix 只认这种形态; 破了就要人工审批.
2. **前缀字面量要一致**: 提醒 user 配前缀 (dsh-approve-prefix 里放行 `just -f <skill>/assets/justfile`) 时, 用你实际调用 `-f` 时的那串绝对路径, 一个字都不能差. 自己调用也一律用绝对路径.
3. **会话里不要 `exit` / `Ctrl-D`**: 会话一结束就彻底没了, 只能重开一个 run 从头来. 断开本地客户端是安全的.
4. **长任务走 `run`**: 不要让 agent 在 shell 里拼 `nohup + sleep + tail` 的循环. `run` 已经做了后台启动, 增量取日志, 退出码回收.
5. **收工不留痕**: `done` 然后 `clean`. 不要留下临时分支, worktree, 或者空转的 run.

## 更多

- **在会话里干活的细节**, 共享 PTY 的脾气, 脚本怎么传才不会被折坏: [docs/session.md](docs/session.md)
- **出错对照**: 404/422, 会话没了, 前缀不匹配, SFTP 传不了, 卡住的 run: [docs/pitfalls.md](docs/pitfalls.md)
- **实现结构**与为什么不拿 bash 写 recipe: [docs/design.md](docs/design.md)
