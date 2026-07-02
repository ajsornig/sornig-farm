#!/bin/bash
# Swap the Chick Cam (cam3) IP address across all config files and restart services.
# Usage: sudo swap-chick-cam-ip.sh <new-ip>

set -e

NEW_IP="$1"
BASE_DIR="/home/ajsornig/chicken-stream"
SERVICE_FILE="/etc/systemd/system/camera-hls-3.service"

if [ -z "$NEW_IP" ]; then
  echo "Usage: $0 <new-ip>"
  exit 1
fi

if ! echo "$NEW_IP" | grep -qP '^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$'; then
  echo "Invalid IP address: $NEW_IP"
  exit 1
fi

OLD_IP=$(python3 -c "import json; d=json.load(open('$BASE_DIR/config.json')); print([c['ptz']['ip'] for c in d['cameras'] if c['id']=='cam3'][0])" 2>/dev/null)

if [ -z "$OLD_IP" ]; then
  echo "Could not read current cam3 IP from config.json"
  exit 1
fi

if [ "$OLD_IP" = "$NEW_IP" ]; then
  echo "Already set to $NEW_IP"
  exit 0
fi

echo "Swapping Chick Cam IP: $OLD_IP -> $NEW_IP"

python3 -c "
import json
with open('$BASE_DIR/config.json', 'r') as f:
    d = json.load(f)
for c in d['cameras']:
    if c['id'] == 'cam3':
        c['ptz']['ip'] = '$NEW_IP'
with open('$BASE_DIR/config.json', 'w') as f:
    json.dump(d, f, indent=2)
print('Updated config.json')
"

sed -i "s|@${OLD_IP}:|@${NEW_IP}:|g" "$SERVICE_FILE"
echo "Updated $SERVICE_FILE"

systemctl daemon-reload
systemctl restart camera-hls-3
echo "Restarted camera-hls-3"

systemctl restart wifi-monitor
echo "Restarted wifi-monitor"

echo "Done. Chick Cam now at $NEW_IP"
