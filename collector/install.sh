#!/bin/bash
# Install the weekly usage report collector on a lab machine. Run as root from a checkout:
#   sudo bash collector/install.sh changlab_merlin
# Safe to re-run: it keeps an existing config and deploy key, and updates the script and units.
set -euo pipefail
MACHINE=${1:?usage: install.sh <machine name, e.g. changlab_merlin>}
HERE=$(cd "$(dirname "$0")" && pwd)
ETC=/etc/changlab-report
LIB=/usr/local/lib/changlab-report
STATE=/var/lib/changlab-report
REPO=git@github.com:changlab-machine-report/changlab-machine-report.github.io.git

[ "$(id -u)" -eq 0 ] || { echo "run this as root (sudo)" >&2; exit 1; }

install -d -m 0755 "$LIB" "$ETC"
install -m 0755 "$HERE/changlab_report.py" "$LIB/"
if [ ! -e "$ETC/config.json" ]; then
  cat > "$ETC/config.json" <<EOF
{
  "machine": "$MACHINE",
  "repo": "$REPO",
  "users": ["jessieli", "kellycyy", "zhining", "josephsuh", "wangzhu"]
}
EOF
fi

# Each machine pushes with its own deploy key, scoped to the report repo only
[ -e "$ETC/deploy_key" ] || ssh-keygen -q -t ed25519 -N "" -C "changlab-report@$MACHINE" -f "$ETC/deploy_key"

# Trust GitHub's SSH host key only if it matches the fingerprint GitHub publishes
published=$(curl -fsS https://api.github.com/meta |
  python3 -c 'import json, sys; print(json.load(sys.stdin)["ssh_key_fingerprints"]["SHA256_ED25519"])')
ssh-keyscan -t ed25519 github.com 2>/dev/null > "$ETC/known_hosts.new"
served=$(ssh-keygen -lf "$ETC/known_hosts.new" | awk '{print $2}')
if [ "$served" != "SHA256:$published" ]; then
  rm -f "$ETC/known_hosts.new"
  echo "GitHub host key $served does not match the published SHA256:$published; stopping" >&2
  exit 1
fi
mv "$ETC/known_hosts.new" "$ETC/known_hosts"

# Raw samples stay on the machine; admins (group adm) can read them
install -d -m 2750 -g adm "$STATE" "$STATE/samples"

install -m 0644 "$HERE"/systemd/changlab-report-* /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now changlab-report-sampler.service changlab-report-publish.timer
systemctl restart changlab-report-sampler.service

echo
echo "Installed on $MACHINE. Add this deploy key to the repo (Settings > Deploy keys > Add deploy key,"
echo "tick 'Allow write access') so the Monday report can be pushed:"
echo
cat "$ETC/deploy_key.pub"
