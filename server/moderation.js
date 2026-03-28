/**
 * moderation.js
 * Keyword-based interest classifier with shadow-ban support.
 * NSFW users are silently paired only with each other.
 */

const NSFW_KEYWORDS = [
  // Sexual / explicit
  'sex', 'porn', 'nsfw', 'nude', 'nudes', 'xxx', 'adult', 'horny',
  'hook', 'hookup', 'hook-up', 'sexting', 'dirty', 'fetish', 'kink',
  'bdsm', 'erotic', 'explicit', '18+',
  // Slurs / hate speech (abbreviated list — extend as needed)
  'hate', 'racist', 'racism',
  // Drug solicitation
  'weed', 'drugs', 'dealer',
];

/**
 * Normalize an interest string: lowercase, trim, strip punctuation.
 * @param {string} s
 * @returns {string}
 */
function normalizeInterest(s) {
  return s.toLowerCase().trim().replace(/[^a-z0-9\s]/g, '');
}

/**
 * Classify a list of raw interest strings.
 * @param {string[]} interests
 * @returns {{ clean: string[], flagged: string[], normalized: string[] }}
 */
function classifyInterests(interests) {
  const clean = [];
  const flagged = [];
  const normalized = [];

  for (const raw of interests) {
    const norm = normalizeInterest(raw);
    if (!norm) continue;
    normalized.push(norm);

    const isNsfw = NSFW_KEYWORDS.some(kw => norm.includes(kw));
    if (isNsfw) {
      flagged.push(norm);
    } else {
      clean.push(norm);
    }
  }

  return { clean, flagged, normalized };
}

/**
 * Returns true if ANY interest is flagged — triggers shadow-ban pool.
 * @param {string[]} interests
 * @returns {boolean}
 */
function isShadowBanned(interests) {
  const { flagged } = classifyInterests(interests);
  return flagged.length > 0;
}

module.exports = { classifyInterests, isShadowBanned, normalizeInterest };
