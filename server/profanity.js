// Basic profanity filter
// Add words to this list as needed
const badWords = [
  'fuck', 'shit', 'ass', 'bitch', 'damn', 'crap', 'piss',
  'dick', 'cock', 'pussy', 'cunt', 'fag', 'slut', 'whore',
  'bastard', 'nigger', 'nigga', 'retard', 'homo',
  'rape', 'penis', 'vagina', 'tits', 'boob', 'porn', 'sex', 'anal',
  'nazi', 'hitler', 'kkk', 'jihad', 'pedo', 'molest', 'kill', 'murder'
];

// Create regex patterns that match whole words and common variations.
// Word boundaries are lookarounds against word chars AND the substitution
// symbols: plain \b fails when the match starts/ends with a symbol (e.g.
// "a$$" has no word boundary after the final "$"), which let the exact
// obfuscations the substitutions target slip through.
const patterns = badWords.map(word => {
  // Match the word with common letter substitutions
  const escaped = word
    .replace(/a/gi, '[a@4]')
    .replace(/e/gi, '[e3]')
    .replace(/i/gi, '[i1!]')
    .replace(/o/gi, '[o0]')
    .replace(/s/gi, '[s$5]')
    .replace(/t/gi, '[t7]');
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

function isUsernameClean(username) {
  // Normalize leetspeak substitutions to letters before stripping the rest,
  // so "sh1t"/"a$$hole" style names don't slip through when digits/symbols
  // are removed.
  const lower = username.toLowerCase()
    .replace(/[@4]/g, 'a')
    .replace(/3/g, 'e')
    .replace(/[1!]/g, 'i')
    .replace(/0/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/7/g, 't')
    .replace(/[^a-z]/g, '');
  return !badWords.some(word => lower.includes(word));
}

module.exports = {
  containsProfanity,
  filterProfanity,
  isUsernameClean
};
