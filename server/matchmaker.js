/**
 * matchmaker.js v2 — Gender-aware three-pool matching
 */

const { normalizeInterest } = require('./moderation');

const FALLBACK_TIMEOUT_MS = 15000;
const RETRY_INTERVAL_MS   = 3000;

const interestMap  = new Map();   // Map<string, Set<Socket>>
const generalPool  = new Set();
const shadowPool   = new Set();
const waitingMeta  = new Map();   // socketId → meta

// ── Gender compatibility ────────────────────────────────────────────────────
function genderCompatible(metaA, metaB) {
  const gA = metaA.myGender     || 'other';
  const gB = metaB.myGender     || 'other';
  const pA = metaA.preferGender || 'any';
  const pB = metaB.preferGender || 'any';
  const aOk = pA === 'any' || pA === gB;
  const bOk = pB === 'any' || pB === gA;
  return aOk && bOk;
}

// ── Internal helpers ────────────────────────────────────────────────────────
function _addToInterestBuckets(socket, interests) {
  for (const interest of interests) {
    if (!interestMap.has(interest)) interestMap.set(interest, new Set());
    interestMap.get(interest).add(socket);
  }
}

function _removeFromInterestBuckets(socket, interests) {
  for (const interest of interests) {
    const bucket = interestMap.get(interest);
    if (bucket) { bucket.delete(socket); if (bucket.size === 0) interestMap.delete(interest); }
  }
}

function _clearTimers(socketId) {
  const meta = waitingMeta.get(socketId);
  if (!meta) return;
  clearTimeout(meta.timer);
  clearInterval(meta.retryInterval);
}

function _findInterestMatch(socket, interests, countryFilter) {
  const myMeta = waitingMeta.get(socket.id);
  for (const interest of interests) {
    const bucket = interestMap.get(interest);
    if (!bucket) continue;
    for (const candidate of bucket) {
      if (candidate.id === socket.id) continue;
      const cMeta = waitingMeta.get(candidate.id);
      if (!cMeta) continue;
      if (countryFilter && cMeta.country && cMeta.country !== countryFilter) continue;
      if (!genderCompatible(myMeta, cMeta)) continue;
      return { partner: candidate, sharedInterest: interest };
    }
  }
  return null;
}

function _findGeneralMatch(socket) {
  const myMeta = waitingMeta.get(socket.id);
  for (const candidate of generalPool) {
    if (candidate.id === socket.id) continue;
    const cMeta = waitingMeta.get(candidate.id);
    if (!cMeta) continue;
    if (!genderCompatible(myMeta, cMeta)) continue;
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

// ── Pair two sockets ────────────────────────────────────────────────────────
function _pairSockets(socketA, socketB, sharedInterests = []) {
  removeFromAllPools(socketA);
  removeFromAllPools(socketB);

  const roomId = `room-${socketA.id}-${socketB.id}`;
  socketA.join(roomId);
  socketB.join(roomId);
  socketA.currentRoom = roomId;
  socketB.currentRoom = roomId;
  socketA.partnerId  = socketB.id;
  socketB.partnerId  = socketA.id;

  const metaA = waitingMeta.get(socketA.id) || {};
  const metaB = waitingMeta.get(socketB.id) || {};

  socketA.emit('matched', { roomId, sharedInterests, partnerInterests: metaB.interests || [], partnerGender: metaB.myGender || 'other' });
  socketB.emit('matched', { roomId, sharedInterests, partnerInterests: metaA.interests || [], partnerGender: metaA.myGender || 'other' });

  console.log(`[match] ${socketA.id} <-> ${socketB.id} | interests: [${sharedInterests.join(', ')}]`);
}

// ── Public API ──────────────────────────────────────────────────────────────
function addToShadowPool(socket, interests) {
  socket.isShadowBanned = true;
  shadowPool.add(socket);
  waitingMeta.set(socket.id, { socket, interests, isShadow: true, myGender: 'other', preferGender: 'any' });

  const partner = _findShadowMatch(socket);
  if (partner) { _pairSockets(socket, partner, []); return; }

  const retryInterval = setInterval(() => {
    if (!shadowPool.has(socket)) { clearInterval(retryInterval); return; }
    const p = _findShadowMatch(socket);
    if (p) _pairSockets(socket, p, []);
  }, RETRY_INTERVAL_MS);

  const meta = waitingMeta.get(socket.id);
  if (meta) meta.retryInterval = retryInterval;
}

function addToInterestPool({ socket, interests, isPremium, country, myGender, preferGender }) {
  _addToInterestBuckets(socket, interests);

  const meta = {
    socket, interests, isPremium,
    country:       country       || null,
    myGender:      myGender      || 'other',
    preferGender:  isPremium ? (preferGender || 'any') : 'any',
  };

  meta.timer = !isPremium ? setTimeout(() => {
    console.log(`[fallback] ${socket.id} -> general`);
    _removeFromInterestBuckets(socket, interests);
    clearInterval(meta.retryInterval);
    generalPool.add(socket);
    socket.emit('status', { type: 'fallback', message: 'Moving to general pool...' });
    const p = _findGeneralMatch(socket);
    if (p) _pairSockets(socket, p, []);
  }, FALLBACK_TIMEOUT_MS) : null;

  meta.retryInterval = setInterval(() => {
    if (!waitingMeta.has(socket.id) || generalPool.has(socket)) { clearInterval(meta.retryInterval); return; }
    const result = _findInterestMatch(socket, interests, isPremium ? country : null);
    if (result) _pairSockets(socket, result.partner, [result.sharedInterest]);
  }, RETRY_INTERVAL_MS);

  waitingMeta.set(socket.id, meta);

  const result = _findInterestMatch(socket, interests, isPremium ? country : null);
  if (result) { _pairSockets(socket, result.partner, [result.sharedInterest]); return; }

  socket.emit('status', { type: 'searching', message: 'Looking for someone with your interests...' });
}

function removeFromAllPools(socket) {
  const meta = waitingMeta.get(socket.id);
  if (meta) { _clearTimers(socket.id); if (meta.interests) _removeFromInterestBuckets(socket, meta.interests); }
  generalPool.delete(socket);
  shadowPool.delete(socket);
  waitingMeta.delete(socket.id);
}

function addToGeneralPool(socket, myGender, preferGender) {
  generalPool.add(socket);
  waitingMeta.set(socket.id, { socket, interests: [], myGender: myGender || 'other', preferGender: preferGender || 'any' });
  const partner = _findGeneralMatch(socket);
  if (partner) { _pairSockets(socket, partner, []); return; }
  socket.emit('status', { type: 'searching', message: 'Finding someone to chat with...' });
}

function getStats() {
  const interestCount = {};
  for (const [k, v] of interestMap.entries()) interestCount[k] = v.size;
  return { interestBuckets: interestCount, general: generalPool.size, shadow: shadowPool.size, totalWaiting: waitingMeta.size };
}

module.exports = { addToInterestPool, addToShadowPool, addToGeneralPool, removeFromAllPools, getStats };
