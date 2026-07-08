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

  # Prune old dailies first so it happens even when the stitch is skipped
  find "$OUTPUT_DIR" -name "motion-timelapse-20*.mp4" -mtime +"$RETENTION_DAYS" -delete

  # Frames normally die right after their day is stitched, but a missed cron
  # run (e.g. 2026-06-30) orphans that day's frames forever — sweep them here.
  find "$RUN_FRAMES" "$COOP_FRAMES" "$CHICK_FRAMES" -name "20*.jpg" -mtime +"$RETENTION_DAYS" -delete

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
}

stitch_weekly() {
  local segments_dir="$BASE_DIR/motion-timelapse/weekly-segments"
  mkdir -p "$segments_dir"

  local filelist=$(mktemp)
  local idx=0
  local encoded=0

  # Rolling week: newest 7 daily videos only (prune lag can leave an 8th on disk)
  local selected=$(ls "$OUTPUT_DIR"/motion-timelapse-20*.mp4 2>/dev/null | sort | tail -n "$RETENTION_DAYS")

  for video in $selected; do
    local date_str=$(basename "$video" .mp4 | sed 's/motion-timelapse-//')
    local segment="$segments_dir/segment_${date_str}.mp4"

    # Labeling forces a full re-encode, so cache the labeled segment per date
    # and only encode days not seen before. nice + 2 threads keeps CPU under
    # the infra-alert critical threshold (80%).
    if [ ! -f "$segment" ] || [ "$video" -nt "$segment" ]; then
      local label=$(date -d "$date_str" '+%a, %b %-d')
      nice -n 19 ffmpeg -y -i "$video" \
        -vf "drawtext=text='${label}':fontsize=28:fontcolor=white:x=20:y=h-50:shadowcolor=black@0.3:shadowx=1:shadowy=1" \
        -c:v libx264 -crf 23 -preset medium -threads 2 \
        -pix_fmt yuv420p \
        "$segment" 2>/dev/null

      if [ $? -ne 0 ]; then
        log "[weekly] WARN: Failed to label segment for $date_str, skipping"
        rm -f "$segment"
        continue
      fi
      encoded=$((encoded + 1))
    fi

    echo "file '$segment'" >> "$filelist"
    idx=$((idx + 1))
  done

  # Drop cached segments that fell out of the rolling week
  for segment in "$segments_dir"/segment_*.mp4; do
    [ -f "$segment" ] || continue
    local seg_date=$(basename "$segment" .mp4 | sed 's/segment_//')
    echo "$selected" | grep -q "motion-timelapse-${seg_date}.mp4" || rm -f "$segment"
  done

  if [ "$idx" -lt 2 ]; then
    log "[weekly] SKIP: Only $idx daily videos available, need at least 2"
    rm -f "$filelist"
    return
  fi

  local output="$OUTPUT_DIR/motion-timelapse-weekly.mp4"

  ffmpeg -y -f concat -safe 0 -i "$filelist" \
    -c copy \
    -movflags +faststart \
    "$output" 2>/dev/null

  if [ $? -eq 0 ] && [ -f "$output" ]; then
    log "[weekly] OK: Compiled $idx days into weekly montage ($encoded newly encoded)"
  else
    log "[weekly] ERROR: Failed to create weekly montage"
  fi

  rm -f "$filelist"
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
