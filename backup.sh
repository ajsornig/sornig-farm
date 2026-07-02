#!/bin/bash
# Backs up the NON-REGENERABLE data set into a timestamped tarball:
#   - data.json                     (users, sessions, messages, favorites index, totalViews)
#   - data/visited-locations.json   (the permanent worldwide visitor map)
#   - restart-baseline.json         (infra restart counter baseline)
#   - public/chick-growth/          (chosen daily growth pics — the mp4 is regenerable)
#   - public/favorites/             (starred favorite images)
# Regenerable assets (HLS segments, motion frames, timelapse mp4s) are excluded.
#
# Keeps the last MAX_BACKUPS tarballs locally. If BACKUP_REMOTE is set (an rsync
# target — another host "user@host:/path/" or a mounted USB path "/mnt/usb/"),
# also copies the archive OFF the SD card so a card failure doesn't lose it too.
set -u

BASE_DIR="/home/ajsornig/chicken-stream"
BACKUP_DIR="$BASE_DIR/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
MAX_BACKUPS=30
ARCHIVE="$BACKUP_DIR/sornig_${TIMESTAMP}.tar.gz"

mkdir -p "$BACKUP_DIR"
cd "$BASE_DIR" || exit 1

# Include only paths that exist (relative to BASE_DIR for a clean restore).
INCLUDE=()
[ -f data.json ]                    && INCLUDE+=("data.json")
[ -f data/visited-locations.json ]  && INCLUDE+=("data/visited-locations.json")
[ -f restart-baseline.json ]        && INCLUDE+=("restart-baseline.json")
[ -d public/chick-growth ]          && INCLUDE+=("public/chick-growth")
[ -d public/favorites ]             && INCLUDE+=("public/favorites")

if [ ${#INCLUDE[@]} -eq 0 ]; then
  echo "Nothing to back up"
  exit 0
fi

if tar -czf "$ARCHIVE" "${INCLUDE[@]}"; then
  echo "Backup created: $(basename "$ARCHIVE")"
else
  echo "Backup FAILED"
  exit 1
fi

# Prune old local tarballs.
ls -t "$BACKUP_DIR"/sornig_*.tar.gz 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs -r rm

# Off-box copy (survives SD-card death). Inert until BACKUP_REMOTE is set.
#   - Remote target ("user@host:/path")  -> rsync.
#   - Local target (a mounted USB/NAS path) -> cp (works on FAT32/exFAT/ext4),
#     guarded by a .backup-ok marker file so we NEVER write into a bare mountpoint
#     on the SD card if the drive isn't mounted. Old off-box archives are pruned
#     to MAX_BACKUPS just like the local ones.
if [ -n "${BACKUP_REMOTE:-}" ]; then
  DEST="${BACKUP_REMOTE%/}"
  if [[ "$BACKUP_REMOTE" == *:* ]]; then
    if rsync -a "$ARCHIVE" "$BACKUP_REMOTE"; then
      echo "Off-box copy -> $BACKUP_REMOTE"
    else
      echo "WARNING: off-box copy to $BACKUP_REMOTE FAILED"
    fi
  elif [ ! -e "$DEST/.backup-ok" ]; then
    echo "WARNING: off-box target $DEST not ready (.backup-ok missing; drive unmounted?) — skipped"
  elif cp "$ARCHIVE" "$DEST/"; then
    echo "Off-box copy -> $DEST"
    ls -t "$DEST"/sornig_*.tar.gz 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs -r rm -f
  else
    echo "WARNING: off-box copy to $DEST FAILED"
  fi
fi
