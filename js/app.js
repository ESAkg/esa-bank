'use strict';
/* ESA Bank — фронтенд-логика (vanilla JS, без сборки) */

const API = '/api';
let state = {
  token: localStorage.getItem('esa_token') || null,
  user: null,
  pendingRecipient: null,   // для перевода по телефону
  pendingQrRecipient: null, // для перевода по QR
  qrScanner: null,
  deferredInstallPrompt: null,
  ratesTimer: null
};

// ---------- Навигация ----------
function goto(screenId, opts) {
  const isBack = !!(opts && opts.back);
  const prevActive = document.querySelector('.screen.active');
  if (prevActive && prevActive.id === 'screen-qr-pay' && screenId !== 'screen-qr-pay') stopQrScanner();
  if (prevActive && prevActive.id === 'screen-register' && screenId !== 'screen-register' && typeof stopRegFaceCamera === 'function') stopRegFaceCamera();
  if (screenId === 'screen-register') { if (typeof resetRegisterForm === 'function') resetRegisterForm(); }
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active', 'screen-back'));
  const el = document.getElementById(screenId);
  if (el) {
    if (isBack) el.classList.add('screen-back');
    // force reflow so the animation class re-triggers even if same screen
    void el.offsetWidth;
    el.classList.add('active');
  }
  document.querySelectorAll('.nav-item, .side-item').forEach(n => {
    n.classList.toggle('active', n.dataset.goto === screenId);
  });
  window.scrollTo(0, 0);
  if (screenId === 'screen-dashboard') loadDashboard();
  if (screenId === 'screen-history') loadHistory();
  if (screenId === 'screen-qr-receive') loadMyQr();
  if (screenId === 'screen-profile') loadProfile();
  if (screenId === 'screen-stats') loadStatsScreen();
  if (screenId === 'screen-cards') loadCardsScreen();
  if (screenId === 'screen-piggy') loadPiggyScreen();
  if (screenId === 'screen-atm-map') loadLocatorScreen();
  if (screenId === 'screen-settings') {
    const pinBtn = document.getElementById('open-pin-setup-btn');
    if (pinBtn) pinBtn.textContent = hasPin() ? t('settings_pin_change') : t('settings_pin_set');
  }
  if (screenId === 'screen-transfer-phone') resetTransferPhoneForm();
  if (screenId === 'screen-qr-pay') resetQrPayForm();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-goto]');
  if (t) { e.preventDefault(); goto(t.dataset.goto, { back: t.classList.contains('back-btn') }); }
});

// ---------- Ripple + micro-interaction effect ----------
(function initRipple() {
  const RIPPLE_SELECTOR = '.btn, .quick-action, .card-action-btn, .nav-item, .side-item, .icon-btn, ' +
    '.menu-row, .settings-row, .pin-key, .card-theme-swatch, .card-action-btn, .help-contact-row, .bal-card .cta';
  document.addEventListener('pointerdown', (e) => {
    const host = e.target.closest(RIPPLE_SELECTOR);
    if (!host) return;
    const cs = getComputedStyle(host);
    if (cs.position === 'static') host.style.position = 'relative';
    host.classList.add('ripple-host');
    const rect = host.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 1.2;
    const wave = document.createElement('span');
    wave.className = 'ripple-wave';
    wave.style.width = wave.style.height = size + 'px';
    wave.style.left = (e.clientX - rect.left - size / 2) + 'px';
    wave.style.top = (e.clientY - rect.top - size / 2) + 'px';
    host.appendChild(wave);
    setTimeout(() => wave.remove(), 600);
  }, { passive: true });
})();

// ---------- Toast ----------
function toast(msg, type) {
  const host = document.getElementById('toast-host');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3800);
}

// ---------- Show/hide password ----------
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.toggle-eye');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.toggle);
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
});

// ---------- API helper ----------
async function api(method, path, body, auth = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth && state.token) headers['Authorization'] = 'Bearer ' + state.token;
  const res = await fetch(API + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });
  let data;
  try { data = await res.json(); } catch (_) { data = {}; }
  if (!res.ok) {
    const err = new Error(data.error || t('err_generic'));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function setError(elId, msg) {
  const el = document.getElementById(elId);
  if (el) el.textContent = msg || '';
}

// ======================================================
// THEME (light / dark)
// ======================================================
function getTheme() {
  return localStorage.getItem('esa_theme') || 'dark';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const isLight = theme === 'light';
  document.querySelectorAll('#theme-icon-use, #theme-icon-use-mobile, #theme-icon-use-settings').forEach(use => {
    use.setAttribute('href', isLight ? '#ic-sun' : '#ic-moon');
  });
}
function toggleTheme() {
  const next = getTheme() === 'light' ? 'dark' : 'light';
  localStorage.setItem('esa_theme', next);
  applyTheme(next);
}
['theme-toggle-btn', 'theme-toggle-btn-mobile', 'settings-theme-btn'].forEach(id => {
  document.getElementById(id) && document.getElementById(id).addEventListener('click', toggleTheme);
});
applyTheme(getTheme());

// ======================================================
// NOTIFICATIONS TOGGLE (Settings → Эскертүүлөр)
// ======================================================
(function initNotifToggle() {
  const toggle = document.getElementById('toggle-notifications');
  if (!toggle) return;
  const saved = localStorage.getItem('esa_notifications_enabled');
  if (saved !== null) toggle.checked = saved === '1';
  toggle.addEventListener('change', () => {
    localStorage.setItem('esa_notifications_enabled', toggle.checked ? '1' : '0');
    if (toggle.checked && 'Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  });
})();

// ======================================================
// LANGUAGE
// ======================================================
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-lang-btn]');
  if (!btn) return;
  setLang(btn.dataset.langBtn);
});
document.addEventListener('langchange', () => {
  // перерисовываем динамический контент на новом языке
  if (document.getElementById('screen-dashboard').classList.contains('active')) loadDashboard();
  if (document.getElementById('screen-stats').classList.contains('active')) loadStatsScreen();
  if (document.getElementById('screen-history').classList.contains('active')) loadHistory();
});
applyTranslations();
document.title = `${t('app_name')} — ${t('app_tagline')}`;

// ======================================================
// AUTH: LOGIN
// ======================================================
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('login-error', '');
  const phone = document.getElementById('login-phone').value.trim();
  const password = document.getElementById('login-password').value;
  const btn = document.getElementById('login-submit');
  const btnLabel = btn.querySelector('span');
  btn.disabled = true; if (btnLabel) btnLabel.textContent = t('login_loading');
  try {
    const data = await api('POST', '/auth/login', { phone, password }, false);
    onAuthSuccess(data);
  } catch (err) {
    setError('login-error', err.message);
  } finally {
    btn.disabled = false; if (btnLabel) btnLabel.textContent = t('btn_login');
  }
});

document.getElementById('link-register').addEventListener('click', () => goto('screen-register'));
document.getElementById('link-forgot').addEventListener('click', (e) => { e.preventDefault(); goto('screen-forgot'); });

// ======================================================
// AUTH: REGISTER (4-step: ФИО/телефон → паспорт → лицо → пароль)
// ======================================================
let regData = { fullName: '', phone: '', passportNumber: '', passportIssuedBy: '', birthDate: '', address: '', facePhoto: null };
let regFaceStream = null;

function showRegStep(n) {
  [1, 2, 3, 4].forEach(i => {
    document.getElementById(`reg-step-${i}-block`).style.display = (i === n) ? 'block' : 'none';
    document.getElementById(`reg-dot-${i}`).classList.toggle('active', i <= n);
  });
  if (n === 3) startRegFaceCamera(); else stopRegFaceCamera();
}

function resetRegisterForm() {
  document.getElementById('form-register-step1').reset();
  document.getElementById('form-register-step2').reset();
  document.getElementById('form-register-step4').reset();
  regData = { fullName: '', phone: '', passportNumber: '', passportIssuedBy: '', birthDate: '', address: '', facePhoto: null };
  resetFaceCaptureUI();
  showRegStep(1);
  setError('register-step1-error', '');
  setError('register-step2-error', '');
  setError('register-step3-error', '');
  setError('register-step4-error', '');
}

document.getElementById('form-register-step1').addEventListener('submit', (e) => {
  e.preventDefault();
  setError('register-step1-error', '');
  const fullName = document.getElementById('reg-name').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  if (fullName.length < 3) { setError('register-step1-error', t('err_fullname_required')); return; }
  regData.fullName = fullName; regData.phone = phone;
  showRegStep(2);
});

document.getElementById('reg-back-1-btn').addEventListener('click', () => showRegStep(1));
document.getElementById('reg-back-2-btn').addEventListener('click', () => showRegStep(2));
document.getElementById('reg-back-3-btn').addEventListener('click', () => showRegStep(3));

document.getElementById('form-register-step2').addEventListener('submit', (e) => {
  e.preventDefault();
  setError('register-step2-error', '');
  const passportNumber = document.getElementById('reg-passport-number').value.trim();
  const passportIssuedBy = document.getElementById('reg-passport-issued-by').value.trim();
  const birthDate = document.getElementById('reg-birth-date').value;
  const address = document.getElementById('reg-address').value.trim();
  if (!passportNumber || !passportIssuedBy || !birthDate || !address) {
    setError('register-step2-error', t('err_passport_required'));
    return;
  }
  regData.passportNumber = passportNumber;
  regData.passportIssuedBy = passportIssuedBy;
  regData.birthDate = birthDate;
  regData.address = address;
  showRegStep(3);
});

// ---------- Захват фото лица (камера) ----------
function resetFaceCaptureUI() {
  const video = document.getElementById('reg-face-video');
  const preview = document.getElementById('reg-face-preview');
  video.style.display = ''; preview.style.display = 'none'; preview.src = '';
  document.getElementById('reg-face-capture-btn').style.display = '';
  document.getElementById('reg-face-retake-btn').style.display = 'none';
  document.getElementById('reg-face-continue-btn').style.display = 'none';
}

async function startRegFaceCamera() {
  resetFaceCaptureUI();
  const video = document.getElementById('reg-face-video');
  const box = video.closest('.face-capture-box');
  try {
    regFaceStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    video.srcObject = regFaceStream;
  } catch (err) {
    const warn = document.createElement('div');
    warn.className = 'camera-unavailable';
    warn.innerHTML = `<svg class="icon icon-lg"><use href="#ic-camera"/></svg><span>${t('camera_unavailable')}</span>`;
    box.appendChild(warn);
    video.style.display = 'none';
  }
}
function stopRegFaceCamera() {
  if (regFaceStream) { regFaceStream.getTracks().forEach(tr => tr.stop()); regFaceStream = null; }
}

document.getElementById('reg-face-capture-btn').addEventListener('click', () => {
  const video = document.getElementById('reg-face-video');
  const canvas = document.getElementById('reg-face-canvas');
  const preview = document.getElementById('reg-face-preview');
  if (!video.videoWidth) { setError('register-step3-error', t('camera_unavailable')); return; }
  canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  // зеркалим так же, как превью, чтобы сохранённое фото выглядело естественно
  ctx.translate(canvas.width, 0); ctx.scale(-1, 1);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  regData.facePhoto = canvas.toDataURL('image/jpeg', 0.82);
  preview.src = regData.facePhoto;
  preview.style.display = ''; video.style.display = 'none';
  document.getElementById('reg-face-capture-btn').style.display = 'none';
  document.getElementById('reg-face-retake-btn').style.display = '';
  document.getElementById('reg-face-continue-btn').style.display = '';
  setError('register-step3-error', '');
  stopRegFaceCamera();
});

document.getElementById('reg-face-retake-btn').addEventListener('click', () => {
  regData.facePhoto = null;
  startRegFaceCamera();
});

document.getElementById('reg-face-continue-btn').addEventListener('click', () => {
  if (!regData.facePhoto) { setError('register-step3-error', t('face_capture_required')); return; }
  showRegStep(4);
});

function checkPwRules() {
  const pw = document.getElementById('reg-password').value;
  const rules = {
    len: pw.length >= 6,
    letter: /[a-zA-Zа-яА-ЯёЁ]/.test(pw),
    digit: /[0-9]/.test(pw)
  };
  document.querySelectorAll('#pw-checklist li').forEach(li => {
    li.classList.toggle('ok', !!rules[li.dataset.rule]);
  });
  return rules.len && rules.letter && rules.digit;
}
document.getElementById('reg-password').addEventListener('input', checkPwRules);

document.getElementById('form-register-step4').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('register-step4-error', '');
  const password = document.getElementById('reg-password').value;
  const password2 = document.getElementById('reg-password2').value;

  if (!checkPwRules()) {
    setError('register-step4-error', t('err_pw_rules'));
    return;
  }
  if (password !== password2) {
    setError('register-step4-error', t('err_pw_mismatch'));
    return;
  }
  const btn = document.getElementById('register-submit');
  btn.disabled = true; btn.textContent = t('register_loading');
  try {
    const data = await api('POST', '/auth/register', {
      fullName: regData.fullName, phone: regData.phone, password,
      passportNumber: regData.passportNumber, passportIssuedBy: regData.passportIssuedBy,
      birthDate: regData.birthDate, address: regData.address, facePhoto: regData.facePhoto
    }, false);
    toast(t('account_created_toast'), 'success');
    resetRegisterForm();
    onAuthSuccess(data);
  } catch (err) {
    setError('register-step4-error', err.message);
  } finally {
    btn.disabled = false; btn.textContent = t('btn_register');
  }
});

// ======================================================
// AUTH: FORGOT PASSWORD
// ======================================================
let forgotPhoneCache = '';

document.getElementById('form-forgot-phone').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('forgot-phone-error', '');
  const phone = document.getElementById('forgot-phone').value.trim();
  try {
    const data = await api('POST', '/auth/forgot-password', { phone }, false);
    forgotPhoneCache = phone;
    document.getElementById('forgot-phone-display').textContent = phone;
    document.getElementById('forgot-demo-code').textContent =
      tf('demo_code_line', { code: data.demoCode, min: Math.round(data.expiresInSec/60) });
    document.getElementById('forgot-step-1').style.display = 'none';
    document.getElementById('forgot-step-2').style.display = 'block';
  } catch (err) {
    setError('forgot-phone-error', err.message);
  }
});

document.getElementById('forgot-resend').addEventListener('click', async (e) => {
  e.preventDefault();
  try {
    const data = await api('POST', '/auth/forgot-password', { phone: forgotPhoneCache }, false);
    document.getElementById('forgot-demo-code').textContent =
      tf('demo_code_resend_line', { code: data.demoCode });
    toast(t('forgot_resend'), 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('form-forgot-reset').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('forgot-reset-error', '');
  const code = document.getElementById('forgot-code').value.trim();
  const newPassword = document.getElementById('forgot-newpass').value;
  try {
    await api('POST', '/auth/reset-password', { phone: forgotPhoneCache, code, newPassword }, false);
    toast(t('pw_updated_toast'), 'success');
    document.getElementById('forgot-step-1').style.display = 'block';
    document.getElementById('forgot-step-2').style.display = 'none';
    document.getElementById('form-forgot-phone').reset();
    document.getElementById('form-forgot-reset').reset();
    goto('screen-login');
  } catch (err) {
    setError('forgot-reset-error', err.message);
  }
});

// ======================================================
// AUTH SUCCESS / LOGOUT
// ======================================================
function onAuthSuccess(data) {
  state.token = data.token;
  state.user = data.user;
  localStorage.setItem('esa_token', data.token);
  document.body.classList.add('app-shell');
  goto('screen-dashboard');
  // Банктын ээсине ыңгайлуулук үчүн — демо-орнотмодо PIN "0000" алдын ала коюлат,
  // эгер ал буга чейин өз PIN-кодун коюп койбосо.
  if (data.user && data.user.account && data.user.account.isOwner && !hasPin()) {
    setPin('0000');
  }
}

function doLogout() {
  api('POST', '/auth/logout').catch(() => {});
  state.token = null; state.user = null;
  localStorage.removeItem('esa_token');
  document.body.classList.remove('app-shell');
  document.getElementById('form-login').reset();
  clearSecurityData();
  goto('screen-login');
}
document.getElementById('logout-btn').addEventListener('click', doLogout);
document.getElementById('sidebar-logout').addEventListener('click', doLogout);
document.getElementById('profile-settings-btn').addEventListener('click', () => goto('screen-settings'));

// ======================================================
// GENERIC MODALS (transaction detail, confirm dialog)
// ======================================================
function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }
document.addEventListener('click', (e) => {
  const closeBtn = e.target.closest('[data-close-modal]');
  if (closeBtn) { closeModal(closeBtn.dataset.closeModal); return; }
  if (e.target.classList.contains('modal-overlay')) { e.target.classList.remove('show'); }
});

function showConfirm(text, yesLabel, onYes) {
  document.getElementById('confirm-modal-text').textContent = text;
  document.getElementById('confirm-modal-yes').textContent = yesLabel || t('confirm_yes');
  document.getElementById('confirm-modal-no').textContent = t('confirm_no');
  const yesBtn = document.getElementById('confirm-modal-yes');
  const newYesBtn = yesBtn.cloneNode(true); // снимаем старые обработчики перед навешиванием нового
  yesBtn.parentNode.replaceChild(newYesBtn, yesBtn);
  newYesBtn.addEventListener('click', () => { closeModal('confirm-modal'); onYes(); });
  document.getElementById('confirm-modal-no').onclick = () => closeModal('confirm-modal');
  openModal('confirm-modal');
}

// ======================================================
// TRANSACTION DETAIL (tap a history row)
// ======================================================
let txCache = {};
let lastOpenedTx = null;

document.addEventListener('click', (e) => {
  const row = e.target.closest('.tx-row[data-tx-id]');
  if (!row) return;
  const tx = txCache[row.dataset.txId];
  if (tx) openTxDetail(tx);
});

function openTxDetail(tx) {
  lastOpenedTx = tx;
  const sign = tx.direction === 'in' ? '+' : '-';
  document.getElementById('txd-date').textContent = formatDateShort(tx.createdAt);
  document.getElementById('txd-receipt').textContent = tx.receiptNo || '—';
  document.getElementById('txd-recipient').textContent = tx.counterparty;
  document.getElementById('txd-amount').textContent = `${sign} ${formatMoney(tx.amount)} сом`;
  document.getElementById('txd-barcode').textContent = tx.receiptNo ? `*${tx.receiptNo}*` : '';
  const methodLabelEl = document.getElementById('txd-method-label');
  if (methodLabelEl) methodLabelEl.textContent = tx.method === 'qr' ? t('method_qr_full') : (tx.deviceCode || t('method_phone_full'));
  const noteRow = document.getElementById('txd-note-row');
  if (tx.note) { noteRow.style.display = 'flex'; document.getElementById('txd-note').textContent = tx.note; }
  else { noteRow.style.display = 'none'; }
  const repeatBtn = document.getElementById('txd-repeat-btn');
  repeatBtn.style.display = (tx.direction === 'out' && tx.method === 'phone' && tx.counterpartyPhone) ? 'flex' : 'none';
  openModal('tx-detail-modal');
}

document.getElementById('txd-repeat-btn').addEventListener('click', () => {
  if (!lastOpenedTx || !lastOpenedTx.counterpartyPhone) return;
  closeModal('tx-detail-modal');
  goto('screen-transfer-phone');
  document.getElementById('transfer-phone').value = lastOpenedTx.counterpartyPhone;
  document.getElementById('form-transfer-lookup').requestSubmit();
  setTimeout(() => {
    document.getElementById('transfer-amount').value = lastOpenedTx.amount;
    document.getElementById('transfer-category').value = lastOpenedTx.category || 'other';
    document.getElementById('transfer-note').value = lastOpenedTx.note || '';
  }, 400);
});

document.getElementById('txd-share-btn').addEventListener('click', async () => {
  if (!lastOpenedTx) return;
  const tx = lastOpenedTx;
  const sign = tx.direction === 'in' ? '+' : '-';
  const text = `ESA Bank\n${formatDateShort(tx.createdAt)}\n${tx.counterparty}: ${sign}${formatMoney(tx.amount)} сом\n${t('tx_receipt_no')}: ${tx.receiptNo || '—'}\n\n${t('share_not_official')}`;
  if (navigator.share) {
    try { await navigator.share({ text }); } catch (_) {}
  } else if (navigator.clipboard) {
    try { await navigator.clipboard.writeText(text); toast(t('copied_clipboard'), 'success'); } catch (_) {}
  }
});

// ======================================================
// SETTINGS: delete account
// ======================================================
document.getElementById('delete-account-row').addEventListener('click', () => {
  if (state.user && state.user.account && state.user.account.isOwner) {
    toast(t('settings_delete_owner_blocked'), 'error');
    return;
  }
  showConfirm(t('settings_delete_confirm'), t('confirm_yes'), async () => {
    try {
      await api('DELETE', '/me');
      toast(t('account_deleted_toast'), 'success');
      doLogout();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
});

// ======================================================
// DASHBOARD
// ======================================================
async function loadDashboard() {
  try {
    const { user } = await api('GET', '/me');
    state.user = user;
    applyUserChrome(user);

    document.getElementById('dash-firstname').textContent = firstName(user.fullName);
    document.getElementById('dash-balance').textContent = user.account.isOwner ? t('unlimited') : formatMoney(user.account.balance);
    document.getElementById('dash-balance-suffix').style.display = user.account.isOwner ? 'none' : '';
    document.getElementById('dash-account').textContent = user.account.accountNumber;
    document.getElementById('dash-date').textContent = formatDateHuman(new Date());

    // Кошелёк и карты — отдельные продукты с собственными балансами
    // (открытие карты не создаёт новых денег, см. /api/cards).
    const { cards } = await api('GET', '/cards');
    state.cards = cards;
    renderDashCardVisual(cards);

    // Депозит — отдельный продукт, пока не открыт ни у одного клиента (честно показываем 0, не выдумываем)
    document.getElementById('dash-deposit-balance').textContent = '0.00';

    const { transactions } = await api('GET', '/transactions');
    renderTxList('dash-tx-list', transactions.slice(0, 5));
    renderLineChart(transactions, user.account.id);

    loadRates();
    loadMonthlyStats('cat-list', 'donut-total', 'chart-donut');
  } catch (err) {
    if (err.status === 401) { forceLogout(); return; }
    toast(err.message, 'error');
  }
}

function renderDashCardVisual(cards) {
  const visual = document.getElementById('dash-card-visual');
  const label = document.getElementById('dash-card-label');
  const balanceEl = document.getElementById('dash-card-balance');
  const suffixEl = document.getElementById('dash-card-suffix');
  const subEl = document.getElementById('dash-card-sub');
  if (!visual) return;
  const active = (cards || []).filter(c => c.status !== 'closed');
  if (!active.length) {
    visual.style.background = '';
    visual.classList.add('card'); visual.classList.remove('frozen');
    label.textContent = t('card_label');
    balanceEl.textContent = '—';
    suffixEl.style.display = 'none';
    subEl.textContent = t('open_new_card');
    return;
  }
  const card = active[0];
  const theme = CARD_THEMES.find(th => th.id === card.themeId) || CARD_THEMES[0];
  visual.style.background = theme.gradient;
  visual.classList.toggle('frozen', card.status === 'frozen');
  label.textContent = card.nickname;
  balanceEl.textContent = formatMoney(card.balance);
  suffixEl.style.display = '';
  subEl.textContent = card.masked;
}

function applyUserChrome(user) {
  document.getElementById('gt-avatar').textContent = initials(user.fullName);
  document.getElementById('gt-name').textContent = firstName(user.fullName);
  document.getElementById('gt-cid').textContent = t('client_no') + ' ' + user.clientId;
}

function forceLogout() {
  state.token = null; state.user = null;
  localStorage.removeItem('esa_token');
  document.body.classList.remove('app-shell');
  goto('screen-login');
  toast(t('session_expired_toast'), 'error');
}

function firstName(full) {
  return (full || '').split(' ')[0] || full;
}

function formatMoney(n) {
  return Number(n).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function formatDateHuman(d) {
  const loc = currentLang === 'en' ? 'en-US' : currentLang === 'ru' ? 'ru-RU' : 'ru-RU';
  return d.toLocaleDateString(loc, { day: '2-digit', month: 'long', year: 'numeric', weekday: 'long' });
}

function initials(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0,2).map(w => w[0]).join('').toUpperCase();
}

function renderTxList(containerId, list) {
  const container = document.getElementById(containerId);
  if (!list.length) {
    container.innerHTML = `<div class="empty-state"><div class="ei"><svg class="icon"><use href="#ic-receipt"/></svg></div>${t('no_ops')}</div>`;
    return;
  }
  list.forEach(tx => { txCache[tx.id] = tx; });
  container.innerHTML = list.map(tx => {
    const sign = tx.direction === 'in' ? '+' : '-';
    const iconName = tx.direction === 'in' ? 'arrow-down' : 'arrow-up';
    const methodLabel = tx.method === 'qr' ? t('method_qr_short') : t('field_phone');
    return `
      <div class="tx-row" data-tx-id="${tx.id}" style="cursor:pointer;">
        <div class="tx-icon ${tx.direction}"><svg class="icon"><use href="#ic-${iconName}"/></svg></div>
        <div class="tx-main">
          <div class="name">${escapeHtml(tx.counterparty)}</div>
          <div class="meta">${methodLabel} · ${formatDateShort(tx.createdAt)}</div>
        </div>
        <div class="tx-amount ${tx.direction}">${sign} ${formatMoney(tx.amount)} сом</div>
      </div>`;
  }).join('');
}

function formatDateShort(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' }) + ', ' +
         d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s == null ? '' : s;
  return div.innerHTML;
}

// ======================================================
// LINE CHART (funds dynamics, last 7 days, computed client-side)
// ======================================================
function renderLineChart(transactions, accountId) {
  const days = 7;
  const today = new Date(); today.setHours(0,0,0,0);
  const buckets = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    buckets.push({ key: d.toISOString().slice(0,10), label: d.toLocaleDateString('ru-RU', { day:'2-digit', month:'2-digit' }), income: 0, expense: 0 });
  }
  const byKey = Object.fromEntries(buckets.map(b => [b.key, b]));
  transactions.forEach(tx => {
    const key = (tx.createdAt || '').slice(0, 10);
    const b = byKey[key];
    if (!b) return;
    if (tx.direction === 'in') b.income += tx.amount; else b.expense += tx.amount;
  });
  if (window.ESACharts) {
    ESACharts.drawLineChart('chart-line', [
      { data: buckets.map(b => b.income), color: '#1db954' },
      { data: buckets.map(b => b.expense), color: '#e5484d' }
    ], buckets.map(b => b.label));
  }
}

// ======================================================
// CURRENCY RATES
// ======================================================
const RATE_FLAGS = { USD: 'US', EUR: 'EU', RUB: 'RU', KZT: 'KZ', UZS: 'UZ', CNY: 'CN' };

async function loadRates() {
  try {
    const data = await api('GET', '/rates', null, false);
    const tbody = document.getElementById('rates-tbody');
    const badge = document.getElementById('rates-badge');
    if (!tbody) return;
    if (!data.table || !data.table.length) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:var(--text-dim); padding:14px;">${t('stats_no_data')}</td></tr>`;
      return;
    }
    tbody.innerHTML = data.table.map(r => `
      <tr>
        <td><span class="rate-code"><span class="rate-flag">${RATE_FLAGS[r.code] || r.code.slice(0,2)}</span>${r.code}</span></td>
        <td>${formatMoney(r.buy)}</td>
        <td>${formatMoney(r.sell)}</td>
      </tr>`).join('');
    if (badge) {
      badge.textContent = data.live ? t('rates_live') : t('rates_cached');
      badge.className = 'rates-badge ' + (data.live ? 'live' : 'cached');
    }
  } catch (err) {
    // курсы не критичны для работы приложения — тихо игнорируем сбой
  }
}

// ======================================================
// MONTHLY SPENDING STATS (donut + category breakdown)
// ======================================================
const CAT_COLORS = { food: '#1db954', transport: '#3b82f6', bills: '#f5c518', entertainment: '#a855f7', shopping: '#e5484d', health: '#06b6d4', other: '#9fb3d1' };

async function loadMonthlyStats(listId, totalId, canvasId) {
  try {
    const data = await api('GET', '/stats/monthly');
    renderStats(data, listId, totalId, canvasId);
    return data;
  } catch (err) {
    if (err.status === 401) return;
  }
}

function renderStats(data, listId, totalId, canvasId) {
  const list = document.getElementById(listId);
  const totalEl = document.getElementById(totalId);
  if (totalEl) totalEl.textContent = formatCompactMoney(data.totalOut || 0);

  const slices = (data.byCategory || []).map(c => ({ value: c.amount, color: CAT_COLORS[c.category] || CAT_COLORS.other, category: c.category }));
  if (window.ESACharts) ESACharts.drawDonutChart(canvasId, slices);

  if (!list) return;
  if (!data.byCategory || !data.byCategory.length) {
    list.innerHTML = `<div class="empty-state" style="padding:14px 0;">${t('stats_no_data')}</div>`;
    return;
  }
  list.innerHTML = data.byCategory.map(c => `
    <div class="cat-row">
      <span class="legend-dot" style="background:${CAT_COLORS[c.category] || CAT_COLORS.other}"></span>
      <span class="name">${t(CATEGORY_KEYS[c.category] || 'cat_other')}</span>
      <span class="val">${formatMoney(c.amount)} сом</span>
    </div>`).join('');
}

async function loadStatsScreen() {
  const data = await loadMonthlyStats('stats-cat-list', 'stats-total', 'stats-donut');
  if (data) {
    const list = document.getElementById('stats-cat-list');
    if (data.byCategory && data.byCategory.length) {
      list.innerHTML = data.byCategory.map(c => `
        <div class="option-card">
          <div class="oi">
            <span class="legend-dot" style="background:${CAT_COLORS[c.category] || CAT_COLORS.other}; width:14px; height:14px;"></span>
            <div><b>${t(CATEGORY_KEYS[c.category] || 'cat_other')}</b><span>${Math.round((c.amount/(data.totalOut||1))*100)}%</span></div>
          </div>
          <b>${formatMoney(c.amount)} сом</b>
        </div>`).join('');
    }
  }
}

function formatCompactMoney(n) {
  return formatMoney(n);
}

// ======================================================
// CARDS SCREEN (real wallet + multiple real cards)
// ======================================================
const CARD_THEMES = [
  { id: 'emerald', nameKey: 'theme_emerald', gradient: 'linear-gradient(135deg, #0f7a4a, #1db954 120%)' },
  { id: 'navy', nameKey: 'theme_navy', gradient: 'linear-gradient(135deg, var(--navy-600), var(--blue-500) 120%)' },
  { id: 'gold', nameKey: 'theme_gold', gradient: 'linear-gradient(135deg, #8a6a12, #f5c518 120%)' },
  { id: 'violet', nameKey: 'theme_violet', gradient: 'linear-gradient(135deg, #5b2fa6, #8b5cf6 120%)' },
  { id: 'graphite', nameKey: 'theme_graphite', gradient: 'linear-gradient(135deg, #2b2f36, #5a6170 120%)' },
  { id: 'sunset', nameKey: 'theme_sunset', gradient: 'linear-gradient(135deg, #a6322f, #f0864a 120%)' },
];
let cardPlansCache = null;
let activeCardMenuId = null;

async function loadCardsScreen() {
  try {
    const { user } = await api('GET', '/me');
    const bal = user.account.isOwner ? t('unlimited') : formatMoney(user.account.balance);
    document.getElementById('cards-acc-balance').textContent = bal;
    document.getElementById('cards-acc-suffix').style.display = user.account.isOwner ? 'none' : '';
    document.getElementById('cards-acc-no').textContent = user.account.accountNumber;
    const { cards } = await api('GET', '/cards');
    state.cards = cards;
    renderCardsList(cards);
    renderDashCardVisual(cards);
  } catch (err) {
    if (err.status === 401) forceLogout();
  }
}

function renderCardsList(cards) {
  const list = document.getElementById('cards-list');
  if (!cards.length) {
    list.innerHTML = `<div class="empty-state"><div class="ei"><svg class="icon"><use href="#ic-card"/></svg></div>${t('coming_soon_cards')}</div>`;
    return;
  }
  list.innerHTML = cards.map(card => {
    const theme = CARD_THEMES.find(th => th.id === card.themeId) || CARD_THEMES[0];
    const frozen = card.status === 'frozen';
    return `
    <div class="card-tile" data-card-id="${card.id}">
      <div class="bal-card card${frozen ? ' frozen' : ''}" style="background:${theme.gradient}">
        <span class="card-network-badge">${escapeHtml(card.network)}</span>
        <div class="label"><svg class="icon"><use href="#ic-card"/></svg> <span>${escapeHtml(card.nickname)}</span></div>
        <div class="amount">${formatMoney(card.balance)} <span>сом</span></div>
        <div class="sub">${card.masked} · ${card.expiry}</div>
        ${frozen ? `<span class="card-frozen-pill"><svg class="icon" style="width:12px;height:12px;"><use href="#ic-lock-closed"/></svg>${t('card_frozen_toast')}</span>` : ''}
      </div>
      <div class="card-actions-grid">
        <button class="card-action-btn" data-card-action="freeze" data-card-id="${card.id}">
          <svg class="icon"><use href="#ic-lock-closed"/></svg>
          <span>${frozen ? t('unfreeze_card_btn') : t('freeze_card')}</span>
        </button>
        <button class="card-action-btn" data-card-action="theme" data-card-id="${card.id}">
          <svg class="icon"><use href="#ic-palette"/></svg>
          <span>${t('change_card_design')}</span>
        </button>
        <button class="card-action-btn" data-card-action="rename" data-card-id="${card.id}">
          <svg class="icon"><use href="#ic-plus"/></svg>
          <span>${t('rename_card')}</span>
        </button>
        <button class="card-action-btn" data-card-action="requisites" data-card-id="${card.id}">
          <svg class="icon"><use href="#ic-doc"/></svg>
          <span>${t('card_requisites')}</span>
        </button>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('cards-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-card-action]');
  if (!btn) return;
  const cardId = btn.dataset.cardId;
  const action = btn.dataset.cardAction;
  activeCardMenuId = cardId;
  const card = (state.cards || []).find(c => c.id === cardId);
  if (!card) return;

  if (action === 'freeze') {
    try {
      const { card: updated } = await api('POST', `/cards/${cardId}/toggle-freeze`, {});
      toast(updated.status === 'frozen' ? t('card_frozen_toast') : t('card_unfrozen_toast'), updated.status === 'frozen' ? 'error' : 'success');
      loadCardsScreen();
    } catch (err) { toast(err.message, 'error'); }
  } else if (action === 'theme') {
    renderCardThemeGrid(card.themeId);
    openModal('card-theme-modal');
  } else if (action === 'rename') {
    document.getElementById('card-rename-input').value = card.nickname;
    openModal('card-rename-modal');
  } else if (action === 'requisites') {
    renderCardRequisites(card);
    openModal('card-requisites-modal');
  }
});

function renderCardThemeGrid(currentThemeId) {
  const grid = document.getElementById('card-theme-grid');
  grid.innerHTML = CARD_THEMES.map(theme => `
    <div>
      <div class="card-theme-swatch${theme.id === currentThemeId ? ' active' : ''}" data-theme-id="${theme.id}" style="background:${theme.gradient}">
        <div class="ts-check"><svg class="icon"><use href="#ic-check"/></svg></div>
      </div>
      <div class="card-theme-label">${t(theme.nameKey)}</div>
    </div>
  `).join('');
}

document.getElementById('card-theme-grid').addEventListener('click', async (e) => {
  const swatch = e.target.closest('[data-theme-id]');
  if (!swatch || !activeCardMenuId) return;
  const themeId = swatch.dataset.themeId;
  try {
    await api('POST', `/cards/${activeCardMenuId}/theme`, { themeId });
    toast(t('card_theme_applied'), 'success');
    setTimeout(() => closeModal('card-theme-modal'), 350);
    loadCardsScreen();
  } catch (err) { toast(err.message, 'error'); }
});

document.getElementById('form-card-rename').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activeCardMenuId) return;
  const nickname = document.getElementById('card-rename-input').value.trim();
  if (!nickname) return;
  try {
    await api('POST', `/cards/${activeCardMenuId}/rename`, { nickname });
    toast(t('card_opened_toast'), 'success');
    closeModal('card-rename-modal');
    loadCardsScreen();
  } catch (err) { toast(err.message, 'error'); }
});

function renderCardRequisites(card) {
  const body = document.getElementById('card-requisites-body');
  body.innerHTML = `
    <div class="paper-receipt-header">
      <div class="pr-logo">ESA BANK</div>
      <div class="pr-sub">${escapeHtml(card.network)} · ${escapeHtml(card.nickname)}</div>
    </div>
    <div class="paper-receipt-row"><span>${t('field_fullname')}</span><span>${escapeHtml(card.holderName)}</span></div>
    <div class="paper-receipt-row"><span>№</span><span>${card.number}</span></div>
    <div class="paper-receipt-row"><span>Expiry</span><span>${card.expiry}</span></div>
    <div class="paper-receipt-row"><span>CVV</span><span>${card.cvv}</span></div>
    <div class="paper-receipt-divider"></div>
    <div class="paper-receipt-row"><span>IBAN</span><span>${document.getElementById('cards-acc-no').textContent}</span></div>
    <div class="paper-receipt-row"><span>SWIFT</span><span>ESABKG22</span></div>
  `;
}

// ---------- Открытие новой карты ----------
document.getElementById('open-new-card-btn').addEventListener('click', async () => {
  try {
    if (!cardPlansCache) {
      const { plans } = await api('GET', '/cards/plans', null, false);
      cardPlansCache = plans;
    }
    document.getElementById('card-plan-list').innerHTML = cardPlansCache.map(p => `
      <div class="card-plan-option ${p.type}" data-plan-type="${p.type}">
        <div>
          <b>${escapeHtml(p.label)}</b>
          <div class="cpo-sub">${p.type === 'visa' ? t('card_plan_visa_sub') : t('card_plan_elkart_sub')}</div>
        </div>
        <div class="cpo-fee">${p.annualFee > 0 ? formatMoney(p.annualFee) + ' сом/жыл' : t('free')}</div>
      </div>`).join('');
    openModal('new-card-modal');
  } catch (err) { toast(err.message, 'error'); }
});

document.getElementById('card-plan-list').addEventListener('click', async (e) => {
  const opt = e.target.closest('[data-plan-type]');
  if (!opt) return;
  try {
    await api('POST', '/cards', { type: opt.dataset.planType, themeId: CARD_THEMES[Math.floor(Math.random() * CARD_THEMES.length)].id });
    toast(t('card_opened_toast'), 'success');
    closeModal('new-card-modal');
    loadCardsScreen();
  } catch (err) { toast(err.message, 'error'); }
});

// ---------- Внутренний перевод: кошелёк <-> карта ----------
document.getElementById('open-internal-transfer-btn').addEventListener('click', () => openInternalTransferModal());

function openInternalTransferModal() {
  const cards = state.cards || [];
  const wallet = { value: 'wallet', label: t('main_account') };
  const options = [wallet, ...cards.map(c => ({ value: `card:${c.id}`, label: `${c.nickname} (${c.masked})` }))];
  const fromSel = document.getElementById('internal-from');
  const toSel = document.getElementById('internal-to');
  fromSel.innerHTML = options.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('');
  toSel.innerHTML = options.map(o => `<option value="${o.value}">${escapeHtml(o.label)}</option>`).join('');
  toSel.selectedIndex = options.length > 1 ? 1 : 0;
  setError('internal-transfer-error', '');
  openModal('internal-transfer-modal');
}

document.getElementById('form-internal-transfer').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('internal-transfer-error', '');
  const fromVal = document.getElementById('internal-from').value;
  const toVal = document.getElementById('internal-to').value;
  const amount = Number(document.getElementById('internal-amount').value);
  if (fromVal === toVal) { setError('internal-transfer-error', t('err_same_account')); return; }
  const body = { amount };
  if (fromVal === 'wallet') { body.fromType = 'wallet'; } else { body.fromType = 'card'; body.fromId = fromVal.split(':')[1]; }
  if (toVal === 'wallet') { body.toType = 'wallet'; } else { body.toType = 'card'; body.toId = toVal.split(':')[1]; }
  try {
    await api('POST', '/transfer/internal', body);
    toast(t('transfer_success_toast'), 'success');
    closeModal('internal-transfer-modal');
    loadCardsScreen();
  } catch (err) {
    setError('internal-transfer-error', err.message);
  }
});

// ======================================================
// PIGGY BANKS (КОПИЛКИ)
// ======================================================
let activePiggyId = null;
let activePiggyAction = 'deposit';

async function loadPiggyScreen() {
  try {
    const { piggyBanks } = await api('GET', '/piggy');
    state.piggyBanks = piggyBanks;
    renderPiggyList(piggyBanks);
  } catch (err) {
    if (err.status === 401) forceLogout();
  }
}

function renderPiggyList(list) {
  const container = document.getElementById('piggy-list');
  const empty = document.getElementById('piggy-empty');
  if (!list.length) {
    container.innerHTML = '';
    empty.style.display = '';
    return;
  }
  empty.style.display = 'none';
  container.innerHTML = list.map(p => {
    const pct = p.targetAmount > 0 ? Math.min(100, Math.round((p.balance / p.targetAmount) * 100)) : 0;
    return `
    <div class="piggy-card" data-piggy-id="${p.id}">
      <div class="piggy-card-head">
        <b>${escapeHtml(p.name)}</b>
        <span class="piggy-mode-pill">${t('piggy_mode_' + p.mode)}</span>
      </div>
      <div class="piggy-amounts"><b>${formatMoney(p.balance)} сом</b>${p.targetAmount > 0 ? ` <span>/ ${formatMoney(p.targetAmount)} сом (${pct}%)</span>` : ''}</div>
      ${p.targetAmount > 0 ? `<div class="piggy-progress-track"><div class="piggy-progress-fill" style="width:${pct}%"></div></div>` : ''}
      <div class="piggy-actions">
        <button class="btn btn-primary btn-sm" data-piggy-action="deposit" data-piggy-id="${p.id}">${t('piggy_deposit_btn')}</button>
        <button class="btn btn-secondary btn-sm" data-piggy-action="withdraw" data-piggy-id="${p.id}">${t('piggy_withdraw_btn')}</button>
        <button class="btn btn-secondary btn-sm" data-piggy-action="delete" data-piggy-id="${p.id}">${t('piggy_delete_btn')}</button>
      </div>
    </div>`;
  }).join('');
}

document.getElementById('piggy-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-piggy-action]');
  if (!btn) return;
  const id = btn.dataset.piggyId;
  const action = btn.dataset.piggyAction;
  if (action === 'delete') {
    try {
      await api('DELETE', `/piggy/${id}`);
      toast(t('piggy_deleted_toast'), 'success');
      loadPiggyScreen();
    } catch (err) { toast(err.message, 'error'); }
    return;
  }
  activePiggyId = id;
  activePiggyAction = action;
  document.getElementById('piggy-amount-title').textContent = action === 'deposit' ? t('piggy_deposit_btn') : t('piggy_withdraw_btn');
  document.getElementById('piggy-amount-input').value = '';
  setError('piggy-amount-error', '');
  openModal('piggy-amount-modal');
});

document.getElementById('form-piggy-amount').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!activePiggyId) return;
  const amount = Number(document.getElementById('piggy-amount-input').value);
  setError('piggy-amount-error', '');
  try {
    await api('POST', `/piggy/${activePiggyId}/${activePiggyAction}`, { amount });
    toast(t('transfer_success_toast'), 'success');
    closeModal('piggy-amount-modal');
    loadPiggyScreen();
  } catch (err) {
    setError('piggy-amount-error', err.message);
  }
});

document.getElementById('open-new-piggy-btn').addEventListener('click', () => {
  document.getElementById('form-new-piggy').reset();
  document.getElementById('piggy-auto-amount-field').style.display = 'none';
  setError('new-piggy-error', '');
  openModal('new-piggy-modal');
});

document.getElementById('piggy-mode').addEventListener('change', (e) => {
  document.getElementById('piggy-auto-amount-field').style.display = e.target.value === 'manual' ? 'none' : '';
});

document.getElementById('form-new-piggy').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('new-piggy-error', '');
  const name = document.getElementById('piggy-name').value.trim();
  const targetAmount = Number(document.getElementById('piggy-target').value) || 0;
  const mode = document.getElementById('piggy-mode').value;
  const autoAmount = Number(document.getElementById('piggy-auto-amount').value) || 0;
  if (!name) { setError('new-piggy-error', t('err_fullname_required')); return; }
  try {
    await api('POST', '/piggy', { name, targetAmount, mode, autoAmount, icon: 'piggy' });
    toast(t('piggy_created_toast'), 'success');
    closeModal('new-piggy-modal');
    loadPiggyScreen();
  } catch (err) {
    setError('new-piggy-error', err.message);
  }
});

// ======================================================
// ATM / TERMINAL / OFFICE LOCATOR
// ======================================================
let locatorMapInstance = null;
let locatorData = { offices: [], devices: [] };
let locatorFilter = 'all';

async function loadLocatorScreen() {
  try {
    const data = await api('GET', '/locations', null, false);
    locatorData = data;
    renderLocatorMap();
    renderLocatorList();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderLocatorMap() {
  const el = document.getElementById('locator-map');
  if (!el || typeof L === 'undefined') { if (el) el.innerHTML = `<div class="empty-state" style="padding:20px;">${t('map_unavailable')}</div>`; return; }
  try {
    if (!locatorMapInstance) {
      locatorMapInstance = L.map(el, { zoomControl: true }).setView([42.8746, 74.5698], 12);
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '&copy; OpenStreetMap', maxZoom: 19
      }).addTo(locatorMapInstance);
      locatorMapInstance._markersLayer = L.layerGroup().addTo(locatorMapInstance);
    }
    locatorMapInstance._markersLayer.clearLayers();
    const points = [];
    if (locatorFilter !== 'device') {
      locatorData.offices.forEach(o => {
        if (o.lat == null || o.lng == null) return;
        L.marker([o.lat, o.lng]).addTo(locatorMapInstance._markersLayer).bindPopup(`<b>${escapeHtml(o.name)}</b><br>${escapeHtml(o.address || '')}`);
        points.push([o.lat, o.lng]);
      });
    }
    if (locatorFilter !== 'office') {
      locatorData.devices.forEach(d => {
        if (!d.location || d.location.lat == null) return;
        L.marker([d.location.lat, d.location.lng]).addTo(locatorMapInstance._markersLayer).bindPopup(`<b>${escapeHtml(d.label)}</b><br>${d.deviceCode}`);
        points.push([d.location.lat, d.location.lng]);
      });
    }
    if (points.length) locatorMapInstance.fitBounds(points, { padding: [24, 24], maxZoom: 15 });
    setTimeout(() => locatorMapInstance.invalidateSize(), 150);
  } catch (_) {
    // Карта чыкпай калса (интернет же CDN жеткиликсиз) — тизме бойдон иштей берет
    el.innerHTML = `<div class="empty-state" style="padding:20px;">${t('map_unavailable')}</div>`;
  }
}

function renderLocatorList() {
  const list = document.getElementById('locator-list');
  const items = [];
  if (locatorFilter !== 'device') {
    locatorData.offices.forEach(o => items.push({ kind: 'office', name: o.name, sub: `${o.address || ''}${o.hours ? ' · ' + o.hours : ''}` }));
  }
  if (locatorFilter !== 'office') {
    locatorData.devices.forEach(d => items.push({ kind: 'device', name: d.label, sub: `${t('locator_atm')} · ${d.deviceCode}${d.location && d.location.address ? ' · ' + d.location.address : ''}` }));
  }
  if (!items.length) {
    list.innerHTML = `<div class="empty-state" style="padding:14px 0;">${t('stats_no_data')}</div>`;
    return;
  }
  list.innerHTML = items.map(it => `
    <div class="locator-item">
      <div class="li-icon"><svg class="icon"><use href="#${it.kind === 'office' ? 'ic-pin' : 'ic-atm'}"/></svg></div>
      <div><b>${escapeHtml(it.name)}</b><span>${escapeHtml(it.sub)}</span></div>
    </div>`).join('');
}

document.querySelectorAll('.locator-tab').forEach(tabBtn => {
  tabBtn.addEventListener('click', () => {
    document.querySelectorAll('.locator-tab').forEach(b => b.classList.remove('active'));
    tabBtn.classList.add('active');
    locatorFilter = tabBtn.dataset.locatorFilter;
    renderLocatorMap();
    renderLocatorList();
  });
});

// ======================================================
// HISTORY
// ======================================================
async function loadHistory() {
  try {
    const { transactions } = await api('GET', '/transactions');
    renderTxList('history-list', transactions);
  } catch (err) {
    if (err.status === 401) { forceLogout(); return; }
    toast(err.message, 'error');
  }
}

// ======================================================
// PROFILE
// ======================================================
async function loadProfile() {
  try {
    const { user } = await api('GET', '/me');
    state.user = user;
    applyUserChrome(user);
    document.getElementById('profile-avatar').textContent = initials(user.fullName);
    document.getElementById('profile-name').textContent = user.fullName;
    document.getElementById('profile-id').textContent = t('client_no') + ' ' + user.clientId;
    document.getElementById('profile-phone').textContent = user.phoneFormatted;
    document.getElementById('profile-account').textContent = user.account.accountNumber;
    document.getElementById('profile-balance').textContent = user.account.isOwner
      ? t('unlimited_owner')
      : formatMoney(user.account.balance) + ' сом';
  } catch (err) {
    if (err.status === 401) { forceLogout(); return; }
    toast(err.message, 'error');
  }
}

// ======================================================
// TRANSFER BY PHONE
// ======================================================
function resetTransferPhoneForm() {
  document.getElementById('form-transfer-lookup').reset();
  document.getElementById('form-transfer-lookup').style.display = 'block';
  document.getElementById('transfer-recipient-block').style.display = 'none';
  document.getElementById('transfer-contacts-block').style.display = 'none';
  document.getElementById('transfer-contacts-list').innerHTML = '';
  document.getElementById('transfer-mode-phone').classList.add('active');
  document.getElementById('transfer-mode-contacts').classList.remove('active');
  setError('transfer-lookup-error', '');
  setError('transfer-submit-error', '');
  state.pendingRecipient = null;
}

document.getElementById('form-transfer-lookup').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('transfer-lookup-error', '');
  const phone = document.getElementById('transfer-phone').value.trim();
  const btn = document.getElementById('transfer-lookup-btn');
  btn.disabled = true; btn.textContent = t('checking_loading');
  try {
    const recipient = await api('POST', '/transfer/lookup-phone', { phone });
    state.pendingRecipient = { ...recipient, phone };
    document.getElementById('transfer-avatar').textContent = initials(recipient.fullName);
    document.getElementById('transfer-recipient-name').textContent = recipient.fullName;
    document.getElementById('transfer-recipient-id').textContent = `${t('client_no')} ${recipient.clientId} · ${recipient.phoneFormatted}`;
    document.getElementById('transfer-recipient-block').style.display = 'block';
    document.getElementById('form-transfer-lookup').style.display = 'none';
  } catch (err) {
    setError('transfer-lookup-error', err.message);
  } finally {
    btn.disabled = false; btn.textContent = t('check_recipient_btn');
  }
});

document.querySelectorAll('[data-amt]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.getElementById('transfer-amount').value = chip.dataset.amt;
  });
});

document.getElementById('transfer-submit-btn').addEventListener('click', async () => {
  setError('transfer-submit-error', '');
  const amount = parseFloat(document.getElementById('transfer-amount').value);
  const note = document.getElementById('transfer-note').value.trim();
  const category = document.getElementById('transfer-category').value;
  if (!amount || amount <= 0) {
    setError('transfer-submit-error', t('err_enter_valid_amount'));
    return;
  }
  const recipientLabel = state.pendingRecipient.fullName;
  openTransferConfirm({
    amount, recipientLabel, note,
    methodLabel: `${recipientLabel} · ${state.pendingRecipient.phoneFormatted || ''}`,
    run: () => api('POST', '/transfer/phone', { phone: state.pendingRecipient.phone, amount, note, category })
  });
});

// ======================================================
// TRANSFER: two-step confirmation (amount entry -> review & confirm)
// ======================================================
let pendingConfirmTransfer = null;

function openTransferConfirm({ amount, recipientLabel, note, methodLabel, run }) {
  pendingConfirmTransfer = { run };
  document.getElementById('tc-amount').textContent = `${formatMoney(amount)} сом`;
  document.getElementById('tc-recipient').textContent = recipientLabel;
  document.getElementById('tc-method').textContent = methodLabel;
  const noteRow = document.getElementById('tc-note-row');
  if (note) { noteRow.style.display = 'flex'; document.getElementById('tc-note').textContent = note; }
  else { noteRow.style.display = 'none'; }
  openModal('transfer-confirm-modal');
  const storedAmount = amount, storedRecipient = recipientLabel, storedNote = note;
  pendingConfirmTransfer.amount = storedAmount;
  pendingConfirmTransfer.recipientLabel = storedRecipient;
  pendingConfirmTransfer.note = storedNote;
}

document.getElementById('transfer-confirm-btn').addEventListener('click', () => {
  if (!pendingConfirmTransfer) return;
  const { run, amount, recipientLabel, note } = pendingConfirmTransfer;
  closeModal('transfer-confirm-modal');
  pendingConfirmTransfer = null;
  runTransfer(run, amount, recipientLabel, note);
});

// ======================================================
// TRANSFER: tabs (phone number vs. contacts) + contacts matching
// ======================================================
document.getElementById('transfer-mode-phone').addEventListener('click', () => {
  document.getElementById('transfer-mode-phone').classList.add('active');
  document.getElementById('transfer-mode-contacts').classList.remove('active');
  document.getElementById('form-transfer-lookup').style.display = 'block';
  document.getElementById('transfer-contacts-block').style.display = 'none';
});

document.getElementById('transfer-mode-contacts').addEventListener('click', () => {
  document.getElementById('transfer-mode-contacts').classList.add('active');
  document.getElementById('transfer-mode-phone').classList.remove('active');
  document.getElementById('form-transfer-lookup').style.display = 'none';
  document.getElementById('transfer-contacts-block').style.display = 'block';
});

document.getElementById('transfer-contacts-permission-btn').addEventListener('click', async () => {
  const listEl = document.getElementById('transfer-contacts-list');
  if (!('contacts' in navigator && 'ContactsManager' in window)) {
    listEl.innerHTML = `<div class="empty-state" style="padding:14px 0;">${t('contacts_not_supported')}</div>`;
    return;
  }
  try {
    const contacts = await navigator.contacts.select(['name', 'tel'], { multiple: true });
    const phones = [];
    contacts.forEach(c => (c.tel || []).forEach(p => phones.push(p)));
    const { matches } = await api('POST', '/clients/match-phones', { phones });
    if (!matches.length) {
      listEl.innerHTML = `<div class="empty-state" style="padding:14px 0;">${t('contacts_none_found')}</div>`;
      return;
    }
    listEl.innerHTML = matches.map(m => `
      <div class="contacts-list-item" data-phone="${m.phone}">
        <div class="contacts-avatar">${initials(m.fullName)}</div>
        <div><b>${escapeHtml(m.fullName)}</b><span>${m.phoneFormatted}</span></div>
      </div>`).join('');
  } catch (err) {
    listEl.innerHTML = `<div class="empty-state" style="padding:14px 0;">${t('contacts_not_supported')}</div>`;
  }
});

document.getElementById('transfer-contacts-list').addEventListener('click', async (e) => {
  const item = e.target.closest('[data-phone]');
  if (!item) return;
  document.getElementById('transfer-phone').value = item.dataset.phone;
  document.getElementById('transfer-mode-phone').click();
  document.getElementById('form-transfer-lookup').requestSubmit();
});

// ======================================================
// QR — SHOW MY CODE (receive)
// ======================================================
async function loadMyQr() {
  try {
    const data = await api('GET', '/qr/my');
    const qrUrl = 'https://api.qrserver.com/v1/create-qr-code/?size=260x260&margin=0&data=' + encodeURIComponent(data.payload);
    document.getElementById('my-qr-img').src = qrUrl;
    document.getElementById('my-qr-name').textContent = data.fullName;
    document.getElementById('my-qr-id').textContent = `${t('client_no')} ${data.clientId} · ${data.accountNumber}`;
  } catch (err) {
    if (err.status === 401) { forceLogout(); return; }
    toast(err.message, 'error');
  }
}

// ======================================================
// QR — SCAN / PAY (+ interoperability detection for other banks' QR formats)
// ======================================================
function resetQrPayForm() {
  document.getElementById('qr-cam-view').style.display = 'flex';
  document.getElementById('qr-pay-block').style.display = 'none';
  document.getElementById('device-pair-block').style.display = 'none';
  document.getElementById('qr-manual-code').value = '';
  document.getElementById('qr-manual-wrap').style.display = 'none';
  document.getElementById('qr-detect-card').style.display = 'none';
  setError('qr-scan-error', '');
  startQrScanner();
}

// Банкомат/терминалдын QR-коду "ESA-DEVICE|<deviceCode>|<pairToken>" форматын
// base64url менен коддолгон түрдө чыгарат (сервердеги makeDevicePairPayload менен дал келет).
function base64UrlDecode(str) {
  try {
    let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return atob(s);
  } catch (_) { return null; }
}
function isDevicePairPayload(payload) {
  const decoded = base64UrlDecode(payload);
  return !!(decoded && decoded.indexOf('ESA-DEVICE|') === 0);
}
async function handleDevicePairPayload(payload) {
  stopQrScanner();
  document.getElementById('qr-cam-view').style.display = 'none';
  document.getElementById('qr-pay-block').style.display = 'none';
  document.getElementById('device-pair-block').style.display = 'block';
  const icon = document.getElementById('device-pair-icon');
  const title = document.getElementById('device-pair-title');
  const label = document.getElementById('device-pair-device-label');
  icon.className = 'status-circle processing';
  title.textContent = t('device_pair_connecting');
  label.textContent = '';
  setError('device-pair-error', '');
  try {
    const result = await api('POST', '/device/pair', { payload });
    icon.className = 'status-circle success';
    title.textContent = t('device_pair_success_title');
    label.textContent = `${result.deviceLabel} (${result.deviceCode})`;
  } catch (err) {
    icon.className = 'status-circle fail';
    title.textContent = t('err_generic');
    setError('device-pair-error', err.message);
  }
}
document.getElementById('device-pair-done-btn').addEventListener('click', () => {
  goto('screen-dashboard');
});

// Разбор QR в стандарте EMVCo "Merchant Presented Mode" (TLV: tag(2) + len(2) + value) —
// это открытый международный стандарт, которым пользуются платёжные QR многих банков
// и платёжных систем. Мы только РАСПОЗНАЁМ формат и показываем, что в нём зашито —
// реального перевода в другой банк мы не делаем, честно сообщаем об этом пользователю.
function parseEmvQr(text) {
  if (!/^\d{2}\d{2}/.test(text)) return null;
  const fields = {};
  let i = 0;
  try {
    while (i < text.length - 4) {
      const tag = text.slice(i, i + 2);
      const len = parseInt(text.slice(i + 2, i + 4), 10);
      if (isNaN(len)) return null;
      const value = text.slice(i + 4, i + 4 + len);
      fields[tag] = value;
      i += 4 + len;
    }
  } catch (_) { return null; }
  if (!fields['00']) return null; // tag 00 = Payload Format Indicator, обязателен в EMVCo QR
  return {
    merchantName: fields['59'] || null,
    merchantCity: fields['60'] || null,
    amount: fields['54'] ? parseFloat(fields['54']) : null,
    currency: fields['53'] || null,
    raw: fields
  };
}

function detectKnownBankLabel(text) {
  const low = text.toLowerCase();
  if (low.includes('mbank') || low.includes('мбанк')) return 'MBank';
  if (low.includes('optima')) return 'Optima Bank';
  if (low.includes('obank') || low.includes('o!bank') || low.includes('о!банк')) return 'O!Bank';
  if (low.includes('companion') || low.includes('компаньон')) return 'Companion';
  return null;
}

async function handleQrPayload(payload) {
  setError('qr-scan-error', '');
  document.getElementById('qr-detect-card').style.display = 'none';
  if (isDevicePairPayload(payload)) {
    return handleDevicePairPayload(payload);
  }
  try {
    const resolved = await api('POST', '/qr/resolve', { payload });
    state.pendingQrRecipient = { payload, ...resolved };
    document.getElementById('qrpay-avatar').textContent = initials(resolved.fullName);
    document.getElementById('qrpay-recipient-name').textContent = resolved.fullName;
    document.getElementById('qrpay-recipient-id').textContent = `${t('client_no')} ${resolved.clientId}`;
    document.getElementById('qr-cam-view').style.display = 'none';
    document.getElementById('qr-pay-block').style.display = 'block';
    stopQrScanner();
  } catch (err) {
    // Это не код пользователя ESA Bank — попробуем распознать формат (для информации),
    // но перевод в другой банк не выполняем, честно объясняем ограничение.
    const emv = parseEmvQr(payload);
    const bankLabel = detectKnownBankLabel(payload);
    const card = document.getElementById('qr-detect-card');
    if (emv || bankLabel) {
      let html = '';
      if (bankLabel) html += `<div class="bank-badge"><svg class="icon" style="width:14px;height:14px;"><use href="#ic-qr"/></svg>${escapeHtml(bankLabel)}</div><br>`;
      else html += `<div class="bank-badge"><svg class="icon" style="width:14px;height:14px;"><use href="#ic-qr"/></svg>EMVCo QR</div><br>`;
      if (emv && emv.merchantName) html += `${t('tx_recipient')}: <b>${escapeHtml(emv.merchantName)}</b><br>`;
      if (emv && emv.amount) html += `${t('tx_amount')}: <b>${formatMoney(emv.amount)}</b><br>`;
      html += t('qr_unknown_format');
      card.innerHTML = html;
      card.style.display = 'block';
      setError('qr-scan-error', '');
    } else {
      setError('qr-scan-error', err.message);
    }
  }
}

document.getElementById('qr-manual-check').addEventListener('click', () => {
  const val = document.getElementById('qr-manual-code').value.trim();
  if (!val) { setError('qr-scan-error', t('err_enter_qr_code')); return; }
  handleQrPayload(val);
});

document.getElementById('qr-manual-toggle').addEventListener('click', () => {
  const wrap = document.getElementById('qr-manual-wrap');
  wrap.style.display = wrap.style.display === 'none' ? 'block' : 'none';
});

document.getElementById('qrpay-back-btn').addEventListener('click', () => {
  resetQrPayForm();
});

document.getElementById('qr-flash-btn').addEventListener('click', async () => {
  const btn = document.getElementById('qr-flash-btn');
  const on = !btn.classList.contains('on');
  try {
    if (state.qrScanner && state.qrScanner.applyVideoConstraints) {
      await state.qrScanner.applyVideoConstraints({ advanced: [{ torch: on }] });
    }
    btn.classList.toggle('on', on);
    btn.querySelector('use').setAttribute('href', on ? '#ic-flash-off' : '#ic-flash');
  } catch (_) {
    // Бул түзмөктө/браузерде чырак (torch) колдоого алынбайт — коопсуз жокко чыгарабыз.
  }
});

document.getElementById('qr-zoom-slider').addEventListener('input', async (e) => {
  const zoom = parseFloat(e.target.value);
  try {
    if (state.qrScanner && state.qrScanner.applyVideoConstraints) {
      await state.qrScanner.applyVideoConstraints({ advanced: [{ zoom }] });
    }
  } catch (_) { /* камера zoom-ду колдобойт — коопсуз этибарга албайбыз */ }
});

document.getElementById('qr-gallery-btn').addEventListener('click', () => {
  document.getElementById('qr-gallery-input').click();
});

document.getElementById('qr-gallery-input').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  if (typeof Html5Qrcode === 'undefined') {
    setError('qr-scan-error', t('err_cam_lib_missing'));
    return;
  }
  try {
    const tempId = 'qr-gallery-scan-tmp';
    let tempDiv = document.getElementById(tempId);
    if (!tempDiv) { tempDiv = document.createElement('div'); tempDiv.id = tempId; tempDiv.style.display = 'none'; document.body.appendChild(tempDiv); }
    const scanner = new Html5Qrcode(tempId);
    const decodedText = await scanner.scanFile(file, false);
    try { scanner.clear(); } catch (_) {}
    handleQrPayload(decodedText);
  } catch (_) {
    setError('qr-scan-error', t('err_qr_not_found_in_image'));
  }
  e.target.value = '';
});

function startQrScanner() {
  const placeholder = document.getElementById('qr-cam-placeholder');
  if (typeof Html5Qrcode === 'undefined') {
    setError('qr-scan-error', t('err_cam_lib_missing_net'));
    return;
  }
  stopQrScanner();
  state.qrScanner = new Html5Qrcode('qr-reader');
  state.qrScanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: 220 },
    (decodedText) => { handleQrPayload(decodedText); },
    () => {}
  ).then(() => {
    if (placeholder) placeholder.style.display = 'none';
  }).catch(() => {
    setError('qr-scan-error', t('err_cam_permission_denied'));
  });
}

function stopQrScanner() {
  const placeholder = document.getElementById('qr-cam-placeholder');
  if (placeholder) placeholder.style.display = 'flex';
  const flashBtn = document.getElementById('qr-flash-btn');
  if (flashBtn) { flashBtn.classList.remove('on'); const u = flashBtn.querySelector('use'); if (u) u.setAttribute('href', '#ic-flash'); }
  if (state.qrScanner) {
    try { state.qrScanner.stop().then(() => state.qrScanner.clear()).catch(()=>{}); } catch (_) {}
    state.qrScanner = null;
  }
}

document.querySelectorAll('[data-amt-qr]').forEach(chip => {
  chip.addEventListener('click', () => {
    document.getElementById('qrpay-amount').value = chip.dataset.amtQr;
  });
});

document.getElementById('qrpay-submit-btn').addEventListener('click', async () => {
  setError('qrpay-submit-error', '');
  const amount = parseFloat(document.getElementById('qrpay-amount').value);
  const note = document.getElementById('qrpay-note').value.trim();
  const category = document.getElementById('qrpay-category').value;
  if (!amount || amount <= 0) {
    setError('qrpay-submit-error', t('err_enter_valid_amount'));
    return;
  }
  const recipientLabel = state.pendingQrRecipient.fullName;
  openTransferConfirm({
    amount, recipientLabel, note,
    methodLabel: `${recipientLabel} · ${t('method_qr_short')}`,
    run: () => api('POST', '/transfer/qr', { payload: state.pendingQrRecipient.payload, amount, note, category })
  });
});

// ======================================================
// SHARED TRANSFER FLOW (processing -> result)
// ======================================================
async function runTransfer(apiCall, amount, recipientLabel, note) {
  document.getElementById('processing-amount').textContent = `- ${formatMoney(amount)} сом`;
  goto('screen-processing');
  const started = Date.now();
  let data, errorObj;
  try {
    data = await apiCall();
  } catch (err) {
    errorObj = err;
  }
  const elapsed = Date.now() - started;
  const minDelay = 1400; // имитация обработки, как в настоящих банковских приложениях
  const wait = Math.max(0, minDelay - elapsed);
  setTimeout(() => showResult(data, errorObj, amount, recipientLabel, note), wait);
}

function showResult(data, errorObj, amount, recipientLabel, note) {
  const circle = document.getElementById('result-circle');
  const statusText = document.getElementById('result-status-text');
  const receiptCard = document.getElementById('result-receipt');

  if (errorObj) {
    circle.className = 'status-circle fail';
    circle.innerHTML = '<svg class="icon icon-lg"><use href="#ic-close"/></svg>';
    statusText.className = 'result-status-text fail';
    statusText.textContent = t('tx_failed_status');
    document.getElementById('result-amount').textContent = `- ${formatMoney(amount)} сом`;
    document.getElementById('result-sub').textContent = errorObj.message || t('err_unknown');
    receiptCard.style.display = 'none';
  } else {
    const tx = data.transaction;
    circle.className = 'status-circle success';
    circle.innerHTML = '<svg class="icon icon-lg"><use href="#ic-check"/></svg>';
    statusText.className = 'result-status-text success';
    statusText.textContent = t('tx_success_status');
    document.getElementById('result-amount').textContent = `- ${formatMoney(tx.amount)} сом`;
    document.getElementById('result-sub').textContent = tx.method === 'qr' ? t('method_qr_full') : t('method_phone_full');
    receiptCard.style.display = 'block';
    document.getElementById('r-date').textContent = formatDateShort(tx.createdAt);
    document.getElementById('r-receipt').textContent = tx.receiptNo;
    document.getElementById('r-recipient').textContent = recipientLabel;
    document.getElementById('r-amount').textContent = '- ' + formatMoney(tx.amount) + ' сом';
    document.getElementById('r-barcode').textContent = '*' + tx.receiptNo + '*';
    const statusOkEl = document.getElementById('r-status-ok');
    if (statusOkEl) statusOkEl.textContent = t('tx_success_status');
    const noteRow = document.getElementById('r-note-row');
    if (note) { noteRow.style.display = 'flex'; document.getElementById('r-note').textContent = note; }
    else { noteRow.style.display = 'none'; }

    showTransferNotification(tx, recipientLabel);
  }
  goto('screen-result');
}

// ======================================================
// TRANSFER NOTIFICATIONS (in-app banner + real OS push, ESA Bank-branded)
// ======================================================
function showNotifBanner(title, body) {
  const banner = document.getElementById('notif-banner');
  if (!banner) return;
  document.getElementById('nb-title-text').textContent = title;
  document.getElementById('nb-time-text').textContent = t('time_now');
  document.getElementById('nb-body-text').textContent = body;
  banner.classList.add('show');
  clearTimeout(banner._hideTimer);
  banner._hideTimer = setTimeout(() => banner.classList.remove('show'), 4200);
}

function notificationsEnabled() {
  const toggle = document.getElementById('toggle-notifications');
  return toggle ? toggle.checked : true;
}

function showTransferNotification(tx, recipientLabel) {
  if (!notificationsEnabled()) return;
  const body = `Которуу: ${formatMoney(tx.amount)} сом → ${recipientLabel}`;
  showNotifBanner('ESA Bank', body);

  // Real OS-level push notification via the registered service worker,
  // tied to this user's own completed transaction — ESA Bank branded only.
  if ('Notification' in window && Notification.permission === 'granted' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.ready.then(reg => {
      reg.showNotification('ESA Bank', {
        body,
        icon: 'icons/icon-192.png',
        badge: 'icons/icon-64.png',
        tag: 'esa-transfer-' + tx.receiptNo,
        data: { receiptNo: tx.receiptNo }
      }).catch(() => {});
    }).catch(() => {});
  }
}

document.getElementById('result-done-btn').addEventListener('click', () => {
  goto('screen-dashboard');
});

// ======================================================
// PWA: install prompt + service worker
// ======================================================
function isAppInstalled() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true
    || localStorage.getItem('esa_pwa_installed') === '1';
}

function hideInstallPrompts() {
  document.querySelectorAll('#install-btn-top, #install-banner, #install-btn-widget').forEach(el => {
    if (el) { el.style.display = 'none'; el.classList.remove('show'); }
  });
}

if (isAppInstalled()) {
  localStorage.setItem('esa_pwa_installed', '1');
  hideInstallPrompts();
} else {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    if (isAppInstalled()) return;
    state.deferredInstallPrompt = e;
    document.querySelectorAll('#install-btn-top, #install-banner, #install-btn-widget').forEach(el => {
      if (el) { el.style.display = el.id === 'install-banner' ? 'flex' : 'inline-flex'; el.classList.add('show'); }
    });
  });
}

window.addEventListener('appinstalled', () => {
  localStorage.setItem('esa_pwa_installed', '1');
  state.deferredInstallPrompt = null;
  hideInstallPrompts();
  toast(t('app_installed_toast'), 'success');
});

async function triggerInstall() {
  if (!state.deferredInstallPrompt) {
    toast(tf('install_instructions_toast', { menu: t('install_menu_item') }), 'success');
    return;
  }
  state.deferredInstallPrompt.prompt();
  const choice = await state.deferredInstallPrompt.userChoice;
  state.deferredInstallPrompt = null;
  if (choice && choice.outcome === 'accepted') localStorage.setItem('esa_pwa_installed', '1');
  hideInstallPrompts();
}
['install-btn-top', 'install-btn-banner', 'install-btn-widget'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('click', triggerInstall);
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ======================================================
// SECURITY: PIN code + biometric (WebAuthn) app lock
// ======================================================
async function sha256Hex(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function getPinHash() { return localStorage.getItem('esa_pin_hash'); }
function hasPin() { return !!getPinHash(); }
async function setPin(pin) { localStorage.setItem('esa_pin_hash', await sha256Hex(pin)); }
async function checkPin(pin) { return hasPin() && (await sha256Hex(pin)) === getPinHash(); }
function clearSecurityData() {
  localStorage.removeItem('esa_pin_hash');
  localStorage.removeItem('esa_webauthn_cred_id');
  localStorage.removeItem('esa_webauthn_registered');
}
function hasBiometric() { return localStorage.getItem('esa_webauthn_registered') === '1'; }
function webauthnSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
}
function b64urlToBuf(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=');
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}
function bufToB64url(buf) {
  let bin = '';
  new Uint8Array(buf).forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function registerBiometric() {
  if (!webauthnSupported()) { toast(t('biometric_not_supported'), 'error'); return false; }
  try {
    const userId = crypto.getRandomValues(new Uint8Array(16));
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const cred = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'ESA Bank' },
        user: { id: userId, name: (state.user && state.user.phoneFormatted) || 'esa-user', displayName: (state.user && state.user.fullName) || 'ESA Bank user' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
        timeout: 60000,
      }
    });
    if (!cred) return false;
    localStorage.setItem('esa_webauthn_cred_id', bufToB64url(cred.rawId));
    localStorage.setItem('esa_webauthn_registered', '1');
    toast(t('biometric_registered'), 'success');
    return true;
  } catch (_) {
    toast(t('biometric_failed'), 'error');
    return false;
  }
}

async function verifyBiometric() {
  if (!webauthnSupported() || !hasBiometric()) return false;
  try {
    const credId = localStorage.getItem('esa_webauthn_cred_id');
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        allowCredentials: credId ? [{ id: b64urlToBuf(credId), type: 'public-key' }] : [],
        userVerification: 'required',
        timeout: 60000,
      }
    });
    return !!assertion;
  } catch (_) {
    return false;
  }
}

document.getElementById('toggle-biometric').addEventListener('change', async (e) => {
  if (e.target.checked) {
    const ok = await registerBiometric();
    if (!ok) e.target.checked = false;
  } else {
    localStorage.removeItem('esa_webauthn_cred_id');
    localStorage.removeItem('esa_webauthn_registered');
    toast(t('biometric_removed'), 'success');
  }
});
(function initBiometricToggle() {
  const toggle = document.getElementById('toggle-biometric');
  if (toggle) toggle.checked = hasBiometric();
})();

// ---------- PIN setup modal (Settings) ----------
let pinSetupBuffer = '';
let pinSetupFirstEntry = null;

function renderPinDots(containerId, count) {
  const dots = document.querySelectorAll(`#${containerId} .pin-dot`);
  dots.forEach((d, i) => d.classList.toggle('filled', i < count));
}

function resetPinSetup() {
  pinSetupBuffer = '';
  pinSetupFirstEntry = null;
  renderPinDots('pin-setup-dots', 0);
  document.getElementById('pin-setup-hint').textContent = t('pin_setup_enter_new');
  setError('pin-setup-error', '');
}

document.getElementById('open-pin-setup-btn').addEventListener('click', () => {
  resetPinSetup();
  openModal('pin-setup-modal');
});

document.getElementById('pin-setup-keypad').addEventListener('click', async (e) => {
  const key = e.target.closest('[data-key]');
  const del = e.target.closest('#pin-setup-del-btn');
  if (del) { pinSetupBuffer = pinSetupBuffer.slice(0, -1); renderPinDots('pin-setup-dots', pinSetupBuffer.length); return; }
  if (!key) return;
  if (pinSetupBuffer.length >= 4) return;
  pinSetupBuffer += key.dataset.key;
  renderPinDots('pin-setup-dots', pinSetupBuffer.length);
  if (pinSetupBuffer.length === 4) {
    if (pinSetupFirstEntry === null) {
      pinSetupFirstEntry = pinSetupBuffer;
      pinSetupBuffer = '';
      setTimeout(() => {
        renderPinDots('pin-setup-dots', 0);
        document.getElementById('pin-setup-hint').textContent = t('pin_setup_confirm');
      }, 200);
    } else {
      if (pinSetupBuffer === pinSetupFirstEntry) {
        await setPin(pinSetupBuffer);
        toast(t('pin_setup_success'), 'success');
        setTimeout(() => closeModal('pin-setup-modal'), 300);
      } else {
        setError('pin-setup-error', t('pin_setup_mismatch'));
        const dotsEl = document.getElementById('pin-setup-dots');
        dotsEl.classList.add('shake');
        setTimeout(() => dotsEl.classList.remove('shake'), 400);
        setTimeout(resetPinSetup, 500);
      }
    }
  }
});

// ---------- PIN lock screen (on app resume) ----------
let pinLockBuffer = '';

function renderPinLockName() {
  const el = document.getElementById('pinlock-name');
  if (el) el.textContent = t('app_name');
}

async function resumeSessionAfterUnlock() {
  try {
    const { user } = await api('GET', '/me');
    state.user = user;
    document.body.classList.add('app-shell');
    goto('screen-dashboard');
  } catch (_) {
    localStorage.removeItem('esa_token');
    state.token = null;
    clearSecurityData();
    document.body.classList.remove('app-shell');
    goto('screen-login');
  }
}

function showPinLockScreen() {
  pinLockBuffer = '';
  renderPinDots('pin-dots', 0);
  renderPinLockName();
  setError('pinlock-error', '');
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById('screen-pinlock').classList.add('active');
  document.getElementById('pin-biometric-btn').style.display = (hasBiometric() && webauthnSupported()) ? 'flex' : 'none';
}

async function handlePinLockDigit(digit) {
  if (pinLockBuffer.length >= 4) return;
  pinLockBuffer += digit;
  renderPinDots('pin-dots', pinLockBuffer.length);
  if (pinLockBuffer.length === 4) {
    const ok = await checkPin(pinLockBuffer);
    if (ok) {
      resumeSessionAfterUnlock();
    } else {
      setError('pinlock-error', t('pin_wrong'));
      const dotsEl = document.getElementById('pin-dots');
      dotsEl.classList.add('shake');
      setTimeout(() => dotsEl.classList.remove('shake'), 400);
      setTimeout(() => { pinLockBuffer = ''; renderPinDots('pin-dots', 0); }, 450);
    }
  }
}

document.getElementById('pin-keypad').addEventListener('click', (e) => {
  const key = e.target.closest('[data-key]');
  const del = e.target.closest('#pin-del-btn');
  if (del) { pinLockBuffer = pinLockBuffer.slice(0, -1); renderPinDots('pin-dots', pinLockBuffer.length); return; }
  if (key) handlePinLockDigit(key.dataset.key);
});

document.getElementById('pin-biometric-btn').addEventListener('click', async () => {
  const ok = await verifyBiometric();
  if (ok) resumeSessionAfterUnlock();
  else toast(t('biometric_failed'), 'error');
});

document.getElementById('pinlock-use-password').addEventListener('click', (e) => {
  e.preventDefault();
  state.token = null;
  localStorage.removeItem('esa_token');
  document.body.classList.remove('app-shell');
  goto('screen-login');
});

// ======================================================
// INIT
// ======================================================
(async function init() {
  if (state.token) {
    if (hasPin()) {
      showPinLockScreen();
      // Эгер биометрика да жеткиликтүү болсо, колдонуучуга өзү тандасын — автоматтык түрдө сурабайбыз.
      return;
    }
    try {
      const { user } = await api('GET', '/me');
      state.user = user;
      document.body.classList.add('app-shell');
      goto('screen-dashboard');
      return;
    } catch (_) {
      localStorage.removeItem('esa_token');
      state.token = null;
    }
  }
  document.body.classList.remove('app-shell');
  goto('screen-login');
})();
