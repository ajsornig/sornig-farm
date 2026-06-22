#!/bin/bash
# Timelapse generator for chicken cams
# Usage:
#   ./timelapse.sh [cam]     - Grab a frame if within capture window
#   ./timelapse.sh --stitch  - Combine both cams into one daily video
#   ./timelapse.sh --weekly  - Compile last 7 days into a single montage

BASE_DIR="/home/ajsornig/chicken-stream"
SUN_SCRIPT="$BASE_DIR/scripts/sun-times.py"
LOG="$BASE_DIR/logs/timelapse.log"
RETENTION_DAYS=7

RUN_FRAMES="$BASE_DIR/timelapse/frames"
COOP_FRAMES="$BASE_DIR/timelapse/frames-coop"
OUTPUT_DIR="$BASE_DIR/public/timelapse"

mkdir -p "$RUN_FRAMES" "$COOP_FRAMES" "$OUTPUT_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" >> "$LOG"
}

grab_frame() {
  local cam="${1:-run}"
  local stream frames_dir sun_check

  case "$cam" in
    coop)
      stream="$BASE_DIR/public/hls2/stream.m3u8"
      frames_dir="$COOP_FRAMES"
      sun_check="check-coop"
      ;;
    *)
      stream="$BASE_DIR/public/hls/stream.m3u8"
      frames_dir="$RUN_FRAMES"
      sun_check="check-run"
      ;;
  esac

  # Check privacy mode (admin kill switch)
  if [ -f "$BASE_DIR/.privacy-mode" ]; then
    exit 0
  fi

  # Check if we're in this camera's capture window
  if ! python3 "$SUN_SCRIPT" "$sun_check" 2>/dev/null; then
    exit 0
  fi

  if [ ! -f "$stream" ]; then
    log "[$cam] SKIP: Stream file not found"
    exit 0
  fi

  local age=$(( $(date +%s) - $(stat -c %Y "$stream") ))
  if [ "$age" -gt 30 ]; then
    log "[$cam] SKIP: Stream stale (${age}s old)"
    exit 0
  fi

  local filename="$(date '+%Y-%m-%d_%H%M').jpg"
  ffmpeg -y -i "$stream" -frames:v 1 -q:v 3 "$frames_dir/$filename" 2>/dev/null

  if [ $? -eq 0 ] && [ -f "$frames_dir/$filename" ]; then
    log "[$cam] OK: Captured $filename"
  else
    log "[$cam] ERROR: Failed to capture frame"
  fi
}

stitch_combined() {
  local yesterday=$(date -d "yesterday" '+%Y-%m-%d')

  # Count all frames from both cameras
  local filelist=$(mktemp)
  local frame_count=0

  for f in $(ls "$RUN_FRAMES/${yesterday}_"*.jpg "$COOP_FRAMES/${yesterday}_"*.jpg 2>/dev/null); do
    frame_count=$((frame_count + 1))
  done

  if [ "$frame_count" -lt 10 ]; then
    log "[stitch] SKIP: Only $frame_count total frames for $yesterday, need at least 10"
    rm -f "$COOP_FRAMES/${yesterday}_"*.jpg "$RUN_FRAMES/${yesterday}_"*.jpg
    rm -f "$filelist"
    return
  fi

  # Dynamic fps: target 37 seconds (middle of 30-45), clamp 3-15fps
  local target_duration=37
  local fps=$(echo "$frame_count $target_duration" | awk '{r=int($1/$2); if(r<3) r=3; if(r>15) r=15; print r}')
  local duration=$(echo "$frame_count $fps" | awk '{printf "%.0f", $1/$2}')
  local frame_dur=$(echo "$fps" | awk '{printf "%.4f", 1/$1}')

  log "[stitch] $frame_count frames, fps=$fps, estimated duration=${duration}s"

  # Build file list: all run frames first, then all coop frames (each sorted by time)
  for f in $(ls "$RUN_FRAMES/${yesterday}_"*.jpg 2>/dev/null | sort); do
    echo "file '$f'"
    echo "duration $frame_dur"
  done > "$filelist"
  for f in $(ls "$COOP_FRAMES/${yesterday}_"*.jpg 2>/dev/null | sort); do
    echo "file '$f'"
    echo "duration $frame_dur"
  done >> "$filelist"

  local output="${OUTPUT_DIR}/timelapse-${yesterday}.mp4"

  ffmpeg -y -f concat -safe 0 -i "$filelist" \
    -vf "scale=1280:960" \
    -c:v libx264 -crf 23 -preset medium \
    -r "$fps" -pix_fmt yuv420p \
    -movflags +faststart \
    "$output" 2>/dev/null

  if [ $? -eq 0 ] && [ -f "$output" ]; then
    log "[stitch] OK: Stitched $frame_count frames (${fps}fps, ~${duration}s) into timelapse-${yesterday}.mp4"
    rm -f "$COOP_FRAMES/${yesterday}_"*.jpg "$RUN_FRAMES/${yesterday}_"*.jpg
  else
    log "[stitch] ERROR: Failed to stitch timelapse for $yesterday"
  fi

  rm -f "$filelist"
  find "$OUTPUT_DIR" -name "timelapse-*.mp4" -mtime +"$RETENTION_DAYS" -delete
}

stitch_weekly() {
  local temp_dir=$(mktemp -d)
  local filelist="$temp_dir/concat.txt"
  local idx=0

  # Find all daily timelapses, sorted chronologically
  for video in $(ls "$OUTPUT_DIR"/timelapse-20*.mp4 2>/dev/null | sort); do
    local date_str=$(basename "$video" .mp4 | sed 's/timelapse-//')
    local label=$(date -d "$date_str" '+%a, %b %-d')

    local temp_out="$temp_dir/segment_${idx}.mp4"

    ffmpeg -y -i "$video" \
      -vf "drawtext=text='${label}':fontsize=28:fontcolor=white:x=20:y=h-50:shadowcolor=black@0.3:shadowx=1:shadowy=1" \
      -c:v libx264 -crf 23 -preset medium \
      -pix_fmt yuv420p \
      "$temp_out" 2>/dev/null

    if [ $? -eq 0 ]; then
      echo "file '$temp_out'" >> "$filelist"
      idx=$((idx + 1))
    fi
  done

  if [ "$idx" -lt 2 ]; then
    log "[weekly] SKIP: Only $idx daily videos available, need at least 2"
    rm -rf "$temp_dir"
    return
  fi

  local output="$OUTPUT_DIR/timelapse-weekly.mp4"

  ffmpeg -y -f concat -safe 0 -i "$filelist" \
    -c copy \
    -movflags +faststart \
    "$output" 2>/dev/null

  if [ $? -eq 0 ] && [ -f "$output" ]; then
    log "[weekly] OK: Compiled $idx days into weekly montage"
  else
    log "[weekly] ERROR: Failed to create weekly montage"
  fi

  rm -rf "$temp_dir"
}

# Parse args
case "$1" in
  --stitch)
    stitch_combined
    ;;
  --weekly)
    stitch_weekly
    ;;
  *)
    grab_frame "${1:-run}"
    ;;
esac
