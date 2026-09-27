# gha-ssh-debug

一个 skill: 在**正在工作的那个仓库**里借一个 GitHub Actions runner, 开 Upterm SSH 会话进去调试 CI, 或者在 runner 上复现构建.

- [SKILL.md](SKILL.md): skill 本体, 操作流程, 收工顺序与踩坑.
- [assets/ssh-debug-upterm.yml](assets/ssh-debug-upterm.yml): 复制到目标 repo 临时分支上的 workflow 模板.

本仓库自身不带 CI, 也没有 justfile: 所有动作都在目标 repo 里完成.
