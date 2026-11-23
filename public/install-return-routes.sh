#!/bin/sh
# Companion installer: reads credentials from the existing Agent, not arguments.
set -eu
if [ "${1:-}" = uninstall ]; then
    if [ "$(id -u)" = 0 ]; then
        dir=/etc/config/cf-probe
        if command -v systemctl >/dev/null 2>&1; then
            systemctl disable --now cfsm-return-routes.timer 2>/dev/null || true
            systemctl stop cfsm-return-routes.service 2>/dev/null || true
            rm -f /etc/systemd/system/cfsm-return-routes.service /etc/systemd/system/cfsm-return-routes.timer
            systemctl daemon-reload
        fi
    else
        dir="$HOME/.cf-probe"
    fi
    if command -v crontab >/dev/null 2>&1; then
        old=$(crontab -l 2>/dev/null || true)
        printf '%s\n' "$old" | sed '/# cfsm-return-routes$/d' | crontab -
    fi
    rm -f "$dir/return-routes.py" "$dir/config.conf.return-routes.lock"
    echo 'Return route probing removed'
    exit 0
fi
origin=''
for arg in "$@"; do
    case "$arg" in -url=*) origin=${arg#-url=} ;; esac
done
case "$origin" in https://*) origin="https://${origin#https://}"; origin="${origin%/update}"; origin="${origin%/}" ;; *) echo 'An HTTPS -url is required' >&2; exit 1 ;; esac
[ "$(uname -s)" = Linux ] || { echo 'Return routes require Linux' >&2; exit 1; }
if [ "$(id -u)" = 0 ]; then
    dir=/etc/config/cf-probe
    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -qq
        apt-get install -y -qq python3 traceroute
    elif command -v dnf >/dev/null 2>&1; then
        dnf install -y python3 traceroute
    elif command -v yum >/dev/null 2>&1; then
        yum install -y python3 traceroute
    elif command -v apk >/dev/null 2>&1; then
        apk add --no-cache python3 traceroute
    fi
else
    dir="$HOME/.cf-probe"
fi
command -v python3 >/dev/null 2>&1 || { echo 'Install python3 as root, then rerun the installation' >&2; exit 1; }
command -v traceroute >/dev/null 2>&1 || { echo 'Install Linux traceroute as root, then rerun the installation' >&2; exit 1; }
traceroute --help 2>&1 | grep -q -- '-A' || { echo 'traceroute must support -A (BusyBox is not supported)' >&2; exit 1; }
[ -r "$dir/config.conf" ] || { echo 'Install the Agent first: config.conf is missing' >&2; exit 1; }
umask 077
tmp=$(mktemp "$dir/return-routes.XXXXXX")
trap 'rm -f "$tmp"' EXIT HUP INT TERM
curl -fsSL --connect-timeout 10 --max-time 60 "$origin/return-routes.py" -o "$tmp"
python3 -c 'import ast,sys; ast.parse(open(sys.argv[1]).read())' "$tmp"
mv "$tmp" "$dir/return-routes.py"
python=$(command -v python3)
if [ "$(id -u)" = 0 ] && [ -d /run/systemd/system ]; then
    cat > /etc/systemd/system/cfsm-return-routes.service <<EOF
[Unit]
Description=CFSM three carrier return routes
Wants=network-online.target
After=network-online.target
[Service]
Type=oneshot
ExecStart=$python $dir/return-routes.py --agent-config $dir/config.conf
TimeoutStartSec=330
UMask=0077
Nice=19
EOF
    cat > /etc/systemd/system/cfsm-return-routes.timer <<'EOF'
[Unit]
Description=Probe CFSM return routes every six hours
[Timer]
OnBootSec=2min
OnUnitActiveSec=6h
RandomizedDelaySec=5min
[Install]
WantedBy=timers.target
EOF
    systemctl daemon-reload
    systemctl enable --now cfsm-return-routes.timer
    systemctl start --no-block cfsm-return-routes.service
else
    command -v crontab >/dev/null 2>&1 || { echo 'A running cron daemon and crontab are required on systems without systemd' >&2; exit 1; }
    # Quote paths for cron and escape percent, which cron otherwise treats as stdin.
    job=$(python3 -c 'import shlex,sys; print(" ".join(map(shlex.quote, sys.argv[1:])).replace("%", r"\%"))' "$python" "$dir/return-routes.py" --agent-config "$dir/config.conf")
    minute=$(od -An -N2 -tu2 /dev/urandom | tr -d ' ')
    minute=$((minute % 60))
    old=$(crontab -l 2>/dev/null || true)
    { printf '%s\n' "$old" | sed '/# cfsm-return-routes$/d'; printf '%s */6 * * * %s >/dev/null 2>&1 # cfsm-return-routes\n' "$minute" "$job"; } | crontab -
    nohup "$python" "$dir/return-routes.py" --agent-config "$dir/config.conf" >/dev/null 2>&1 &
fi
echo 'Return route probing installed. First result may take up to five minutes; subsequent runs every six hours.'
