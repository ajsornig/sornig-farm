#!/bin/bash
# WiFi signal + stream health monitor
# Logs signal strength, camera connectivity, and ffmpeg restarts every minute
# Output: ~/chicken-stream/logs/wifi-monitor.log

LOG="/home/ajsornig/chicken-stream/logs/wifi-monitor.log"
mkdir -p "$(dirname "$LOG")"

while true; do
  timestamp=$(date '+%Y-%m-%d %H:%M:%S')

  # Camera signal info from AP interface
  signal=$(sudo iw dev wlan1 station dump 2>/dev/null | grep 'signal:' | awk '{print $2}')
  tx_rate=$(sudo iw dev wlan1 station dump 2>/dev/null | grep 'tx bitrate:' | head -1 | sed 's/.*tx bitrate:\s*//')
  rx_rate=$(sudo iw dev wlan1 station dump 2>/dev/null | grep 'rx bitrate:' | head -1 | sed 's/.*rx bitrate:\s*//')

  # Can we ping the cameras?
  ping_cam1=$(ping -c 1 -W 2 10.0.0.10 2>/dev/null && echo "OK" || echo "FAIL")
  ping1=$(echo "$ping_cam1" | tail -1)
  ping_cam2=$(ping -c 1 -W 2 10.0.0.11 2>/dev/null && echo "OK" || echo "FAIL")
  ping2=$(echo "$ping_cam2" | tail -1)
  ping_cam3=$(ping -c 1 -W 2 10.0.0.12 2>/dev/null && echo "OK" || echo "FAIL")
  ping3=$(echo "$ping_cam3" | tail -1)

  # Stream freshness
  if [ -f /home/ajsornig/chicken-stream/public/hls/stream.m3u8 ]; then
    stream_age=$(( $(date +%s) - $(stat -c %Y /home/ajsornig/chicken-stream/public/hls/stream.m3u8) ))
  else
    stream_age="NO_FILE"
  fi

  # ffmpeg restart count
  restarts=$(sudo systemctl show camera-hls --property=NRestarts 2>/dev/null | cut -d= -f2)

  # ffmpeg running?
  ffmpeg_pid=$(pgrep -f 'ffmpeg.*hls' || echo "DEAD")

  echo "${timestamp} | signal=${signal:-?}dBm | tx=${tx_rate:-?} | rx=${rx_rate:-?} | ping1=${ping1} ping2=${ping2} ping3=${ping3} | stream_age=${stream_age}s | restarts=${restarts} | ffmpeg=${ffmpeg_pid}" >> "$LOG"

  sleep 60
done
