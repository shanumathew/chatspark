/**
 * landing.js v2
 * FingerprintJS + Razorpay + gender-aware matchmaking
 */
(function () {
  'use strict';

  const MAX_FREE_INTERESTS = 2;

  // ── State ──────────────────────────────────────────────────────────────────
  let interests   = [];
  let myGender    = null;   // 'male' | 'female' | 'other'
  let preferGender = 'any'; // 'male' | 'female' | 'any'
  let isPremium   = false;
  let fingerprint = '';
  let searching   = false;
  let rzpKeyId    = '';
  let countdownInterval = null;

  // ── Elements ───────────────────────────────────────────────────────────────
  const chipWrap          = document.getElementById('chip-wrap');
  const interestInput     = document.getElementById('interest-input');
  const limitNote         = document.getElementById('limit-note');
  const startBtn          = document.getElementById('start-btn');
  const randomBtn         = document.getElementById('random-btn');
  const payBtn            = document.getElementById('pay-btn');
  const payNote           = document.getElementById('pay-note');
  const premiumBadge      = document.getElementById('premium-badge');
  const premiumUpsell     = document.getElementById('premium-upsell');
  const premiumActive     = document.getElementById('premium-active');
  const premiumExpiryText = document.getElementById('premium-expiry-text');
  const countryToggle     = document.getElementById('country-filter-toggle');
  const searchOverlay     = document.getElementById('searching-overlay');
  const searchStatusText  = document.getElementById('search-status-text');
  const searchSubText     = document.getElementById('search-sub-text');
  const countdownNum      = document.getElementById('countdown-num');
  const countdownCircle   = document.getElementById('countdown-circle');
  const timerSection      = document.getElementById('timer-section');
  const fallbackNote      = document.getElementById('fallback-note');
  const cancelSearchBtn   = document.getElementById('cancel-search-btn');
  const genderLockBadge   = document.getElementById('gender-lock-badge');

  // ── Socket ─────────────────────────────────────────────────────────────────
  const socket = io();

  // ── Init ───────────────────────────────────────────────────────────────────
  async function init() {
    // Load Razorpay key ID from server
    try {
      const cfg = await fetch('/api/config').then(r => r.json());
      rzpKeyId = cfg.razorpayKeyId || '';
    } catch (_) {}

    // Generate fingerprint
    try {
      const FP = await FingerprintJS.load();
      const result = await FP.get();
      fingerprint = result.visitorId;
    } catch (_) {
      fingerprint = Math.random().toString(36).slice(2);
    }

    // Check premium
    await checkPremium();

    // Select "Any" as default for prefer-gender
    selectPrefGender('any');
  }

  // ── Premium ────────────────────────────────────────────────────────────────
  async function checkPremium() {
    if (!fingerprint) return;
    try {
      const data = await fetch(`/api/check-premium?fp=${fingerprint}`).then(r => r.json());
      if (data.isPremium) {
        activatePremiumUI(data.expiresAt);
      }
    } catch (_) {}
  }

  function activatePremiumUI(expiresAt) {
    isPremium = true;

    // Badge
    premiumBadge.classList.remove('hidden');

    // Cards
    premiumUpsell.classList.add('hidden');
    premiumActive.classList.remove('hidden');

    // Expiry text
    if (expiresAt) {
      const remaining = Math.max(0, Math.round((expiresAt - Date.now()) / 1000 / 60 / 60 * 10) / 10);
      premiumExpiryText.textContent = `${remaining} hour${remaining !== 1 ? 's' : ''} remaining`;
    }

    // Unlock prefer-gender buttons and country filter
    unlockPrefGender();
    countryToggle.disabled = false;
    genderLockBadge.classList.add('hidden');

    updateChipLimit();
  }

  function unlockPrefGender() {
    document.querySelectorAll('#pref-gender-group .gender-btn').forEach(btn => {
      btn.disabled    = false;
      btn.classList.remove('locked');
    });
  }

  // ── Payment ────────────────────────────────────────────────────────────────
  if (payBtn) {
    payBtn.addEventListener('click', async () => {
      if (!rzpKeyId) {
        payNote.textContent = 'Payment is not configured yet. Please check back soon.';
        payNote.style.color = 'var(--red)';
        return;
      }
      payBtn.disabled     = true;
      payBtn.textContent  = 'Creating order...';

      try {
        const { success, order, error } = await fetch('/api/create-order', { method: 'POST' }).then(r => r.json());
        if (!success) throw new Error(error || 'Order creation failed');

        const options = {
          key:         rzpKeyId,
          amount:      order.amount,
          currency:    order.currency,
          name:        'ChatSpark',
          description: 'Premium Access — 24 hours',
          order_id:    order.id,
          theme:       { color: '#F01869' },
          prefill:     {},
          handler: async (response) => {
            try {
              payBtn.textContent = 'Verifying...';
              const verify = await fetch('/api/verify-payment', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                  razorpay_order_id:   response.razorpay_order_id,
                  razorpay_payment_id: response.razorpay_payment_id,
                  razorpay_signature:  response.razorpay_signature,
                  fingerprint,
                }),
              }).then(r => r.json());

              if (verify.success) {
                activatePremiumUI(verify.expiresAt);
              } else {
                throw new Error(verify.error || 'Verification failed');
              }
            } catch (err) {
              payNote.textContent = 'Payment error: ' + err.message;
              payNote.style.color = 'var(--red)';
              payBtn.disabled     = false;
              payBtn.textContent  = 'Pay Rs.50 — Unlock for 24 hours';
            }
          },
          modal: {
            ondismiss: () => {
              payBtn.disabled    = false;
              payBtn.innerHTML   = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="4" width="22" height="16" rx="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg> Pay Rs.50 — Unlock for 24 hours`;
            },
          },
        };

        const rzp = new Razorpay(options);
        rzp.open();
      } catch (err) {
        payNote.textContent = 'Error: ' + err.message;
        payNote.style.color = 'var(--red)';
        payBtn.disabled     = false;
        payBtn.textContent  = 'Pay Rs.50 — Unlock for 24 hours';
      }
    });
  }

  // ── Gender selectors ───────────────────────────────────────────────────────
  function setupGenderGroup(groupId, onSelect) {
    const group = document.getElementById(groupId);
    if (!group) return;
    group.addEventListener('click', (e) => {
      const btn = e.target.closest('.gender-btn');
      if (!btn || btn.disabled) return;
      const g = btn.dataset.gender;
      group.querySelectorAll('.gender-btn').forEach(b => {
        b.className = b.className.replace(/active-\w+/g, '').trim();
      });
      btn.classList.add(`active-${g}`);
      onSelect(g);
    });
  }

  setupGenderGroup('my-gender-group', (g) => { myGender = g; });
  setupGenderGroup('pref-gender-group', (g) => { preferGender = g; });

  function selectPrefGender(g) {
    const group = document.getElementById('pref-gender-group');
    if (!group) return;
    group.querySelectorAll('.gender-btn').forEach(b => {
      b.className = b.className.replace(/active-\w+/g, '').trim();
    });
    const target = group.querySelector(`[data-gender="${g}"]`);
    if (target) target.classList.add(`active-${g}`);
    preferGender = g;
  }

  // ── Interest chips ─────────────────────────────────────────────────────────
  function maxInterests() { return isPremium ? 10 : MAX_FREE_INTERESTS; }

  function addInterest(raw) {
    const clean = raw.trim().toLowerCase().replace(/[^a-z0-9\s-]/g, '').slice(0, 30);
    if (!clean || interests.includes(clean) || interests.length >= maxInterests()) return;
    interests.push(clean);
    renderChip(clean);
    updateChipLimit();
  }

  function removeInterest(text) { interests = interests.filter(i => i !== text); updateChipLimit(); }

  function renderChip(text) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.interest = text;
    chip.innerHTML = `${escHtml(text)}<button class="chip-remove" aria-label="Remove">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
    </button>`;
    chip.querySelector('.chip-remove').addEventListener('click', () => { chip.remove(); removeInterest(text); });
    chipWrap.insertBefore(chip, interestInput);
  }

  function updateChipLimit() {
    const rem = maxInterests() - interests.length;
    if (!isPremium) {
      limitNote.innerHTML = rem > 0
        ? `Free plan: up to <b>${MAX_FREE_INTERESTS} interests</b> (${rem} remaining).`
        : `Free limit reached. <strong>Upgrade to Premium</strong> for unlimited.`;
    } else {
      limitNote.textContent = 'Premium: unlimited interests unlocked.';
      limitNote.style.color = 'var(--green)';
    }
    interestInput.disabled = interests.length >= maxInterests();
    interestInput.placeholder = interestInput.disabled ? 'Limit reached' : 'Type and press Enter or comma...';
  }

  interestInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      const val = interestInput.value.replace(',', '').trim();
      if (val) addInterest(val);
      interestInput.value = '';
    } else if (e.key === 'Backspace' && !interestInput.value && interests.length) {
      const last = interests[interests.length - 1];
      chipWrap.querySelector(`[data-interest="${CSS.escape(last)}"]`)?.remove();
      removeInterest(last);
    }
  });
  interestInput.addEventListener('input', () => {
    if (interestInput.value.endsWith(',')) {
      const v = interestInput.value.slice(0, -1).trim();
      if (v) addInterest(v);
      interestInput.value = '';
    }
  });
  chipWrap.addEventListener('click', () => interestInput.focus());

  // ── Countdown ──────────────────────────────────────────────────────────────
  const CIRCUMFERENCE = 2 * Math.PI * 20; // r=20 → ~125.7

  function startCountdown(seconds) {
    let remaining = seconds;
    countdownNum.textContent = remaining;
    countdownCircle.style.strokeDashoffset = '0';

    countdownInterval = setInterval(() => {
      remaining--;
      countdownNum.textContent = Math.max(0, remaining);
      const pct = (seconds - remaining) / seconds;
      countdownCircle.style.strokeDashoffset = pct * CIRCUMFERENCE;

      if (remaining <= 0) {
        clearInterval(countdownInterval);
        timerSection.classList.add('hidden');
        fallbackNote.classList.remove('hidden');
        searchSubText.textContent = 'Joining general pool...';
      }
    }, 1000);
  }

  function stopCountdown() {
    clearInterval(countdownInterval);
    countdownInterval = null;
  }

  // ── Searching overlay ──────────────────────────────────────────────────────
  function showSearch(withInterests) {
    searching = true;
    searchOverlay.classList.remove('hidden');
    timerSection.classList.remove('hidden');
    fallbackNote.classList.add('hidden');

    if (withInterests && interests.length) {
      searchStatusText.textContent = 'Finding your match';
      searchSubText.textContent = `Looking for: ${interests.join(', ')}`;
      startCountdown(15);
    } else {
      searchStatusText.textContent = 'Finding someone to chat with';
      searchSubText.textContent = 'Searching general pool';
      timerSection.classList.add('hidden');
    }
  }

  function hideSearch() {
    searching = false;
    searchOverlay.classList.add('hidden');
    stopCountdown();
  }

  cancelSearchBtn.addEventListener('click', () => { socket.emit('stop-chat'); hideSearch(); });

  // ── CTA buttons ────────────────────────────────────────────────────────────
  startBtn.addEventListener('click', () => {
    if (searching) return;
    sessionStorage.setItem('cs_interests', JSON.stringify(interests));
    sessionStorage.setItem('cs_premium',   isPremium ? '1' : '0');
    sessionStorage.setItem('cs_fp',        fingerprint);
    sessionStorage.setItem('cs_my_gender', myGender || 'other');

    socket.emit('find-match', {
      interests,
      fingerprint,
      myGender:     myGender || 'other',
      preferGender: isPremium ? preferGender : 'any',
      countryFilter: countryToggle.checked && isPremium,
    });
    showSearch(interests.length > 0);
  });

  randomBtn.addEventListener('click', () => {
    if (searching) return;
    sessionStorage.setItem('cs_interests', JSON.stringify([]));
    sessionStorage.setItem('cs_premium',   isPremium ? '1' : '0');
    sessionStorage.setItem('cs_fp',        fingerprint);
    sessionStorage.setItem('cs_my_gender', myGender || 'other');
    socket.emit('find-anyone', { fingerprint, myGender: myGender || 'other' });
    showSearch(false);
  });

  // ── Socket events ──────────────────────────────────────────────────────────
  socket.on('matched', ({ roomId, sharedInterests, partnerInterests }) => {
    stopCountdown();
    sessionStorage.setItem('cs_room',              roomId);
    sessionStorage.setItem('cs_shared',            JSON.stringify(sharedInterests || []));
    sessionStorage.setItem('cs_partner_interests', JSON.stringify(partnerInterests || []));
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

  // ── Helper ─────────────────────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  init();
})();
