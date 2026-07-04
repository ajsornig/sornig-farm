const { describe, it } = require('node:test');
const assert = require('node:assert');

const { isUsernameClean, containsProfanity, filterProfanity } = require('../server/profanity');

describe('isUsernameClean', () => {
  describe('innocent names containing bad substrings (Scunthorpe problem)', () => {
    const allowed = ['cassidy', 'Cassidy-99', 'classic', 'bassplayer', 'grass_fed', 'an4lytics'];
    for (const name of allowed) {
      it(`should allow "${name}"`, () => {
        assert.strictEqual(isUsernameClean(name), true);
      });
    }
  });

  describe('genuinely offensive names', () => {
    const blocked = [
      'asshole',   // edge word at segment start
      'dumbass',   // edge word at segment end
      'a$$hole',   // leetspeak symbols
      'sh1thead',  // leetspeak digits, substring tier
      'sh1t',
      'dumb-a$$',  // edge word as its own segment
      'xXfuckXx',  // substring tier matches anywhere
      'sexmachine', // edge word at segment start
      'ass'        // edge word as the whole name
    ];
    for (const name of blocked) {
      it(`should block "${name}"`, () => {
        assert.strictEqual(isUsernameClean(name), false);
      });
    }
  });
});

describe('chat filter regression', () => {
  it('should not flag innocent words in chat messages', () => {
    assert.strictEqual(containsProfanity('grab some grass'), false);
  });

  it('should still mask standalone leetspeak profanity in chat', () => {
    assert.strictEqual(filterProfanity('what an a$$'), 'what an ***');
  });
});
