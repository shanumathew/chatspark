/**
 * index.js — ChatSpark Server v2
 * Adds: Razorpay payments, device fingerprint premium storage, gender-aware matching
 */

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const crypto   = require('crypto');
const Razorpay = require('razorpay');

const { classifyInterests, isShadowBanned } = require('./moderation');
const { getCountry } = require('./geoip');
const {
  addToInterestPool, addToShadowPool, addToGeneralPool,
  removeFromAllPools, getStats,
} = require('./matchmaker');

const PORT = process.env.PORT || 3000;

// ── Razorpay ─────────────────────────────────────────────────────────────────
const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID     || 'rzp_test_placeholder',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret',
});

// ── Premium fingerprint store ─────────────────────────────────────────────────
// Map<fingerprint, expiresAt timestamp>
const premiumStore = new Map();

function isPremiumFp(fp) {
  if (!fp) return false;
  const exp = premiumStore.get(fp);
  return !!(exp && exp > Date.now());
}

function grantPremium(fp) {
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24 hours
  premiumStore.set(fp, expiresAt);
  return expiresAt;
}

// Clean up expired entries every hour
setInterval(() => {
  const now = Date.now();
  for (const [fp, exp] of premiumStore.entries()) {
    if (exp < now) premiumStore.delete(fp);
  }
}, 60 * 60 * 1000);

// ── Express ───────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, transports: ['websocket', 'polling'] });

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ── API: frontend config (exposes Razorpay key ID only) ───────────────────────
app.get('/api/config', (_req, res) => {
  res.json({ razorpayKeyId: process.env.RAZORPAY_KEY_ID || '' });
});

// ── API: check premium by fingerprint ─────────────────────────────────────────
app.get('/api/check-premium', (req, res) => {
  const fp = req.query.fp;
  if (!fp) return res.json({ isPremium: false });
  const exp = premiumStore.get(fp);
  const isPremium = !!(exp && exp > Date.now());
  res.json({ isPremium, expiresAt: isPremium ? exp : null });
});

// ── API: create Razorpay order ─────────────────────────────────────────────────
app.post('/api/create-order', async (req, res) => {
  try {
    const order = await razorpay.orders.create({
      amount:   5000,   // 50 INR in paise
      currency: 'INR',
      receipt:  `cs_${Date.now()}`,
    });
    res.json({ success: true, order });
  } catch (err) {
    console.error('[payment] create-order error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── API: verify payment & grant premium ────────────────────────────────────────
app.post('/api/verify-payment', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, fingerprint } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !fingerprint) {
    return res.status(400).json({ success: false, error: 'Missing fields' });
  }

  const body     = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET || 'placeholder_secret')
    .update(body)
    .digest('hex');

  if (expected !== razorpay_signature) {
    return res.status(400).json({ success: false, error: 'Invalid signature' });
  }

  const expiresAt = grantPremium(fingerprint);
  console.log(`[payment] Premium granted for fp=${fingerprint.slice(0, 8)}... until ${new Date(expiresAt).toISOString()}`);
  res.json({ success: true, expiresAt });
});

// ── API: debug stats ───────────────────────────────────────────────────────────
app.get('/api/stats', (_req, res) => res.json(getStats()));

// ── Socket.IO ─────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  const clientIp = (socket.handshake.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || socket.handshake.address;
  console.log(`[connect] ${socket.id}`);

  // find-match
  socket.on('find-match', async ({
    interests = [], fingerprint = '',
    myGender = 'other', preferGender = 'any',
    countryFilter = false,
  } = {}) => {
    removeFromAllPools(socket);
    socket.currentRoom = null;
    socket.partnerId   = null;

    // Validate premium via fingerprint
    const premium = isPremiumFp(fingerprint);

    // Limit interests: free = 2, premium = 10
    const rawInterests = (premium ? interests.slice(0, 10) : interests.slice(0, 2));
    const { clean, normalized } = require('./moderation').classifyInterests(rawInterests);

    // Shadow ban check
    if (isShadowBanned(rawInterests)) {
      console.log(`[shadow] ${socket.id}`);
      addToShadowPool(socket, normalized);
      socket.emit('status', { type: 'searching', message: 'Looking for someone with your interests...' });
      return;
    }

    // GeoIP for premium country filter
    let country = null;
    if (premium && countryFilter) country = await getCountry(clientIp);

    if (clean.length === 0) {
      addToGeneralPool(socket, myGender, premium ? preferGender : 'any');
      return;
    }

    addToInterestPool({
      socket, interests: clean, isPremium: premium, country,
      myGender, preferGender: premium ? preferGender : 'any',
    });
  });

  // find-anyone (general pool directly)
  socket.on('find-anyone', ({ fingerprint = '', myGender = 'other' } = {}) => {
    removeFromAllPools(socket);
    socket.currentRoom = null;
    socket.partnerId   = null;
    const premium = isPremiumFp(fingerprint);
    addToGeneralPool(socket, myGender, 'any');
  });

  // message
  socket.on('message', ({ text, id } = {}) => {
    if (!socket.currentRoom || !text) return;
    socket.to(socket.currentRoom).emit('message', { text: String(text).slice(0, 500), id, from: 'stranger', ts: Date.now() });
  });

  // typing
  socket.on('typing', ({ isTyping } = {}) => {
    if (!socket.currentRoom) return;
    socket.to(socket.currentRoom).emit('typing', { isTyping });
  });

  // stop-chat
  socket.on('stop-chat', () => {
    if (socket.currentRoom) { socket.to(socket.currentRoom).emit('partner-left'); socket.leave(socket.currentRoom); }
    socket.currentRoom = null;
    socket.partnerId   = null;
    removeFromAllPools(socket);
  });

  socket.on('disconnect', () => {
    console.log(`[disconnect] ${socket.id}`);
    if (socket.currentRoom) socket.to(socket.currentRoom).emit('partner-left');
    removeFromAllPools(socket);
  });
});

server.listen(PORT, () => {
  console.log(`\nChatSpark v2 running at http://localhost:${PORT}\n`);
});
