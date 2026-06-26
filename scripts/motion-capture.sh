#!/bin/bash
# Unified motion-capture timelapse — grabs a frame only when something changed.
# Same RMSE comparison method as motion-detect-chicks.sh, applied to all 3 cams.
# Usage: motion-capture.sh <run|coop|chick>

BASE_DIR="/home/ajsornig/chicken-stream"
LOG="$BASE_DIR/logs/motion-timelapse.log"
STATS_LOG="$BASE_DIR/logs/motion-capture-stats.log"

CAM="${1:-run}"

case "$CAM" in
  coop)
    STREAM="$BASE_DIR/public/hls2/stream.m3u8"
    THRESHOLD="0.025"
    FRAMES_DIR="$BASE_DIR/motion-timelapse/frames-coop"
    ;;
  chick)
    STREAM="$BASE_DIR/public/hls3/stream.m3u8"
    THRESHOLD="0.03"
    FRAMES_DIR="$BASE_DIR/motion-timelapse/frames-chick"
    ;;
  *)
    CAM="run"
    STREAM="$BASE_DIR/public/hls/stream.m3u8"
    THRESHOLD="0.025"
    FRAMES_DIR="$BASE_DIR/motion-timelapse/frames-run"
    ;;
esac

WORK_DIR="/tmp/motion-capture-${CAM}"

mkdir -p "$FRAMES_DIR" "$WORK_DIR" "$(dirname "$LOG")"

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

# Check privacy mode (admin kill switch)
if [ -f "$BASE_DIR/.privacy-mode" ]; then
  exit 0
fi

if [ ! -f "$STREAM" ]; then
  log "SKIP: Stream file not found"
  exit 0
fi

age=$(( $(date +%s) - $(stat -c %Y "$STREAM") ))
if [ "$age" -gt 30 ]; then
  log "SKIP: Stream stale (${age}s old)"
  exit 0
fi

if ! ffmpeg -y -i "$STREAM" -frames:v 1 -vf "scale=160:120,gblur=sigma=5" -q:v 5 "$WORK_DIR/current_blur.jpg" 2>/dev/null; then
  log "ERROR: Failed to grab comparison frame"
  exit 0
fi

# First-run bootstrap: no previous frame yet, just save current and exit
if [ ! -f "$WORK_DIR/previous.jpg" ]; then
  cp "$WORK_DIR/current_blur.jpg" "$WORK_DIR/previous.jpg"
  log "OK: First frame, bootstrapping previous reference"
  exit 0
fi

rmse=$(compare_frames "$WORK_DIR/previous.jpg" "$WORK_DIR/current_blur.jpg")

if [ -z "$rmse" ]; then
  log "ERROR: Failed to compare frames"
  cp "$WORK_DIR/current_blur.jpg" "$WORK_DIR/previous.jpg"
  exit 0
fi

if exceeds_threshold "$rmse"; then
  filename="$(date '+%Y-%m-%d_%H%M').jpg"
  ffmpeg -y -i "$STREAM" -frames:v 1 -q:v 3 "$FRAMES_DIR/$filename" 2>/dev/null

  if [ $? -eq 0 ] && [ -f "$FRAMES_DIR/$filename" ]; then
    log "CAPTURE: Motion detected (RMSE=${rmse}) - $filename"
    stat_log "captured" "$rmse"
  else
    log "ERROR: Failed to capture clean frame"
  fi
else
  stat_log "skipped" "$rmse"
fi

cp "$WORK_DIR/current_blur.jpg" "$WORK_DIR/previous.jpg"
