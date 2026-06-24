#!/bin/bash
BACKUP_DIR="/home/ajsornig/chicken-stream/backups"
DATA_FILE="/home/ajsornig/chicken-stream/data.json"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
MAX_BACKUPS=30

if [ -f "$DATA_FILE" ]; then
  cp "$DATA_FILE" "$BACKUP_DIR/data_${TIMESTAMP}.json"
  # Keep only the most recent backups
  ls -t "$BACKUP_DIR"/data_*.json 2>/dev/null | tail -n +$((MAX_BACKUPS + 1)) | xargs -r rm
  echo "Backup created: data_${TIMESTAMP}.json"
else
  echo "No data.json found to backup"
fi
