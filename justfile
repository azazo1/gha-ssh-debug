# 默认调试仓库. 换仓库: just repo=OWNER/REPO run
repo := "azazo1/gha-ssh-debug"
workflow := "ssh-upterm.yml"
conn_dir := justfile_directory() / ".tmp" / "upterm"
known_hosts := justfile_directory() / ".tmp" / "upterm-known-hosts"

[private]
default:
    @just --list

# 触发 Upterm SSH Debug workflow.
run:
    gh workflow run {{ workflow }} --repo {{ repo }}

# 查看最近几次 Upterm workflow 运行状态.
status:
    gh run list --repo {{ repo }} --workflow {{ workflow }} --limit 5

# 监听最新一次运行的实时日志. 仅人类终端使用, agent 不要跑.
watch:
    gh run watch "$(gh run list --repo {{ repo }} --workflow {{ workflow }} --limit 1 --json databaseId --jq '.[0].databaseId')" --repo {{ repo }}

# 取消最新一次 Upterm workflow 运行.
cancel:
    gh run cancel "$(gh run list --repo {{ repo }} --workflow {{ workflow }} --limit 1 --json databaseId --jq '.[0].databaseId')" --repo {{ repo }}

# 下载最新一次运行的 upterm 连接命令到 .tmp/upterm 并打印.
connection:
    rm -rf "{{ conn_dir }}"
    mkdir -p "{{ conn_dir }}"
    gh run download "$(gh run list --repo {{ repo }} --workflow {{ workflow }} --limit 1 --json databaseId --jq '.[0].databaseId')" -n upterm-connection -D "{{ conn_dir }}" --repo {{ repo }}
    cat "{{ conn_dir }}/ssh.txt"

# 读取 .tmp/upterm/ssh.txt 并进入 SSH 会话.
ssh: connection
    ssh -tt \
        -o StrictHostKeyChecking=accept-new \
        -o UserKnownHostsFile="{{ known_hosts }}" \
        -o ConnectTimeout=10 \
        "$(sed 's/^ssh[[:space:]]*//' "{{ conn_dir }}/ssh.txt")"
