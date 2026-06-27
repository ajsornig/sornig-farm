#!/bin/bash
# Motion Highlights — picks 5 candidate frames per cam from yesterday's
# motion-capture frames, saves them for a 7-day review window.
# Admin can star/favorite any highlight before auto-cleanup.
#
# Runs via cron at 00:06 (before stitch at 00:10 deletes yesterday's frames).

BASE_DIR="/home/ajsornig/chicken-stream"
LOG="$BASE_DIR/logs/motion-timelapse.log"
HIGHLIGHTS_DIR="$BASE_DIR/public/highlights"
FAVORITES_DIR="$BASE_DIR/public/favorites"

mkdir -p "$HIGHLIGHTS_DIR"

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [highlights] $1" >> "$LOG"
}

pick_highlights() {
  local yesterday=$(date -d "yesterday" '+%Y-%m-%d')

  for cam in run coop chick; do
    local frames_dir="$BASE_DIR/motion-timelapse/frames-${cam}"
    local frames=($(ls "$frames_dir/${yesterday}_"*.jpg 2>/dev/null | sort))
    local count=${#frames[@]}

    if [ "$count" -eq 0 ]; then
      log "$cam: no frames for $yesterday"
      continue
    fi

    local n=5
    if [ "$count" -lt 5 ]; then
      n=$count
    fi

    local saved=0
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
      local src="${frames[$idx]}"
      local base=$(basename "$src")
      cp "$src" "$HIGHLIGHTS_DIR/${cam}_${base}"
      saved=$((saved + 1))
    done

    log "$cam: saved $saved highlight(s) for $yesterday from $count frames"
  done
}

cleanup_old() {
  local cutoff=$(date -d "7 days ago" '+%Y-%m-%d')

  for f in "$HIGHLIGHTS_DIR"/*.jpg; do
    [ -f "$f" ] || continue
    local base=$(basename "$f")
    local date_part=$(echo "$base" | grep -oP '\d{4}-\d{2}-\d{2}')
    if [ -n "$date_part" ] && [[ "$date_part" < "$cutoff" ]]; then
      local fav_name=$(basename "$f")
      if [ ! -f "$FAVORITES_DIR/$fav_name" ]; then
        rm "$f"
        log "cleanup: removed old highlight $base"
      fi
    fi
  done
}

pick_highlights
cleanup_old
