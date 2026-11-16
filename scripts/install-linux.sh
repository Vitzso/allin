#!/usr/bin/env bash
# Installs AllIn from an unpacked release folder. Run as root, from that folder.
# It never changes or removes anything already under /var/lib/allin, and it does not start the service.
set -eu
umask 022

here=$(cd "$(dirname "$0")" && pwd)
die() {
  echo "AllIn install: $*" >&2
  exit 1
}

[ "$(id -u)" -eq 0 ] || die "run this as root."
[ "$(uname -s)" = "Linux" ] || die "this installer is for Linux."
command -v systemctl >/dev/null 2>&1 || die "systemd is required, and systemctl was not found."
command -v npm >/dev/null 2>&1 || die "npm was not found."
command -v runuser >/dev/null 2>&1 || die "runuser was not found (it comes with util-linux)."
# The unit runs "/usr/bin/env node" on systemd's default PATH, which may find a different node than root's PATH does.
svc_path=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
svc_node() { /usr/bin/env -i PATH="$svc_path" node "$@"; }
svc_node -e 0 >/dev/null 2>&1 || die "Node 22.18 or later is required, and node was not found on the service's PATH ($svc_path)."
svc_node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)' ||
  die "Node 22.18 or later is required, found $(svc_node --version) on the service's PATH."
node_path=$(readlink -f "$(svc_node -p process.execPath)")
case "$node_path" in
  /home/* | /root/*) die "node is under a home folder ($node_path), which the service cannot read. Install Node system-wide." ;;
esac
if systemctl is-active --quiet allin; then die "the allin service is running. Run systemctl stop allin first, then run this again."; fi
# The server starts the feed sandbox from this exact path.
[ -x /usr/bin/bwrap ] || die "bubblewrap is required at /usr/bin/bwrap. Install the bubblewrap package."
for item in build dist package.json package-lock.json allin.service allin.env.example; do
  [ -e "$here/$item" ] || die "$item is missing from the release folder."
done

if ! id allin >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/lib/allin --no-create-home --shell /usr/sbin/nologin allin
fi
# Root passing proves nothing about the service user, so the check runs as allin.
runuser -u allin -- /usr/bin/bwrap --unshare-all --ro-bind / / true >/dev/null 2>&1 ||
  die "bubblewrap does not work for the allin user. The feed sandbox needs unprivileged user namespaces."

# Existing folders are left exactly as they are.
[ -d /var/lib/allin ] || install -d -o allin -g allin -m 0700 /var/lib/allin
[ -d /var/lib/allin/vault ] || install -d -o allin -g allin -m 0700 /var/lib/allin/vault
[ -d /var/lib/allin/keys ] || install -d -o allin -g allin -m 0700 /var/lib/allin/keys
[ -d /etc/allin ] || install -d -o root -g allin -m 0750 /etc/allin
[ -d /etc/allin/tls ] || install -d -o allin -g allin -m 0700 /etc/allin/tls

echo "Downloading dependencies from the npm registry."
staging=$(mktemp -d /opt/.allin-new.XXXXXX)
trap 'rm -rf "$staging"' EXIT
cp -R "$here/build" "$here/dist" "$here/package.json" "$here/package-lock.json" "$staging/"
# --ignore-scripts: npm would otherwise run node-gyp on the database module, as root. It isn't
# needed, because the module loads its shipped binary, and it fails without Python and a compiler.
(cd "$staging" && env PATH="$svc_path" npm ci --omit=dev --ignore-scripts)
chmod -R u=rwX,go=rX "$staging"
# The old copy stays until the new one is in place.
rm -rf /opt/allin.old
[ ! -d /opt/allin ] || mv /opt/allin /opt/allin.old
mv "$staging" /opt/allin
rm -rf /opt/allin.old

install -m 0644 "$here/allin.service" /etc/systemd/system/allin.service
[ -e /etc/allin/allin.env ] || install -o root -g allin -m 0640 "$here/allin.env.example" /etc/allin/allin.env
systemctl daemon-reload

echo "AllIn is installed. It is not running yet. Next:"
echo "  1. Fill in /etc/allin/allin.env (the WireGuard address and origin)."
echo "  2. Put server.crt and server.key in /etc/allin/tls, owned by allin, with the key mode 0600."
echo "  3. Run: systemctl enable --now allin"
