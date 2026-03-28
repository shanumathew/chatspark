/**
 * index.js — ChatSpark Server
 * Express + Socket.IO entry point.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { classifyInterests, isShadowBanned } = require('./moderation');
const { getCountry } = require('./geoip');
const {
  addToInterestPool,
  addToShadowPool,
  addToGeneralPool,
  removeFromAllPools,
  getStats,
} = require('./matchmaker');

const PORT = process.env.PORT || 3000;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'],
});

// ── Static files ──────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── Debug stats endpoint ───────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  res.json(getStats());
});

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const clientIp =
    (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim() ||
    socket.handshake.address;

  console.log(`[connect] ${socket.id} from ${clientIp}`);

  // ── find-match ────────────────────────────────────────────────────────────
  socket.on('find-match', async ({ interests = [], isPremium = false, countryFilter = false } = {}) => {
    // Clean up any previous state
    removeFromAllPools(socket);
    socket.currentRoom = null;
    socket.partnerId = null;

    // Limit interests for free users
    const rawInterests = isPremium ? interests.slice(0, 10) : interests.slice(0, 2);

    // Classify interests
    const { clean } = classifyInterests(rawInterests);

    // Shadow-ban check (any flagged interest triggers shadow pool)
    if (isShadowBanned(rawInterests)) {
      console.log(`[shadow] ${socket.id} routed to shadow pool`);
      const { normalized } = require('./moderation').classifyInterests(rawInterests);
      addToShadowPool(socket, normalized);
      // Tell client same status as normal — no hint of shadow ban
      socket.emit('status', { type: 'searching', message: 'Looking for someone with your interests...' });
      return;
    }

    // GeoIP lookup for premium country filter
    let country = null;
    if (isPremium && countryFilter) {
      country = await getCountry(clientIp);
    }

    if (clean.length === 0) {
      // No valid interests — go straight to general pool
      addToGeneralPool(socket);
      return;
    }

    addToInterestPool({ socket, interests: clean, isPremium, country });
  });

  // ── find-anyone (skip interests, go general) ───────────────────────────────
  socket.on('find-anyone', () => {
    removeFromAllPools(socket);
    socket.currentRoom = null;
    socket.partnerId = null;
    addToGeneralPool(socket);
  });

  // ── message ───────────────────────────────────────────────────────────────
  socket.on('message', ({ text, id } = {}) => {
    if (!socket.currentRoom || !text) return;
    const sanitized = String(text).slice(0, 500); // max 500 chars
    socket.to(socket.currentRoom).emit('message', {
      text: sanitized,
      id,
      from: 'stranger',
      ts: Date.now(),
    });
  });

  // ── typing ────────────────────────────────────────────────────────────────
  socket.on('typing', ({ isTyping } = {}) => {
    if (!socket.currentRoom) return;
    socket.to(socket.currentRoom).emit('typing', { isTyping });
  });

  // ── stop-chat (user clicked Stop/Next) ────────────────────────────────────
  socket.on('stop-chat', () => {
    if (socket.currentRoom) {
      socket.to(socket.currentRoom).emit('partner-left');
      socket.leave(socket.currentRoom);
    }
    socket.currentRoom = null;
    socket.partnerId = null;
    removeFromAllPools(socket);
  });

  // ── disconnect ────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    if (socket.currentRoom) {
      socket.to(socket.currentRoom).emit('partner-left');
    }
    removeFromAllPools(socket);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🚀 ChatSpark running at http://localhost:${PORT}\n`);
});
