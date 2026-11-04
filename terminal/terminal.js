// ESA Bank — Terminal/ATM kiosk logic
(function () {
  'use strict';

  const API = '/api';
  let DEVICE_TOKEN = localStorage.getItem('esa_device_token') || '';
  let DEVICE_INFO = null;
  let sessionPollTimer = null;
  let qrRefreshTimer = null;
  let clockTimer = null;
  let currentClient = null; // { fullName, clientId, wallet, cards }
  let withdrawAmountStr = '';
  let depositSessionId = null;
  let depositTimerInterval = null;
  let idleReturnTimer = null;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function money(n) { return (Number(n) || 0).toLocaleString('ru-RU') + ' сом'; }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function toast(msg, type) {
    const c = $('#toast-container');
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3400);
  }

  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (DEVICE_TOKEN) headers['Authorization'] = 'Bearer ' + DEVICE_TOKEN;
    const res = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  function showScreen(id) {
    $all('.k-screen').forEach(s => s.classList.toggle('active', s.id === id));
  }

  // ===================== DEVICE SETUP =====================
  async function tryAutoDeviceLogin() {
    if (!DEVICE_TOKEN) return showScreen('k-screen-setup');
    try {
      // verify token still valid by requesting session state
      const data = await api('GET', '/device/session');
      enterIdle();
    } catch (e) {
      DEVICE_TOKEN = '';
      localStorage.removeItem('esa_device_token');
      showScreen('k-screen-setup');
    }
  }

  $('#form-device-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#device-login-btn');
    const errBox = $('#device-login-error');
    errBox.textContent = '';
    btn.disabled = true;
    try {
      const deviceCode = $('#device-code').value.trim().toUpperCase();
      const password = $('#device-password').value;
      const data = await api('POST', '/device/auth/login', { deviceCode, password });
      DEVICE_TOKEN = data.token;
      DEVICE_INFO = data.device;
      localStorage.setItem('esa_device_token', DEVICE_TOKEN);
      toast('Түзмөк активдештирилди!', 'ok');
      enterIdle(data.qrPayload);
    } catch (err) {
      errBox.textContent = err.message || 'Ката кетти';
    } finally {
      btn.disabled = false;
    }
  });

  $('#idle-gear-btn').addEventListener('click', () => {
    if (!confirm('Түзмөктү өчүрүп, баштапкы бетке кайтуу керекпи?')) return;
    DEVICE_TOKEN = '';
    DEVICE_INFO = null;
    localStorage.removeItem('esa_device_token');
    clearInterval(sessionPollTimer); clearInterval(qrRefreshTimer); clearInterval(clockTimer);
    showScreen('k-screen-setup');
  });

  // ===================== IDLE / QR =====================
  function enterIdle(initialQrPayload) {
    showScreen('k-screen-idle');
    $('#idle-device-label').textContent = DEVICE_INFO ? `${DEVICE_INFO.label} (${DEVICE_INFO.deviceCode})` : '';
    if (initialQrPayload) renderQr(initialQrPayload);
    else refreshQr();
    clearInterval(qrRefreshTimer);
    qrRefreshTimer = setInterval(refreshQr, 25000);
    clearInterval(clockTimer);
    tickClock(); clockTimer = setInterval(tickClock, 1000);
    clearInterval(sessionPollTimer);
    sessionPollTimer = setInterval(pollDeviceSession, 1800);
  }
  function tickClock() {
    const d = new Date();
    $('#idle-clock').textContent = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) + ' · ' + d.toLocaleDateString('ru-RU');
  }
  async function refreshQr() {
    try {
      const data = await api('GET', '/device/qr');
      renderQr(data.payload);
    } catch (e) { /* ignore transient errors */ }
  }
  function renderQr(payload) {
    const box = $('#qr-canvas');
    box.innerHTML = '';
    try {
      if (window.QRCode) {
        new QRCode(box, { text: payload, width: 220, height: 220, colorDark: '#0a1f3d', colorLight: '#ffffff', correctLevel: QRCode.CorrectLevel.M });
      } else {
        box.innerHTML = `<div style="width:220px;height:220px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#666;text-align:center;padding:10px;">QR китепканасы жүктөлгөн жок (интернет талап кылынат)</div>`;
      }
    } catch (e) {
      box.innerHTML = `<div style="width:220px;height:220px;display:flex;align-items:center;justify-content:center;font-size:11px;color:#666;">QR ката</div>`;
    }
  }
  async function pollDeviceSession() {
    try {
      const data = await api('GET', '/device/session');
      if (data.paired) {
        currentClient = data;
        clearInterval(sessionPollTimer);
        clearInterval(qrRefreshTimer);
        clearInterval(clockTimer);
        enterMenu();
      }
    } catch (e) { /* ignore */ }
  }

  // ===================== CLIENT MENU =====================
  function enterMenu() {
    showScreen('k-screen-menu');
    $('#menu-client-name').textContent = currentClient.user.fullName;
    $('#menu-client-id').textContent = currentClient.user.clientId;
    $('#menu-wallet-balance').textContent = currentClient.wallet.isOwner ? 'Чексиз' : money(currentClient.wallet.balance);
    const cardsBox = $('#menu-cards-row');
    cardsBox.innerHTML = (currentClient.cards || []).map(c => `
      <div class="menu-card-tile">
        <div class="label">${c.type === 'visa' ? 'ESA Visa' : 'ESA Элкарт'}<small>${c.maskedNumber}</small></div>
        <div class="bal">${money(c.balance)}</div>
      </div>
    `).join('');
    resetIdleReturnTimer();
  }
  function resetIdleReturnTimer() {
    clearTimeout(idleReturnTimer);
    idleReturnTimer = setTimeout(() => { endClientSession(true); }, 90000);
  }
  ['click', 'touchstart'].forEach(ev => document.addEventListener(ev, () => {
    if ($('#k-screen-menu').classList.contains('active') ||
        $('#k-screen-withdraw-amount').classList.contains('active') ||
        $('#k-screen-deposit-scan').classList.contains('active')) resetIdleReturnTimer();
  }));

  async function endClientSession(auto) {
    clearTimeout(idleReturnTimer);
    try { await api('POST', '/device/session/end'); } catch (e) {}
    currentClient = null;
    if (auto) toast('Убакыт бүткөндүктөн сессия аяктады', 'err');
    enterIdle();
  }
  $('#menu-end-session-btn').addEventListener('click', () => endClientSession(false));

  // ===================== WITHDRAW: AMOUNT =====================
  $('#menu-withdraw-btn').addEventListener('click', () => {
    withdrawAmountStr = '';
    renderWithdrawAmount();
    $('#withdraw-amount-error').textContent = '';
    $all('.quick-amt-btn').forEach(b => b.classList.remove('active'));
    showScreen('k-screen-withdraw-amount');
  });
  function renderWithdrawAmount() {
    const n = Number(withdrawAmountStr || '0');
    $('#withdraw-amount-display').textContent = money(n);
  }
  $all('.keypad-btn').forEach(btn => btn.addEventListener('click', () => {
    $all('.quick-amt-btn').forEach(b => b.classList.remove('active'));
    const k = btn.dataset.k;
    if (k === 'del') withdrawAmountStr = withdrawAmountStr.slice(0, -1);
    else {
      if ((withdrawAmountStr + k).replace(/^0+/, '').length > 7) return;
      withdrawAmountStr += k;
    }
    renderWithdrawAmount();
  }));
  $all('.quick-amt-btn').forEach(btn => btn.addEventListener('click', () => {
    $all('.quick-amt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    withdrawAmountStr = String(btn.dataset.amt);
    renderWithdrawAmount();
  }));
  $all('[data-k-back]').forEach(btn => btn.addEventListener('click', () => showScreen(btn.dataset.kBack)));

  $('#withdraw-continue-btn').addEventListener('click', async () => {
    const amount = Number(withdrawAmountStr || '0');
    const errBox = $('#withdraw-amount-error');
    errBox.textContent = '';
    if (!amount || amount <= 0) { errBox.textContent = 'Сумманы киргизиңиз'; return; }
    if (!currentClient.wallet.isOwner && amount > Number(String(currentClient.wallet.balance).replace(/\D/g, ''))) {
      // soft client-side pre-check; server is authoritative
    }
    showScreen('k-screen-withdraw-processing');
    await sleep(1700);
    try {
      const data = await api('POST', '/device/withdraw', { amount });
      renderWithdrawReceipt(data.receipt);
      currentClient.wallet.balance = data.newBalance;
      showScreen('k-screen-withdraw-receipt');
    } catch (err) {
      showScreen('k-screen-withdraw-amount');
      errBox.textContent = err.message || 'Ката кетти';
    }
  });

  function renderWithdrawReceipt(r) {
    const denomRows = Object.entries(r.denominations || {}).sort((a, b) => b[0] - a[0])
      .map(([d, c]) => `<div class="pr-row"><span>${d} сом x ${c}</span><span>${money(d * c)}</span></div>`).join('');
    $('#withdraw-receipt-paper').innerHTML = `
      <div class="pr-center">
        <div class="pr-title">ESA BANK</div>
        <div class="pr-sub">Накталай акча алуу чеги</div>
      </div>
      <div class="pr-divider"></div>
      <div class="pr-row"><span>Түзмөк</span><span>${r.deviceCode}</span></div>
      <div class="pr-row"><span>Чек №</span><span>${r.receiptNo}</span></div>
      <div class="pr-row"><span>Дата</span><span>${new Date(r.createdAt).toLocaleString('ru-RU')}</span></div>
      <div class="pr-divider"></div>
      ${denomRows}
      <div class="pr-divider"></div>
      <div class="pr-amount">- ${money(r.amount)}</div>
      <div class="pr-center" style="color:#1a7a3c;font-weight:700;">ОПЕРАЦИЯ ИЙГИЛИКТҮҮ</div>
      <div class="pr-barcode">▌│▌║▌║│▌║│▌▌│║▌</div>
    `;
  }
  $('#withdraw-done-btn').addEventListener('click', () => { endClientSession(false); });

  // ===================== DEPOSIT: SCAN =====================
  $('#menu-deposit-btn').addEventListener('click', startDepositSession);
  async function startDepositSession() {
    $('#deposit-scan-error').textContent = '';
    $('#deposit-confirm-btn').disabled = true;
    try {
      const data = await api('POST', '/device/deposit/start');
      depositSessionId = data.sessionId;
      renderDepositTotal(0);
      startDepositCountdown(data.expiresAt);
      showScreen('k-screen-deposit-scan');
      setScannerStatus('idle', 'Купюраны тандап, машинага салыңыз');
    } catch (err) { toast(err.message || 'Ката кетти', 'err'); }
  }
  function renderDepositTotal(total) {
    $('#deposit-total').textContent = money(total);
    $('#deposit-confirm-btn').disabled = total < 100000;
    $('#deposit-confirm-btn').textContent = total < 100000
      ? `Ырастоо (кеминде ${money(100000)} керек)`
      : 'Ырастоо жана эсепке кошуу';
  }
  function startDepositCountdown(expiresAt) {
    clearInterval(depositTimerInterval);
    function tick() {
      const secLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      const timerEl = $('#deposit-timer');
      timerEl.textContent = secLeft;
      timerEl.classList.toggle('low', secLeft <= 10);
      if (secLeft <= 0) {
        clearInterval(depositTimerInterval);
        cancelDepositOnTimeout();
      }
    }
    tick();
    depositTimerInterval = setInterval(tick, 400);
  }
  async function cancelDepositOnTimeout() {
    try { await api('POST', '/device/deposit/cancel', { sessionId: depositSessionId }); } catch (e) {}
    showOverlay('Убакыт бүттү', 'Операция токтотулду. Эгер купюра салган болсоңуз, аны алып, кайра аракет кылыңыз.');
    overlayNextAction = () => { showScreen('k-screen-menu'); };
  }
  function setScannerStatus(kind, text) {
    const el = $('.scanner-slot') || $('#k-screen-deposit-scan .scanner-slot');
    const slot = document.querySelector('.scanner-slot');
    slot.classList.remove('scanning', 'ok-flash', 'err-flash');
    if (kind === 'scanning') slot.classList.add('scanning');
    if (kind === 'ok') slot.classList.add('ok-flash');
    if (kind === 'err') slot.classList.add('err-flash');
    $('#scanner-status-text').textContent = text;
  }
  function randomSerial() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
    let s = '';
    for (let i = 0; i < 9; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  let scanningNow = false;
  $all('.bill-btn').forEach(btn => btn.addEventListener('click', async () => {
    if (scanningNow) return;
    scanningNow = true;
    $all('.bill-btn').forEach(b => b.disabled = true);
    $('#deposit-scan-error').textContent = '';
    setScannerStatus('scanning', 'Купюра таанылууда...');
    await sleep(900 + Math.random() * 500);
    try {
      const denom = Number(btn.dataset.denom);
      const serial = randomSerial();
      const data = await api('POST', '/device/deposit/scan', { sessionId: depositSessionId, denomination: denom, serial });
      renderDepositTotal(data.total);
      startDepositCountdown(data.expiresAt);
      setScannerStatus('ok', `Кабыл алынды: ${denom} сом`);
      await sleep(500);
      setScannerStatus('idle', 'Дагы купюра салыңыз же ырастаңыз');
    } catch (err) {
      setScannerStatus('err', err.message || 'Купюра кабыл алынган жок');
      $('#deposit-scan-error').textContent = err.message || 'Ката кетти';
      await sleep(600);
      setScannerStatus('idle', 'Купюраны тандап, машинага салыңыз');
    } finally {
      scanningNow = false;
      $all('.bill-btn').forEach(b => b.disabled = false);
    }
  }));

  $('#deposit-cancel-btn').addEventListener('click', async () => {
    clearInterval(depositTimerInterval);
    try { await api('POST', '/device/deposit/cancel', { sessionId: depositSessionId }); } catch (e) {}
    showScreen('k-screen-menu');
  });

  $('#deposit-confirm-btn').addEventListener('click', async () => {
    clearInterval(depositTimerInterval);
    showScreen('k-screen-deposit-processing');
    await sleep(1500);
    try {
      const data = await api('POST', '/device/deposit/confirm', { sessionId: depositSessionId });
      renderDepositReceipt(data.receipt);
      currentClient.wallet.balance = data.newBalance;
      showScreen('k-screen-deposit-receipt');
    } catch (err) {
      showScreen('k-screen-menu');
      toast(err.message || 'Ката кетти', 'err');
    }
  });
  function renderDepositReceipt(r) {
    const denomRows = Object.entries(r.denominations || {}).sort((a, b) => b[0] - a[0])
      .map(([d, c]) => `<div class="pr-row"><span>${d} сом x ${c}</span><span>${money(d * c)}</span></div>`).join('');
    $('#deposit-receipt-paper').innerHTML = `
      <div class="pr-center">
        <div class="pr-title">ESA BANK</div>
        <div class="pr-sub">Эсепти толуктоо чеги</div>
      </div>
      <div class="pr-divider"></div>
      <div class="pr-row"><span>Түзмөк</span><span>${r.deviceCode}</span></div>
      <div class="pr-row"><span>Чек №</span><span>${r.receiptNo}</span></div>
      <div class="pr-row"><span>Дата</span><span>${new Date(r.createdAt).toLocaleString('ru-RU')}</span></div>
      <div class="pr-divider"></div>
      ${denomRows}
      <div class="pr-divider"></div>
      <div class="pr-row"><span>Комиссия</span><span>0 сом</span></div>
      <div class="pr-amount" style="color:#1a7a3c;">+ ${money(r.amount)}</div>
      <div class="pr-center" style="color:#1a7a3c;font-weight:700;">ОПЕРАЦИЯ ИЙГИЛИКТҮҮ</div>
      <div class="pr-barcode">▌│▌║▌║│▌║│▌▌│║▌</div>
    `;
  }
  $('#deposit-done-btn').addEventListener('click', () => { endClientSession(false); });

  // ===================== OVERLAY =====================
  let overlayNextAction = null;
  function showOverlay(title, text) {
    $('#k-overlay-title').textContent = title;
    $('#k-overlay-text').textContent = text;
    $('#k-timeout-overlay').classList.add('show');
  }
  $('#k-overlay-ok-btn').addEventListener('click', () => {
    $('#k-timeout-overlay').classList.remove('show');
    if (overlayNextAction) { const fn = overlayNextAction; overlayNextAction = null; fn(); }
  });

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ===================== INIT =====================
  tryAutoDeviceLogin();
})();
