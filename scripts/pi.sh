#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ ! -f .pi.env ]]; then
  echo 'Copy .pi.env.example to .pi.env and set PI_HOST and PI_DIR.' >&2
  exit 1
fi
source .pi.env
: "${PI_HOST:?Set PI_HOST in .pi.env}"
: "${PI_DIR:?Set PI_DIR in .pi.env}"
if [[ ! "$PI_HOST" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$ || ! "$PI_DIR" =~ ^/[a-zA-Z0-9_/-]+$ || "$PI_DIR" == / ]]; then
  echo 'Use a simple SSH host/alias and an absolute PI_DIR containing only letters, digits, _, /, and -.' >&2
  exit 1
fi
case "${1:-}" in
  sync)
    ssh "$PI_HOST" "mkdir -p '$PI_DIR'"
    rsync -az --exclude=.git --exclude=node_modules --exclude=dist --exclude=data --exclude=.env --exclude=.pi.env ./ "$PI_HOST:$PI_DIR/"
    ;;
  setup)
    ssh -t "$PI_HOST" "export PATH=\"\$HOME/.local/opt/node/bin:\$PATH\"; cd '$PI_DIR' && npm ci && npm run build"
    ;;
  run)
    # Rebuild the web UI, then watch server changes. Ctrl-C stops the remote run.
    ssh -t "$PI_HOST" "export PATH=\"\$HOME/.local/opt/node/bin:\$PATH\"; cd '$PI_DIR' && npm run build && npm run dev:server"
    ;;
  logs)
    ssh -t "$PI_HOST" 'journalctl _SYSTEMD_USER_UNIT=fridge-ai.service -f -n 50'
    ;;
  restart)
    ssh "$PI_HOST" "export PATH=\"\$HOME/.local/opt/node/bin:\$PATH\"; cd '$PI_DIR' && npm run build && systemctl --user restart fridge-ai"
    ;;
  tunnel)
    ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -L 127.0.0.1:3002:127.0.0.1:3000 "$PI_HOST"
    ;;
  sensor-on|sensor-off)
    sensor_enabled=false
    [[ "$1" == sensor-on ]] && sensor_enabled=true
    ssh "$PI_HOST" "cd '$PI_DIR' && python3 - '$sensor_enabled'" <<'PY'
from pathlib import Path
import sys
p = Path('.env')
lines = [line for line in p.read_text().splitlines() if not line.startswith('DOOR_SENSOR_ENABLED=')]
p.write_text('\n'.join(lines + ['DOOR_SENSOR_ENABLED=' + sys.argv[1]]) + '\n')
PY
    ssh "$PI_HOST" 'systemctl --user restart fridge-ai'
    ;;
  sensor-check)
    ssh "$PI_HOST" 'gpioget --chip gpiochip0 --bias pull-up --hold-period 10ms --numeric 17'
    ;;
  *) echo 'Usage: bash scripts/pi.sh {sync|setup|run|logs|restart|tunnel|sensor-on|sensor-off|sensor-check}' >&2; exit 1 ;;
esac
