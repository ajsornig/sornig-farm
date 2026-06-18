#!/bin/bash
# Motion detection for chicken cam (nighttime predator alert)
# Runs as a loop, comparing consecutive frames for significant changes

STREAM="/home/ajsornig/chicken-stream/public/hls/stream.m3u8"
CAPTURES_DIR="/home/ajsornig/chicken-stream/public/motion-captures"
LOG="/home/ajsornig/chicken-stream/logs/motion.log"
WORK_DIR="/tmp/motion-detect"

# Configuration
THRESHOLD=40         # Percentage of pixels that must change to trigger
COOLDOWN=300         # Seconds between alerts
CHECK_INTERVAL=10    # Seconds between frame checks
NIGHT_ONLY=true      # Only run detection during night hours (9pm-6am)
CONFIRM_COUNT=3      # Must detect motion N consecutive times before alerting

mkdir -p "$CAPTURES_DIR" "$WORK_DIR"

last_alert=0
consecutive_triggers=0

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"
}

is_nighttime() {
  local hour=$(date +%H)
  # Stop before sunrise to avoid dawn light change triggering false positives
  if [ "$hour" -ge 21 ] || [ "$hour" -lt 5 ]; then
    return 0
  fi
  return 1
}

grab_frame() {
  local output="$1"
  # Blur slightly to reduce WiFi compression noise triggering false positives
  ffmpeg -y -i "$STREAM" -frames:v 1 -vf "scale=320:240,gblur=sigma=2" -q:v 5 "$output" 2>/dev/null
  return $?
}

compare_frames() {
  local frame1="$1"
  local frame2="$2"

  if [ ! -f "$frame1" ] || [ ! -f "$frame2" ]; then
    return 1
  fi

  # Use ImageMagick compare to get difference percentage
  local diff=$(compare -metric AE "$frame1" "$frame2" /dev/null 2>&1)

  # Total pixels in 320x240 = 76800
  local total=76800
  local percent=$(( (diff * 100) / total ))

  echo "$percent"
}

trigger_alert() {
  local percent="$1"
  local now=$(date +%s)

  # Check cooldown
  if [ $(( now - last_alert )) -lt "$COOLDOWN" ]; then
    return
  fi

  last_alert=$now
  local timestamp=$(date '+%Y-%m-%d_%H%M%S')

  # Save the motion frame
  cp "$WORK_DIR/current.jpg" "$CAPTURES_DIR/motion-${timestamp}.jpg"

  log "ALERT: Motion detected (${percent}% change) - saved motion-${timestamp}.jpg"

  # Write alert file for other processes to pick up
  echo "${timestamp}|${percent}" > /tmp/motion-alert

  # Keep only last 50 captures
  ls -t "$CAPTURES_DIR"/motion-*.jpg 2>/dev/null | tail -n +51 | xargs rm -f 2>/dev/null
}

cleanup() {
  rm -f "$WORK_DIR/previous.jpg" "$WORK_DIR/current.jpg"
  log "Motion detection stopped"
  exit 0
}

trap cleanup SIGTERM SIGINT

log "Motion detection started (threshold=${THRESHOLD}%, cooldown=${COOLDOWN}s, night_only=${NIGHT_ONLY})"

while true; do
  # Check if we should be running
  if [ "$NIGHT_ONLY" = "true" ] && ! is_nighttime; then
    sleep 60
    continue
  fi

  # Check stream is active
  if [ ! -f "$STREAM" ]; then
    sleep "$CHECK_INTERVAL"
    continue
  fi

  local age=$(( $(date +%s) - $(stat -c %Y "$STREAM") ))
  if [ "$age" -gt 30 ]; then
    sleep "$CHECK_INTERVAL"
    continue
  fi

  # Move current to previous
  if [ -f "$WORK_DIR/current.jpg" ]; then
    mv "$WORK_DIR/current.jpg" "$WORK_DIR/previous.jpg"
  fi

  # Grab new frame
  if ! grab_frame "$WORK_DIR/current.jpg"; then
    sleep "$CHECK_INTERVAL"
    continue
  fi

  # Compare if we have two frames
  if [ -f "$WORK_DIR/previous.jpg" ]; then
    percent=$(compare_frames "$WORK_DIR/previous.jpg" "$WORK_DIR/current.jpg")
    if [ -n "$percent" ] && [ "$percent" -gt "$THRESHOLD" ]; then
      consecutive_triggers=$((consecutive_triggers + 1))
      if [ "$consecutive_triggers" -ge "$CONFIRM_COUNT" ]; then
        trigger_alert "$percent"
        consecutive_triggers=0
      fi
    else
      consecutive_triggers=0
    fi
  fi

  sleep "$CHECK_INTERVAL"
done
