/**
 * landing.js — ChatSpark landing page logic
 * Handles: interest chip input, premium toggle, find-match emit, countdown UI
 */

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────────────────────
  const MAX_FREE_INTERESTS = 2;
  let interests = [];
  let isPremium = false;
  let searching = false;
  let countdownTimer = null;
  let fallbackTimer = null;

  // ── Elements ───────────────────────────────────────────────────────────────
  const chipWrap = document.getElementById('chip-wrap');
  const interestInput = document.getElementById('interest-input');
  const limitNote = document.getElementById('limit-note');
  const startBtn = document.getElementById('start-btn');
  const randomBtn = document.getElementById('random-btn');
  const activatePremiumBtn = document.getElementById('activate-premium-btn');
  const premiumBadge = document.getElementById('premium-badge-display');
  const premiumUpsell = document.getElementById('premium-upsell');
  const countryToggle = document.getElementById('country-filter-toggle');
  const hardFilterToggle = document.getElementById('hard-filter-toggle');
  const searchOverlay = document.getElementById('searching-overlay');
  const searchStatusText = document.getElementById('search-status-text');
  const searchSubText = document.getElementById('search-sub-text');
  const countdownNum = document.getElementById('countdown-num');
  const countdownCircle = document.getElementById('countdown-circle');
  const timerSection = document.getElementById('timer-section');
  const fallbackNote = document.getElementById('fallback-note');
  const cancelSearchBtn = document.getElementById('cancel-search-btn');

  // ── Socket ────────────────────────────────────────────────────────────────
  const socket = io();

  // ── Premium detection (localStorage flag) ────────────────────────────────
  function checkPremium() {
    // URL param ?premium=1 OR localStorage
    const params = new URLSearchParams(location.search);
    if (params.get('premium') === '1' || localStorage.getItem('chatspark_premium') === '1') {
      enablePremium();
    }
  }

  function enablePremium() {
    isPremium = true;
    localStorage.setItem('chatspark_premium', '1');
    premiumBadge.classList.remove('hidden');
    premiumUpsell.classList.add('hidden');
    countryToggle.disabled = false;
    hardFilterToggle.disabled = false;
    limitNote.innerHTML = 'Premium: <b style="color:var(--accent-3)">unlimited interests</b> · hard filters enabled';
    updateChipLimit();
  }

  activatePremiumBtn.addEventListener('click', () => {
    enablePremium();
    activatePremiumBtn.textContent = '✓ Activated';
    activatePremiumBtn.disabled = true;
  });

  // ── Interest chip management ───────────────────────────────────────────────
  function maxAllowed() {
    return isPremium ? 10 : MAX_FREE_INTERESTS;
  }

  function addInterest(text) {
    const clean = text.trim().toLowerCase().replace(/[^a-z0-9\s\-]/g, '').slice(0, 30);
    if (!clean || interests.includes(clean)) return;
    if (interests.length >= maxAllowed()) return;

    interests.push(clean);
    renderChip(clean);
    updateChipLimit();
  }

  function removeInterest(text) {
    interests = interests.filter(i => i !== text);
    updateChipLimit();
  }

  function renderChip(text) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.interest = text;
    chip.innerHTML = `${escapeHtml(text)} <button class="chip-remove" aria-label="Remove ${text}">×</button>`;
    chip.querySelector('.chip-remove').addEventListener('click', () => {
      chip.remove();
      removeInterest(text);
    });
    chipWrap.insertBefore(chip, interestInput);
  }

  function updateChipLimit() {
    const remaining = maxAllowed() - interests.length;
    if (!isPremium) {
      limitNote.innerHTML = remaining > 0
        ? `Free: up to <b>${MAX_FREE_INTERESTS} interests</b> (${remaining} remaining). Unlock more with Premium ↓`
        : `Free limit reached. <b style="color:var(--accent-2)">Upgrade to Premium</b> for more.`;
    }
    interestInput.disabled = interests.length >= maxAllowed();
    if (interestInput.disabled) interestInput.placeholder = 'Limit reached';
    else interestInput.placeholder = 'Type an interest and press Enter or comma…';
  }

  interestInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = interestInput.value.replace(',', '').trim();
      if (val) addInterest(val);
      interestInput.value = '';
    } else if (e.key === 'Backspace' && !interestInput.value && interests.length > 0) {
      // Remove last chip
      const last = interests[interests.length - 1];
      chipWrap.querySelector(`[data-interest="${CSS.escape(last)}"]`)?.remove();
      removeInterest(last);
    }
  });

  interestInput.addEventListener('input', () => {
    const val = interestInput.value;
    if (val.endsWith(',')) {
      const clean = val.slice(0, -1).trim();
      if (clean) addInterest(clean);
      interestInput.value = '';
    }
  });

  chipWrap.addEventListener('click', () => interestInput.focus());

  // ── Countdown UI ───────────────────────────────────────────────────────────
  const CIRCUMFERENCE = 2 * Math.PI * 22; // ≈ 138.2

  function startCountdown(seconds) {
    let remaining = seconds;
    countdownNum.textContent = remaining;
    countdownCircle.style.strokeDashoffset = '0';

    countdownTimer = setInterval(() => {
      remaining--;
      countdownNum.textContent = Math.max(0, remaining);
      const offset = ((seconds - remaining) / seconds) * CIRCUMFERENCE;
      countdownCircle.style.strokeDashoffset = offset;

      if (remaining <= 0) {
        clearInterval(countdownTimer);
        countdownTimer = null;
        // Countdown done — show fallback note, hide timer
        timerSection.classList.add('hidden');
        fallbackNote.classList.remove('hidden');
        searchSubText.textContent = 'Joining general pool…';
      }
    }, 1000);
  }

  function stopCountdown() {
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
  }

  // ── Search overlay ─────────────────────────────────────────────────────────
  function showSearchOverlay(withInterests) {
    searching = true;
    searchOverlay.classList.remove('hidden');
    timerSection.classList.remove('hidden');
    fallbackNote.classList.add('hidden');

    if (withInterests && interests.length > 0) {
      searchStatusText.textContent = 'Finding your match…';
      searchSubText.textContent = `Looking for someone who likes: ${interests.join(', ')}`;
      if (!isPremium || !hardFilterToggle.checked) {
        startCountdown(15);
      } else {
        // Premium hard filter — no countdown
        timerSection.classList.add('hidden');
        searchSubText.textContent = 'Hard filter: waiting for exact interest match…';
      }
    } else {
      searchStatusText.textContent = 'Finding someone to chat with…';
      searchSubText.textContent = 'General pool — connecting shortly';
      timerSection.classList.add('hidden');
    }
  }

  function hideSearchOverlay() {
    searching = false;
    searchOverlay.classList.add('hidden');
    stopCountdown();
  }

  cancelSearchBtn.addEventListener('click', () => {
    socket.emit('stop-chat');
    hideSearchOverlay();
  });

  // ── Start buttons ──────────────────────────────────────────────────────────
  startBtn.addEventListener('click', () => {
    if (searching) return;
    const countryFilter = countryToggle.checked && isPremium;

    // Store session data for chat page
    sessionStorage.setItem('cs_interests', JSON.stringify(interests));
    sessionStorage.setItem('cs_premium', isPremium ? '1' : '0');

    socket.emit('find-match', {
      interests,
      isPremium,
      countryFilter,
    });

    showSearchOverlay(interests.length > 0);
  });

  randomBtn.addEventListener('click', () => {
    if (searching) return;
    sessionStorage.setItem('cs_interests', JSON.stringify([]));
    sessionStorage.setItem('cs_premium', isPremium ? '1' : '0');
    socket.emit('find-anyone');
    showSearchOverlay(false);
  });

  // ── Socket events ──────────────────────────────────────────────────────────
  socket.on('matched', ({ roomId, sharedInterests, partnerInterests }) => {
    stopCountdown();
    // Store room data for chat page
    sessionStorage.setItem('cs_room', roomId);
    sessionStorage.setItem('cs_shared', JSON.stringify(sharedInterests));
    sessionStorage.setItem('cs_partner_interests', JSON.stringify(partnerInterests));
    // Navigate
    location.href = '/chat.html';
  });

  socket.on('status', ({ type, message }) => {
    if (type === 'fallback') {
      stopCountdown();
      timerSection.classList.add('hidden');
      fallbackNote.classList.remove('hidden');
      searchSubText.textContent = message;
    }
  });

  socket.on('disconnect', () => {
    if (searching) {
      searchStatusText.textContent = 'Connection lost…';
      searchSubText.textContent = 'Reconnecting';
    }
  });

  // ── Helpers ────────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  checkPremium();
})();
