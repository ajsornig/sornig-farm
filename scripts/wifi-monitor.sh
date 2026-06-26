#!/bin/bash
# Network + stream health monitor
# Logs eth0 link, wlan0/wlan1 signal, camera pings, Wavlink AP, stream freshness every minute
# Output: ~/chicken-stream/logs/wifi-monitor.log

LOG="/home/ajsornig/chicken-stream/logs/wifi-monitor.log"
mkdir -p "$(dirname "$LOG")"

while true; do
  timestamp=$(date '+%Y-%m-%d %H:%M:%S')

  # eth0 link state (camera network)
  eth0_state=$(cat /sys/class/net/eth0/operstate 2>/dev/null || echo "UNKNOWN")
  eth0_speed=$(cat /sys/class/net/eth0/speed 2>/dev/null || echo "?")

  # wlan0 signal (home WiFi — fallback uplink)
  wlan0_signal=$(sudo iw dev wlan0 link 2>/dev/null | grep 'signal:' | awk '{print $2}')

  # wlan1 signal (BrosTrend 5GHz — primary uplink)
  wlan1_signal=$(sudo iw dev wlan1 link 2>/dev/null | grep 'signal:' | awk '{print $2}')

  # Ping cameras
  ping1_ms=$(ping -c 1 -W 2 10.0.0.10 2>/dev/null | grep 'time=' | sed 's/.*time=\([^ ]*\).*/\1/' || echo "FAIL")
  ping2_ms=$(ping -c 1 -W 2 10.0.0.11 2>/dev/null | grep 'time=' | sed 's/.*time=\([^ ]*\).*/\1/' || echo "FAIL")

  # Ping Wavlink AP
  wavlink_ms=$(ping -c 1 -W 2 10.0.0.49 2>/dev/null | grep 'time=' | sed 's/.*time=\([^ ]*\).*/\1/' || echo "FAIL")

  # Stream freshness (cam1)
  if [ -f /home/ajsornig/chicken-stream/public/hls/stream.m3u8 ]; then
    stream1_age=$(( $(date +%s) - $(stat -c %Y /home/ajsornig/chicken-stream/public/hls/stream.m3u8) ))
  else
    stream1_age="NO_FILE"
  fi

  # Stream freshness (cam2)
  if [ -f /home/ajsornig/chicken-stream/public/hls2/stream.m3u8 ]; then
    stream2_age=$(( $(date +%s) - $(stat -c %Y /home/ajsornig/chicken-stream/public/hls2/stream.m3u8) ))
  else
    stream2_age="NO_FILE"
  fi

  # ffmpeg restart counts
  restarts1=$(sudo systemctl show camera-hls --property=NRestarts 2>/dev/null | cut -d= -f2)
  restarts2=$(sudo systemctl show camera-hls-2 --property=NRestarts 2>/dev/null | cut -d= -f2)

  # ffmpeg process count
  ffmpeg_count=$(pgrep -c -f 'ffmpeg.*hls' 2>/dev/null || echo "0")

  # System resources
  cpu_pct=$(awk '{u=$2+$4; t=$2+$4+$5; if(NR==1){ou=u;ot=t} else printf "%.1f", (u-ou)/(t-ot)*100}' <(grep '^cpu ' /proc/stat; sleep 1; grep '^cpu ' /proc/stat) 2>/dev/null || echo "?")
  mem_info=$(awk '/MemTotal/{t=$2} /MemAvailable/{a=$2} END{printf "%.0f/%.0f", (t-a)/1024, t/1024}' /proc/meminfo 2>/dev/null || echo "?/?")
  load_avg=$(awk '{print $1}' /proc/loadavg 2>/dev/null || echo "?")
  cpu_temp=$(awk '{printf "%.1f", $1/1000}' /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo "?")

  echo "${timestamp} | eth0=${eth0_state}@${eth0_speed}Mbps | wlan0=${wlan0_signal:-?}dBm | wlan1=${wlan1_signal:-?}dBm | cam1=${ping1_ms}ms cam2=${ping2_ms}ms wavlink=${wavlink_ms}ms | stream1=${stream1_age}s stream2=${stream2_age}s | restarts=${restarts1}/${restarts2} | ffmpeg=${ffmpeg_count} | cpu=${cpu_pct}% mem=${mem_info}MB load=${load_avg} temp=${cpu_temp}C" >> "$LOG"

  sleep 60
done
