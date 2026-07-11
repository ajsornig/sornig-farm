const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the store at a throwaway temp file BEFORE requiring the module, so the
// test never touches the live data/visited-locations.json (safe to run on the
// Pi). node --test runs each file in its own process, so this can't leak.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visited-locations-test-'));
const storeFile = path.join(tempDir, 'visited-locations.json');
process.env.VISITED_LOCATIONS_FILE = storeFile;

const NOW = Date.now();
const CELL_A = '43.1_-83.3';
const CELL_B = '40.7_-74.0';

function writeFixture() {
  fs.writeFileSync(storeFile, JSON.stringify({
    [CELL_A]: {
      lat: 43.1, lng: -83.3, city: 'Lapeer', country: 'United States',
      firstSeen: NOW, lastSeen: NOW, count: 5,
      visitors: { TestGuy: NOW, Alice: NOW }
    },
    [CELL_B]: {
      lat: 40.7, lng: -74.0, city: 'New York', country: 'United States',
      firstSeen: NOW, lastSeen: NOW, count: 2,
      visitors: { bob: NOW }
    }
  }));
}

describe('removeUserAttribution', () => {
  let removeUserAttribution;
  let getVisitedLocations;

  before(() => {
    writeFixture();
    ({ removeUserAttribution, getVisitedLocations } = require('../server/visited-locations'));
  });

  after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('removes the user case-insensitively, keeps other visitors and all cells, and rewrites the file', () => {
    const touched = removeUserAttribution('testguy'); // stored as "TestGuy"
    assert.strictEqual(touched, 1);

    const store = getVisitedLocations();
    assert.ok(store[CELL_A], 'cell A must survive the sweep');
    assert.ok(store[CELL_B], 'cell B must survive the sweep');
    assert.strictEqual(store[CELL_A].visitors.TestGuy, undefined);
    assert.strictEqual(store[CELL_A].visitors.Alice, NOW);
    assert.strictEqual(store[CELL_B].visitors.bob, NOW);

    // The change must be persisted to disk, not just in the in-memory cache.
    const onDisk = JSON.parse(fs.readFileSync(storeFile, 'utf-8'));
    assert.strictEqual(onDisk[CELL_A].visitors.TestGuy, undefined);
    assert.strictEqual(onDisk[CELL_A].visitors.Alice, NOW);
    assert.ok(onDisk[CELL_B], 'cell B must still be on disk');
  });

  it('keeps a cell even when its visitors object becomes empty (anonymous pin survives)', () => {
    const touched = removeUserAttribution('BOB'); // stored as "bob"
    assert.strictEqual(touched, 1);

    const store = getVisitedLocations();
    assert.ok(store[CELL_B], 'cell B must survive with no visitors');
    assert.deepStrictEqual(store[CELL_B].visitors, {});
    assert.strictEqual(store[CELL_B].count, 2, 'aggregate count is untouched');
  });

  it('returns 0 and leaves the file alone for an unknown user', () => {
    const mtimeBefore = fs.statSync(storeFile).mtimeMs;
    assert.strictEqual(removeUserAttribution('nobody-here'), 0);
    assert.strictEqual(fs.statSync(storeFile).mtimeMs, mtimeBefore, 'no-op must not rewrite the store');
  });

  it('returns 0 for empty or non-string usernames', () => {
    assert.strictEqual(removeUserAttribution(''), 0);
    assert.strictEqual(removeUserAttribution(null), 0);
    assert.strictEqual(removeUserAttribution(undefined), 0);
  });
});
