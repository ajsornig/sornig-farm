#!/bin/bash
# wlan0 failover watchdog — ensures built-in WiFi stays connected
# Runs every 5 min via systemd timer. If wlan0 is disconnected, reconnects it.
# This matters when the BrosTrend (wlan1) goes down — wlan0 is the fallback.

STATE=$(nmcli -t -f DEVICE,STATE dev status | grep '^wlan0:' | cut -d: -f2)

if [ "$STATE" != "connected" ]; then
    logger -t wlan0-watchdog "wlan0 is $STATE — reconnecting"
    nmcli con up 'netplan-wlan0-UTECHHOMEMAIN' 2>&1 | logger -t wlan0-watchdog
else
    logger -t wlan0-watchdog "wlan0 ok"
fi
