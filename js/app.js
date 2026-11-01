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
function goto(screenId) {
  const prevActive = document.querySelector('.screen.active');
  if (prevActive && prevActive.id === 'screen-qr-pay' && screenId !== 'screen-qr-pay') stopQrScanner();
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(screenId);
  if (el) el.classList.add('active');
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
  if (screenId === 'screen-settings') { /* статичный экран, данные не нужны */ }
  if (screenId === 'screen-transfer-phone') resetTransferPhoneForm();
  if (screenId === 'screen-qr-pay') resetQrPayForm();
}

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-goto]');
  if (t) { e.preventDefault(); goto(t.dataset.goto); }
});

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
    const err = new Error(data.error || 'Ката кетти');
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

// ======================================================
// AUTH: LOGIN
// ======================================================
document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('login-error', '');
  const phone = document.getElementById('login-phone').value.trim();
  const password = document.getElementById('login-password').value;
  const btn = document.getElementById('login-submit');
  btn.disabled = true; btn.textContent = 'Кирүү...';
  try {
    const data = await api('POST', '/auth/login', { phone, password }, false);
    onAuthSuccess(data);
  } catch (err) {
    setError('login-error', err.message);
  } finally {
    btn.disabled = false; btn.textContent = t('btn_login');
  }
});

document.getElementById('link-register').addEventListener('click', () => goto('screen-register'));
document.getElementById('link-forgot').addEventListener('click', (e) => { e.preventDefault(); goto('screen-forgot'); });

// ======================================================
// AUTH: REGISTER (2-step)
// ======================================================
let regData = { fullName: '', phone: '' };

function resetRegisterForm() {
  document.getElementById('form-register-step1').reset();
  document.getElementById('form-register-step2').reset();
  document.getElementById('reg-step-1-block').style.display = 'block';
  document.getElementById('reg-step-2-block').style.display = 'none';
  document.getElementById('reg-dot-1').classList.add('active');
  document.getElementById('reg-dot-2').classList.remove('active');
  setError('register-step1-error', '');
  setError('register-step2-error', '');
}

document.getElementById('form-register-step1').addEventListener('submit', (e) => {
  e.preventDefault();
  setError('register-step1-error', '');
  const fullName = document.getElementById('reg-name').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  if (fullName.length < 3) { setError('register-step1-error', 'Атыңызды толук киргизиңиз.'); return; }
  regData = { fullName, phone };
  document.getElementById('reg-step-1-block').style.display = 'none';
  document.getElementById('reg-step-2-block').style.display = 'block';
  document.getElementById('reg-dot-1').classList.remove('active');
  document.getElementById('reg-dot-2').classList.add('active');
});

document.getElementById('reg-back-btn').addEventListener('click', () => {
  document.getElementById('reg-step-1-block').style.display = 'block';
  document.getElementById('reg-step-2-block').style.display = 'none';
  document.getElementById('reg-dot-1').classList.add('active');
  document.getElementById('reg-dot-2').classList.remove('active');
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

document.getElementById('form-register-step2').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('register-step2-error', '');
  const password = document.getElementById('reg-password').value;
  const password2 = document.getElementById('reg-password2').value;

  if (!checkPwRules()) {
    setError('register-step2-error', 'Сырсөз талаптарга жооп бериш керек.');
    return;
  }
  if (password !== password2) {
    setError('register-step2-error', 'Сырсөздөр дал келген жок (Пароли не совпадают).');
    return;
  }
  const btn = document.getElementById('register-submit');
  btn.disabled = true; btn.textContent = 'Катталууда...';
  try {
    const data = await api('POST', '/auth/register', { fullName: regData.fullName, phone: regData.phone, password }, false);
    toast('Аккаунт ийгиликтүү түзүлдү! Кош келиңиз.', 'success');
    resetRegisterForm();
    onAuthSuccess(data);
  } catch (err) {
    setError('register-step2-error', err.message);
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
      `Текшерүү коду: ${data.demoCode} (жарактуу: ${Math.round(data.expiresInSec/60)} мүнөт).`;
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
      `Жаңы текшерүү коду: ${data.demoCode}.`;
    toast('Жаңы код жөнөтүлдү', 'success');
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
    toast('Сырсөз ийгиликтүү жаңыртылды. Эми кирсеңиз болот.', 'success');
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
}

function doLogout() {
  api('POST', '/auth/logout').catch(() => {});
  state.token = null; state.user = null;
  localStorage.removeItem('esa_token');
  document.body.classList.remove('app-shell');
  document.getElementById('form-login').reset();
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
      toast(t('copied_clipboard') === 'Copied' ? 'Account deleted.' : 'Аккаунт өчүрүлдү.', 'success');
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
    document.getElementById('dash-balance').textContent = user.account.isOwner ? 'Безлимиттүү' : formatMoney(user.account.balance);
    document.getElementById('dash-balance-suffix').style.display = user.account.isOwner ? 'none' : '';
    document.getElementById('dash-account').textContent = user.account.accountNumber;
    document.getElementById('dash-date').textContent = formatDateHuman(new Date());

    // Карта привязана к тому же счёту (как в реальном банке — дебетовая карта = счёт)
    document.getElementById('dash-card-balance').textContent = user.account.isOwner ? 'Безлимиттүү' : formatMoney(user.account.balance);
    document.getElementById('dash-card-suffix').style.display = user.account.isOwner ? 'none' : '';
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
  toast('Сессия аяктады, кайра кириңиз', 'error');
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
    const methodLabel = tx.method === 'qr' ? 'QR код' : 'Телефон номери';
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
// CARDS SCREEN (accounts overview)
// ======================================================
async function loadCardsScreen() {
  try {
    const { user } = await api('GET', '/me');
    const bal = user.account.isOwner ? 'Безлимиттүү' : formatMoney(user.account.balance);
    document.getElementById('cards-acc-balance').textContent = bal;
    document.getElementById('cards-card-balance').textContent = bal;
    document.getElementById('cards-acc-no').textContent = user.account.accountNumber;
  } catch (err) {
    if (err.status === 401) forceLogout();
  }
}

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
      ? 'Безлимиттүү (банк ээси)'
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
  setError('transfer-lookup-error', '');
  setError('transfer-submit-error', '');
  state.pendingRecipient = null;
}

document.getElementById('form-transfer-lookup').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('transfer-lookup-error', '');
  const phone = document.getElementById('transfer-phone').value.trim();
  const btn = document.getElementById('transfer-lookup-btn');
  btn.disabled = true; btn.textContent = 'Текшерилүүдө...';
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
    btn.disabled = false; btn.textContent = 'Алуучуну текшерүү';
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
    setError('transfer-submit-error', 'Сумманы туура киргизиңиз.');
    return;
  }
  const recipientLabel = state.pendingRecipient.fullName;
  runTransfer(
    () => api('POST', '/transfer/phone', { phone: state.pendingRecipient.phone, amount, note, category }),
    amount, recipientLabel, note
  );
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
  document.getElementById('qr-manual-code').value = '';
  document.getElementById('qr-manual-wrap').style.display = 'none';
  document.getElementById('qr-detect-card').style.display = 'none';
  setError('qr-scan-error', '');
  startQrScanner();
}

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
      if (emv && emv.merchantName) html += `${t('category_label') === 'Категория' ? 'Алуучу' : 'Recipient'}: <b>${escapeHtml(emv.merchantName)}</b><br>`;
      if (emv && emv.amount) html += `Сумма: <b>${formatMoney(emv.amount)}</b><br>`;
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
  if (!val) { setError('qr-scan-error', 'QR кодду киргизиңиз.'); return; }
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
    setError('qr-scan-error', 'Камера китепканасы жүктөлгөн жок. Кодду кол менен киргизиңиз.');
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
    setError('qr-scan-error', 'Сүрөттөн QR код табылган жок.');
  }
  e.target.value = '';
});

function startQrScanner() {
  const placeholder = document.getElementById('qr-cam-placeholder');
  if (typeof Html5Qrcode === 'undefined') {
    setError('qr-scan-error', 'Камера китепканасы жүктөлгөн жок (жайлоого байланыштуу). Кодду кол менен киргизиңиз.');
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
    setError('qr-scan-error', 'Камерага уруксат берилген жок. Кодду кол менен киргизиңиз.');
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
    setError('qrpay-submit-error', 'Сумманы туура киргизиңиз.');
    return;
  }
  const recipientLabel = state.pendingQrRecipient.fullName;
  runTransfer(
    () => api('POST', '/transfer/qr', { payload: state.pendingQrRecipient.payload, amount, note, category }),
    amount, recipientLabel, note
  );
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
    statusText.textContent = 'Которуу аткарылган жок';
    document.getElementById('result-amount').textContent = `- ${formatMoney(amount)} сом`;
    document.getElementById('result-sub').textContent = errorObj.message || 'Белгисиз ката';
    receiptCard.style.display = 'none';
  } else {
    const tx = data.transaction;
    circle.className = 'status-circle success';
    circle.innerHTML = '<svg class="icon icon-lg"><use href="#ic-check"/></svg>';
    statusText.className = 'result-status-text success';
    statusText.textContent = 'Транзакция ийгиликтүү аткарылды';
    document.getElementById('result-amount').textContent = `- ${formatMoney(tx.amount)} сом`;
    document.getElementById('result-sub').textContent = tx.method === 'qr' ? 'QR код менен которуу' : 'Телефон номери менен которуу';
    receiptCard.style.display = 'block';
    document.getElementById('r-date').textContent = formatDateShort(tx.createdAt);
    document.getElementById('r-receipt').textContent = tx.receiptNo;
    document.getElementById('r-recipient').textContent = recipientLabel;
    document.getElementById('r-amount').textContent = formatMoney(tx.amount) + ' сом';
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
  document.getElementById('nb-time-text').textContent = 'сейчас';
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
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  state.deferredInstallPrompt = e;
  document.querySelectorAll('#install-btn-top, #install-banner, #install-btn-widget').forEach(el => {
    if (el) { el.style.display = el.id === 'install-banner' ? 'flex' : 'inline-flex'; el.classList.add('show'); }
  });
});

async function triggerInstall() {
  if (!state.deferredInstallPrompt) {
    toast('Тиркемени орнотуу үчүн браузердин менюсунан "Добавить на главный экран" тандаңыз.', 'success');
    return;
  }
  state.deferredInstallPrompt.prompt();
  await state.deferredInstallPrompt.userChoice;
  state.deferredInstallPrompt = null;
  document.querySelectorAll('#install-btn-top, #install-banner, #install-btn-widget').forEach(el => {
    if (el) { el.style.display = 'none'; el.classList.remove('show'); }
  });
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
// INIT
// ======================================================
(async function init() {
  if (state.token) {
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
