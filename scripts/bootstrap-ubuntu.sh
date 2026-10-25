#!/usr/bin/env bash
# Run once as root on Ubuntu: bash bootstrap-ubuntu.sh existing-deploy-user /opt/comp-prep
# Does not reconfigure existing websites, DNS, SSH or firewall rules.
set -Eeuo pipefail
deploy_user=${1:?Specify an existing deployment user}
root=${2:-/opt/comp-prep}
[[ "$EUID" == 0 ]] || { echo 'Run with sudo'; exit 2; }
[[ "$root" =~ ^/[a-zA-Z0-9/_-]+$ && "$root" != / ]] || exit 2
id "$deploy_user" >/dev/null
source /etc/os-release
[[ "$ID" == ubuntu ]] || { echo 'This bootstrap supports Ubuntu only'; exit 2; }
if ! command -v docker >/dev/null; then
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  arch=$(dpkg --print-architecture)
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
docker compose version
systemctl enable --now docker
usermod -aG docker "$deploy_user"
install -d -m 0750 -o "$deploy_user" -g "$(id -gn "$deploy_user")" "$root" "$root/releases" "$root/backups"
echo "Ready: $root. Reconnect SSH to apply Docker group membership."
