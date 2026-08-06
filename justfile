[private]
default:
    @just --list

# 触发 SSH Debug workflow.
run:
    gh workflow run ssh.yml --repo azazo1/ssh-debug

# 查看最近几次 workflow 运行状态.
status:
    gh run list --repo azazo1/ssh-debug --workflow ssh.yml --limit 5

# 监听 workflow 实时日志.
watch:
    gh run watch --repo azazo1/ssh-debug

# 取消最新一次 workflow 运行.
cancel:
    gh run cancel "$(gh run list --repo azazo1/ssh-debug --workflow ssh.yml --limit 1 --json databaseId --jq '.[0].databaseId')"
