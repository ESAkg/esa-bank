// ESA Bank — Office (back-office) application logic
(function () {
  'use strict';

  const API = '/api';
  let STAFF_TOKEN = localStorage.getItem('esa_staff_token') || '';
  let STAFF = null;
  let regFaceStream = null;
  let regFacePhoto = null;
  const CARD_PLAN_LABELS = { visa: 'ESA Visa Classic', elkart: 'ESA Элкарт' };

  // ---------- helpers ----------
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
  function money(n) { return (Number(n) || 0).toLocaleString('ru-RU') + ' сом'; }
  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function toast(msg, type) {
    const c = $('#toast-container');
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => { el.remove(); }, 3600);
  }

  async function api(method, path, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (STAFF_TOKEN) headers['Authorization'] = 'Bearer ' + STAFF_TOKEN;
    const res = await fetch(API + path, {
      method, headers,
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('HTTP ' + res.status));
      err.status = res.status; err.data = data;
      throw err;
    }
    return data;
  }

  // ---------- auth ----------
  async function tryAutoLogin() {
    if (!STAFF_TOKEN) return showLogin();
    try {
      const data = await api('GET', '/staff/me');
      STAFF = data.staff;
      showApp();
    } catch (e) {
      STAFF_TOKEN = '';
      localStorage.removeItem('esa_staff_token');
      showLogin();
    }
  }

  function showLogin() {
    $('#screen-login').classList.add('active');
    $('#app-shell').style.display = 'none';
  }

  function showApp() {
    $('#screen-login').classList.remove('active');
    $('#app-shell').style.display = 'flex';
    $('#staff-name').textContent = STAFF.fullName || 'Кызматкер';
    $('#staff-role').textContent = STAFF.isOwner ? 'Банк ээси' : 'Кызматкер';
    switchView('dashboard');
  }

  $('#form-staff-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#staff-login-btn');
    const errBox = $('#staff-login-error');
    errBox.textContent = '';
    btn.disabled = true;
    try {
      const phone = $('#staff-phone').value.trim();
      const password = $('#staff-password').value;
      const data = await api('POST', '/staff/auth/login', { phone, password });
      STAFF_TOKEN = data.token;
      STAFF = data.staff;
      localStorage.setItem('esa_staff_token', STAFF_TOKEN);
      showApp();
      toast('Кош келдиңиз, ' + (STAFF.fullName || '') + '!', 'ok');
    } catch (err) {
      errBox.textContent = err.message || 'Ката кетти';
    } finally {
      btn.disabled = false;
    }
  });

  $('#staff-logout-btn').addEventListener('click', async () => {
    try { await api('POST', '/staff/auth/logout'); } catch (e) {}
    STAFF_TOKEN = '';
    STAFF = null;
    localStorage.removeItem('esa_staff_token');
    showLogin();
  });

  // ---------- nav ----------
  function switchView(name) {
    $all('.side-item[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === name));
    $all('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    if (name === 'dashboard') loadDashboard();
    if (name === 'clients') loadClientsView();
    if (name === 'devices') loadDevicesView();
    if (name === 'offices') loadOfficesView();
    if (name === 'register') { /* nothing to preload */ }
  }
  $all('.side-item[data-view]').forEach(b => {
    b.addEventListener('click', () => switchView(b.dataset.view));
  });

  // ---------- dashboard ----------
  async function loadDashboard() {
    const grid = $('#overview-stats');
    grid.innerHTML = '<div class="empty-hint">Жүктөлүүдө...</div>';
    try {
      const d = await api('GET', '/office/overview');
      grid.innerHTML = `
        <div class="stat-tile"><div class="stat-label">Клиенттер</div><div class="stat-value">${d.totalClients}</div></div>
        <div class="stat-tile"><div class="stat-label">Жалпы калдык (капчыктар)</div><div class="stat-value">${money(d.totalWalletBalance)}</div></div>
        <div class="stat-tile"><div class="stat-label">Активдүү карталар</div><div class="stat-value">${d.totalCards}</div></div>
        <div class="stat-tile"><div class="stat-label">Түзмөктөр (банкомат/терминал)</div><div class="stat-value">${d.totalDevices}</div></div>
        <div class="stat-tile"><div class="stat-label">Бүгүнкү транзакциялар</div><div class="stat-value">${d.todayTxCount}</div><div class="stat-sub">${money(d.todayTxVolume)}</div></div>
      `;
    } catch (e) {
      grid.innerHTML = '<div class="empty-hint">Жүктөй алган жокпуз: ' + (e.message || '') + '</div>';
    }
  }

  // ---------- clients search ----------
  let searchDebounce = null;
  function loadClientsView() {
    $('#client-search-input').value = '';
    $('#client-search-results').innerHTML = '<div class="empty-hint">Издөө үчүн атын, телефонун же паспорт номерин киргизиңиз.</div>';
  }
  $('#client-search-input').addEventListener('input', (e) => {
    clearTimeout(searchDebounce);
    const q = e.target.value.trim();
    if (!q) { $('#client-search-results').innerHTML = '<div class="empty-hint">Издөө үчүн атын, телефонун же паспорт номерин киргизиңиз.</div>'; return; }
    searchDebounce = setTimeout(() => runClientSearch(q), 320);
  });
  async function runClientSearch(q) {
    const box = $('#client-search-results');
    box.innerHTML = '<div class="empty-hint">Издөөдө...</div>';
    try {
      const data = await api('GET', '/office/clients/search?q=' + encodeURIComponent(q));
      if (!data.clients.length) { box.innerHTML = '<div class="empty-hint">Эч нерсе табылган жок.</div>'; return; }
      box.innerHTML = data.clients.map(c => `
        <div class="client-row" data-client-id="${c.id}">
          <div class="client-row-info">
            <b>${escapeHtml(c.fullName)}</b>
            <span>${escapeHtml(c.phoneFormatted)} · ${c.clientId} · ${c.hasKyc ? 'KYC ✓' : 'KYC жок'} · ${c.cardCount} карта</span>
          </div>
          <div>
            <b style="font-size:14px;">${money(c.walletBalance)}</b>
          </div>
        </div>
      `).join('');
      $all('.client-row', box).forEach(row => row.addEventListener('click', () => openClientDetail(row.dataset.clientId)));
    } catch (e) {
      box.innerHTML = '<div class="empty-hint">Ката: ' + (e.message || '') + '</div>';
    }
  }

  async function openClientDetail(id) {
    try {
      const data = await api('GET', '/office/clients/' + id);
      const c = data.client;
      const kyc = c.kyc || {};
      const modal = $('#device-modal');
      $('#device-modal-title').textContent = c.fullName;
      $('#device-modal-body').innerHTML = `
        <div class="device-meta-grid">
          <div class="device-meta-item"><div class="k">Клиент ID</div><div class="v">${c.clientId}</div></div>
          <div class="device-meta-item"><div class="k">Телефон</div><div class="v">${escapeHtml(c.phoneFormatted)}</div></div>
          <div class="device-meta-item"><div class="k">Капчык</div><div class="v">${c.wallet ? money(c.wallet.balance) : '—'}</div></div>
          <div class="device-meta-item"><div class="k">Катталган</div><div class="v" style="font-size:12px;">${fmtDate(c.createdAt)}</div></div>
        </div>
        ${kyc.passportNumber ? `
        <h4>Паспорт маалыматы</h4>
        <div class="device-meta-grid">
          <div class="device-meta-item"><div class="k">Паспорт №</div><div class="v">${escapeHtml(kyc.passportNumber)}</div></div>
          <div class="device-meta-item"><div class="k">Берген</div><div class="v" style="font-size:12.5px;">${escapeHtml(kyc.passportIssuedBy || '—')}</div></div>
          <div class="device-meta-item"><div class="k">Туулган күнү</div><div class="v">${kyc.birthDate || '—'}</div></div>
          <div class="device-meta-item"><div class="k">Дареги</div><div class="v" style="font-size:12.5px;">${escapeHtml(kyc.address || '—')}</div></div>
        </div>
        ${kyc.facePhoto ? `<img src="${kyc.facePhoto}" style="width:100%;border-radius:10px;margin-top:10px;max-height:220px;object-fit:cover;">` : ''}
        ` : '<p style="color:var(--text-dim);font-size:13px;">KYC маалыматы жок.</p>'}
        <h4>Карталар (${c.cards.length})</h4>
        ${c.cards.length ? c.cards.map(cd => `
          <div class="device-meta-item" style="margin-bottom:8px;">
            <div class="k">${CARD_PLAN_LABELS[cd.type] || cd.type} · ${cd.maskedNumber}</div>
            <div class="v">${money(cd.balance)} ${cd.frozen ? '· 🔒 тоңдурулган' : ''}</div>
          </div>
        `).join('') : '<p style="color:var(--text-dim);font-size:13px;">Карта жок.</p>'}
        <h4>Жаңы карта чыгаруу</h4>
        <div class="field">
          <select id="issue-card-type-select">
            <option value="visa">ESA Visa Classic — 500 сом/жыл</option>
            <option value="elkart">ESA Элкарт — 150 сом/жыл</option>
          </select>
        </div>
        <button class="btn btn-primary" id="issue-card-btn" style="width:100%;">Карта чыгаруу</button>
      `;
      modal.classList.add('show');
      $('#issue-card-btn').addEventListener('click', async () => {
        try {
          const type = $('#issue-card-type-select').value;
          await api('POST', `/office/clients/${c.id}/cards`, { type });
          toast('Карта ийгиликтүү чыгарылды!', 'ok');
          modal.classList.remove('show');
          runClientSearch($('#client-search-input').value.trim() || c.clientId);
        } catch (e) { toast(e.message || 'Ката кетти', 'err'); }
      });
    } catch (e) { toast(e.message || 'Ката кетти', 'err'); }
  }

  // ---------- register new client ----------
  $('#form-register-client').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('#register-client-btn');
    const errBox = $('#register-client-error');
    const okBox = $('#register-client-success');
    errBox.textContent = ''; okBox.style.display = 'none';
    if (!regFacePhoto) { errBox.textContent = 'Алгач клиенттин жүзүн сүрөткө тартыңыз.'; return; }
    btn.disabled = true;
    try {
      const payload = {
        fullName: $('#rc-fullname').value.trim(),
        phone: $('#rc-phone').value.trim(),
        password: $('#rc-password').value,
        passportNumber: $('#rc-passport-number').value.trim(),
        passportIssuedBy: $('#rc-passport-issued-by').value.trim(),
        birthDate: $('#rc-birth-date').value,
        address: $('#rc-address').value.trim(),
        facePhoto: regFacePhoto
      };
      const data = await api('POST', '/office/clients/register-passport', payload);
      okBox.style.display = 'block';
      okBox.textContent = `Клиент катталды! ID: ${data.client.clientId}, эсеп: ${data.client.accountNumber}`;
      toast('Жаңы клиент катталды!', 'ok');
      $('#form-register-client').reset();
      resetRegFaceCapture();
    } catch (err) {
      errBox.textContent = err.message || 'Ката кетти';
    } finally {
      btn.disabled = false;
    }
  });

  // ---- face capture (office registration) ----
  async function startRegFaceCamera() {
    try {
      regFaceStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      const video = $('#rc-face-video');
      video.srcObject = regFaceStream;
      video.style.display = 'block';
      $('#rc-face-preview').style.display = 'none';
    } catch (e) {
      $('#rc-face-video').outerHTML = '<div class="camera-unavailable" style="padding:30px;text-align:center;color:var(--text-dim);font-size:13px;">Камера жеткиликсиз. Браузер уруксатын текшериңиз.</div>';
    }
  }
  function stopRegFaceCamera() {
    if (regFaceStream) { regFaceStream.getTracks().forEach(t => t.stop()); regFaceStream = null; }
  }
  function resetRegFaceCapture() {
    regFacePhoto = null;
    $('#rc-face-preview').style.display = 'none';
    $('#rc-face-preview').src = '';
    const video = $('#rc-face-video');
    if (video) video.style.display = 'block';
    $('#rc-face-capture-btn').style.display = 'inline-flex';
    $('#rc-face-retake-btn').style.display = 'none';
    startRegFaceCamera();
  }
  $('#rc-face-capture-btn').addEventListener('click', () => {
    const video = $('#rc-face-video');
    if (!video || !video.videoWidth) { toast('Камера даяр эмес', 'err'); return; }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.translate(canvas.width, 0); ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    regFacePhoto = canvas.toDataURL('image/jpeg', 0.82);
    $('#rc-face-preview').src = regFacePhoto;
    $('#rc-face-preview').style.display = 'block';
    video.style.display = 'none';
    $('#rc-face-capture-btn').style.display = 'none';
    $('#rc-face-retake-btn').style.display = 'inline-flex';
  });
  $('#rc-face-retake-btn').addEventListener('click', resetRegFaceCapture);

  // ---- find existing client by passport (to issue card) ----
  $('#form-find-passport').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errBox = $('#find-passport-error');
    errBox.textContent = '';
    const box = $('#found-client-card');
    box.style.display = 'none';
    try {
      const passportNumber = $('#find-passport-number').value.trim();
      const data = await api('POST', '/office/clients/find-by-passport', { passportNumber });
      const c = data.client;
      box.style.display = 'block';
      box.innerHTML = `
        <h4 style="margin-top:0;">${escapeHtml(c.fullName)}</h4>
        <p style="color:var(--text-dim);font-size:13px;margin:0 0 14px;">${escapeHtml(c.phoneFormatted)} · ${c.clientId}</p>
        <div class="field">
          <label>Картанын түрү</label>
          <select id="found-card-type-select">
            <option value="visa">ESA Visa Classic — 500 сом/жыл</option>
            <option value="elkart">ESA Элкарт — 150 сом/жыл</option>
          </select>
        </div>
        <button class="btn btn-primary" id="found-issue-card-btn" style="width:100%;">Карта чыгаруу</button>
      `;
      $('#found-issue-card-btn').addEventListener('click', async () => {
        try {
          const type = $('#found-card-type-select').value;
          await api('POST', `/office/clients/${c.id}/cards`, { type });
          toast('Карта ийгиликтүү чыгарылды!', 'ok');
        } catch (err) { toast(err.message || 'Ката кетти', 'err'); }
      });
    } catch (err) {
      errBox.textContent = err.message || 'Клиент табылган жок';
    }
  });

  // ---------- devices ----------
  async function loadDevicesView() {
    const box = $('#devices-list');
    box.innerHTML = '<div class="empty-hint">Жүктөлүүдө...</div>';
    try {
      const data = await api('GET', '/office/devices');
      if (!data.devices.length) { box.innerHTML = '<div class="empty-hint">Түзмөк жок. Жаңы түзмөк кошуңуз.</div>'; return; }
      box.innerHTML = data.devices.map(dv => deviceCardHtml(dv)).join('');
      wireDeviceCardButtons();
    } catch (e) { box.innerHTML = '<div class="empty-hint">Ката: ' + (e.message || '') + '</div>'; }
  }
  function deviceCardHtml(dv) {
    const kindLabel = dv.kind === 'atm' ? 'Банкомат' : dv.kind === 'terminal' ? 'Терминал' : 'Банкомат + Терминал';
    const statusPill = dv.status === 'active' ? '<span class="pill pill-green">Активдүү</span>' : '<span class="pill pill-red">Өчүрүлгөн</span>';
    return `
      <div class="device-card" data-device-id="${dv.id}">
        <div class="device-card-head">
          <b>${escapeHtml(dv.label)} <span style="color:var(--text-dim);font-weight:600;font-size:12.5px;">(${dv.deviceCode})</span></b>
          ${statusPill}
        </div>
        <div style="font-size:12.5px;color:var(--text-dim);margin-bottom:6px;">${kindLabel} · ${escapeHtml((dv.location && dv.location.address) || 'Дарек көрсөтүлгөн эмес')}</div>
        <div class="device-meta-grid">
          <div class="device-meta-item"><div class="k">Кассадагы акча</div><div class="v">${money(dv.cashTotal)}</div></div>
          <div class="device-meta-item"><div class="k">Сырсөз</div><div class="v">${dv.passwordHint || '••••'}</div></div>
        </div>
        <div class="device-actions">
          <button class="btn btn-sm btn-secondary" data-act="cash" data-id="${dv.id}">Инкассация</button>
          <button class="btn btn-sm btn-secondary" data-act="history" data-id="${dv.id}">Тарых</button>
          <button class="btn btn-sm ${dv.status === 'active' ? 'btn-danger' : 'btn-primary'}" data-act="toggle" data-id="${dv.id}" data-status="${dv.status}">${dv.status === 'active' ? 'Өчүрүү' : 'Күйгүзүү'}</button>
        </div>
      </div>
    `;
  }
  function wireDeviceCardButtons() {
    $all('[data-act="toggle"]').forEach(btn => btn.addEventListener('click', async () => {
      try {
        const newStatus = btn.dataset.status === 'active' ? 'disabled' : 'active';
        await api('POST', `/office/devices/${btn.dataset.id}/status`, { status: newStatus });
        toast('Абал өзгөртүлдү', 'ok');
        loadDevicesView();
      } catch (e) { toast(e.message || 'Ката', 'err'); }
    }));
    $all('[data-act="cash"]').forEach(btn => btn.addEventListener('click', () => openCashModal(btn.dataset.id)));
    $all('[data-act="history"]').forEach(btn => btn.addEventListener('click', () => openDeviceHistory(btn.dataset.id)));
  }
  const DEVICE_DENOMS = [2000, 1000, 500, 200, 100, 50];
  function openCashModal(id) {
    const modal = $('#device-modal');
    $('#device-modal-title').textContent = 'Инкассация (акча толтуруу)';
    $('#device-modal-body').innerHTML = `
      <p style="color:var(--text-dim);font-size:13px;margin-top:0;">Ар бир номиналдан канча купюра кошуласыз?</p>
      <div class="cash-grid" id="cash-input-grid">
        ${DEVICE_DENOMS.map(d => `
          <div>
            <div style="font-size:11px;color:var(--text-dim);text-align:center;margin-bottom:4px;">${d}</div>
            <input type="number" min="0" value="0" data-denom="${d}" style="width:100%;padding:8px 4px;text-align:center;border-radius:8px;border:1px solid var(--border-subtle);background:var(--navy-900);color:var(--text-light);">
          </div>
        `).join('')}
      </div>
      <button class="btn btn-primary" id="cash-submit-btn" style="width:100%;margin-top:14px;">Толтуруу</button>
    `;
    modal.classList.add('show');
    $('#cash-submit-btn').addEventListener('click', async () => {
      const cash = {};
      $all('#cash-input-grid input').forEach(inp => { cash[inp.dataset.denom] = Number(inp.value) || 0; });
      try {
        await api('POST', `/office/devices/${id}/cash`, { cash });
        toast('Касса толтурулду!', 'ok');
        modal.classList.remove('show');
        loadDevicesView();
      } catch (e) { toast(e.message || 'Ката', 'err'); }
    });
  }
  async function openDeviceHistory(id) {
    const modal = $('#device-modal');
    $('#device-modal-title').textContent = 'Түзмөктүн тарыхы';
    $('#device-modal-body').innerHTML = '<div class="empty-hint">Жүктөлүүдө...</div>';
    modal.classList.add('show');
    try {
      const data = await api('GET', '/office/devices/' + id);
      const receipts = data.receipts || [];
      $('#device-modal-body').innerHTML = `
        <div class="device-meta-grid" style="margin-bottom:16px;">
          <div class="device-meta-item"><div class="k">Жалпы кассадагы акча</div><div class="v">${money(data.device.cashTotal)}</div></div>
          <div class="device-meta-item"><div class="k">Абал</div><div class="v">${data.device.status === 'active' ? 'Активдүү' : 'Өчүрүлгөн'}</div></div>
        </div>
        ${receipts.length ? receipts.slice(0, 30).map(r => `
          <div class="device-meta-item" style="margin-bottom:8px;">
            <div class="k">${r.kind === 'withdraw' ? 'Чыгаруу' : 'Толтуруу'} · ${fmtDate(r.createdAt)}</div>
            <div class="v">${money(r.amount)}</div>
          </div>
        `).join('') : '<div class="empty-hint">Операция жок.</div>'}
      `;
    } catch (e) { $('#device-modal-body').innerHTML = '<div class="empty-hint">Ката: ' + (e.message || '') + '</div>'; }
  }

  $('#open-new-device-btn').addEventListener('click', () => {
    const modal = $('#device-modal');
    $('#device-modal-title').textContent = 'Жаңы түзмөк кошуу';
    $('#device-modal-body').innerHTML = `
      <div class="field">
        <label>Аталышы</label>
        <input type="text" id="nd-label" placeholder="Мис: Борбордук офис АТМ-1">
      </div>
      <div class="field">
        <label>Түрү</label>
        <select id="nd-kind">
          <option value="both">Банкомат + Терминал</option>
          <option value="atm">Банкомат гана</option>
          <option value="terminal">Терминал гана</option>
        </select>
      </div>
      <div class="field">
        <label>Сырсөз (киоскко кирүү үчүн)</label>
        <input type="text" id="nd-password" placeholder="Кеминде 4 белги">
      </div>
      <div class="field">
        <label>Дарек</label>
        <input type="text" id="nd-address" placeholder="Бишкек, ...">
      </div>
      <div class="field-row">
        <div class="field"><label>Lat</label><input type="number" step="0.0001" id="nd-lat" value="42.8746"></div>
        <div class="field"><label>Lng</label><input type="number" step="0.0001" id="nd-lng" value="74.5698"></div>
      </div>
      <div class="field-error" id="nd-error"></div>
      <button class="btn btn-primary" id="nd-submit-btn" style="width:100%;">Кошуу</button>
    `;
    $('#device-modal').classList.add('show');
    $('#nd-submit-btn').addEventListener('click', async () => {
      const errBox = $('#nd-error');
      errBox.textContent = '';
      try {
        await api('POST', '/office/devices', {
          label: $('#nd-label').value.trim(),
          kind: $('#nd-kind').value,
          password: $('#nd-password').value,
          location: { address: $('#nd-address').value.trim(), lat: $('#nd-lat').value, lng: $('#nd-lng').value }
        });
        toast('Түзмөк кошулду!', 'ok');
        $('#device-modal').classList.remove('show');
        loadDevicesView();
      } catch (e) { errBox.textContent = e.message || 'Ката кетти'; }
    });
  });

  // ---------- offices ----------
  async function loadOfficesView() {
    const box = $('#offices-list');
    box.innerHTML = '<div class="empty-hint">Жүктөлүүдө...</div>';
    try {
      const data = await api('GET', '/office/offices');
      if (!data.offices.length) { box.innerHTML = '<div class="empty-hint">Офис кошулган жок.</div>'; return; }
      box.innerHTML = data.offices.map(o => `
        <div class="office-row">
          <b>${escapeHtml(o.name)}</b>
          <span>${escapeHtml(o.address || '')} ${o.phone ? '· ' + escapeHtml(o.phone) : ''} · ${escapeHtml(o.hours || '')}</span>
        </div>
      `).join('');
    } catch (e) { box.innerHTML = '<div class="empty-hint">Ката: ' + (e.message || '') + '</div>'; }
  }
  $('#form-new-office').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('POST', '/office/offices', {
        name: $('#office-name').value.trim(),
        phone: $('#office-phone').value.trim(),
        address: $('#office-address').value.trim(),
        lat: $('#office-lat').value, lng: $('#office-lng').value,
        hours: $('#office-hours').value.trim()
      });
      toast('Офис кошулду!', 'ok');
      $('#form-new-office').reset();
      loadOfficesView();
    } catch (err) { toast(err.message || 'Ката кетти', 'err'); }
  });

  // ---------- modal close ----------
  $all('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => $('#' + btn.dataset.closeModal).classList.remove('show'));
  });
  $all('.modal-overlay').forEach(ov => {
    ov.addEventListener('click', (e) => { if (e.target === ov) ov.classList.remove('show'); });
  });

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------- init ----------
  tryAutoLogin();
  // start camera lazily when register view is first shown
  const origSwitch = switchView;
  document.querySelector('[data-view="register"]').addEventListener('click', () => {
    if (!regFaceStream && !regFacePhoto) startRegFaceCamera();
  });
})();
