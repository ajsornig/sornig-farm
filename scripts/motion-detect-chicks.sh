#!/bin/bash
# Motion detection for chick cam (Peep Show / cam3)
# Uses RMSE comparison with heavy blur to ignore compression/IR noise
# Only triggers on actual visible movement (chicks walking, etc.)
# Saves to chick-album/pending/ for admin approval into public album

STREAM="/home/ajsornig/chicken-stream/public/hls3/stream.m3u8"
CAPTURES_DIR="/home/ajsornig/chicken-stream/public/chick-album"
LOG="/home/ajsornig/chicken-stream/logs/chick-motion.log"
WORK_DIR="/tmp/motion-detect-chicks"

# RMSE threshold — 0 means identical, 1 means completely different.
# IR noise + JPEG artifacts sit around 0.01-0.02 on a static scene.
# A chick walking across frame is ~0.04-0.08. Set to 0.03 to catch
# real movement while ignoring noise.
THRESHOLD="0.03"
COOLDOWN=300         # Seconds between captures (5 minutes)
CHECK_INTERVAL=30    # Seconds between frame checks
CONFIRM_COUNT=2      # Must detect motion N consecutive times
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

# Heavy blur + small size to eliminate noise, keep only real movement
grab_frame_blurred() {
  local output="$1"
  ffmpeg -y -i "$STREAM" -frames:v 1 -vf "scale=160:120,gblur=sigma=5" -q:v 5 "$output" 2>/dev/null
  return $?
}

compare_frames() {
  local frame1="$1"
  local frame2="$2"

  if [ ! -f "$frame1" ] || [ ! -f "$frame2" ]; then
    return 1
  fi

  # RMSE returns a normalized value (0-1) representing average pixel difference.
  # Much better than AE (absolute error count) which fires on noise.
  # Output format: "1234.56 (0.0188)" — we grab the normalized value in parens.
  local raw=$(compare -metric RMSE "$frame1" "$frame2" /dev/null 2>&1)
  local rmse=$(echo "$raw" | grep -oP '\([\d.]+\)' | tr -d '()')

  if [ -z "$rmse" ]; then
    return 1
  fi

  echo "$rmse"
}

exceeds_threshold() {
  local val="$1"
  # bc returns 1 if the comparison is true
  local result=$(echo "$val > $THRESHOLD" | bc -l 2>/dev/null)
  [ "$result" = "1" ]
}

trigger_alert() {
  local rmse="$1"
  local now=$(date +%s)

  if [ $(( now - last_alert )) -lt "$COOLDOWN" ]; then
    return
  fi

  last_alert=$now
  local timestamp=$(date '+%Y-%m-%d_%H%M%S')

  cp "$WORK_DIR/current_clean.jpg" "$CAPTURES_DIR/pending/chick-${timestamp}.jpg"

  log "CAPTURE: Motion detected (RMSE=${rmse}) - chick-${timestamp}.jpg"

  # Keep only last MAX_PENDING captures
  ls -t "$CAPTURES_DIR/pending"/chick-*.jpg 2>/dev/null | tail -n +$((MAX_PENDING + 1)) | xargs rm -f 2>/dev/null
}

cleanup() {
  rm -f "$WORK_DIR/previous.jpg" "$WORK_DIR/current_blur.jpg" "$WORK_DIR/current_clean.jpg"
  log "Chick motion detection stopped"
  exit 0
}

trap cleanup SIGTERM SIGINT

log "Motion detection started (method=RMSE, threshold=${THRESHOLD}, blur=sigma5@160x120, cooldown=${COOLDOWN}s)"

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

  # Compare blurred frames using RMSE
  if [ -f "$WORK_DIR/previous.jpg" ]; then
    rmse=$(compare_frames "$WORK_DIR/previous.jpg" "$WORK_DIR/current_blur.jpg")
    if [ -n "$rmse" ]; then
      if exceeds_threshold "$rmse"; then
        consecutive_triggers=$((consecutive_triggers + 1))
        log "DEBUG: RMSE=${rmse} (above ${THRESHOLD}), streak=${consecutive_triggers}/${CONFIRM_COUNT}"
        if [ "$consecutive_triggers" -ge "$CONFIRM_COUNT" ]; then
          trigger_alert "$rmse"
          consecutive_triggers=0
        fi
      else
        if [ "$consecutive_triggers" -gt 0 ]; then
          log "DEBUG: RMSE=${rmse} (below ${THRESHOLD}), streak reset"
        fi
        consecutive_triggers=0
      fi
    fi
  fi

  sleep "$CHECK_INTERVAL"
done
