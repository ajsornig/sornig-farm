#!/bin/bash
# Stitches motion-captured frames (run, coop, chick) into a daily timelapse video.
# Same encoding profile as timelapse.sh, but sourced from motion-filtered frames.
# Usage:
#   motion-timelapse-stitch.sh --stitch
#   motion-timelapse-stitch.sh --weekly

BASE_DIR="/home/ajsornig/chicken-stream"
LOG="$BASE_DIR/logs/motion-timelapse.log"
RETENTION_DAYS=7

RUN_FRAMES="$BASE_DIR/motion-timelapse/frames-run"
COOP_FRAMES="$BASE_DIR/motion-timelapse/frames-coop"
CHICK_FRAMES="$BASE_DIR/motion-timelapse/frames-chick"
OUTPUT_DIR="$BASE_DIR/public/motion-timelapse"

mkdir -p "$RUN_FRAMES" "$COOP_FRAMES" "$CHICK_FRAMES" "$OUTPUT_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [stitch] $1" >> "$LOG"
}

stitch_combined() {
  local yesterday=$(date -d "yesterday" '+%Y-%m-%d')

  local run_count=$(ls "$RUN_FRAMES/${yesterday}_"*.jpg 2>/dev/null | wc -l)
  local coop_count=$(ls "$COOP_FRAMES/${yesterday}_"*.jpg 2>/dev/null | wc -l)
  local chick_count=$(ls "$CHICK_FRAMES/${yesterday}_"*.jpg 2>/dev/null | wc -l)
  local frame_count=$(( run_count + coop_count + chick_count ))

  if [ "$frame_count" -lt 10 ]; then
    log "SKIP: Only $frame_count total frames for $yesterday (run=$run_count coop=$coop_count chick=$chick_count), need at least 10"
    rm -f "$RUN_FRAMES/${yesterday}_"*.jpg "$COOP_FRAMES/${yesterday}_"*.jpg "$CHICK_FRAMES/${yesterday}_"*.jpg
    return
  fi

  # Dynamic fps: target 37 seconds (middle of 30-45), clamp 3-15fps
  local target_duration=37
  local fps=$(echo "$frame_count $target_duration" | awk '{r=int($1/$2); if(r<3) r=3; if(r>15) r=15; print r}')
  local duration=$(echo "$frame_count $fps" | awk '{printf "%.0f", $1/$2}')
  local frame_dur=$(echo "$fps" | awk '{printf "%.4f", 1/$1}')

  log "$frame_count frames (run=$run_count coop=$coop_count chick=$chick_count), fps=$fps, estimated duration=${duration}s"

  local filelist=$(mktemp)

  # Build file list: all run frames first, then coop, then chick (each sorted by time)
  for f in $(ls "$RUN_FRAMES/${yesterday}_"*.jpg 2>/dev/null | sort); do
    echo "file '$f'"
    echo "duration $frame_dur"
  done > "$filelist"
  for f in $(ls "$COOP_FRAMES/${yesterday}_"*.jpg 2>/dev/null | sort); do
    echo "file '$f'"
    echo "duration $frame_dur"
  done >> "$filelist"
  for f in $(ls "$CHICK_FRAMES/${yesterday}_"*.jpg 2>/dev/null | sort); do
    echo "file '$f'"
    echo "duration $frame_dur"
  done >> "$filelist"

  local output="${OUTPUT_DIR}/motion-timelapse-${yesterday}.mp4"

  ffmpeg -y -f concat -safe 0 -i "$filelist" \
    -vf "scale=1280:960" \
    -c:v libx264 -crf 23 -preset medium \
    -r "$fps" -pix_fmt yuv420p \
    -movflags +faststart \
    "$output" 2>/dev/null

  if [ $? -eq 0 ] && [ -f "$output" ]; then
    log "OK: Stitched $frame_count frames (${fps}fps, ~${duration}s) into motion-timelapse-${yesterday}.mp4 (run=$run_count coop=$coop_count chick=$chick_count)"
    rm -f "$RUN_FRAMES/${yesterday}_"*.jpg "$COOP_FRAMES/${yesterday}_"*.jpg "$CHICK_FRAMES/${yesterday}_"*.jpg
  else
    log "ERROR: Failed to stitch motion-timelapse for $yesterday"
  fi

  rm -f "$filelist"
  find "$OUTPUT_DIR" -name "motion-timelapse-20*.mp4" -mtime +"$RETENTION_DAYS" -delete
}

stitch_weekly() {
  local temp_dir=$(mktemp -d)
  local filelist="$temp_dir/concat.txt"
  local idx=0

  for video in $(ls "$OUTPUT_DIR"/motion-timelapse-20*.mp4 2>/dev/null | sort); do
    local date_str=$(basename "$video" .mp4 | sed 's/motion-timelapse-//')
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

  local output="$OUTPUT_DIR/motion-timelapse-weekly.mp4"

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

case "$1" in
  --stitch)
    stitch_combined
    ;;
  --weekly)
    stitch_weekly
    ;;
  *)
    echo "Usage: $0 --stitch|--weekly"
    exit 1
    ;;
esac
