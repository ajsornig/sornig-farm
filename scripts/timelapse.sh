#!/bin/bash
# Timelapse generator for chicken cam
# Usage:
#   ./timelapse.sh          - Grab a single frame
#   ./timelapse.sh --stitch - Stitch yesterday's frames into a video + cleanup

STREAM="/home/ajsornig/chicken-stream/public/hls/stream.m3u8"
FRAMES_DIR="/home/ajsornig/chicken-stream/timelapse/frames"
OUTPUT_DIR="/home/ajsornig/chicken-stream/public/timelapse"
LOG="/home/ajsornig/chicken-stream/logs/timelapse.log"
RETENTION_DAYS=7

mkdir -p "$FRAMES_DIR" "$OUTPUT_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"
}

grab_frame() {
  if [ ! -f "$STREAM" ]; then
    log "SKIP: Stream file not found"
    exit 0
  fi

  # Check stream is fresh (modified in last 30 seconds)
  local age=$(( $(date +%s) - $(stat -c %Y "$STREAM") ))
  if [ "$age" -gt 30 ]; then
    log "SKIP: Stream stale (${age}s old)"
    exit 0
  fi

  local filename="$(date '+%Y-%m-%d_%H%M').jpg"
  ffmpeg -y -i "$STREAM" -frames:v 1 -q:v 3 "$FRAMES_DIR/$filename" 2>/dev/null

  if [ $? -eq 0 ] && [ -f "$FRAMES_DIR/$filename" ]; then
    log "OK: Captured $filename"
  else
    log "ERROR: Failed to capture frame"
  fi
}

stitch_day() {
  local yesterday=$(date -d "yesterday" '+%Y-%m-%d')
  local pattern="${FRAMES_DIR}/${yesterday}_*.jpg"
  local frame_count=$(ls $pattern 2>/dev/null | wc -l)

  if [ "$frame_count" -lt 10 ]; then
    log "SKIP: Only $frame_count frames for $yesterday, need at least 10"
    rm -f $pattern
    return
  fi

  local output="${OUTPUT_DIR}/timelapse-${yesterday}.mp4"

  # Create file list for ffmpeg (10fps = each frame shows for 0.1s)
  local filelist=$(mktemp)
  ls $pattern | sort | while read f; do
    echo "file '$f'"
    echo "duration 0.1"
  done > "$filelist"

  ffmpeg -y -f concat -safe 0 -i "$filelist" \
    -vf "scale=1280:960" \
    -c:v libx264 -crf 23 -preset medium \
    -r 10 -pix_fmt yuv420p \
    "$output" 2>/dev/null

  if [ $? -eq 0 ] && [ -f "$output" ]; then
    log "OK: Stitched $frame_count frames into timelapse-${yesterday}.mp4"
    rm -f $pattern
  else
    log "ERROR: Failed to stitch timelapse for $yesterday"
  fi

  rm -f "$filelist"

  # Cleanup old timelapses
  find "$OUTPUT_DIR" -name "timelapse-*.mp4" -mtime +"$RETENTION_DAYS" -delete
  log "Cleanup: removed timelapses older than ${RETENTION_DAYS} days"
}

case "${1:-}" in
  --stitch)
    stitch_day
    ;;
  *)
    grab_frame
    ;;
esac
