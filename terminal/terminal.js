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

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // Бекер (free-tier) хостингде сервер бир аз "уйкуда" болушу мүмкүн — ошондуктан
  // тармак катасында же убактылуу 502/503/504'тө бир жолу кайра аракет кылабыз.
  async function api(method, path, body, _retry, timeoutMs) {
    const headers = { 'Content-Type': 'application/json' };
    if (DEVICE_TOKEN) headers['Authorization'] = 'Bearer ' + DEVICE_TOKEN;
    let res;
    let timer = null;
    const controller = timeoutMs ? new AbortController() : null;
    if (controller) timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      res = await fetch(API + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined, signal: controller ? controller.signal : undefined });
    } catch (netErr) {
      if (netErr.name === 'AbortError') {
        throw new Error('Сервер жооп бербей жатат — интернет жай болушу мүмкүн (Сервер не отвечает). Кайра аракет кылыңыз.');
      }
      if (!_retry) { await sleep(1200); return api(method, path, body, true, timeoutMs); }
      throw new Error('Сервер менен байланыш жок (Нет связи с сервером). Кайра аракет кылыңыз.');
    } finally {
      if (timer) clearTimeout(timer);
    }
    if ([502, 503, 504].includes(res.status) && !_retry) {
      await sleep(1500);
      return api(method, path, body, true);
    }
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
    clearInterval(depositTimerInterval);
    clearInterval(withdrawPollTimer);
    clearInterval(withdrawPollCountdown);
    activeWithdrawRequestId = null;
    stopDepositCamera();
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

  let withdrawPollTimer = null;
  let withdrawPollCountdown = null;
  let activeWithdrawRequestId = null;

  $('#withdraw-continue-btn').addEventListener('click', async () => {
    const amount = Number(withdrawAmountStr || '0');
    const errBox = $('#withdraw-amount-error');
    errBox.textContent = '';
    if (!amount || amount <= 0) { errBox.textContent = 'Сумманы киргизиңиз'; return; }
    const btn = $('#withdraw-continue-btn');
    btn.disabled = true;
    try {
      const data = await api('POST', '/device/withdraw/request', { amount });
      activeWithdrawRequestId = data.requestId;
      $('#withdraw-waiting-amount').textContent = money(amount);
      showScreen('k-screen-withdraw-waiting');
      startWithdrawWaitingCountdown(data.expiresAt);
      pollWithdrawStatus();
    } catch (err) {
      errBox.textContent = err.message || 'Ката кетти';
    } finally {
      btn.disabled = false;
    }
  });

  function startWithdrawWaitingCountdown(expiresAt) {
    clearInterval(withdrawPollCountdown);
    function tick() {
      const secLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      const timerEl = $('#withdraw-waiting-timer');
      timerEl.textContent = secLeft;
      timerEl.classList.toggle('low', secLeft <= 15);
    }
    tick();
    withdrawPollCountdown = setInterval(tick, 500);
  }

  function pollWithdrawStatus() {
    clearInterval(withdrawPollTimer);
    withdrawPollTimer = setInterval(async () => {
      if (!activeWithdrawRequestId) return;
      try {
        const data = await api('GET', `/device/withdraw/status?requestId=${encodeURIComponent(activeWithdrawRequestId)}`);
        if (data.status === 'approved') {
          clearInterval(withdrawPollTimer);
          clearInterval(withdrawPollCountdown);
          activeWithdrawRequestId = null;
          currentClient.wallet.balance = data.newBalance;
          showScreen('k-screen-withdraw-processing');
          await sleep(1200);
          renderWithdrawReceipt(data.receipt);
          showScreen('k-screen-withdraw-receipt');
        } else if (data.status === 'rejected') {
          clearInterval(withdrawPollTimer);
          clearInterval(withdrawPollCountdown);
          activeWithdrawRequestId = null;
          showOverlay('Операция четке кагылды', data.error || 'Кардар телефонунан операцияны четке кагды.');
          overlayNextAction = () => { showScreen('k-screen-menu'); };
        } else if (data.status === 'expired') {
          clearInterval(withdrawPollTimer);
          clearInterval(withdrawPollCountdown);
          activeWithdrawRequestId = null;
          showOverlay('Убакыт бүттү', 'Ырастоо убактысы бүттү. Кайра аракет кылыңыз.');
          overlayNextAction = () => { showScreen('k-screen-menu'); };
        }
        // 'pending' — күтө беребиз
      } catch (e) { /* убактылуу ката — кийинки polling аракетинде кайталайбыз */ }
    }, 1500);
  }

  $('#withdraw-waiting-cancel-btn').addEventListener('click', () => {
    clearInterval(withdrawPollTimer);
    clearInterval(withdrawPollCountdown);
    activeWithdrawRequestId = null;
    showScreen('k-screen-withdraw-amount');
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
  $('#withdraw-another-op-btn').addEventListener('click', () => { enterMenu(); });

  // ===================== DEPOSIT: SCAN =====================
  let depositCameraStream = null;
  async function startDepositCamera() {
    const video = $('#deposit-camera-video');
    const note = $('#camera-unavailable-note');
    note.style.display = 'none';
    video.style.display = 'block';
    try {
      // 1280x720 — номиналдын сандарын так окууга жетиштүү, бирок 1920x1080
      // сыяктуу эле кадрды 4 жолу тартып, OCR'ге жөнөтүүдө убакытты
      // кыскартат (аз пиксел = азыраак маалымат → сервер тезирээк иштейт,
      // интернетке да тезирээк жүктөлөт — "катып калуу" көйгөйүн азайтат).
      depositCameraStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      video.srcObject = depositCameraStream;
      $('#scan-bill-btn').disabled = false;
    } catch (e) {
      // Камера жок же уруксат берилген жок — чыныгы таанып билүү камера
      // сүрөтү болбосо иштебейт, ошондуктан сканерлөөнү өчүрөбүз (жасалма
      // симуляцияга чалынбайбыз).
      video.style.display = 'none';
      note.style.display = 'flex';
      note.querySelector('span').textContent = 'Камерага уруксат жок — купюраны сканерлөө мүмкүн эмес. Браузердин камера уруксатын текшериңиз.';
      $('#scan-bill-btn').disabled = true;
      setScannerStatus('idle', '');
    }
  }
  function stopDepositCamera() {
    if (depositCameraStream) { depositCameraStream.getTracks().forEach(t => t.stop()); depositCameraStream = null; }
  }

  $('#menu-deposit-btn').addEventListener('click', startDepositSession);
  async function startDepositSession() {
    $('#deposit-scan-error').textContent = '';
    $('#deposit-confirm-btn').disabled = true;
    $('#recognized-note-badge').style.display = 'none';
    try {
      const data = await api('POST', '/device/deposit/start');
      depositSessionId = data.sessionId;
      renderDepositTotal(0);
      startDepositCountdown(data.expiresAt);
      showScreen('k-screen-deposit-scan');
      startDepositCamera();
      setScannerStatus('idle', '');
    } catch (err) { toast(err.message || 'Ката кетти', 'err'); }
  }
  function renderDepositTotal(total) {
    $('#deposit-total').textContent = money(total);
    $('#deposit-confirm-btn').disabled = total <= 0;
    $('#deposit-confirm-btn').textContent = 'Ырастоо жана эсепке кошуу';
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
    stopDepositCamera();
    try { await api('POST', '/device/deposit/cancel', { sessionId: depositSessionId }); } catch (e) {}
    showOverlay('Убакыт бүттү', 'Операция токтотулду. Эгер купюра салган болсоңуз, аны алып, кайра аракет кылыңыз.');
    overlayNextAction = () => { showScreen('k-screen-menu'); };
  }
  function setScannerStatus(kind, text) {
    const box = $('#scanner-camera-box');
    box.classList.remove('scanning', 'ok-flash', 'err-flash');
    if (kind === 'scanning') box.classList.add('scanning');
    if (kind === 'ok') box.classList.add('ok-flash');
    if (kind === 'err') box.classList.add('err-flash');
    $('#scanner-status-text').textContent = text || '';
  }
  function showScanFlash(kind, text) {
    const flash = $('#scan-result-flash');
    flash.textContent = text;
    flash.className = 'scan-result-flash show' + (kind ? ' ' + kind : '');
  }
  function hideScanFlash() {
    $('#scan-result-flash').className = 'scan-result-flash';
  }
  function showRecognizedBadge(denom, serial, confidence) {
    const badge = $('#recognized-note-badge');
    const textEl = $('#recognized-note-text');
    const confEl = $('#recognized-note-conf');
    textEl.textContent = `✓ ${denom.toLocaleString('ru-RU')} сом` + (serial ? ` · № ${serial}` : '');
    textEl.className = 'amt';
    if (confidence === 'low') {
      confEl.textContent = 'Ишеним аз — текшериңиз';
      confEl.className = 'conf-low';
    } else {
      confEl.textContent = '';
    }
    badge.style.display = 'flex';
  }

  // Кадрды реалдуу камера видеосунан сүрөткө тартып, JPEG катары base64'ке
  // айландырат — так ушул сүрөт серверге (чыныгы OCR/компьютердик көрүү
  // таанып билүүгө) жиберилет. Эч кандай симуляция жок: эмне көрсөтсө,
  // ошону алат жана ошону боюнча таанат.
  function captureVideoFrame() {
    const video = $('#deposit-camera-video');
    if (!video || !video.videoWidth) return null;
    const canvas = $('#deposit-capture-canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.92);
  }

  // Бир кадрга ишенбей, бир нече кадрды (аз-аздан убакыт аралыгы менен)
  // тартып, ар бирин талдатып, эн көп кайталанган/эн ишенимдүү жыйынтыкты
  // тандайбыз — "кайра-кайра сканерлеп, туура вариантты чыгаруу" деген
  // талапка жооп ушул.
  const SCAN_FRAME_COUNT = 4;
  const SCAN_FRAME_GAP_MS = 220;
  async function captureMultipleFrames() {
    const frames = [];
    for (let i = 0; i < SCAN_FRAME_COUNT; i++) {
      const f = captureVideoFrame();
      if (f) frames.push(f);
      if (i < SCAN_FRAME_COUNT - 1) await sleep(SCAN_FRAME_GAP_MS);
    }
    return frames;
  }

  let scanningNow = false;
  $('#scan-bill-btn').addEventListener('click', async () => {
    if (scanningNow) return;
    if (!captureVideoFrame()) {
      $('#deposit-scan-error').textContent = 'Камера даяр эмес, бир аз күтүп кайра аракет кылыңыз (Камера не готова).';
      return;
    }
    scanningNow = true;
    $('#scan-bill-btn').disabled = true;
    $('#deposit-scan-error').textContent = '';
    $('#recognized-note-badge').style.display = 'none';
    hideScanFlash();
    // Реалдуу бир нече кадрды тартуу + талдоо анимациясы (лазер сызык),
    // ал эми чыныгы таанып билүү (OCR + түс анализи, добуш берүү менен)
    // серверде ушул учурда жүрөт.
    setScannerStatus('scanning', 'Купюра бир нече ирет тартылууда...');
    const frames = await captureMultipleFrames();
    setScannerStatus('scanning', 'Варианттар талдалууда...');
    const minDwell = sleep(400);
    try {
      const data = await api('POST', '/device/deposit/scan-image', { sessionId: depositSessionId, images: frames }, false, 35000);
      await minDwell;
      renderDepositTotal(data.total);
      startDepositCountdown(data.expiresAt);
      setScannerStatus('ok', '');
      showScanFlash('ok', `✓ Таанылды: ${data.lastDenom} сом`);
      showRecognizedBadge(data.lastDenom, data.serial, data.confidence);
      await sleep(700);
      hideScanFlash();
      setScannerStatus('idle', 'Дагы купюра көрсөтүңүз же ырастаңыз');
    } catch (err) {
      await minDwell;
      setScannerStatus('err', '');
      showScanFlash('err', err.message || 'Купюра таанылган жок');
      $('#deposit-scan-error').textContent = err.message || 'Ката кетти';
      await sleep(900);
      hideScanFlash();
      setScannerStatus('idle', 'Купюраны камерага түз көрсөтүп, «Сканерлөө» баскычын басыңыз');
    } finally {
      scanningNow = false;
      $('#scan-bill-btn').disabled = false;
    }
  });

  $('#deposit-cancel-btn').addEventListener('click', async () => {
    clearInterval(depositTimerInterval);
    stopDepositCamera();
    try { await api('POST', '/device/deposit/cancel', { sessionId: depositSessionId }); } catch (e) {}
    showScreen('k-screen-menu');
  });

  $('#deposit-confirm-btn').addEventListener('click', async () => {
    clearInterval(depositTimerInterval);
    stopDepositCamera();
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
  $('#deposit-another-op-btn').addEventListener('click', () => { enterMenu(); });

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

  // ===================== INIT =====================
  tryAutoDeviceLogin();
})();
