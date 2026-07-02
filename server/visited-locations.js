const fs = require('fs');
const path = require('path');
const { atomicWriteJSON } = require('./atomic-write');

// Permanent worldwide visitor map: unlike the activity log (which is trimmed
// and per-visit), this tracks a cell-bucketed set of locations that have ever
// been visited, with running counts and per-visitor last-seen timestamps. Cell
// key = round each coord to 0.1 deg so nearby visitors from the same
// city/region collapse onto one pin instead of stacking duplicates.
const STORE_FILE = path.join(__dirname, '../data/visited-locations.json');

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
  const entry = store[key] || { firstSeen: Date.now(), count: 0, visitors: {} };
  entry.lat = geo.lat;
  entry.lng = geo.lng;
  entry.city = geo.city || 'Unknown';
  entry.country = geo.country || 'Unknown';
  entry.count = (entry.count || 0) + 1;
  entry.lastSeen = Date.now();
  if (username) {
    entry.visitors[username] = Date.now();
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

// Best-effort one-time seed from the existing activity log, so the permanent
// map isn't empty on first deploy. No-op if the store already has data (i.e.
// this has already run, or pins have been recorded/removed since).
function backfillFromActivityLog(entries) {
  getStore();
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
  backfillFromActivityLog
};
