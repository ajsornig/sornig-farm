#!/bin/bash
# Chick Growth Timelapse — picks 5 candidate frames from yesterday's chick
# motion-capture frames, auto-selects the middle one as the day's growth
# photo, and (re)builds the permanent growth timelapse video.
#
# Usage:
#   chick-growth-pick.sh            # daily pick (run via cron at 00:05)
#   chick-growth-pick.sh --stitch   # rebuild the growth video only

BASE_DIR="/home/ajsornig/chicken-stream"
LOG="$BASE_DIR/logs/chick-growth.log"
FRAMES_DIR="$BASE_DIR/motion-timelapse/frames-chick"
GROWTH_DIR="$BASE_DIR/public/chick-growth"
PENDING_DIR="$GROWTH_DIR/pending"

mkdir -p "$GROWTH_DIR" "$PENDING_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [chick-growth] $1" >> "$LOG"
}

pick_frames() {
  local yesterday=$(date -d "yesterday" '+%Y-%m-%d')

  local frames=($(ls "$FRAMES_DIR/${yesterday}_"*.jpg 2>/dev/null | sort))
  local count=${#frames[@]}

  if [ "$count" -eq 0 ]; then
    log "no frames for $yesterday"
    return
  fi

  # Pick up to 5 evenly spaced candidates at 1/6, 2/6, 3/6, 4/6, 5/6 through
  # the sorted list. If fewer than 5 frames exist, use what's available.
  local picks=()
  local n=5
  if [ "$count" -lt 5 ]; then
    n=$count
  fi

  for i in $(seq 1 $n); do
    local idx
    if [ "$count" -lt 5 ]; then
      idx=$((i - 1))
    else
      idx=$(( (i * count) / 6 ))
      if [ "$idx" -ge "$count" ]; then
        idx=$((count - 1))
      fi
    fi
    picks+=("${frames[$idx]}")
  done

  local saved=0
  for i in "${!picks[@]}"; do
    local num=$((i + 1))
    cp "${picks[$i]}" "$PENDING_DIR/${yesterday}_${num}.jpg"
    saved=$((saved + 1))
  done

  log "saved $saved candidate(s) for $yesterday from $count frames"

  # Auto-select the middle candidate (#3, or the middle of however many we got)
  local middle_index=$(( (saved + 1) / 2 ))
  if [ "$middle_index" -lt 1 ]; then
    middle_index=1
  fi
  if [ -f "$PENDING_DIR/${yesterday}_${middle_index}.jpg" ]; then
    cp "$PENDING_DIR/${yesterday}_${middle_index}.jpg" "$GROWTH_DIR/${yesterday}.jpg"
    log "auto-selected candidate #${middle_index} for $yesterday"
  else
    log "ERROR: expected candidate #${middle_index} not found for $yesterday"
  fi

  stitch_growth
}

stitch_growth() {
  local frames=($(ls "$GROWTH_DIR"/*.jpg 2>/dev/null | grep -E '/[0-9]{4}-[0-9]{2}-[0-9]{2}\.jpg$' | sort))
  local count=${#frames[@]}

  if [ "$count" -lt 3 ]; then
    log "[stitch] SKIP: Only $count chosen frame(s), need at least 3"
    return
  fi

  local filelist=$(mktemp)
  local fps="2"
  local frame_dur="0.5"

  for f in "${frames[@]}"; do
    local basefile=$(basename "$f" .jpg)
    local label=$(date -d "$basefile" '+%b %-d' 2>/dev/null)
    if [ -z "$label" ]; then
      label="$basefile"
    fi

    echo "file '$f'" >> "$filelist"
    echo "duration $frame_dur" >> "$filelist"
  done
  # ffmpeg concat demuxer requires the last file repeated without a duration
  echo "file '${frames[-1]}'" >> "$filelist"

  local output="$GROWTH_DIR/chick-growth.mp4"
  local tmp_output=$(mktemp --suffix=.mp4)

  # Build a drawtext filter that overlays each frame's date. Since the
  # concat demuxer doesn't expose per-segment metadata to drawtext easily,
  # render per-frame labeled stills first, then concat those.
  local label_dir=$(mktemp -d)
  local concat_list=$(mktemp)
  local idx=0

  for f in "${frames[@]}"; do
    local basefile=$(basename "$f" .jpg)
    local label=$(date -d "$basefile" '+%b %-d' 2>/dev/null)
    if [ -z "$label" ]; then
      label="$basefile"
    fi
    local labeled="$label_dir/frame_${idx}.jpg"

    ffmpeg -y -i "$f" \
      -vf "scale=1280:960,drawtext=text='${label}':fontsize=36:fontcolor=white:borderw=2:bordercolor=black:x=(w-tw)/2:y=h-60" \
      -frames:v 1 \
      "$labeled" 2>/dev/null

    if [ -f "$labeled" ]; then
      echo "file '$labeled'" >> "$concat_list"
      echo "duration $frame_dur" >> "$concat_list"
      idx=$((idx + 1))
    fi
  done

  if [ "$idx" -gt 0 ]; then
    echo "file '$label_dir/frame_$((idx - 1)).jpg'" >> "$concat_list"
  fi

  if [ "$idx" -lt 3 ]; then
    log "[stitch] ERROR: Only labeled $idx frame(s) successfully, need at least 3"
    rm -f "$filelist" "$concat_list"
    rm -rf "$label_dir"
    rm -f "$tmp_output"
    return
  fi

  ffmpeg -y -f concat -safe 0 -i "$concat_list" \
    -vf "scale=1280:960" \
    -c:v libx264 -crf 23 -preset medium \
    -r "$fps" -pix_fmt yuv420p \
    -movflags +faststart \
    "$tmp_output" 2>/dev/null

  if [ $? -eq 0 ] && [ -f "$tmp_output" ]; then
    mv "$tmp_output" "$output"
    log "[stitch] OK: Stitched $idx frames (${fps}fps) into chick-growth.mp4"
  else
    log "[stitch] ERROR: Failed to stitch chick-growth.mp4"
    rm -f "$tmp_output"
  fi

  rm -f "$filelist" "$concat_list"
  rm -rf "$label_dir"
}

case "$1" in
  --stitch)
    stitch_growth
    ;;
  *)
    pick_frames
    ;;
esac
