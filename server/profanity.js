// Basic profanity filter
// Add words to this list as needed
const badWords = [
  'fuck', 'shit', 'ass', 'bitch', 'damn', 'crap', 'piss',
  'dick', 'cock', 'pussy', 'cunt', 'fag', 'slut', 'whore',
  'bastard', 'nigger', 'nigga', 'retard', 'homo'
];

// Create regex patterns that match whole words and common variations
const patterns = badWords.map(word => {
  // Match the word with common letter substitutions
  const escaped = word
    .replace(/a/gi, '[a@4]')
    .replace(/e/gi, '[e3]')
    .replace(/i/gi, '[i1!]')
    .replace(/o/gi, '[o0]')
    .replace(/s/gi, '[s$5]')
    .replace(/t/gi, '[t7]');
  return new RegExp(`\\b${escaped}\\b`, 'gi');
});

function containsProfanity(text) {
  const lower = text.toLowerCase();
  for (const pattern of patterns) {
    if (pattern.test(lower)) {
      return true;
    }
  }
  return false;
}

function filterProfanity(text) {
  let filtered = text;
  for (const pattern of patterns) {
    filtered = filtered.replace(pattern, match => '*'.repeat(match.length));
  }
  return filtered;
}

module.exports = {
  containsProfanity,
  filterProfanity
};
