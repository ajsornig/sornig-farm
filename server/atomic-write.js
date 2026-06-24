const fs = require('fs');
const path = require('path');

// Write JSON atomically: serialize to a temp file in the same directory, then
// rename it over the target. rename(2) is atomic on the same filesystem, so a
// crash or power loss mid-write can never leave a half-written / truncated file.
// Previously a power loss on the Pi while saving data.json could corrupt it and
// wipe every account + session on the next boot.
function atomicWriteJSON(file, obj) {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.tmp`);
  const json = JSON.stringify(obj, null, 2);

  try {
    // Write the temp file and flush its data to disk BEFORE renaming. Without
    // the fsync, rename atomicity alone doesn't survive power loss: the rename
    // metadata can land while the file's data blocks are still in the page
    // cache, leaving a zero-length/garbage file on next boot.
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, json);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmp, file);

    // Flush the directory so the rename itself is durable. Not supported on all
    // platforms (e.g. Windows dev) — best-effort; the temp fsync is what matters
    // on the Pi's ext4.
    try {
      const dfd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dfd);
      } finally {
        fs.closeSync(dfd);
      }
    } catch (err) {
      // Directory fsync unsupported here; ignore.
    }
  } catch (error) {
    // Don't leave a partial/orphaned temp file behind; surface the real error.
    try { fs.unlinkSync(tmp); } catch (cleanupErr) { /* temp may not exist */ }
    throw error;
  }
}

module.exports = { atomicWriteJSON };
