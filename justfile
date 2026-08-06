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

# 下载最新一次运行的 tmate 连接信息到本地并打印.
connection:
    rm -f ssh.txt web.txt
    gh run download "$(gh run list --repo azazo1/ssh-debug --workflow ssh.yml --limit 1 --json databaseId --jq '.[0].databaseId')" -n tmate-connection -D . -R azazo1/ssh-debug
    cat ssh.txt

# 读取 ssh.txt 并进入 SSH 会话.
ssh: connection
    eval "$(cat ssh.txt)"

# 下载最新一次运行的构建产物.
download:
    gh run download "$(gh run list --repo azazo1/ssh-debug --workflow ssh.yml --limit 1 --json databaseId --jq '.[0].databaseId')" -n build-artifacts -R azazo1/ssh-debug
