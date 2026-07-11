const test = require('node:test');
const assert = require('node:assert');
const { planDiskPrune, PRUNE_TARGET_FREE_MB, PRUNE_TRIGGER_FREE_MB } = require('../server/disk-prune');

const file = (name, sizeMb) => ({ path: `/fake/${name}`, sizeMb, mtimeMs: 0, source: 'test' });

test('plans nothing when disk metrics are unknown', () => {
  assert.deepStrictEqual(planDiskPrune({ candidates: [file('a.mp4', 500)], freeMb: null }), []);
  assert.deepStrictEqual(planDiskPrune({ candidates: [file('a.mp4', 500)], freeMb: undefined }), []);
});

test('plans nothing when already at or above the target', () => {
  assert.deepStrictEqual(planDiskPrune({ candidates: [file('a.mp4', 500)], freeMb: PRUNE_TARGET_FREE_MB }), []);
});

test('takes candidates in order and stops once estimated free reaches target', () => {
  const candidates = [file('a.mp4', 1500), file('b.mp4', 1500), file('c.mp4', 1500)];
  const plan = planDiskPrune({ candidates, freeMb: 500 });
  // 500 + 1500 + 1500 = 3500 >= 3072 target -> c.mp4 survives.
  assert.deepStrictEqual(plan.map(f => f.path), ['/fake/a.mp4', '/fake/b.mp4']);
});

test('plans everything when candidates cannot reach the target', () => {
  const candidates = [file('a.mp4', 10), file('b.mp4', 10)];
  const plan = planDiskPrune({ candidates, freeMb: 100 });
  assert.strictEqual(plan.length, 2);
});

test('does not mutate the candidates array', () => {
  const candidates = [file('a.mp4', 5000)];
  const before = JSON.stringify(candidates);
  planDiskPrune({ candidates, freeMb: 100 });
  assert.strictEqual(JSON.stringify(candidates), before);
});

test('trigger floor is below the refill target (sanity on constants)', () => {
  assert.ok(PRUNE_TRIGGER_FREE_MB < PRUNE_TARGET_FREE_MB);
});
