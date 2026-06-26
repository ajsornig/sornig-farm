#!/bin/bash
# Motion detection for chick cam (Peep Show / cam3)
# Lower threshold than predator detection — captures chick activity
# Saves to chick-album/pending/ for admin approval into public album

STREAM="/home/ajsornig/chicken-stream/public/hls3/stream.m3u8"
CAPTURES_DIR="/home/ajsornig/chicken-stream/public/chick-album"
LOG="/home/ajsornig/chicken-stream/logs/chick-motion.log"
WORK_DIR="/tmp/motion-detect-chicks"

# Lower threshold for small chick movements
THRESHOLD=5          # Percentage of pixels that must change
COOLDOWN=30          # Seconds between captures (more frequent than predator)
CHECK_INTERVAL=10    # Seconds between frame checks
CONFIRM_COUNT=2      # Must detect motion 2 consecutive times
MAX_PENDING=100      # Keep last N pending captures

mkdir -p "$CAPTURES_DIR/pending" "$WORK_DIR" "$(dirname "$LOG")"

last_alert=0
consecutive_triggers=0

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"
}

grab_frame() {
  local output="$1"
  ffmpeg -y -i "$STREAM" -frames:v 1 -vf "scale=640:480" -q:v 3 "$output" 2>/dev/null
  return $?
}

grab_frame_blurred() {
  local output="$1"
  ffmpeg -y -i "$STREAM" -frames:v 1 -vf "scale=320:240,gblur=sigma=2" -q:v 5 "$output" 2>/dev/null
  return $?
}

compare_frames() {
  local frame1="$1"
  local frame2="$2"

  if [ ! -f "$frame1" ] || [ ! -f "$frame2" ]; then
    return 1
  fi

  local diff=$(compare -metric AE "$frame1" "$frame2" /dev/null 2>&1)

  # Total pixels in 320x240 = 76800
  local total=76800
  local percent=$(( (diff * 100) / total ))

  echo "$percent"
}

trigger_alert() {
  local percent="$1"
  local now=$(date +%s)

  if [ $(( now - last_alert )) -lt "$COOLDOWN" ]; then
    return
  fi

  last_alert=$now
  local timestamp=$(date '+%Y-%m-%d_%H%M%S')

  cp "$WORK_DIR/current_clean.jpg" "$CAPTURES_DIR/pending/chick-${timestamp}.jpg"

  log "CAPTURE: Motion detected (${percent}% change) - chick-${timestamp}.jpg"

  # Keep only last MAX_PENDING captures
  ls -t "$CAPTURES_DIR/pending"/chick-*.jpg 2>/dev/null | tail -n +$((MAX_PENDING + 1)) | xargs rm -f 2>/dev/null
}

cleanup() {
  rm -f "$WORK_DIR/previous.jpg" "$WORK_DIR/current_blur.jpg" "$WORK_DIR/current_clean.jpg"
  log "Chick motion detection stopped"
  exit 0
}

trap cleanup SIGTERM SIGINT

log "Chick motion detection started (threshold=${THRESHOLD}%, cooldown=${COOLDOWN}s)"

while true; do
  # Check stream is active
  if [ ! -f "$STREAM" ]; then
    sleep "$CHECK_INTERVAL"
    continue
  fi

  local_age=$(( $(date +%s) - $(stat -c %Y "$STREAM") ))
  if [ "$local_age" -gt 30 ]; then
    sleep "$CHECK_INTERVAL"
    continue
  fi

  # Move current to previous
  if [ -f "$WORK_DIR/current_blur.jpg" ]; then
    mv "$WORK_DIR/current_blur.jpg" "$WORK_DIR/previous.jpg"
  fi

  # Grab blurred frame for comparison, clean frame for saving
  if ! grab_frame_blurred "$WORK_DIR/current_blur.jpg"; then
    sleep "$CHECK_INTERVAL"
    continue
  fi
  grab_frame "$WORK_DIR/current_clean.jpg"

  # Compare blurred frames
  if [ -f "$WORK_DIR/previous.jpg" ]; then
    percent=$(compare_frames "$WORK_DIR/previous.jpg" "$WORK_DIR/current_blur.jpg")
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
