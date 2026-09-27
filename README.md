# gha-ssh-debug

一个 skill: 在**正在工作的那个仓库**里借一个 GitHub Actions runner, 开 Upterm SSH 会话进去调试 CI, 或者在 runner 上复现构建.

- [SKILL.md](SKILL.md): skill 本体, 操作流程, 收工顺序与踩坑.
- [assets/justfile](assets/justfile): 调试全过程用到的 recipe (体检, 铺模板, 查 run, 取连接命令, 收工清理), 用 `just -f <本 skill 目录>/assets/justfile -d <目标 repo> ...` 调用.
- [assets/ssh-debug-upterm.yml](assets/ssh-debug-upterm.yml): 由 `prep` 渲染后提交到目标 repo 临时分支的 workflow 模板.

本仓库自身不带 CI: 所有动作都发生在目标 repo 里, 本仓库只提供这份 skill.
