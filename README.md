# gha-ssh-debug

一个 skill: 在**正在工作的那个仓库**里借一个 GitHub Actions runner, 开 Upterm SSH 会话进去调试 CI, 在 runner 上复现构建, 或者把 runner 上的构建产物拉回本地.

- [SKILL.md](SKILL.md): skill 本体, 最短路径与硬约束.
- [docs/](docs/): 展开的细节.
  - [session.md](docs/session.md): 共享 PTY 的脾气, 命令怎么喂进去, 脚本怎么传.
  - [pitfalls.md](docs/pitfalls.md): 出错对照表.
  - [design.md](docs/design.md): 实现结构与 allow prefix 原理.
- [assets/justfile](assets/justfile): 调试全过程用到的 recipe, 只是一层派发.
- [assets/scripts/](assets/scripts/): recipe 的实现, 纯 node (无依赖), 因此 Unix 与 Windows 都能跑.
- [assets/ssh-debug-upterm.yml](assets/ssh-debug-upterm.yml): 由 `prep` 渲染后提交到目标 repo 临时分支的 workflow 模板.

本仓库自身不带 CI: 所有动作都发生在目标 repo 里, 本仓库只提供这份 skill.
