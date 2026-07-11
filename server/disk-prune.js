const fs = require('fs');
const path = require('path');

// Emergency safety valve: when the SD card gets critically low, delete the most
// regenerable media first so the box keeps recording instead of wedging. Only
// the three allowlisted sources below are ever touched — never data.json,
// data/, backups/, public/favorites/, public/chick-growth/, or logs.

const REPO_ROOT = path.join(__dirname, '..');

// Run a prune only when free space falls below this hard floor (MB)…
const PRUNE_TRIGGER_FREE_MB = 1024;
// …and delete (oldest/most-regenerable first) until estimated free reaches this (MB).
const PRUNE_TARGET_FREE_MB = 3072;
// Minimum gap between automatic prunes — one emergency sweep, then let it breathe.
const PRUNE_COOLDOWN_MS = 6 * 60 * 60 * 1000;
// Always keep at least this many newest daily timelapse videos.
const KEEP_MIN_DAILY_TIMELAPSES = 2;
// Never delete highlight jpgs newer than this many days.
const KEEP_HIGHLIGHT_DAYS = 2;

const BYTES_PER_MB = 1024 * 1024;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Allowlisted prune sources, in deletion-priority order (cheapest to lose first).
const WEEKLY_SEGMENTS_DIR = path.join(REPO_ROOT, 'motion-timelapse', 'weekly-segments');
const PUBLIC_TIMELAPSE_DIR = path.join(REPO_ROOT, 'public', 'motion-timelapse');
const HIGHLIGHTS_DIR = path.join(REPO_ROOT, 'public', 'highlights');
const WEEKLY_MONTAGE_NAME = 'motion-timelapse-weekly.mp4';

// In-memory cooldown; a restart allows one extra prune early — acceptable.
let lastPruneAt = 0;

// List regular files in `dir` whose names pass `matcher`. lstat (never follows
// symlinks) and a resolved-path containment check keep everything inside the
// allowlisted dir even if a hostile name sneaks into a listing.
function listPrunableFiles(dir, matcher) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`disk-prune: cannot read ${dir}: ${err.message}`);
    return [];
  }
  const resolvedDir = path.resolve(dir);
  const files = [];
  for (const name of names) {
    if (!matcher(name)) continue;
    const filePath = path.join(dir, name);
    if (!path.resolve(filePath).startsWith(resolvedDir + path.sep)) continue; // escaped the dir — skip
    let stat;
    try {
      stat = fs.lstatSync(filePath);
    } catch (err) {
      console.error(`disk-prune: cannot stat ${filePath}: ${err.message}`);
      continue;
    }
    if (!stat.isFile()) continue; // symlinks/dirs are never touched
    files.push({ path: filePath, sizeMb: stat.size / BYTES_PER_MB, mtimeMs: stat.mtimeMs });
  }
  return files;
}

const byOldestFirst = (a, b) => a.mtimeMs - b.mtimeMs;
const tagSource = (source) => (file) => ({ ...file, source });

// Ordered candidate list across the three allowlisted sources.
function collectPruneCandidates(now = Date.now()) {
  // 1. Weekly-montage segment cache — pure regenerable cache, free to drop.
  const segments = listPrunableFiles(WEEKLY_SEGMENTS_DIR, n => /^segment_.*\.mp4$/.test(n))
    .sort(byOldestFirst)
    .map(tagSource('weekly-segments'));

  // 2. The stitched weekly montage, then daily timelapses oldest-first keeping the newest few.
  const weeklyMontage = listPrunableFiles(PUBLIC_TIMELAPSE_DIR, n => n === WEEKLY_MONTAGE_NAME)
    .map(tagSource('weekly-montage'));
  const dailies = listPrunableFiles(PUBLIC_TIMELAPSE_DIR, n => /^motion-timelapse-20.*\.mp4$/.test(n))
    .sort(byOldestFirst);
  const prunableDailies = dailies
    .slice(0, Math.max(0, dailies.length - KEEP_MIN_DAILY_TIMELAPSES))
    .map(tagSource('daily-timelapse'));

  // 3. Highlight stills older than the keep window, oldest-first.
  const highlightCutoffMs = now - KEEP_HIGHLIGHT_DAYS * MS_PER_DAY;
  const highlights = listPrunableFiles(HIGHLIGHTS_DIR, n => /\.jpg$/i.test(n))
    .filter(f => f.mtimeMs < highlightCutoffMs)
    .sort(byOldestFirst)
    .map(tagSource('highlights'));

  return [...segments, ...weeklyMontage, ...prunableDailies, ...highlights];
}

// Pure planner: walk the ordered candidates, accumulating estimated freed space,
// and stop once estimated free space reaches the target. Never plans anything
// when disk metrics are unknown (freeMb null/undefined).
function planDiskPrune({ candidates, freeMb }) {
  if (freeMb === null || freeMb === undefined) return [];
  const plan = [];
  let estimatedFreeMb = freeMb;
  for (const candidate of candidates) {
    if (estimatedFreeMb >= PRUNE_TARGET_FREE_MB) break;
    plan.push(candidate);
    estimatedFreeMb += candidate.sizeMb;
  }
  return plan;
}

// Execute (or dry-run) a prune. Per-file try/catch: one stubborn file never
// aborts the sweep. Returns a summary for logging/alerting.
function runDiskPrune({ dryRun = false, freeMb = null, now = Date.now() } = {}) {
  const candidates = collectPruneCandidates(now);
  const planned = planDiskPrune({ candidates, freeMb });
  const deleted = [];
  const failed = [];
  if (!dryRun) {
    for (const item of planned) {
      try {
        fs.unlinkSync(item.path);
        deleted.push(item);
      } catch (err) {
        console.error(`disk-prune: failed to delete ${item.path}: ${err.message}`);
        failed.push({ ...item, error: err.message });
      }
    }
  }
  const freedMb = Math.round(deleted.reduce((sum, f) => sum + f.sizeMb, 0));
  return { dryRun, freeMbBefore: freeMb, candidateCount: candidates.length, planned, deleted, failed, freedMb };
}

// Poller entry point: prune only when disk metrics are present, below the
// trigger floor, and outside the cooldown window. Returns the summary of a real
// prune, or null when nothing was done.
function maybeRunDiskPrune(system, now = Date.now()) {
  if (!system || system.diskUsed == null || system.diskTotal == null) return null;
  const freeMb = system.diskTotal - system.diskUsed;
  if (freeMb >= PRUNE_TRIGGER_FREE_MB) return null;
  if (now - lastPruneAt < PRUNE_COOLDOWN_MS) return null;
  lastPruneAt = now;
  return runDiskPrune({ dryRun: false, freeMb, now });
}

// Best-effort current free MB from the newest wifi-monitor sample (Node's
// statfs is not guaranteed on the Pi's version, so the monitor log is the
// source of truth for disk numbers). Null when no usable sample exists.
function readFreeMbFromMonitorLog() {
  const { readLogTail, parseInfraLine } = require('./infra');
  let raw;
  try {
    raw = readLogTail(path.join(REPO_ROOT, 'logs', 'wifi-monitor.log'), 64 * 1024);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`disk-prune: cannot read monitor log: ${err.message}`);
    return null;
  }
  const lines = raw.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const entry = parseInfraLine(lines[i]);
    if (entry && entry.system.diskUsed !== null && entry.system.diskTotal !== null) {
      return entry.system.diskTotal - entry.system.diskUsed;
    }
  }
  return null;
}

function runCli() {
  const dryRun = process.argv.includes('--dry-run');
  const freeMb = readFreeMbFromMonitorLog();
  if (freeMb === null && !dryRun) {
    console.error('disk-prune: no disk metrics available (logs/wifi-monitor.log) — refusing a real prune');
    process.exit(1);
  }
  const summary = runDiskPrune({ dryRun, freeMb });
  console.log(`disk-prune ${dryRun ? '(dry run)' : ''}`.trim());
  console.log(`  free space before: ${freeMb === null ? 'unknown' : freeMb + 'MB'} (target ${PRUNE_TARGET_FREE_MB}MB)`);
  console.log(`  candidates found: ${summary.candidateCount}`);
  console.log(`  planned deletions: ${summary.planned.length}`);
  for (const item of summary.planned) {
    console.log(`    [${item.source}] ${item.path} (${item.sizeMb.toFixed(1)}MB)`);
  }
  if (!dryRun) {
    console.log(`  deleted: ${summary.deleted.length}, failed: ${summary.failed.length}, freed ~${summary.freedMb}MB`);
  }
}

if (require.main === module) runCli();

module.exports = {
  planDiskPrune,
  runDiskPrune,
  maybeRunDiskPrune,
  collectPruneCandidates,
  PRUNE_TRIGGER_FREE_MB,
  PRUNE_TARGET_FREE_MB,
  PRUNE_COOLDOWN_MS,
  KEEP_MIN_DAILY_TIMELAPSES,
  KEEP_HIGHLIGHT_DAYS
};
