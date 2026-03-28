/**
 * chat.js — ChatSpark chat page logic
 * Handles: message send/receive, typing indicators, stop/next, partner disconnect
 */

(function () {
  'use strict';

  // ── Session data from landing page ────────────────────────────────────────
  const myInterests = JSON.parse(sessionStorage.getItem('cs_interests') || '[]');
  const isPremium = sessionStorage.getItem('cs_premium') === '1';
  const sharedInterests = JSON.parse(sessionStorage.getItem('cs_shared') || '[]');
  const partnerInterests = JSON.parse(sessionStorage.getItem('cs_partner_interests') || '[]');

  // ── State ──────────────────────────────────────────────────────────────────
  let connected = false;
  let chatStartTime = null;
  let messageCount = 0;
  let typingTimeout = null;
  let isTyping = false;
  let typingEl = null;
  let msgIdCounter = 0;

  // ── Elements ───────────────────────────────────────────────────────────────
  const connectingOverlay = document.getElementById('connecting-overlay');
  const connectingText = document.getElementById('connecting-text');
  const disconnectedOverlay = document.getElementById('disconnected-overlay');
  const disconnectStats = document.getElementById('disconnect-stats');
  const messagesArea = document.getElementById('messages-area');
  const msgInput = document.getElementById('msg-input');
  const sendBtn = document.getElementById('send-btn');
  const stopBtn = document.getElementById('stop-btn');
  const nextBtn = document.getElementById('next-btn');
  const homeBtn = document.getElementById('home-btn');
  const statusDot = document.getElementById('status-dot');
  const partnerLabel = document.getElementById('partner-label');
  const sharedChipsTopbar = document.getElementById('shared-chips-topbar');
  const charCount = document.getElementById('char-count');
  const findNextBtn = document.getElementById('find-next-btn');
  const premiumIndicator = document.getElementById('premium-indicator');

  // ── Socket ────────────────────────────────────────────────────────────────
  const socket = io();

  // ── Init ──────────────────────────────────────────────────────────────────
  function init() {
    // If no session data, re-emit find-match from stored state or go home
    connectingText.textContent = 'Reconnecting to your match…';

    // Show premium badge in topbar if premium
    if (isPremium) {
      premiumIndicator.innerHTML = '<span class="badge badge-premium" style="font-size:10px">★ Premium</span>';
    }

    // Render shared interest chips in topbar
    if (sharedInterests.length > 0) {
      sharedChipsTopbar.innerHTML = sharedInterests
        .map(i => `<span class="chip shared" style="font-size:11px;padding:3px 9px">${escapeHtml(i)}</span>`)
        .join('');
    }

    // Reconnect: re-emit find-match (the server will match us again since we navigate)
    socket.emit('find-match', {
      interests: myInterests,
      isPremium,
      countryFilter: false,
    });
  }

  // ── UI helpers ────────────────────────────────────────────────────────────
  function setConnected(on) {
    connected = on;
    msgInput.disabled = !on;
    sendBtn.disabled = !on;
    stopBtn.disabled = false;
    nextBtn.disabled = !on;

    if (on) {
      connectingOverlay.classList.add('hidden');
      statusDot.className = 'status-dot';
      partnerLabel.textContent = sharedInterests.length > 0
        ? `Stranger · likes: ${sharedInterests.join(', ')}`
        : 'Stranger';
      chatStartTime = Date.now();
      addSysMsg('🟢 Connected to a stranger. Say hi!');
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
    removetypingIndicator();
    const wrap = document.createElement('div');
    wrap.style.cssText = `display:flex; width:100%; justify-content:${mine ? 'flex-end' : 'flex-start'}`;

    const bubble = document.createElement('div');
    bubble.className = `bubble ${mine ? 'mine' : 'theirs'} fade-in`;
    bubble.textContent = text;

    wrap.appendChild(bubble);
    messagesArea.appendChild(wrap);
    scrollToBottom();
    messageCount++;
  }

  function showTypingIndicator() {
    if (typingEl) return;
    const wrap = document.createElement('div');
    wrap.id = 'typing-wrap';
    wrap.style.cssText = 'display:flex; width:100%; justify-content:flex-start';
    typingEl = document.createElement('div');
    typingEl.className = 'typing-indicator fade-in';
    typingEl.innerHTML = '<div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div>';
    wrap.appendChild(typingEl);
    messagesArea.appendChild(wrap);
    scrollToBottom();
  }

  function removetypingIndicator() {
    const el = document.getElementById('typing-wrap');
    if (el) el.remove();
    typingEl = null;
  }

  function scrollToBottom() {
    messagesArea.scrollTop = messagesArea.scrollHeight;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    return `${Math.floor(s / 60)}m ${s % 60}s`;
  }

  // ── Message send ───────────────────────────────────────────────────────────
  function sendMessage() {
    const text = msgInput.value.trim();
    if (!text || !connected) return;

    const id = ++msgIdCounter;
    socket.emit('message', { text, id });
    addBubble(text, true);
    msgInput.value = '';
    charCount.textContent = '';
    adjustTextareaHeight();

    // Stop typing signal
    if (isTyping) {
      isTyping = false;
      socket.emit('typing', { isTyping: false });
    }
    clearTimeout(typingTimeout);
  }

  sendBtn.addEventListener('click', sendMessage);

  msgInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // ── Typing indicator emit ─────────────────────────────────────────────────
  msgInput.addEventListener('input', () => {
    adjustTextareaHeight();
    const len = msgInput.value.length;
    charCount.textContent = len > 400 ? `${len}/500` : '';

    if (!connected) return;
    if (!isTyping) {
      isTyping = true;
      socket.emit('typing', { isTyping: true });
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      isTyping = false;
      socket.emit('typing', { isTyping: false });
    }, 2000);
  });

  function adjustTextareaHeight() {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight, 120) + 'px';
  }

  // ── Stop / Next ───────────────────────────────────────────────────────────
  stopBtn.addEventListener('click', () => {
    socket.emit('stop-chat');
    connected = false;
    const duration = chatStartTime ? formatDuration(Date.now() - chatStartTime) : '–';
    disconnectStats.textContent = `Chat lasted ${duration} · ${messageCount} messages exchanged`;
    disconnectedOverlay.classList.remove('hidden');
    addSysMsg('🔴 You ended the chat.');
  });

  nextBtn.addEventListener('click', () => {
    socket.emit('stop-chat');
    connected = false;
    // Re-initiate search immediately
    connectingOverlay.classList.remove('hidden');
    connectingText.textContent = 'Finding next stranger…';
    messagesArea.innerHTML = '';
    messageCount = 0;
    chatStartTime = null;
    msgInput.value = '';

    socket.emit('find-match', {
      interests: myInterests,
      isPremium,
      countryFilter: false,
    });
  });

  homeBtn.addEventListener('click', () => {
    socket.emit('stop-chat');
    location.href = '/';
  });

  findNextBtn.addEventListener('click', () => {
    disconnectedOverlay.classList.add('hidden');
    connectingOverlay.classList.remove('hidden');
    connectingText.textContent = 'Finding next stranger…';
    messagesArea.innerHTML = '';
    messageCount = 0;
    chatStartTime = null;
    setConnected(false);

    socket.emit('find-match', {
      interests: myInterests,
      isPremium,
      countryFilter: false,
    });
  });

  // ── Socket events ──────────────────────────────────────────────────────────
  socket.on('matched', ({ sharedInterests: shared, partnerInterests: pi }) => {
    // Update session with fresh shared interests if rematched
    if (shared) {
      sharedInterests.length = 0;
      shared.forEach(i => sharedInterests.push(i));
      sharedChipsTopbar.innerHTML = shared
        .map(i => `<span class="chip shared" style="font-size:11px;padding:3px 9px">${escapeHtml(i)}</span>`)
        .join('');
    }
    setConnected(true);
  });

  socket.on('message', ({ text, id }) => {
    addBubble(text, false);
  });

  socket.on('typing', ({ isTyping: strangerTyping }) => {
    if (strangerTyping) {
      showTypingIndicator();
    } else {
      removetypingIndicator();
    }
  });

  socket.on('partner-left', () => {
    connected = false;
    removetypingIndicator();
    statusDot.className = 'status-dot red';
    partnerLabel.textContent = 'Stranger disconnected';
    addSysMsg('🔴 Stranger has left the chat.');

    const duration = chatStartTime ? formatDuration(Date.now() - chatStartTime) : '–';
    disconnectStats.textContent = `Chat lasted ${duration} · ${messageCount} messages exchanged`;
    disconnectedOverlay.classList.remove('hidden');
    msgInput.disabled = true;
    sendBtn.disabled = true;
    nextBtn.disabled = true;
  });

  socket.on('status', ({ message }) => {
    connectingText.textContent = message || 'Searching…';
  });

  socket.on('disconnect', () => {
    if (connected) {
      connected = false;
      addSysMsg('⚠️ Connection lost. Trying to reconnect…');
      statusDot.className = 'status-dot red';
    }
  });

  socket.on('connect', () => {
    if (!connected) {
      // Re-trigger search on reconnect
      socket.emit('find-match', {
        interests: myInterests,
        isPremium,
        countryFilter: false,
      });
    }
  });

  // ── Start ─────────────────────────────────────────────────────────────────
  init();
})();
