const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('./atomic-write');

// Permanent worldwide visitor map: unlike the activity log (which is trimmed
// and per-visit), this tracks a cell-bucketed set of locations that have ever
// been visited, with running counts and per-visitor last-seen timestamps. Cell
// key = round each coord to 0.1 deg so nearby visitors from the same
// city/region collapse onto one pin instead of stacking duplicates.
// Overridable so tests can point the store at a temp file instead of live data.
const STORE_FILE = process.env.VISITED_LOCATIONS_FILE || path.join(__dirname, '../data/visited-locations.json');
// Written once after the first backfill so we never re-seed an intentionally
// empty store (e.g. after an admin deletes pins) — deleted pins must stay gone.
const SEEDED_FLAG = path.join(__dirname, '../data/.visited-seeded');
// Don't re-record the same user at the same cell within this window: avoids a
// full-store disk rewrite on every /me poll and stops the count inflating.
const VISIT_DEDUP_MS = 30 * 60 * 1000;

function cellKey(lat, lng) {
  return `${Math.round(lat * 10) / 10}_${Math.round(lng * 10) / 10}`;
}

function loadStore() {
  if (fs.existsSync(STORE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
    } catch (err) {
      return {};
    }
  }
  return {};
}

// Module-level cache, loaded once on first access.
let store = null;
function getStore() {
  if (store === null) store = loadStore();
  return store;
}

function saveStore() {
  atomicWriteJSON(STORE_FILE, store);
}

function recordVisitedLocation(username, geo) {
  if (!geo || geo.lat == null || geo.lng == null) return;
  getStore();
  const key = cellKey(geo.lat, geo.lng);
  const now = Date.now();
  const entry = store[key] || { firstSeen: now, count: 0, visitors: {} };
  // Throttle repeat visits from the same user at the same cell (e.g. rapid /me
  // polls) so we don't rewrite the whole store to disk on every request.
  if (username && entry.visitors[username] && (now - entry.visitors[username]) < VISIT_DEDUP_MS) {
    return;
  }
  entry.lat = geo.lat;
  entry.lng = geo.lng;
  entry.city = geo.city || 'Unknown';
  entry.country = geo.country || 'Unknown';
  entry.count = (entry.count || 0) + 1;
  entry.lastSeen = now;
  if (username) {
    entry.visitors[username] = now;
  }
  store[key] = entry;
  saveStore();
}

function getVisitedLocations() {
  return getStore();
}

function removeVisitedLocation(key) {
  getStore();
  if (!Object.prototype.hasOwnProperty.call(store, key)) return false;
  delete store[key];
  saveStore();
  return true;
}

// Privacy sweep for account deletion/denial: strip a user's attribution from
// every cell. Visitor keys are stored in ORIGINAL case (unlike data.json's
// lowercase user keys), so matching must be case-insensitive. Cells are kept
// even if their visitors object becomes empty — public pins survive as
// anonymous, and the seeded-sentinel semantics are untouched (cells are never
// deleted here). Returns the number of cells that had attribution removed.
function removeUserAttribution(username) {
  if (typeof username !== 'string' || username.length === 0) return 0;
  getStore();
  const usernameLower = username.toLowerCase();
  let cellsTouched = 0;
  Object.values(store).forEach(entry => {
    if (!entry || !entry.visitors) return;
    const matches = Object.keys(entry.visitors).filter(v => v.toLowerCase() === usernameLower);
    if (matches.length === 0) return;
    matches.forEach(v => { delete entry.visitors[v]; });
    cellsTouched += 1;
  });
  if (cellsTouched > 0) saveStore();
  return cellsTouched;
}

// One-time seed from the existing activity log, so the permanent map isn't empty
// on first deploy. Guarded by a persistent sentinel (not by emptiness) so that an
// intentionally-empty store — e.g. after an admin deletes pins — is never
// re-seeded, and purged locations/usernames don't come back on restart.
function backfillFromActivityLog(entries) {
  if (fs.existsSync(SEEDED_FLAG)) return;
  getStore();
  // Mark seeded up front so this can't run twice even if seeding is skipped.
  try { fs.writeFileSync(SEEDED_FLAG, new Date().toISOString()); } catch (err) { /* best-effort */ }
  if (Object.keys(store).length > 0) return;
  if (!Array.isArray(entries)) return;

  entries.forEach(e => {
    if (!e || !e.details || e.details.lat == null || e.details.lng == null) return;
    const key = cellKey(e.details.lat, e.details.lng);
    const entry = store[key] || { firstSeen: e.timestamp, lastSeen: e.timestamp, count: 0, visitors: {} };
    entry.lat = e.details.lat;
    entry.lng = e.details.lng;
    entry.city = e.details.city || entry.city || 'Unknown';
    entry.country = e.details.country || entry.country || 'Unknown';
    entry.firstSeen = Math.min(entry.firstSeen, e.timestamp);
    entry.lastSeen = Math.max(entry.lastSeen, e.timestamp);
    entry.count = (entry.count || 0) + 1;
    if (e.username) {
      entry.visitors[e.username] = Math.max(entry.visitors[e.username] || 0, e.timestamp);
    }
    store[key] = entry;
  });

  saveStore();
}

module.exports = {
  recordVisitedLocation,
  getVisitedLocations,
  removeVisitedLocation,
  removeUserAttribution,
  backfillFromActivityLog
};
