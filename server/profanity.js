// Basic profanity filter
// Add words to the lists below as needed.

// Unambiguous words/slurs — offensive even embedded inside a longer name,
// so usernames block on a match anywhere.
const substringBlocked = [
  'fuck', 'shit', 'bitch', 'cunt', 'pussy', 'whore', 'slut',
  'nigger', 'nigga', 'fag', 'bastard', 'retard', 'penis', 'vagina',
  'porn', 'nazi', 'hitler', 'kkk', 'jihad', 'pedo', 'molest', 'rape'
];

// Short/ambiguous words that appear inside many innocent names (cassidy,
// classic, bassplayer). Usernames only block when the word is a whole
// segment or sits at a segment's start/end; chat masks them as whole words.
const edgeBlocked = [
  'ass', 'sex', 'anal', 'dick', 'cock', 'kill', 'murder',
  'crap', 'damn', 'piss', 'tits', 'boob', 'homo'
];

const badWords = [...substringBlocked, ...edgeBlocked];

// Common letter→symbol substitutions, shared by the chat regexes (letter
// matches its symbols) and the username normalizer (symbols fold back to
// the letter).
const LEET_MAP = { a: '@4', e: '3', i: '1!', o: '0', s: '$5', t: '7' };

// Create regex patterns that match whole words and common variations.
// Word boundaries are lookarounds against word chars AND the substitution
// symbols: plain \b fails when the match starts/ends with a symbol (e.g.
// "a$$" has no word boundary after the final "$"), which let the exact
// obfuscations the substitutions target slip through.
const patterns = badWords.map(word => {
  const escaped = word.replace(/[aeiost]/g, ch => `[${ch}${LEET_MAP[ch]}]`);
  return new RegExp(`(?<![\\w@$!])${escaped}(?![\\w@$!])`, 'gi');
});

function containsProfanity(text) {
  const lower = text.toLowerCase();
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    if (pattern.test(lower)) {
      return true;
    }
  }
  return false;
}

function filterProfanity(text) {
  let filtered = text;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    filtered = filtered.replace(pattern, match => '*'.repeat(match.length));
  }
  return filtered;
}

// Fold leetspeak symbols back to letters so "a$$"/"sh1t" read as the words
// they imitate. Symbols in LEET_MAP values are all literal inside a
// character class, so no regex escaping is needed.
function normalizeLeetspeak(text) {
  return Object.entries(LEET_MAP).reduce(
    (result, [letter, symbols]) => result.replace(new RegExp(`[${symbols}]`, 'g'), letter),
    text.toLowerCase()
  );
}

// Innocent whole segments that end in an edge word ("grass" ends in "ass").
const cleanSegments = ['pass', 'grass', 'class', 'glass', 'bass', 'brass', 'sass'];
// Innocent stems that start with an edge word ("analytics" starts with "anal").
const cleanPrefixes = ['assist', 'asset', 'assign', 'assassin', 'analy', 'analog'];

function segmentHitsEdgeWord(segment, word) {
  if (segment === word) return true;
  if (cleanSegments.includes(segment)) return false;
  if (cleanPrefixes.some(prefix => segment.startsWith(prefix))) return false;
  return segment.startsWith(word) || segment.endsWith(word);
}

function isUsernameClean(username) {
  // Normalize leetspeak BEFORE splitting so "a$$" still reads as "ass",
  // while real separators (- _ .) survive as segment boundaries.
  const segments = normalizeLeetspeak(username)
    .split(/[^a-z]+/)
    .filter(Boolean);

  // Substring tier: match anywhere, even across separators ("f.u.c.k").
  const joined = segments.join('');
  if (substringBlocked.some(word => joined.includes(word))) return false;

  // Edge tier: only whole segments or segment edges, so mid-word hits
  // like "cassidy" pass instead of tripping the Scunthorpe problem.
  return !segments.some(segment =>
    edgeBlocked.some(word => segmentHitsEdgeWord(segment, word))
  );
}

module.exports = {
  containsProfanity,
  filterProfanity,
  isUsernameClean
};
