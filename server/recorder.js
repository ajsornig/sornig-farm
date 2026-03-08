const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const config = require('../config.json');

const recordingsDir = path.join(__dirname, '../recordings');
const activeRecordings = new Map();

function ensureRecordingsDir() {
  if (!fs.existsSync(recordingsDir)) {
    fs.mkdirSync(recordingsDir, { recursive: true });
  }
}

function startRecording(cameraId) {
  const camera = config.cameras.find(c => c.id === cameraId);
  if (!camera) {
    throw new Error(`Camera ${cameraId} not found`);
  }

  if (activeRecordings.has(cameraId)) {
    console.log(`Already recording ${cameraId}`);
    return;
  }

  ensureRecordingsDir();

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${cameraId}_${timestamp}.mp4`;
  const outputPath = path.join(recordingsDir, filename);

  const ffmpeg = spawn('ffmpeg', [
    '-i', camera.streamUrl,
    '-c', 'copy',
    '-t', '3600',
    '-y',
    outputPath
  ]);

  ffmpeg.stderr.on('data', (data) => {
    console.log(`[${cameraId}] ${data}`);
  });

  ffmpeg.on('close', (code) => {
    console.log(`Recording ${cameraId} ended with code ${code}`);
    activeRecordings.delete(cameraId);
  });

  activeRecordings.set(cameraId, { process: ffmpeg, filename });
  console.log(`Started recording ${cameraId} to ${filename}`);

  return filename;
}

function stopRecording(cameraId) {
  const recording = activeRecordings.get(cameraId);
  if (!recording) {
    return false;
  }

  recording.process.stdin.write('q');
  activeRecordings.delete(cameraId);
  return true;
}

function cleanupOldRecordings() {
  ensureRecordingsDir();

  const retentionMs = config.recording.retentionDays * 24 * 60 * 60 * 1000;
  const now = Date.now();

  const files = fs.readdirSync(recordingsDir);
  let deletedCount = 0;

  for (const file of files) {
    const filepath = path.join(recordingsDir, file);
    const stats = fs.statSync(filepath);
    const age = now - stats.mtimeMs;

    if (age > retentionMs) {
      fs.unlinkSync(filepath);
      deletedCount++;
      console.log(`Deleted old recording: ${file}`);
    }
  }

  return deletedCount;
}

function scheduleCleanup() {
  cleanupOldRecordings();
  setInterval(cleanupOldRecordings, 60 * 60 * 1000);
}

function getActiveRecordings() {
  return Array.from(activeRecordings.entries()).map(([id, data]) => ({
    cameraId: id,
    filename: data.filename
  }));
}

module.exports = {
  startRecording,
  stopRecording,
  cleanupOldRecordings,
  scheduleCleanup,
  getActiveRecordings
};
