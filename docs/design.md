# 实现结构

justfile 只做派发, 每个 recipe 是一行 `node <脚本>` 调用, 逻辑全在 `assets/scripts/`.

## 目录

- `assets/justfile`: recipe 定义与参数, 以及那条要给 user 放行的 allow prefix.
- `assets/ssh-debug-upterm.yml`: 由 `prep` 渲染后提交到目标 repo 临时分支的 workflow 模板.
- `assets/scripts/lib/`: 公共逻辑.
  - `log.mjs`: 输出与退出码 (含 EPIPE 处理, 免得管道被下游截断时吐栈).
  - `run.mjs`: 执行外部命令.
  - `context.mjs`: 参数解析, branch 与 cwd 校验, 派生路径推导.
  - `gh.mjs`: gh 调用, 连接命令解析, 等 artifact.
  - `session.mjs`: 取连接信息, 拼 ssh 参数.
  - `session-run.mjs`: 往共享 PTY 喂命令并按标记截输出.
  - `transfer.mjs`: scp 传输与落地核验.
  - `cli.mjs`: 入口包装 (统一把 CliError 翻成退出码).
- `assets/scripts/*.mjs`: 每个 recipe 一个, 名字对应.

## 为什么不拿 bash 写 recipe

- just 的 shebang recipe 在 **Windows 上不被支持** (手册明说 Windows 不支持 shebang, 会把首行拆成命令再调用). 用 `#!/usr/bin/env bash` 就把整个 skill 锁死在 Unix. 现在 recipe 体是一行普通命令, Unix 走 `sh`, Windows 走 `cmd`, 都不需要 bash.
- 命令行里的引号交给 just 的 `quote()`, 路径带空格也拆不坏.
- 要在 Windows 上用, 前提只有一条: `node` 在 PATH 上. `gh` / `git` / `ssh` / `scp` 本来就是各平台的常规安装.
- 需要"等待"的场景 (等 runner 起来, 等构建结束) 写在脚本里, 于是命令形态永远是干净的一条 argv, allow prefix 始终能吃到.

## allow prefix 的原理

这些 recipe 要写目标 repo 的 `.git` 并读 gh 凭据, 所以调用时要提权. dsh-approve-prefix 放行
`just -f <本 skill 目录>/assets/justfile` 之后, 匹配该前缀的**单条命令**会自动通过审批.

匹配要求整个命令就是一条简单命令: 前置 `cd` / `sleep`, 后接 `;` / `&&`, 夹管道或重定向都不算.
所以不要为了省事去拼长命令 —— 那是把自动化能力换成一次性操作.

## 派生路径

`root` / `wt` / `conn` 全部由 `branch` 推导 (`.tmp/ssh-debug-<branch 去掉斜杠>/` 之下), 并且
不在 justfile 里定义, 只存在于 `context.mjs` 里. 好处是命令行无法把 `clean` 的删除目标改到别处;
代价是要改路径就得改代码, 而不是传个变量.
