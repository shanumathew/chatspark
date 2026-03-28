/**
 * matchmaker.js
 * Manages three pools:
 *   1. interestMap  — Map<interest, Socket[]>  (priority matching by shared tag)
 *   2. generalPool  — Socket[]                 (random fallback)
 *   3. shadowPool   — Socket[]                 (NSFW-flagged users, isolated)
 *
 * Matching flow per user:
 *   → Try interest match immediately
 *   → Retry every RETRY_INTERVAL_MS
 *   → After FALLBACK_TIMEOUT_MS, move to generalPool (clean users only)
 *   → generalPool match attempted on every addition
 */

const { normalizeInterest } = require('./moderation');

const FALLBACK_TIMEOUT_MS = 15000; // 15 seconds
const RETRY_INTERVAL_MS = 3000;   // retry interest match every 3s

// ── Pool State ──────────────────────────────────────────────────────────────
const interestMap = new Map();   // Map<string, Set<Socket>>
const generalPool = new Set();
const shadowPool = new Set();

// Map<socketId, { socket, interests, timer, retryInterval, isPremium, country }>
const waitingMeta = new Map();

// ── Internal helpers ─────────────────────────────────────────────────────────

function _addToInterestBuckets(socket, interests) {
  for (const interest of interests) {
    if (!interestMap.has(interest)) interestMap.set(interest, new Set());
    interestMap.get(interest).add(socket);
  }
}

function _removeFromInterestBuckets(socket, interests) {
  for (const interest of interests) {
    const bucket = interestMap.get(interest);
    if (bucket) {
      bucket.delete(socket);
      if (bucket.size === 0) interestMap.delete(interest);
    }
  }
}

function _clearTimers(socketId) {
  const meta = waitingMeta.get(socketId);
  if (!meta) return;
  clearTimeout(meta.timer);
  clearInterval(meta.retryInterval);
}

/**
 * Find the first other waiting socket that shares at least one interest.
 * For premium users, also enforce country match if countryFilter is set.
 * Returns the partner socket or null.
 */
function _findInterestMatch(socket, interests, countryFilter) {
  for (const interest of interests) {
    const bucket = interestMap.get(interest);
    if (!bucket) continue;

    for (const candidate of bucket) {
      if (candidate.id === socket.id) continue;
      const candidateMeta = waitingMeta.get(candidate.id);
      if (!candidateMeta) continue;

      // Country filter (premium hard-filter)
      if (countryFilter && candidateMeta.country && candidateMeta.country !== countryFilter) {
        continue;
      }

      return { partner: candidate, sharedInterest: interest };
    }
  }
  return null;
}

function _findGeneralMatch(socket) {
  for (const candidate of generalPool) {
    if (candidate.id === socket.id) continue;
    return candidate;
  }
  return null;
}

function _findShadowMatch(socket) {
  for (const candidate of shadowPool) {
    if (candidate.id === socket.id) continue;
    return candidate;
  }
  return null;
}

// ── Pair two sockets ─────────────────────────────────────────────────────────

function _pairSockets(socketA, socketB, sharedInterests = []) {
  // Remove both from all pools
  removeFromAllPools(socketA);
  removeFromAllPools(socketB);

  const roomId = `room-${socketA.id}-${socketB.id}`;

  socketA.join(roomId);
  socketB.join(roomId);

  // Store room reference on socket for message routing
  socketA.currentRoom = roomId;
  socketB.currentRoom = roomId;
  socketA.partnerId = socketB.id;
  socketB.partnerId = socketA.id;

  // Emit matched event with metadata
  const metaA = waitingMeta.get(socketA.id) || {};
  const metaB = waitingMeta.get(socketB.id) || {};

  socketA.emit('matched', {
    roomId,
    sharedInterests,
    partnerInterests: metaB.interests || [],
    isPremium: metaA.isPremium,
  });

  socketB.emit('matched', {
    roomId,
    sharedInterests,
    partnerInterests: metaA.interests || [],
    isPremium: metaB.isPremium,
  });

  console.log(`[match] ${socketA.id} ↔ ${socketB.id} | interests: [${sharedInterests.join(', ')}]`);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Add a shadow-banned user to the shadow pool.
 */
function addToShadowPool(socket, interests) {
  socket.isShadowBanned = true;
  shadowPool.add(socket);
  waitingMeta.set(socket.id, { socket, interests, isShadow: true });

  // Immediately try to pair with another shadow user
  const partner = _findShadowMatch(socket);
  if (partner) {
    _pairSockets(socket, partner, []);
    return;
  }

  // Retry every 3 seconds — shadow users wait indefinitely
  const retryInterval = setInterval(() => {
    if (!shadowPool.has(socket)) {
      clearInterval(retryInterval);
      return;
    }
    const p = _findShadowMatch(socket);
    if (p) _pairSockets(socket, p, []);
  }, RETRY_INTERVAL_MS);

  const meta = waitingMeta.get(socket.id);
  if (meta) meta.retryInterval = retryInterval;
}

/**
 * Add a clean user to the interest-based matching system.
 * @param {object} opts
 * @param {Socket} opts.socket
 * @param {string[]} opts.interests  - Normalized, clean interest strings
 * @param {boolean} opts.isPremium
 * @param {string|null} opts.country - ISO-2 country code (premium only)
 */
function addToInterestPool({ socket, interests, isPremium, country }) {
  _addToInterestBuckets(socket, interests);

  const meta = {
    socket,
    interests,
    isPremium,
    country: country || null,
  };

  // Fallback timer — only for non-premium or premium without hard filter
  const shouldFallback = !isPremium; // premium with hard filter stays in interest pool
  meta.timer = shouldFallback
    ? setTimeout(() => {
        console.log(`[fallback] ${socket.id} moving to general pool`);
        _removeFromInterestBuckets(socket, interests);
        clearInterval(meta.retryInterval);
        generalPool.add(socket);
        socket.emit('status', { type: 'fallback', message: 'Moving to general pool...' });

        // Immediately try general match
        const partner = _findGeneralMatch(socket);
        if (partner) {
          _pairSockets(socket, partner, []);
          return;
        }
      }, FALLBACK_TIMEOUT_MS)
    : null;

  // Retry interval — try interest match every 3s
  meta.retryInterval = setInterval(() => {
    if (!waitingMeta.has(socket.id)) {
      clearInterval(meta.retryInterval);
      return;
    }
    // Don't retry if already moved to general pool
    if (generalPool.has(socket)) {
      clearInterval(meta.retryInterval);
      return;
    }
    const result = _findInterestMatch(socket, interests, isPremium ? country : null);
    if (result) {
      _pairSockets(socket, result.partner, [result.sharedInterest]);
    }
  }, RETRY_INTERVAL_MS);

  waitingMeta.set(socket.id, meta);

  // Immediate first attempt
  const result = _findInterestMatch(socket, interests, isPremium ? country : null);
  if (result) {
    _pairSockets(socket, result.partner, [result.sharedInterest]);
    return;
  }

  socket.emit('status', { type: 'searching', message: 'Looking for someone with your interests...' });
}

/**
 * Remove a socket from every pool and cancel all timers.
 */
function removeFromAllPools(socket) {
  const meta = waitingMeta.get(socket.id);
  if (meta) {
    _clearTimers(socket.id);
    if (meta.interests) _removeFromInterestBuckets(socket, meta.interests);
  }
  generalPool.delete(socket);
  shadowPool.delete(socket);
  waitingMeta.delete(socket.id);
}

/**
 * Add a socket directly to the general pool (used on reconnect / manual skip).
 */
function addToGeneralPool(socket) {
  generalPool.add(socket);
  waitingMeta.set(socket.id, { socket, interests: [] });

  const partner = _findGeneralMatch(socket);
  if (partner) {
    _pairSockets(socket, partner, []);
    return;
  }
  socket.emit('status', { type: 'searching', message: 'Finding someone to chat with...' });
}

/**
 * Returns pool stats for debugging.
 */
function getStats() {
  const interestCount = {};
  for (const [k, v] of interestMap.entries()) {
    interestCount[k] = v.size;
  }
  return {
    interestBuckets: interestCount,
    general: generalPool.size,
    shadow: shadowPool.size,
    totalWaiting: waitingMeta.size,
  };
}

module.exports = {
  addToInterestPool,
  addToShadowPool,
  addToGeneralPool,
  removeFromAllPools,
  getStats,
};
