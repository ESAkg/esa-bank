'use strict';
/* ESA Bank — фронтенд-логика (vanilla JS, без сборки) */

const API = '/api';
let state = {
  token: localStorage.getItem('esa_token') || null,
  user: null,
  pendingRecipient: null,   // для перевода по телефону
  pendingQrRecipient: null, // для перевода по QR
  qrScanner: null
};

// ---------- Навигация ----------
function goto(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(screenId);
  if (el) el.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => {
    n.classList.toggle('active', n.dataset.goto === screenId);
  });
  window.scrollTo(0, 0);
  if (screenId === 'screen-dashboard') loadDashboard();
  if (screenId === 'screen-history') loadHistory();
  if (screenId === 'screen-qr-receive') loadMyQr();
  if (screenId === 'screen-profile') loadProfile();
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
    btn.disabled = false; btn.textContent = 'Кирүү';
  }
});

document.getElementById('link-register').addEventListener('click', () => goto('screen-register'));
document.getElementById('link-forgot').addEventListener('click', (e) => { e.preventDefault(); goto('screen-forgot'); });

// ======================================================
// AUTH: REGISTER
// ======================================================
document.getElementById('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  setError('register-error', '');
  const fullName = document.getElementById('reg-name').value.trim();
  const phone = document.getElementById('reg-phone').value.trim();
  const password = document.getElementById('reg-password').value;
  const password2 = document.getElementById('reg-password2').value;

  if (password !== password2) {
    setError('register-error', 'Сырсөздөр дал келген жок (Пароли не совпадают).');
    return;
  }
  const btn = document.getElementById('register-submit');
  btn.disabled = true; btn.textContent = 'Катталууда...';
  try {
    const data = await api('POST', '/auth/register', { fullName, phone, password }, false);
    toast('Аккаунт ийгиликтүү түзүлдү! Кош келиңиз.', 'success');
    onAuthSuccess(data);
  } catch (err) {
    setError('register-error', err.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Катталуу';
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
  goto('screen-dashboard');
}

document.getElementById('logout-btn').addEventListener('click', async () => {
  try { await api('POST', '/auth/logout'); } catch (_) {}
  state.token = null; state.user = null;
  localStorage.removeItem('esa_token');
  document.getElementById('form-login').reset();
  goto('screen-login');
});

// ======================================================
// DASHBOARD
// ======================================================
async function loadDashboard() {
  try {
    const { user } = await api('GET', '/me');
    state.user = user;
    document.getElementById('dash-firstname').textContent = firstName(user.fullName);
    document.getElementById('dash-balance').textContent = user.account.isOwner ? 'Безлимиттүү' : formatMoney(user.account.balance);
    document.getElementById('dash-balance-suffix').style.display = user.account.isOwner ? 'none' : '';
    document.getElementById('dash-account').textContent = user.account.accountNumber;
    document.getElementById('dash-date').textContent = formatDateHuman(new Date());

    const { transactions } = await api('GET', '/transactions');
    renderTxList('dash-tx-list', transactions.slice(0, 5));
  } catch (err) {
    if (err.status === 401) { forceLogout(); return; }
    toast(err.message, 'error');
  }
}

function forceLogout() {
  state.token = null; state.user = null;
  localStorage.removeItem('esa_token');
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
  return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric', weekday: 'long' });
}

function initials(name) {
  return (name || '?').split(' ').filter(Boolean).slice(0,2).map(w => w[0]).join('').toUpperCase();
}

function renderTxList(containerId, list) {
  const container = document.getElementById(containerId);
  if (!list.length) {
    container.innerHTML = '<div class="empty-state"><div class="ei"><svg class="icon"><use href="#ic-receipt"/></svg></div>Операциялар жок</div>';
    return;
  }
  container.innerHTML = list.map(t => {
    const sign = t.direction === 'in' ? '+' : '-';
    const iconName = t.direction === 'in' ? 'arrow-down' : 'arrow-up';
    const methodLabel = t.method === 'qr' ? 'QR код' : 'Телефон номери';
    return `
      <div class="tx-row">
        <div class="tx-icon ${t.direction}"><svg class="icon"><use href="#ic-${iconName}"/></svg></div>
        <div class="tx-main">
          <div class="name">${escapeHtml(t.counterparty)}</div>
          <div class="meta">${methodLabel} · ${formatDateShort(t.createdAt)}</div>
        </div>
        <div class="tx-amount ${t.direction}">${sign} ${formatMoney(t.amount)} сом</div>
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
    document.getElementById('profile-avatar').textContent = initials(user.fullName);
    document.getElementById('profile-name').textContent = user.fullName;
    document.getElementById('profile-id').textContent = 'Клиент № ' + user.clientId;
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
    document.getElementById('transfer-recipient-id').textContent = `Клиент № ${recipient.clientId} · ${recipient.phoneFormatted}`;
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
  if (!amount || amount <= 0) {
    setError('transfer-submit-error', 'Сумманы туура киргизиңиз.');
    return;
  }
  const recipientLabel = state.pendingRecipient.fullName;
  runTransfer(
    () => api('POST', '/transfer/phone', { phone: state.pendingRecipient.phone, amount, note }),
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
    document.getElementById('my-qr-id').textContent = `Клиент № ${data.clientId} · ${data.accountNumber}`;
  } catch (err) {
    if (err.status === 401) { forceLogout(); return; }
    toast(err.message, 'error');
  }
}

// ======================================================
// QR — SCAN / PAY
// ======================================================
function resetQrPayForm() {
  document.getElementById('qr-scan-block').style.display = 'block';
  document.getElementById('qr-pay-block').style.display = 'none';
  document.getElementById('qr-manual-code').value = '';
  setError('qr-scan-error', '');
  stopQrScanner();
}

async function handleQrPayload(payload) {
  setError('qr-scan-error', '');
  try {
    const resolved = await api('POST', '/qr/resolve', { payload });
    state.pendingQrRecipient = { payload, ...resolved };
    document.getElementById('qrpay-avatar').textContent = initials(resolved.fullName);
    document.getElementById('qrpay-recipient-name').textContent = resolved.fullName;
    document.getElementById('qrpay-recipient-id').textContent = `Клиент № ${resolved.clientId}`;
    document.getElementById('qr-scan-block').style.display = 'none';
    document.getElementById('qr-pay-block').style.display = 'block';
    stopQrScanner();
  } catch (err) {
    setError('qr-scan-error', err.message);
  }
}

document.getElementById('qr-manual-check').addEventListener('click', () => {
  const val = document.getElementById('qr-manual-code').value.trim();
  if (!val) { setError('qr-scan-error', 'QR кодду киргизиңиз.'); return; }
  handleQrPayload(val);
});

document.getElementById('qr-start-cam').addEventListener('click', () => {
  startQrScanner();
});

function startQrScanner() {
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
  ).catch(() => {
    setError('qr-scan-error', 'Камерага уруксат берилген жок. Кодду кол менен киргизиңиз.');
  });
}

function stopQrScanner() {
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
  if (!amount || amount <= 0) {
    setError('qrpay-submit-error', 'Сумманы туура киргизиңиз.');
    return;
  }
  const recipientLabel = state.pendingQrRecipient.fullName;
  runTransfer(
    () => api('POST', '/transfer/qr', { payload: state.pendingQrRecipient.payload, amount, note }),
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
  }
  goto('screen-result');
}

document.getElementById('result-done-btn').addEventListener('click', () => {
  goto('screen-dashboard');
});

// ======================================================
// INIT
// ======================================================
(async function init() {
  if (state.token) {
    try {
      const { user } = await api('GET', '/me');
      state.user = user;
      goto('screen-dashboard');
      return;
    } catch (_) {
      localStorage.removeItem('esa_token');
      state.token = null;
    }
  }
  goto('screen-login');
})();
