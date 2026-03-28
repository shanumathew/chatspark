/**
 * chat.js v2 — No emojis, SVG-based UI
 */
(function () {
  'use strict';

  const myInterests      = JSON.parse(sessionStorage.getItem('cs_interests') || '[]');
  const isPremium        = sessionStorage.getItem('cs_premium') === '1';
  const fingerprint      = sessionStorage.getItem('cs_fp') || '';
  const sharedInterests  = JSON.parse(sessionStorage.getItem('cs_shared') || '[]');
  const partnerInterests = JSON.parse(sessionStorage.getItem('cs_partner_interests') || '[]');
  const myGender         = sessionStorage.getItem('cs_my_gender') || 'other';

  let connected     = false;
  let chatStartTime = null;
  let messageCount  = 0;
  let typingTimeout = null;
  let isTyping      = false;
  let typingEl      = null;
  let msgIdCounter  = 0;

  // ── Elements ───────────────────────────────────────────────────────────────
  const connectingOverlay   = document.getElementById('connecting-overlay');
  const connectingText      = document.getElementById('connecting-text');
  const disconnectedOverlay = document.getElementById('disconnected-overlay');
  const disconnectStats     = document.getElementById('disconnect-stats');
  const messagesArea        = document.getElementById('messages-area');
  const msgInput            = document.getElementById('msg-input');
  const sendBtn             = document.getElementById('send-btn');
  const stopBtn             = document.getElementById('stop-btn');
  const nextBtn             = document.getElementById('next-btn');
  const homeBtn             = document.getElementById('home-btn');
  const statusDot           = document.getElementById('status-dot');
  const partnerLabel        = document.getElementById('partner-label');
  const sharedChipsTopbar   = document.getElementById('shared-chips-topbar');
  const charCount           = document.getElementById('char-count');
  const findNextBtn         = document.getElementById('find-next-btn');
  const premiumIndicator    = document.getElementById('premium-indicator');

  // ── Socket ─────────────────────────────────────────────────────────────────
  const socket = io();

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    if (isPremium) {
      premiumIndicator.innerHTML = '<span class="badge badge-premium" style="font-size:10px"><svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg> Premium</span>';
    }

    if (sharedInterests.length > 0) {
      sharedChipsTopbar.innerHTML = sharedInterests
        .map(i => `<span class="chip shared" style="font-size:11px;padding:2px 8px">${escHtml(i)}</span>`)
        .join('');
    }

    // Re-emit find-match on page load (navigated from landing)
    socket.emit('find-match', {
      interests: myInterests,
      fingerprint,
      myGender,
      preferGender: 'any',
      countryFilter: false,
    });
  }

  // ── UI helpers ─────────────────────────────────────────────────────────────
  function setConnected(on) {
    connected       = on;
    msgInput.disabled = !on;
    sendBtn.disabled  = !on;
    nextBtn.disabled  = !on;
    stopBtn.disabled  = false;

    if (on) {
      connectingOverlay.classList.add('hidden');
      statusDot.className = 'status-dot';
      partnerLabel.textContent = sharedInterests.length
        ? `Stranger — likes ${sharedInterests.join(', ')}`
        : 'Stranger';
      chatStartTime = Date.now();
      addSysMsg('Connected. Say hello.');
    } else {
      statusDot.className = 'status-dot yellow';
    }
  }

  function addSysMsg(text) {
    const el = document.createElement('div');
    el.className = 'sys-msg fade-in';
    el.textContent = text;
    messagesArea.appendChild(el);
    scrollToBottom();
  }

  function addBubble(text, mine) {
    removeTypingEl();
    const wrap = document.createElement('div');
    wrap.style.cssText = `display:flex;width:100%;justify-content:${mine ? 'flex-end' : 'flex-start'}`;
    const bubble = document.createElement('div');
    bubble.className = `bubble ${mine ? 'mine' : 'theirs'} fade-in`;
    bubble.textContent = text;
    wrap.appendChild(bubble);
    messagesArea.appendChild(wrap);
    scrollToBottom();
    messageCount++;
  }

  function showTypingEl() {
    if (typingEl) return;
    const wrap = document.createElement('div');
    wrap.id = 'typing-wrap';
    wrap.style.cssText = 'display:flex;width:100%;justify-content:flex-start';
    typingEl = document.createElement('div');
    typingEl.className = 'typing-indicator fade-in';
    typingEl.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    wrap.appendChild(typingEl);
    messagesArea.appendChild(wrap);
    scrollToBottom();
  }

  function removeTypingEl() {
    document.getElementById('typing-wrap')?.remove();
    typingEl = null;
  }

  function scrollToBottom() { messagesArea.scrollTop = messagesArea.scrollHeight; }

  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  // ── Send ───────────────────────────────────────────────────────────────────
  function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || !connected) return;
    socket.emit('message', { text, id: ++msgIdCounter });
    addBubble(text, true);
    msgInput.value = '';
    charCount.textContent = '';
    adjustHeight();
    if (isTyping) { isTyping = false; socket.emit('typing', { isTyping: false }); }
    clearTimeout(typingTimeout);
  }

  sendBtn.addEventListener('click', sendMessage);
  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  msgInput.addEventListener('input', () => {
    adjustHeight();
    const len = msgInput.value.length;
    charCount.textContent = len > 400 ? `${len}/500` : '';
    if (!connected) return;
    if (!isTyping) { isTyping = true; socket.emit('typing', { isTyping: true }); }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => { isTyping = false; socket.emit('typing', { isTyping: false }); }, 2000);
  });

  function adjustHeight() {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 110) + 'px';
  }

  // ── Controls ───────────────────────────────────────────────────────────────
  function resetForNext() {
    connected     = false;
    chatStartTime = null;
    messageCount  = 0;
    messagesArea.innerHTML = '';
    msgInput.value = '';
    sharedInterests.length = 0;
    sharedChipsTopbar.innerHTML = '';
    statusDot.className = 'status-dot yellow';
    partnerLabel.textContent = 'Finding next...';
    disconnectedOverlay.classList.add('hidden');
    connectingOverlay.classList.remove('hidden');
    connectingText.textContent = 'Finding next stranger...';
  }

  stopBtn.addEventListener('click', () => {
    socket.emit('stop-chat');
    connected = false;
    const dur = chatStartTime ? formatDuration(Date.now() - chatStartTime) : '0s';
    disconnectStats.textContent = `Chat lasted ${dur} — ${messageCount} messages`;
    disconnectedOverlay.classList.remove('hidden');
    addSysMsg('You ended the chat.');
  });

  nextBtn.addEventListener('click', () => {
    socket.emit('stop-chat');
    resetForNext();
    socket.emit('find-match', { interests: myInterests, fingerprint, myGender, preferGender: 'any', countryFilter: false });
  });

  homeBtn.addEventListener('click', () => { socket.emit('stop-chat'); location.href = '/'; });

  findNextBtn.addEventListener('click', () => {
    resetForNext();
    socket.emit('find-match', { interests: myInterests, fingerprint, myGender, preferGender: 'any', countryFilter: false });
  });

  // ── Socket events ──────────────────────────────────────────────────────────
  socket.on('matched', ({ sharedInterests: shared, partnerInterests: pi, partnerGender }) => {
    if (shared && shared.length) {
      sharedInterests.length = 0;
      shared.forEach(i => sharedInterests.push(i));
      sharedChipsTopbar.innerHTML = shared
        .map(i => `<span class="chip shared" style="font-size:11px;padding:2px 8px">${escHtml(i)}</span>`)
        .join('');
    }
    setConnected(true);
    if (partnerGender && partnerGender !== 'other') {
      const gl = partnerLabel.textContent;
      partnerLabel.title = `Partner gender: ${partnerGender}`;
    }
  });

  socket.on('message', ({ text }) => { addBubble(text, false); });

  socket.on('typing', ({ isTyping: st }) => { st ? showTypingEl() : removeTypingEl(); });

  socket.on('partner-left', () => {
    connected = false;
    removeTypingEl();
    statusDot.className = 'status-dot red';
    partnerLabel.textContent = 'Stranger disconnected';
    addSysMsg('Stranger has left the chat.');
    const dur = chatStartTime ? formatDuration(Date.now() - chatStartTime) : '0s';
    disconnectStats.textContent = `Chat lasted ${dur} — ${messageCount} messages`;
    disconnectedOverlay.classList.remove('hidden');
    msgInput.disabled = true;
    sendBtn.disabled  = true;
    nextBtn.disabled  = true;
  });

  socket.on('status', ({ message }) => { if (connectingText) connectingText.textContent = message || 'Searching...'; });

  socket.on('disconnect', () => {
    if (connected) { connected = false; addSysMsg('Connection lost. Reconnecting...'); statusDot.className = 'status-dot red'; }
  });

  socket.on('connect', () => {
    if (!connected) {
      socket.emit('find-match', { interests: myInterests, fingerprint, myGender, preferGender: 'any', countryFilter: false });
    }
  });

  init();
})();
