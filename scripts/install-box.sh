#!/usr/bin/env bash
# AgentBox devvm base installer.
#
# Run once, as root, on a fresh devvm VM (Ubuntu, devvm's `base` image) during
# `agentbox prepare --provider devvm`. The VM is then saved as a devvm snapshot,
# which every per-box create starts from.
#
# Adapted from AgentBox's Hetzner installer (madarco/agentbox,
# packages/sandbox-hetzner/scripts/install-box.sh, MIT). Differences:
#   - Node 24 from nodejs.org's own tarball, checked against its SHASUMS256
#     (NodeSource does not list every Ubuntu release devvm's image may be on).
#   - The `vscode` user takes the first free uid: devvm's own guest user (the
#     one its ssh config logs in as) is never renamed or locked out, and no
#     sshd drop-in is written.
#   - No Docker-in-Docker, VNC or Chrome: the provider declares dind and vnc
#     off, and the box stays small.
#
# Inputs (uploaded to /tmp before this runs): /tmp/agentbox-ctl and the shared
# runtime helpers named in the "baked helper scripts" step, plus the config
# files named in the "baked config files" step.

set -euo pipefail

step() { printf '\n>>> BEGIN %s\n' "$1"; }
done_() { printf '<<< END %s\n' "$1"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "install-box.sh: must run as root (got uid $(id -u))" >&2
  exit 64
fi

export DEBIAN_FRONTEND=noninteractive

step "wait for cloud-init"
cloud-init status --wait >/dev/null 2>&1 || true
done_ "wait for cloud-init"

step "apt update + base packages"
apt-get update
apt-get install -y --no-install-recommends \
  curl ca-certificates gnupg xz-utils \
  fuse3 rsync python3 python3-pip python3-venv build-essential \
  git git-lfs tmux vim libcap2-bin sudo locales bash-completion
locale-gen en_US.UTF-8 >/dev/null 2>&1 || true
update-locale LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 >/dev/null 2>&1 || true
done_ "apt update + base packages"

step "Node 24 from nodejs.org"
case "$(uname -m)" in
  aarch64|arm64) node_arch=arm64 ;;
  x86_64|amd64) node_arch=x64 ;;
  *) echo "install-box.sh: unsupported architecture $(uname -m)" >&2; exit 65 ;;
esac
if ! command -v node >/dev/null 2>&1 || ! node --version | grep -qE '^v24\.'; then
  base=https://nodejs.org/dist/latest-v24.x
  sums="$(curl -fsSL "$base/SHASUMS256.txt")"
  line="$(printf '%s\n' "$sums" | grep -E "  node-v24\.[0-9.]+-linux-${node_arch}\.tar\.xz$" | head -1)"
  file="${line##* }"
  want="${line%% *}"
  if [ -z "$file" ] || [ -z "$want" ]; then
    echo "install-box.sh: no Node 24 linux-${node_arch} archive in $base/SHASUMS256.txt" >&2
    exit 66
  fi
  curl -fsSL -o "/tmp/$file" "$base/$file"
  got="$(sha256sum "/tmp/$file" | cut -d' ' -f1)"
  if [ "$got" != "$want" ]; then
    echo "install-box.sh: $file checksum mismatch" >&2
    exit 67
  fi
  tar -xJf "/tmp/$file" -C /usr/local --strip-components=1 --no-same-owner
  rm -f "/tmp/$file"
fi
node --version
done_ "Node 24 from nodejs.org"

step "vscode user + sudoers"
if ! id vscode >/dev/null 2>&1; then
  useradd -m -s /bin/bash vscode
fi
install -d -m 0755 -o vscode -g vscode /home/vscode
echo 'vscode ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/90-agentbox-vscode
chmod 0440 /etc/sudoers.d/90-agentbox-vscode
done_ "vscode user + sudoers"

step "agentbox base dirs + /workspace ownership"
mkdir -p /workspace /run/agentbox /var/log/agentbox /var/lib/agentbox /etc/agentbox /etc/claude-code \
         /usr/local/share/agentbox
chmod 755 /workspace
chown vscode:vscode /workspace /run/agentbox /var/log/agentbox /var/lib/agentbox
# /run is a tmpfs: make /run/agentbox again on every boot.
printf 'd /run/agentbox 0755 vscode vscode -\n' > /etc/tmpfiles.d/agentbox.conf
done_ "agentbox base dirs + /workspace ownership"

step "global npm installs for every user"
# devvm's image points each user's npm at ~/.npm-global (NPM_CONFIG_PREFIX in
# /etc/profile.d/devvm-tools.sh, which is also BASH_ENV). AgentBox installs
# agent CLIs as root with `npm install -g` and then looks for them as vscode,
# so global installs go to /usr/local like in AgentBox's own box image.
if [ -f /etc/profile.d/devvm-tools.sh ]; then
  sed -i '/NPM_CONFIG_PREFIX/d' /etc/profile.d/devvm-tools.sh
fi
done_ "global npm installs for every user"

step "node setcap (port <1024 bind without root)"
NODE_BIN="$(readlink -f "$(command -v node)")"
setcap cap_net_bind_service=+ep "$NODE_BIN"
done_ "node setcap (port <1024 bind without root)"

step "corepack (pnpm + yarn shims)"
npm install -g corepack@latest
corepack enable pnpm yarn
sudo -u vscode -H mkdir -p /home/vscode/.cache/node/corepack
done_ "corepack (pnpm + yarn shims)"

step "git system config"
git config --system --add safe.directory '*'
git lfs install --system --skip-repo
done_ "git system config"

step "agentbox-ctl install"
install -m 0755 /tmp/agentbox-ctl /usr/local/bin/agentbox-ctl
done_ "agentbox-ctl install"

step "baked helper scripts (cleanup / xdg-open / gh + git + tool shims)"
install -m 0755 /tmp/agentbox-checkpoint-cleanup /usr/local/bin/agentbox-checkpoint-cleanup
install -m 0755 /tmp/agentbox-open               /usr/local/bin/agentbox-open
ln -sf /usr/local/bin/agentbox-open /usr/local/bin/xdg-open
install -m 0755 /tmp/agentbox-gh-shim            /usr/local/bin/gh
install -m 0755 /tmp/agentbox-git-shim           /usr/local/bin/git
install -m 0755 /tmp/agentbox-tool-shim          /usr/local/bin/agentbox-tool-shim
done_ "baked helper scripts (cleanup / xdg-open / gh + git + tool shims)"

step "baked config files (claude / codex / setup guide / tmux.conf)"
install -m 0644 /tmp/agentbox-custom-CLAUDE.md      /etc/claude-code/CLAUDE.md
install -m 0644 /tmp/agentbox-managed-settings.json /etc/claude-code/managed-settings.json
install -m 0644 /tmp/agentbox-codex-hooks.json      /usr/local/share/agentbox/codex-hooks.json
install -m 0644 /tmp/agentbox-setup-skill.md        /usr/local/share/agentbox/setup-guide.md
install -m 0644 /tmp/agentbox-identity-skill.md     /usr/local/share/agentbox/identity-skill.md
cat > /etc/tmux.conf <<'TMUX'
set -g default-terminal "tmux-256color"
set -as terminal-overrides ",*:Tc"
set -as terminal-overrides ",*:RGB"
set -as terminal-features ",*:hyperlinks"
set -as terminal-features ",*:RGB"
set -g allow-passthrough on
set -g set-clipboard on
set -g extended-keys on
set -as terminal-features ",*:extkeys"
set -g mouse on
bind -T copy-mode    WheelUpPane   send -N2 -X scroll-up
bind -T copy-mode    WheelDownPane send -N2 -X scroll-down
bind -T copy-mode-vi WheelUpPane   send -N2 -X scroll-up
bind -T copy-mode-vi WheelDownPane send -N2 -X scroll-down
set -g history-limit 50000
set -g escape-time 0
TMUX
done_ "baked config files (claude / codex / setup guide / tmux.conf)"

step "login-shell shim (/etc/profile.d/agentbox.sh)"
cat > /etc/profile.d/agentbox.sh <<'PROFILE'
# Auto-loaded by login shells; box.env is written at create time.
if [ -r /etc/agentbox/box.env ]; then
  set -a
  . /etc/agentbox/box.env
  set +a
fi
case ":$PATH:" in
  *:/home/vscode/.local/bin:*) : ;;
  *) PATH=/home/vscode/.local/bin:$PATH ;;
esac
export PATH
export COLORTERM=${COLORTERM:-truecolor}
export DISABLE_AUTOUPDATER=${DISABLE_AUTOUPDATER:-1}
export LANG=${LANG:-en_US.UTF-8}
export LC_ALL=${LC_ALL:-en_US.UTF-8}
export BROWSER=${BROWSER:-/usr/local/bin/agentbox-open}
case $- in
  *i*)
    if [ "$PWD" = "$HOME" ] && [ -d /workspace ]; then
      cd /workspace
    fi
    ;;
esac
PROFILE
chmod 0644 /etc/profile.d/agentbox.sh
done_ "login-shell shim (/etc/profile.d/agentbox.sh)"

step "apt cleanup"
apt-get clean
rm -rf /var/lib/apt/lists/*
rm -f /tmp/agentbox-ctl /tmp/agentbox-checkpoint-cleanup /tmp/agentbox-open \
      /tmp/agentbox-gh-shim /tmp/agentbox-git-shim /tmp/agentbox-tool-shim \
      /tmp/agentbox-custom-CLAUDE.md /tmp/agentbox-managed-settings.json \
      /tmp/agentbox-codex-hooks.json /tmp/agentbox-setup-skill.md /tmp/agentbox-identity-skill.md
mv /tmp/agentbox-install.sh /var/log/agentbox/install-box.sh 2>/dev/null || true
done_ "apt cleanup"

printf '\n*** install-box.sh: complete — VM ready to save as the base snapshot.\n'
