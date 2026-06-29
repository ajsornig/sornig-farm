#!/bin/bash
# Unified motion-capture timelapse — grabs a frame only when something changed.
# Same RMSE comparison method as motion-detect-chicks.sh, applied to all 3 cams.
# Runs as a loop (systemd service), checks every 30s, 5-min cooldown after capture.
# Usage: motion-capture.sh <run|coop|chick>

BASE_DIR="/home/ajsornig/chicken-stream"
LOG="$BASE_DIR/logs/motion-timelapse.log"
STATS_LOG="$BASE_DIR/logs/motion-capture-stats.log"
SUN_SCRIPT="$BASE_DIR/scripts/sun-times.py"

CHECK_INTERVAL=30
COOLDOWN=300
NIGHT_FALLBACK=1800

CAM="${1:-run}"

case "$CAM" in
  coop)
    STREAM="$BASE_DIR/public/hls2/stream.m3u8"
    THRESHOLD="0.04"
    COOLDOWN=180
    MIN_BRIGHTNESS="0.10"
    FRAMES_DIR="$BASE_DIR/motion-timelapse/frames-coop"
    ;;
  chick)
    STREAM="$BASE_DIR/public/hls3/stream.m3u8"
    THRESHOLD="0.04"
    COOLDOWN=600
    MIN_BRIGHTNESS="0.10"
    FRAMES_DIR="$BASE_DIR/motion-timelapse/frames-chick"
    ;;
  *)
    CAM="run"
    STREAM="$BASE_DIR/public/hls/stream.m3u8"
    THRESHOLD="0.04"
    MIN_BRIGHTNESS="0.30"
    FRAMES_DIR="$BASE_DIR/motion-timelapse/frames-run"
    ;;
esac

WORK_DIR="/tmp/motion-capture-${CAM}"

mkdir -p "$FRAMES_DIR" "$WORK_DIR" "$(dirname "$LOG")"

last_capture=0

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$CAM] $1" >> "$LOG"
}

stat_log() {
  local status="$1"
  local rmse="$2"
  echo "$(date '+%Y-%m-%d')|$CAM|$status|$rmse" >> "$STATS_LOG"
}

compare_frames() {
  local frame1="$1"
  local frame2="$2"

  if [ ! -f "$frame1" ] || [ ! -f "$frame2" ]; then
    return 1
  fi

  local raw=$(compare -metric RMSE "$frame1" "$frame2" /dev/null 2>&1)
  local rmse=$(echo "$raw" | grep -oP '\([\d.]+\)' | tr -d '()')

  if [ -z "$rmse" ]; then
    return 1
  fi

  echo "$rmse"
}

exceeds_threshold() {
  local val="$1"
  local result=$(echo "$val > $THRESHOLD" | bc -l 2>/dev/null)
  [ "$result" = "1" ]
}

cleanup() {
  rm -f "$WORK_DIR/current_blur.jpg"
  log "Motion capture stopped"
  exit 0
}

trap cleanup SIGTERM SIGINT

log "Motion capture started (threshold=${THRESHOLD}, cooldown=${COOLDOWN}s, interval=${CHECK_INTERVAL}s)"

while true; do
  # Check privacy mode
  if [ -f "$BASE_DIR/.privacy-mode" ]; then
    sleep "$CHECK_INTERVAL"
    continue
  fi

  # Check stream exists and is fresh
  if [ ! -f "$STREAM" ]; then
    sleep "$CHECK_INTERVAL"
    continue
  fi

  age=$(( $(date +%s) - $(stat -c %Y "$STREAM") ))
  if [ "$age" -gt 30 ]; then
    sleep "$CHECK_INTERVAL"
    continue
  fi

  # Grab blurred frame for comparison
  if ! ffmpeg -y -i "$STREAM" -frames:v 1 -vf "scale=160:120,gblur=sigma=5" -q:v 5 "$WORK_DIR/current_blur.jpg" 2>/dev/null; then
    sleep "$CHECK_INTERVAL"
    continue
  fi

  # Skip washed-out, pitch-black, or half-exposed frames
  exposure=$(convert "$WORK_DIR/current_blur.jpg" -format "%[fx:mean]|%[fx:standard_deviation]" info: 2>/dev/null)
  if [ -n "$exposure" ]; then
    brightness=$(echo "$exposure" | cut -d'|' -f1)
    stddev=$(echo "$exposure" | cut -d'|' -f2)
    too_bright=$(echo "$brightness > 0.85" | bc -l 2>/dev/null)
    too_dark=$(echo "$brightness < $MIN_BRIGHTNESS" | bc -l 2>/dev/null)
    too_contrasty=$(echo "$stddev > 0.35" | bc -l 2>/dev/null)
    if [ "$too_bright" = "1" ] || [ "$too_dark" = "1" ] || [ "$too_contrasty" = "1" ]; then
      stat_log "skipped_exposure" "$brightness:$stddev"
      sleep "$CHECK_INTERVAL"
      continue
    fi
  fi

  # First-run bootstrap
  if [ ! -f "$WORK_DIR/previous.jpg" ]; then
    cp "$WORK_DIR/current_blur.jpg" "$WORK_DIR/previous.jpg"
    log "First frame, bootstrapping previous reference"
    sleep "$CHECK_INTERVAL"
    continue
  fi

  rmse=$(compare_frames "$WORK_DIR/previous.jpg" "$WORK_DIR/current_blur.jpg")

  if [ -z "$rmse" ]; then
    cp "$WORK_DIR/current_blur.jpg" "$WORK_DIR/previous.jpg"
    sleep "$CHECK_INTERVAL"
    continue
  fi

  if exceeds_threshold "$rmse"; then
    now=$(date +%s)
    if [ $(( now - last_capture )) -ge "$COOLDOWN" ]; then
      filename="$(date '+%Y-%m-%d_%H%M%S').jpg"
      ffmpeg -y -i "$STREAM" -frames:v 1 -q:v 3 "$FRAMES_DIR/$filename" 2>/dev/null

      if [ $? -eq 0 ] && [ -f "$FRAMES_DIR/$filename" ]; then
        log "CAPTURE: Motion detected (RMSE=${rmse}) - $filename"
        stat_log "captured" "$rmse"
        last_capture=$(date +%s)
      else
        log "ERROR: Failed to capture clean frame"
      fi
    else
      stat_log "skipped_cooldown" "$rmse"
    fi
  else
    stat_log "skipped" "$rmse"

    # Coop nighttime fallback: grab one frame per 30 min when birds are sleeping
    if [ "$CAM" = "coop" ] && [ $(( $(date +%s) - last_capture )) -ge "$NIGHT_FALLBACK" ]; then
      if python3 "$SUN_SCRIPT" check-coop 2>/dev/null; then
        filename="$(date '+%Y-%m-%d_%H%M%S').jpg"
        ffmpeg -y -i "$STREAM" -frames:v 1 -q:v 3 "$FRAMES_DIR/$filename" 2>/dev/null

        if [ $? -eq 0 ] && [ -f "$FRAMES_DIR/$filename" ]; then
          log "CAPTURE: Night fallback (no motion for ${NIGHT_FALLBACK}s) - $filename"
          stat_log "captured_night" "$rmse"
          last_capture=$(date +%s)
        fi
      fi
    fi
  fi

  cp "$WORK_DIR/current_blur.jpg" "$WORK_DIR/previous.jpg"
  sleep "$CHECK_INTERVAL"
done
