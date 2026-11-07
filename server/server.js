'use strict';
/**
 * ESA Bank — backend (чистый Node.js http-сервер без веб-фреймворков;
 * единственные npm-зависимости — tesseract.js и jimp, нужны только для
 * настоящего распознавания купюр камерой терминала, см. billScanner.js).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const storeDb = require('./db/store');
const { hashPassword, verifyPassword, newToken, newId, sixDigitCode } = require('./lib/security');
const {
  normalizePhone, formatPhone, genAccountNumber, genReceiptNo, money,
  genCardNumberSimple, genCvv, cardExpiry, maskCardNumber, genDeviceCode
} = require('./lib/helpers');
const { recognizeBill, recognizeBillConsensus, warmup: warmupOcr, isSameBill } = require('./billScanner');

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
const STAFF_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов — рабочая смена в офисе
const RESET_CODE_TTL_MS = 10 * 60 * 1000; // 10 минут
const STARTING_BALANCE = 0; // новый клиент начинает с пустого кошелька (0 сом), как в реальном банке
const OWNER_DISPLAY_BALANCE = 999999999; // счёт владельца — безлимитный, баланс не уменьшается
const DEVICE_PAIR_TTL_MS = 3 * 60 * 1000; // 3 минуты на то, чтобы подойти к терминалу после сканирования
const DEPOSIT_SESSION_TTL_MS = 60 * 1000; // 60 секунд на сканирование купюр в терминале
const DEPOSIT_MIN_AMOUNT = 0; // минимум пополнения не ограничен — клиент вносит сколько хочет
const WITHDRAW_REQUEST_TTL_MS = 90 * 1000; // 90 секунд клиенту на подтверждение снятия наличных в приложении

// Карточные тарифы ESA Bank (вымышленные, для демо)
const CARD_PLANS = {
  visa: { label: 'ESA Visa Classic', annualFee: 500, currency: 'KGS', network: 'Visa', years: 3 },
  elkart: { label: 'ESA Элкарт', annualFee: 150, currency: 'KGS', network: 'Элкарт', years: 5 }
};
const PIGGY_MODES = ['manual', 'daily', 'weekly', 'monthly'];
const DEVICE_DENOMS = [2000, 1000, 500, 200, 100, 50];

// Категории операций — используются для разбивки "месячные траты" на экране статистики
const CATEGORIES = ['food', 'transport', 'bills', 'entertainment', 'shopping', 'health', 'other'];
function normalizeCategory(c) {
  return CATEGORIES.includes(c) ? c : 'other';
}

// ---------- Курсы валют (реальные, с внешнего источника + кэш + запасные значения) ----------
// Источник: open.er-api.com — бесплатный публичный API, ключ не нужен.
// Если сервер не может достучаться до интернета (нет сети, таймаут), отдаём
// последние известные значения, а если их тоже нет — разумные запасные цифры,
// чтобы экран курсов никогда не был пустым.
let ratesCache = { at: 0, base: null };
const RATES_TTL_MS = 60 * 60 * 1000; // обновляем раз в час
const FALLBACK_USD_RATES = { USD: 1, KGS: 87.3, EUR: 0.93, KZT: 522, UZS: 12950, RUB: 97.5, CNY: 7.1, GBP: 0.78 };

function fetchJson(url, timeoutMs = 7000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'User-Agent': 'ESA-Bank/1.0' } }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

async function getUsdRates() {
  const now = Date.now();
  if (ratesCache.base && (now - ratesCache.at) < RATES_TTL_MS) {
    return { rates: ratesCache.base, live: ratesCache.live, fetchedAt: ratesCache.at };
  }
  try {
    const json = await fetchJson('https://open.er-api.com/v6/latest/USD');
    if (json && json.result === 'success' && json.rates && json.rates.KGS) {
      ratesCache = { at: now, base: json.rates, live: true };
      // сохраняем в базу как запасной вариант на случай перезапуска без интернета
      const d = db();
      d.meta.lastRates = { rates: json.rates, at: now };
      storeDb.save();
      return { rates: json.rates, live: true, fetchedAt: now };
    }
    throw new Error('bad payload');
  } catch (err) {
    const d = db();
    const saved = d.meta.lastRates;
    if (saved && saved.rates) {
      ratesCache = { at: ratesCache.at, base: saved.rates, live: false };
      return { rates: saved.rates, live: false, fetchedAt: saved.at };
    }
    ratesCache = { at: ratesCache.at, base: FALLBACK_USD_RATES, live: false };
    return { rates: FALLBACK_USD_RATES, live: false, fetchedAt: 0 };
  }
}

// Строим таблицу курсов относительно сома (KGS), с небольшим банковским
// спредом покупки/продажи — как в реальном обменном окне банка.
async function buildRatesTable() {
  const { rates, live, fetchedAt } = await getUsdRates();
  const kgsPerUsd = rates.KGS;
  const codes = [
    { code: 'USD', name: 'US Dollar' },
    { code: 'EUR', name: 'Euro' },
    { code: 'RUB', name: 'Russian Ruble' },
    { code: 'KZT', name: 'Kazakhstani Tenge' },
    { code: 'UZS', name: 'Uzbekistani Som' },
    { code: 'CNY', name: 'Chinese Yuan' }
  ];
  const table = codes.map(({ code, name }) => {
    const perUsd = code === 'USD' ? 1 : rates[code]; // базовая валюта API (USD) может отсутствовать в самом списке rates
    if (!perUsd) return null;
    const mid = kgsPerUsd / perUsd; // сколько сомов стоит 1 единица валюты code
    const spread = 0.006; // 0.6% спред — типично для обменного окна банка
    return {
      code, name,
      buy: money(mid * (1 - spread)),
      sell: money(mid * (1 + spread)),
      mid: money(mid)
    };
  }).filter(Boolean);
  return { table, live, fetchedAt };
}

// index.html и остальной фронтенд лежат в корне проекта (на уровень выше
// папки server/), чтобы при открытии репозитория сайт был виден сразу,
// а не спрятан в подпапке. Серверный код и база данных (db/) остаются
// внутри server/ и никогда не публикуются как статические файлы — это
// отдельная функция serveStatic ниже, которая раздаёт файлы только из
// WEB_ROOT и явно отказывает в доступе к папке server/.
const WEB_ROOT = path.join(__dirname, '..');
const DENYLIST_PREFIXES = ['server', '.git', 'node_modules', '.env'];

// ---------- Вспомогательные функции работы с БД ----------

function db() { return storeDb.get(); }

// Чыныгы билдирмелер (колокольчик) — ойдон чыгарылбайт, так чыныгы окуялар
// болгондо гана түзүлөт: акча келгенде, терминалдан толукталганда,
// банкоматтан акча алуу талап кылынганда/жыйынтыкталганда.
function addNotification(userId, type, title, body, data) {
  if (!userId) return;
  const notif = {
    id: newId(), userId, type, title, body, data: data || null,
    read: false, createdAt: new Date().toISOString()
  };
  db().notifications.push(notif);
  return notif;
}

function findUserByPhone(phone) {
  return db().users.find(u => u.phone === phone);
}
function findUserById(id) {
  return db().users.find(u => u.id === id);
}
function findAccountByUserId(userId) {
  return db().accounts.find(a => a.userId === userId);
}
function findAccountById(id) {
  return db().accounts.find(a => a.id === id);
}

function createUserWithAccount({ fullName, phone, password }) {
  const d = db();
  const { hash, salt } = hashPassword(password);
  const clientId = d.meta.nextClientId++;
  const user = {
    id: newId(),
    clientId,
    fullName: fullName.trim(),
    phone,
    passwordHash: hash,
    passwordSalt: salt,
    createdAt: new Date().toISOString()
  };
  const account = {
    id: newId(),
    userId: user.id,
    accountNumber: genAccountNumber(clientId),
    balance: STARTING_BALANCE,
    currency: 'KGS',
    createdAt: new Date().toISOString()
  };
  d.users.push(user);
  d.accounts.push(account);
  storeDb.save();
  return { user, account };
}

function createSession(userId) {
  const token = newToken();
  db().sessions.push({
    token,
    userId,
    createdAt: new Date().toISOString(),
    expiresAt: Date.now() + SESSION_TTL_MS
  });
  storeDb.save();
  return token;
}

function getSession(token) {
  const s = db().sessions.find(s => s.token === token);
  if (!s) return null;
  if (s.expiresAt < Date.now()) return null;
  return s;
}

function destroySession(token) {
  const d = db();
  const idx = d.sessions.findIndex(s => s.token === token);
  if (idx >= 0) {
    d.sessions.splice(idx, 1);
    storeDb.save();
  }
}

function publicUser(user, account) {
  return {
    id: user.id,
    clientId: user.clientId,
    fullName: user.fullName,
    phone: user.phone,
    phoneFormatted: formatPhone(user.phone),
    account: account ? {
      id: account.id,
      accountNumber: account.accountNumber,
      balance: money(account.balance),
      currency: account.currency,
      isOwner: !!account.isOwner
    } : null
  };
}

// QR-код кодирует простую строку вида ESA|<accountId>|<clientId>, закодированную в base64url.
function makeQrPayload(account, user) {
  const raw = `ESA|${account.id}|${user.clientId}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}
function parseQrPayload(payload) {
  try {
    const raw = Buffer.from(String(payload), 'base64url').toString('utf8');
    const parts = raw.split('|');
    if (parts.length !== 3 || parts[0] !== 'ESA') return null;
    return { accountId: parts[1], clientId: Number(parts[2]) };
  } catch (_) {
    return null;
  }
}

// QR терминала/банкомата: ESA-DEVICE|<deviceCode>|<pairToken>
function makeDevicePairPayload(device) {
  const raw = `ESA-DEVICE|${device.deviceCode}|${device.pairToken}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}
function parseDevicePairPayload(payload) {
  try {
    const raw = Buffer.from(String(payload), 'base64url').toString('utf8');
    const parts = raw.split('|');
    if (parts.length !== 3 || parts[0] !== 'ESA-DEVICE') return null;
    return { deviceCode: parts[1], pairToken: parts[2] };
  } catch (_) {
    return null;
  }
}

// ---------- Карты ----------
function findCardsByUserId(userId) {
  return db().cards.filter(c => c.userId === userId && c.status !== 'closed');
}
function findCardById(id) {
  return db().cards.find(c => c.id === id);
}
function publicCard(card) {
  return {
    id: card.id,
    type: card.type,
    label: CARD_PLANS[card.type] ? CARD_PLANS[card.type].label : 'ESA Card',
    network: CARD_PLANS[card.type] ? CARD_PLANS[card.type].network : '',
    number: card.number,
    masked: maskCardNumber(card.number),
    holderName: card.holderName,
    expiry: card.expiry,
    cvv: card.cvv,
    nickname: card.nickname,
    themeId: card.themeId,
    balance: money(card.balance),
    annualFee: card.annualFee,
    feeDueAt: card.feeDueAt,
    status: card.status,
    createdAt: card.createdAt
  };
}
function issueCard(userId, { type, themeId, nickname }) {
  const plan = CARD_PLANS[type] || CARD_PLANS.visa;
  const user = findUserById(userId);
  const d = db();
  const card = {
    id: newId(),
    userId,
    type: CARD_PLANS[type] ? type : 'visa',
    number: genCardNumberSimple(type),
    holderName: (user.fullName || '').toUpperCase(),
    expiry: cardExpiry(plan.years),
    cvv: genCvv(),
    themeId: themeId || 'emerald',
    nickname: (nickname || plan.label).slice(0, 40),
    balance: 0, // открытие карты не создаёт новых денег — пополняется из кошелька
    annualFee: plan.annualFee,
    feeDueAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
    status: 'active',
    createdAt: new Date().toISOString()
  };
  d.cards.push(card);
  storeDb.save();
  return card;
}

// Ежегодное списание за обслуживание карты — проверяется лениво (без
// настоящего cron-а) при каждом входе пользователя в приложение.
function chargeDueCardFees(userId) {
  const d = db();
  const account = findAccountByUserId(userId);
  if (!account) return;
  const now = Date.now();
  findCardsByUserId(userId).forEach(card => {
    if (card.status !== 'active') return;
    if (!card.annualFee || card.annualFee <= 0) return;
    let dueAt = new Date(card.feeDueAt).getTime();
    let guard = 0;
    while (dueAt <= now && guard < 5) {
      guard++;
      if (account.isOwner || account.balance >= card.annualFee) {
        if (!account.isOwner) account.balance = money(account.balance - card.annualFee);
        d.transactions.push({
          id: newId(), kind: 'card_fee',
          fromAccountId: account.id, toAccountId: null,
          fromCardId: null, toCardId: card.id,
          userId,
          fromName: findUserById(userId).fullName, toName: `${card.nickname} — жыл сайынкы тейлөө`,
          amount: card.annualFee, currency: 'KGS', method: 'card_fee',
          note: 'Картаны тейлөө үчүн жыл сайынкы төлөм', category: 'bills',
          status: 'success', receiptNo: genReceiptNo(), createdAt: new Date().toISOString()
        });
      }
      dueAt += 365 * 24 * 60 * 60 * 1000;
    }
    card.feeDueAt = new Date(dueAt).toISOString();
  });
  storeDb.save();
}

// ---------- Копилки ----------
function findPiggyByUserId(userId) {
  return db().piggyBanks.filter(p => p.userId === userId);
}
function publicPiggy(p) {
  return {
    id: p.id, name: p.name, icon: p.icon || 'piggy',
    targetAmount: p.targetAmount, balance: money(p.balance),
    mode: p.mode, autoAmount: p.autoAmount, createdAt: p.createdAt
  };
}
function runPiggyAutoDeposits(userId) {
  const d = db();
  const account = findAccountByUserId(userId);
  if (!account || account.isOwner) return;
  const now = Date.now();
  const stepMs = { daily: 24*60*60*1000, weekly: 7*24*60*60*1000, monthly: 30*24*60*60*1000 };
  findPiggyByUserId(userId).forEach(p => {
    if (p.mode === 'manual' || !p.autoAmount) return;
    const step = stepMs[p.mode];
    if (!step) return;
    let last = new Date(p.lastAutoAt || p.createdAt).getTime();
    let guard = 0;
    while (now - last >= step && guard < 30) {
      guard++;
      if (account.balance < p.autoAmount) break; // недостаточно средств — пропускаем автопополнение
      account.balance = money(account.balance - p.autoAmount);
      p.balance = money(p.balance + p.autoAmount);
      d.transactions.push({
        id: newId(), kind: 'piggy_deposit',
        fromAccountId: account.id, toAccountId: null, piggyId: p.id, userId,
        fromName: findUserById(userId).fullName, toName: `Копилка «${p.name}»`,
        amount: p.autoAmount, currency: 'KGS', method: 'piggy_auto',
        note: 'Автопополнение копилки', category: 'other',
        status: 'success', receiptNo: genReceiptNo(), createdAt: new Date().toISOString()
      });
      last += step;
    }
    p.lastAutoAt = new Date(last).toISOString();
  });
  storeDb.save();
}

// ---------- Сотрудники / офис ----------
function findStaffByPhone(phone) {
  return db().staff.find(s => s.phone === phone);
}
function findStaffById(id) {
  return db().staff.find(s => s.id === id);
}
function createStaffSession(staffId) {
  const token = newToken();
  db().staffSessions.push({ token, staffId, createdAt: new Date().toISOString(), expiresAt: Date.now() + STAFF_SESSION_TTL_MS });
  storeDb.save();
  return token;
}
function getStaffAuthUser(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const s = db().staffSessions.find(s => s.token === match[1]);
  if (!s || s.expiresAt < Date.now()) return null;
  return findStaffById(s.staffId);
}
function publicStaff(staff) {
  return { id: staff.id, fullName: staff.fullName, role: staff.role, phone: staff.phone, phoneFormatted: formatPhone(staff.phone) };
}

// ---------- Устройства (банкомат + терминал) ----------
function findDeviceByCode(code) {
  return db().devices.find(d => d.deviceCode === code);
}
function findDeviceById(id) {
  return db().devices.find(d => d.id === id);
}
function publicDevice(device, { withCash } = {}) {
  const out = {
    id: device.id, deviceCode: device.deviceCode, kind: device.kind, label: device.label,
    location: device.location, status: device.status, createdAt: device.createdAt
  };
  if (withCash) out.cash = device.cash;
  return out;
}
function deviceCashTotal(device) {
  return Object.entries(device.cash || {}).reduce((sum, [denom, count]) => sum + Number(denom) * count, 0);
}
// Жадный разбор суммы на доступные в устройстве купюры. Возвращает null, если
// устройство физически не может выдать точную сумму имеющимися номиналами.
function breakdownCash(cash, amount) {
  const denoms = DEVICE_DENOMS.slice().sort((a, b) => b - a);
  const used = {};
  let remaining = amount;
  for (const denom of denoms) {
    const available = cash[denom] || 0;
    const want = Math.min(available, Math.floor(remaining / denom));
    if (want > 0) { used[denom] = want; remaining -= want * denom; }
  }
  if (remaining !== 0) return null;
  return used;
}

// ---------- HTTP-утилиты ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req, maxSize) {
  const limit = maxSize || 1e6;
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Payload too large')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function getAuthUser(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const session = getSession(match[1]);
  if (!session) return null;
  const user = findUserById(session.userId);
  if (!user) return null;
  return user;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// ESA Bank — это теперь 4 сайта на одном сервере: клиентское приложение
// (корень "/"), офис банка ("/office/"), банкомат+терминал ("/terminal/")
// и публичный сайт банка ("/about/"). Каждый — своя отдельная SPA, поэтому
// у каждого корня собственный "мягкий" 404-фолбэк на СВОЙ index.html, а не
// на index.html другого сайта.
const SITE_ROOTS = ['office', 'terminal', 'about'];

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');

  // Жёсткий запрет: никогда не отдавать содержимое server/ (там исходный
  // код бэкенда и файл базы данных с хэшами паролей и токенами сессий).
  const firstSegment = filePath.replace(/^[/\\]+/, '').split(/[/\\]/)[0];
  if (DENYLIST_PREFIXES.includes(firstSegment)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  const isKnownSiteRoot = SITE_ROOTS.includes(firstSegment);
  const fallbackPath = isKnownSiteRoot ? `/${firstSegment}/index.html` : '/index.html';

  function attempt(fp, triedIndexAppend) {
    const fullPath = path.join(WEB_ROOT, fp);
    if (!fullPath.startsWith(WEB_ROOT)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    fs.readFile(fullPath, (err, data) => {
      if (err) {
        // "/office" (без слэша) или директория без явного файла -> пробуем .../index.html один раз
        if (!triedIndexAppend) {
          const withIndex = fp.replace(/\/+$/, '') + '/index.html';
          return attempt(withIndex, true);
        }
        // Ничего не нашли — мягкий фолбэк на index.html ТОГО ЖЕ сайта (SPA-роутинг)
        if (fp === fallbackPath) { res.writeHead(404); res.end('Not found'); return; }
        fs.readFile(path.join(WEB_ROOT, fallbackPath), (err2, data2) => {
          if (err2) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': MIME['.html'] });
          res.end(data2);
        });
        return;
      }
      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
      res.end(data);
    });
  }
  attempt(filePath, false);
}

// ---------- API-роуты ----------

const routes = [];
function route(method, pattern, handler) {
  // Поддержка параметров вида /api/office/devices/:id
  const paramNames = [];
  const regex = new RegExp('^' + pattern.replace(/:[a-zA-Z0-9_]+/g, (m) => {
    paramNames.push(m.slice(1));
    return '([^/]+)';
  }) + '$');
  routes.push({ method, pattern, regex, paramNames, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.paramNames.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
    return { handler: r.handler, params };
  }
  return null;
}

// --- Регистрация ---
// Регистрация в приложении — теперь, как в настоящем банке, требует
// паспортные данные и снимок лица (как при открытии счёта в офисе), а не
// только имя и телефон.
route('POST', '/api/auth/register', async (req, res) => {
  const body = await readJsonBody(req);
  const fullName = (body.fullName || '').trim();
  const phone = normalizePhone(body.phone);
  const password = body.password || '';
  const passportNumber = (body.passportNumber || '').trim();
  const birthDate = body.birthDate || '';
  const facePhoto = body.facePhoto || null;

  if (fullName.length < 2) return sendJson(res, 400, { error: 'Толук атыңызды туура киргизиңиз (Укажите корректное имя).' });
  if (phone.length !== 12) return sendJson(res, 400, { error: 'Телефон номерин туура киргизиңиз (Укажите корректный номер телефона).' });
  if (password.length < 6) return sendJson(res, 400, { error: 'Купуя сөз кеминде 6 белгиден турушу керек (Пароль должен быть не короче 6 символов).' });
  if (!passportNumber) return sendJson(res, 400, { error: 'Паспорттун номерин киргизиңиз (Укажите номер паспорта).' });
  if (!birthDate) return sendJson(res, 400, { error: 'Туулган күнүңүздү киргизиңиз (Укажите дату рождения).' });
  if (!facePhoto) return sendJson(res, 400, { error: 'Жүзүңүздүн сүрөтүн тартыңыз (Сделайте фото лица).' });
  if (findUserByPhone(phone)) return sendJson(res, 409, { error: 'Бул номер менен колдонуучу буга чейин катталган (Этот номер уже зарегистрирован).' });
  if (db().users.some(u => u.kyc && u.kyc.passportNumber === passportNumber)) {
    return sendJson(res, 409, { error: 'Бул паспорт менен колдонуучу буга чейин катталган (Клиент с этим паспортом уже зарегистрирован).' });
  }

  const { user, account } = createUserWithAccount({ fullName, phone, password });
  user.kyc = {
    passportNumber,
    passportIssuedBy: (body.passportIssuedBy || '').trim(),
    passportIssuedAt: body.passportIssuedAt || null,
    birthDate,
    address: (body.address || '').trim(),
    facePhoto,
    verifiedByStaffId: null, // самостоятельная регистрация через приложение
    verifiedAt: new Date().toISOString()
  };
  storeDb.save();
  const token = createSession(user.id);
  sendJson(res, 201, { token, user: publicUser(user, account) });
});

// --- Вход ---
route('POST', '/api/auth/login', async (req, res) => {
  const body = await readJsonBody(req);
  const phone = normalizePhone(body.phone);
  const password = body.password || '';

  const user = findUserByPhone(phone);
  if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
    return sendJson(res, 401, { error: 'Телефон же сырсөз туура эмес (Неверный телефон или пароль).' });
  }
  const account = findAccountByUserId(user.id);
  const token = createSession(user.id);
  sendJson(res, 200, { token, user: publicUser(user, account) });
});

// --- Выход ---
route('POST', '/api/auth/logout', async (req, res) => {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) destroySession(match[1]);
  sendJson(res, 200, { ok: true });
});

// --- Забыли пароль: запрос кода ---
route('POST', '/api/auth/forgot-password', async (req, res) => {
  const body = await readJsonBody(req);
  const phone = normalizePhone(body.phone);
  const user = findUserByPhone(phone);
  if (!user) return sendJson(res, 404, { error: 'Бул номер менен колдонуучу табылган жок (Пользователь с таким номером не найден).' });

  const code = sixDigitCode();
  const d = db();
  d.resetCodes = d.resetCodes.filter(r => r.phone !== phone); // удаляем старые коды
  d.resetCodes.push({ phone, code, expiresAt: Date.now() + RESET_CODE_TTL_MS, used: false });
  storeDb.save();

  // В проекте нет подключённого SMS-шлюза (платная услуга, нужен отдельный
  // провайдер и номер отправителя). Поэтому в демо-режиме код возвращается
  // прямо в ответе API, и экран входа честно показывает пользователю,
  // что это демо-код — подделкой/обманом это не является.
  sendJson(res, 200, { ok: true, demoCode: code, expiresInSec: RESET_CODE_TTL_MS / 1000 });
});

// --- Забыли пароль: подтверждение кода + новый пароль ---
route('POST', '/api/auth/reset-password', async (req, res) => {
  const body = await readJsonBody(req);
  const phone = normalizePhone(body.phone);
  const code = String(body.code || '').trim();
  const newPassword = body.newPassword || '';

  if (newPassword.length < 6) return sendJson(res, 400, { error: 'Жаңы сырсөз кеминде 6 белгиден турушу керек (Новый пароль должен быть не короче 6 символов).' });

  const d = db();
  const entry = d.resetCodes.find(r => r.phone === phone && r.code === code && !r.used);
  if (!entry) return sendJson(res, 400, { error: 'Код туура эмес же мөөнөтү өткөн (Код неверен или истёк).' });
  if (entry.expiresAt < Date.now()) return sendJson(res, 400, { error: 'Коддун мөөнөтү өттү, кайра сураңыз (Срок действия кода истёк, запросите новый).' });

  const user = findUserByPhone(phone);
  if (!user) return sendJson(res, 404, { error: 'Колдонуучу табылган жок (Пользователь не найден).' });

  const { hash, salt } = hashPassword(newPassword);
  user.passwordHash = hash;
  user.passwordSalt = salt;
  entry.used = true;
  // Разлогиниваем все старые сессии этого пользователя из соображений безопасности
  d.sessions = d.sessions.filter(s => s.userId !== user.id);
  storeDb.save();

  sendJson(res, 200, { ok: true });
});

// --- Текущий пользователь ---
route('GET', '/api/me', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла). Кайра киргиле.' });
  chargeDueCardFees(user.id);
  runPiggyAutoDeposits(user.id);
  const account = findAccountByUserId(user.id);
  sendJson(res, 200, { user: publicUser(user, account) });
});

// --- Мой QR-код для получения перевода ---
route('GET', '/api/qr/my', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const account = findAccountByUserId(user.id);
  const payload = makeQrPayload(account, user);
  sendJson(res, 200, { payload, fullName: user.fullName, clientId: user.clientId, accountNumber: account.accountNumber });
});

// --- Расшифровка QR-кода (безопасный просмотр получателя, без списания денег) ---
route('POST', '/api/qr/resolve', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const parsed = parseQrPayload(body.payload);
  if (!parsed) return sendJson(res, 400, { error: 'QR-код жараксыз (Недействительный QR-код).' });

  const toAccount = findAccountById(parsed.accountId);
  if (!toAccount) return sendJson(res, 404, { error: 'QR-коддогу эсеп табылган жок (Счёт из QR-кода не найден).' });
  const toUser = findUserById(toAccount.userId);
  if (!toUser || toUser.clientId !== parsed.clientId) return sendJson(res, 400, { error: 'QR-код жараксыз (Недействительный QR-код).' });
  if (toUser.id === user.id) return sendJson(res, 400, { error: 'Өзүңүздүн QR кодуңузду скандай албайсыз (Нельзя сканировать свой же QR-код).' });

  sendJson(res, 200, { fullName: toUser.fullName, clientId: toUser.clientId });
});

// --- Поиск получателя по телефону (для экрана перевода, показать имя до подтверждения) ---
route('POST', '/api/transfer/lookup-phone', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const phone = normalizePhone(body.phone);
  const target = findUserByPhone(phone);
  if (!target) return sendJson(res, 404, { error: 'Мындай номер менен ESA Bank колдонуучусу жок (Клиент ESA Bank с таким номером не найден).' });
  if (target.id === user.id) return sendJson(res, 400, { error: 'Өзүңүзгө которо албайсыз (Нельзя перевести самому себе).' });
  sendJson(res, 200, { fullName: target.fullName, clientId: target.clientId, phoneFormatted: formatPhone(target.phone) });
});

// --- Перевод по номеру телефона ---
route('POST', '/api/transfer/phone', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const phone = normalizePhone(body.phone);
  const amount = money(body.amount);
  const note = (body.note || '').trim().slice(0, 140);
  const category = normalizeCategory(body.category);

  if (!amount || amount <= 0) return sendJson(res, 400, { error: 'Сумманы туура киргизиңиз (Укажите корректную сумму).' });

  const target = findUserByPhone(phone);
  if (!target) return sendJson(res, 404, { error: 'Мындай номер менен ESA Bank колдонуучусу жок (Клиент ESA Bank с таким номером не найден).' });
  if (target.id === user.id) return sendJson(res, 400, { error: 'Өзүңүзгө которо албайсыз (Нельзя перевести самому себе).' });

  const fromAccount = findAccountByUserId(user.id);
  const toAccount = findAccountByUserId(target.id);
  if (!fromAccount.isOwner && fromAccount.balance < amount) {
    return sendJson(res, 400, { error: 'Эсепте каражат жетишсиз (Недостаточно средств на счёте).' });
  }

  const result = executeTransfer({
    fromAccount, toAccount,
    fromUser: user, toUser: target,
    amount, method: 'phone', note, category
  });
  sendJson(res, 200, result);
});

// --- Перевод по QR-коду ---
route('POST', '/api/transfer/qr', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const amount = money(body.amount);
  const note = (body.note || '').trim().slice(0, 140);
  const category = normalizeCategory(body.category);
  const payload = body.payload;

  if (!amount || amount <= 0) return sendJson(res, 400, { error: 'Сумманы туура киргизиңиз (Укажите корректную сумму).' });

  const parsed = parseQrPayload(payload);
  if (!parsed) return sendJson(res, 400, { error: 'QR-код жараксыз (Недействительный QR-код).' });

  const toAccount = findAccountById(parsed.accountId);
  if (!toAccount) return sendJson(res, 404, { error: 'QR-коддогу эсеп табылган жок (Счёт из QR-кода не найден).' });
  const toUser = findUserById(toAccount.userId);
  if (!toUser || toUser.clientId !== parsed.clientId) return sendJson(res, 400, { error: 'QR-код жараксыз (Недействительный QR-код).' });
  if (toUser.id === user.id) return sendJson(res, 400, { error: 'Өзүңүзгө которо албайсыз (Нельзя перевести самому себе).' });

  const fromAccount = findAccountByUserId(user.id);
  if (!fromAccount.isOwner && fromAccount.balance < amount) {
    return sendJson(res, 400, { error: 'Эсепте каражат жетишсиз (Недостаточно средств на счёте).' });
  }

  const result = executeTransfer({
    fromAccount, toAccount,
    fromUser: user, toUser,
    amount, method: 'qr', note, category
  });
  sendJson(res, 200, result);
});

function executeTransfer({ fromAccount, toAccount, fromUser, toUser, amount, method, note, category }) {
  // Счёт владельца банка — эмитент средств: баланс никогда не уменьшается.
  if (!fromAccount.isOwner) {
    fromAccount.balance = money(fromAccount.balance - amount);
  }
  // Если получатель — тоже владелец (как исключение), его баланс остаётся
  // фиксированным, а не растёт до абсурдных значений.
  if (!toAccount.isOwner) {
    toAccount.balance = money(toAccount.balance + amount);
  }

  const tx = {
    id: newId(),
    fromAccountId: fromAccount.id,
    toAccountId: toAccount.id,
    fromName: fromUser.fullName,
    toName: toUser.fullName,
    fromClientId: fromUser.clientId,
    toClientId: toUser.clientId,
    fromPhone: fromUser.phone,
    toPhone: toUser.phone,
    amount,
    currency: 'KGS',
    method, // 'phone' | 'qr'
    note,
    category: normalizeCategory(category),
    status: 'success',
    receiptNo: genReceiptNo(),
    createdAt: new Date().toISOString()
  };
  db().transactions.push(tx);
  if (!toAccount.isOwner) {
    addNotification(toUser.id, 'transfer_in',
      'Которуу келди (Поступил перевод)',
      `${fromUser.fullName}: +${amount.toLocaleString('ru-RU')} сом`,
      { receiptNo: tx.receiptNo, amount, fromName: fromUser.fullName });
  }
  storeDb.save();

  return {
    ok: true,
    transaction: tx,
    newBalance: money(fromAccount.balance)
  };
}

// =======================================================================
//  КАРТЫ
// =======================================================================

// --- Тарифы на карты (для экрана открытия карты) ---
route('GET', '/api/cards/plans', async (req, res) => {
  sendJson(res, 200, { plans: Object.entries(CARD_PLANS).map(([type, p]) => ({ type, ...p })) });
});

// --- Мои карты ---
route('GET', '/api/cards', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  chargeDueCardFees(user.id);
  sendJson(res, 200, { cards: findCardsByUserId(user.id).map(publicCard) });
});

// --- Открыть новую карту (сам клиент, из приложения) ---
route('POST', '/api/cards', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const type = CARD_PLANS[body.type] ? body.type : null;
  if (!type) return sendJson(res, 400, { error: 'Картанын түрүн тандаңыз: Visa же Элкарт (Выберите тип карты: Visa или Элкарт).' });
  const existing = findCardsByUserId(user.id).filter(c => c.type === type);
  if (existing.length >= 3) return sendJson(res, 400, { error: 'Бул түрдөгү карталардын саны чектелген (Достигнут лимит карт этого типа).' });
  const card = issueCard(user.id, { type, themeId: body.themeId, nickname: body.nickname });
  sendJson(res, 201, { card: publicCard(card) });
});

function requireOwnCard(user, id) {
  const card = findCardById(id);
  if (!card || card.userId !== user.id || card.status === 'closed') return null;
  return card;
}

route('POST', '/api/cards/:id/toggle-freeze', async (req, res, params) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const card = requireOwnCard(user, params.id);
  if (!card) return sendJson(res, 404, { error: 'Карта табылган жок (Карта не найдена).' });
  card.status = card.status === 'frozen' ? 'active' : 'frozen';
  storeDb.save();
  sendJson(res, 200, { card: publicCard(card) });
});

route('POST', '/api/cards/:id/close', async (req, res, params) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const card = requireOwnCard(user, params.id);
  if (!card) return sendJson(res, 404, { error: 'Карта табылган жок (Карта не найдена).' });
  if (card.balance > 0) {
    const account = findAccountByUserId(user.id);
    if (!account.isOwner) account.balance = money(account.balance + card.balance);
    card.balance = 0;
  }
  card.status = 'closed';
  storeDb.save();
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/cards/:id/rename', async (req, res, params) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const card = requireOwnCard(user, params.id);
  if (!card) return sendJson(res, 404, { error: 'Карта табылган жок (Карта не найдена).' });
  const body = await readJsonBody(req);
  const name = (body.nickname || '').trim().slice(0, 40);
  if (!name) return sendJson(res, 400, { error: 'Атын киргизиңиз (Укажите название).' });
  card.nickname = name;
  storeDb.save();
  sendJson(res, 200, { card: publicCard(card) });
});

route('POST', '/api/cards/:id/theme', async (req, res, params) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const card = requireOwnCard(user, params.id);
  if (!card) return sendJson(res, 404, { error: 'Карта табылган жок (Карта не найдена).' });
  const body = await readJsonBody(req);
  card.themeId = (body.themeId || 'emerald').slice(0, 30);
  storeDb.save();
  sendJson(res, 200, { card: publicCard(card) });
});

// --- Внутренний перевод: кошелёк <-> своя карта ---
route('POST', '/api/transfer/internal', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const amount = money(body.amount);
  const fromType = body.fromType, toType = body.toType; // 'wallet' | 'card'
  if (!amount || amount <= 0) return sendJson(res, 400, { error: 'Сумманы туура киргизиңиз (Укажите корректную сумму).' });
  if (fromType === toType) return sendJson(res, 400, { error: 'Бир эле эсепке которо албайсыз (Нельзя перевести на тот же счёт).' });

  const account = findAccountByUserId(user.id);
  let fromLabel, toLabel, fromCard = null, toCard = null;

  if (fromType === 'card') {
    fromCard = requireOwnCard(user, body.fromId);
    if (!fromCard) return sendJson(res, 404, { error: 'Карта табылган жок (Карта не найдена).' });
    if (fromCard.status === 'frozen') return sendJson(res, 400, { error: 'Карта бөгөттөлгөн (Карта заморожена).' });
    if (fromCard.balance < amount) return sendJson(res, 400, { error: 'Картада каражат жетишсиз (Недостаточно средств на карте).' });
    fromLabel = fromCard.nickname;
  } else {
    if (!account.isOwner && account.balance < amount) return sendJson(res, 400, { error: 'Капчыкта каражат жетишсиз (Недостаточно средств на кошельке).' });
    fromLabel = 'Электрондук капчык';
  }

  if (toType === 'card') {
    toCard = requireOwnCard(user, body.toId);
    if (!toCard) return sendJson(res, 404, { error: 'Карта табылган жок (Карта не найдена).' });
    if (toCard.status === 'frozen') return sendJson(res, 400, { error: 'Карта бөгөттөлгөн (Карта заморожена).' });
    toLabel = toCard.nickname;
  } else {
    toLabel = 'Электрондук капчык';
  }

  if (fromCard) fromCard.balance = money(fromCard.balance - amount); else if (!account.isOwner) account.balance = money(account.balance - amount);
  if (toCard) toCard.balance = money(toCard.balance + amount); else account.balance = money(account.balance + amount);

  const tx = {
    id: newId(), kind: 'internal', userId: user.id,
    fromAccountId: fromType === 'wallet' ? account.id : null,
    toAccountId: toType === 'wallet' ? account.id : null,
    fromCardId: fromCard ? fromCard.id : null,
    toCardId: toCard ? toCard.id : null,
    fromName: fromLabel, toName: toLabel,
    amount, currency: 'KGS', method: 'internal', note: body.note || '',
    category: 'other', status: 'success', receiptNo: genReceiptNo(), createdAt: new Date().toISOString()
  };
  db().transactions.push(tx);
  storeDb.save();
  sendJson(res, 200, {
    ok: true, transaction: tx,
    walletBalance: money(account.balance),
    cards: findCardsByUserId(user.id).map(publicCard)
  });
});

// =======================================================================
//  КОНТАКТЫ
// =======================================================================

// --- Какие из телефонных номеров контактов являются клиентами ESA Bank ---
route('POST', '/api/clients/match-phones', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const phones = Array.isArray(body.phones) ? body.phones.slice(0, 1000) : [];
  const matches = [];
  phones.forEach(raw => {
    const phone = normalizePhone(raw);
    if (!phone || phone.length !== 12) return;
    const target = findUserByPhone(phone);
    if (!target || target.id === user.id) return;
    matches.push({ phone, phoneFormatted: formatPhone(target.phone), fullName: target.fullName, clientId: target.clientId });
  });
  sendJson(res, 200, { matches });
});

// =======================================================================
//  КОПИЛКИ
// =======================================================================

route('GET', '/api/piggy', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  runPiggyAutoDeposits(user.id);
  sendJson(res, 200, { piggyBanks: findPiggyByUserId(user.id).map(publicPiggy) });
});

route('POST', '/api/piggy', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const name = (body.name || '').trim().slice(0, 40);
  if (!name) return sendJson(res, 400, { error: 'Копилкага ат бериңиз (Дайте копилке название).' });
  const mode = PIGGY_MODES.includes(body.mode) ? body.mode : 'manual';
  const targetAmount = body.targetAmount ? Math.max(0, money(body.targetAmount)) : 0;
  const autoAmount = mode !== 'manual' ? Math.max(0, money(body.autoAmount || 0)) : 0;
  const p = {
    id: newId(), userId: user.id, name, icon: (body.icon || 'piggy').slice(0, 20),
    targetAmount, balance: 0, mode, autoAmount,
    lastAutoAt: new Date().toISOString(), createdAt: new Date().toISOString()
  };
  db().piggyBanks.push(p);
  storeDb.save();
  sendJson(res, 201, { piggyBank: publicPiggy(p) });
});

route('POST', '/api/piggy/:id/deposit', async (req, res, params) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const p = db().piggyBanks.find(x => x.id === params.id && x.userId === user.id);
  if (!p) return sendJson(res, 404, { error: 'Копилка табылган жок (Копилка не найдена).' });
  const body = await readJsonBody(req);
  const amount = money(body.amount);
  if (!amount || amount <= 0) return sendJson(res, 400, { error: 'Сумманы туура киргизиңиз (Укажите корректную сумму).' });
  const account = findAccountByUserId(user.id);
  if (!account.isOwner && account.balance < amount) return sendJson(res, 400, { error: 'Капчыкта каражат жетишсиз (Недостаточно средств).' });
  if (!account.isOwner) account.balance = money(account.balance - amount);
  p.balance = money(p.balance + amount);
  db().transactions.push({
    id: newId(), kind: 'piggy_deposit', userId: user.id, piggyId: p.id,
    fromAccountId: account.id, toAccountId: null,
    fromName: user.fullName, toName: `Копилка «${p.name}»`,
    amount, currency: 'KGS', method: 'piggy', note: '', category: 'other',
    status: 'success', receiptNo: genReceiptNo(), createdAt: new Date().toISOString()
  });
  storeDb.save();
  sendJson(res, 200, { piggyBank: publicPiggy(p), walletBalance: money(account.balance) });
});

route('POST', '/api/piggy/:id/withdraw', async (req, res, params) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const p = db().piggyBanks.find(x => x.id === params.id && x.userId === user.id);
  if (!p) return sendJson(res, 404, { error: 'Копилка табылган жок (Копилка не найдена).' });
  const body = await readJsonBody(req);
  const amount = money(body.amount);
  if (!amount || amount <= 0 || amount > p.balance) return sendJson(res, 400, { error: 'Сумманы туура киргизиңиз (Укажите корректную сумму).' });
  const account = findAccountByUserId(user.id);
  p.balance = money(p.balance - amount);
  if (!account.isOwner) account.balance = money(account.balance + amount);
  db().transactions.push({
    id: newId(), kind: 'piggy_withdraw', userId: user.id, piggyId: p.id,
    fromAccountId: null, toAccountId: account.id,
    fromName: `Копилка «${p.name}»`, toName: user.fullName,
    amount, currency: 'KGS', method: 'piggy', note: '', category: 'other',
    status: 'success', receiptNo: genReceiptNo(), createdAt: new Date().toISOString()
  });
  storeDb.save();
  sendJson(res, 200, { piggyBank: publicPiggy(p), walletBalance: money(account.balance) });
});

route('DELETE', '/api/piggy/:id', async (req, res, params) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const d = db();
  const p = d.piggyBanks.find(x => x.id === params.id && x.userId === user.id);
  if (!p) return sendJson(res, 404, { error: 'Копилка табылган жок (Копилка не найдена).' });
  const account = findAccountByUserId(user.id);
  if (p.balance > 0 && !account.isOwner) account.balance = money(account.balance + p.balance);
  d.piggyBanks = d.piggyBanks.filter(x => x.id !== p.id);
  storeDb.save();
  sendJson(res, 200, { ok: true, walletBalance: money(account.balance) });
});

// =======================================================================
//  ПУБЛИЧНАЯ КАРТА БАНКОМАТОВ / ТЕРМИНАЛОВ / ОФИСОВ (для приложения и сайта банка)
// =======================================================================

route('GET', '/api/locations', async (req, res) => {
  const d = db();
  sendJson(res, 200, {
    offices: d.offices.map(o => ({ id: o.id, name: o.name, address: o.address, lat: o.lat, lng: o.lng, phone: o.phone, hours: o.hours })),
    devices: d.devices.filter(dv => dv.status === 'active').map(dv => publicDevice(dv))
  });
});

// =======================================================================
//  СОТРУДНИКИ / ОФИС БАНКА
// =======================================================================

route('POST', '/api/staff/auth/login', async (req, res) => {
  const body = await readJsonBody(req);
  const phone = normalizePhone(body.phone);
  const password = body.password || '';
  const staff = findStaffByPhone(phone);
  if (!staff || !verifyPassword(password, staff.passwordSalt, staff.passwordHash)) {
    return sendJson(res, 401, { error: 'Телефон же сырсөз туура эмес (Неверный телефон или пароль).' });
  }
  const token = createStaffSession(staff.id);
  sendJson(res, 200, { token, staff: publicStaff(staff) });
});

route('POST', '/api/staff/auth/logout', async (req, res) => {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) {
    const d = db();
    d.staffSessions = d.staffSessions.filter(s => s.token !== match[1]);
    storeDb.save();
  }
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/staff/me', async (req, res) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  sendJson(res, 200, { staff: publicStaff(staff) });
});

// --- Обзорная статистика для панели офиса ---
route('GET', '/api/office/overview', async (req, res) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const d = db();
  const totalClients = d.users.filter(u => { const a = findAccountByUserId(u.id); return a && !a.isOwner; }).length;
  const totalWalletBalance = d.accounts.filter(a => !a.isOwner).reduce((s, a) => s + a.balance, 0);
  const totalCards = d.cards.filter(c => c.status !== 'closed').length;
  const totalDevices = d.devices.length;
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayTx = d.transactions.filter(t => (t.createdAt || '').slice(0, 10) === todayStr);
  sendJson(res, 200, {
    totalClients, totalWalletBalance: money(totalWalletBalance), totalCards, totalDevices,
    todayTxCount: todayTx.length,
    todayTxVolume: money(todayTx.reduce((s, t) => s + t.amount, 0))
  });
});

// --- Поиск клиента (по имени / телефону / паспорту) ---
route('GET', '/api/office/clients/search', async (req, res) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const q = (new URL(req.url, 'http://x').searchParams.get('q') || '').trim().toLowerCase();
  if (!q) return sendJson(res, 200, { clients: [] });
  const d = db();
  const qDigits = q.replace(/\D/g, '');
  const results = d.users.filter(u => {
    const kyc = u.kyc || {};
    return u.fullName.toLowerCase().includes(q)
      || (qDigits.length > 0 && u.phone.includes(qDigits))
      || (kyc.passportNumber || '').toLowerCase().includes(q);
  }).slice(0, 25).map(u => {
    const account = findAccountByUserId(u.id);
    return {
      id: u.id, clientId: u.clientId, fullName: u.fullName, phoneFormatted: formatPhone(u.phone),
      hasKyc: !!u.kyc, walletBalance: account ? money(account.balance) : 0,
      cardCount: findCardsByUserId(u.id).length
    };
  });
  sendJson(res, 200, { clients: results });
});

// --- Карточка клиента (детально) ---
route('GET', '/api/office/clients/:id', async (req, res, params) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const user = findUserById(params.id);
  if (!user) return sendJson(res, 404, { error: 'Клиент табылган жок (Клиент не найден).' });
  const account = findAccountByUserId(user.id);
  sendJson(res, 200, {
    client: {
      id: user.id, clientId: user.clientId, fullName: user.fullName, phoneFormatted: formatPhone(user.phone),
      createdAt: user.createdAt, kyc: user.kyc || null,
      wallet: account ? { accountNumber: account.accountNumber, balance: money(account.balance) } : null,
      cards: findCardsByUserId(user.id).map(publicCard)
    }
  });
});

// --- Регистрация нового клиента по паспорту (офис) ---
route('POST', '/api/office/clients/register-passport', async (req, res) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const fullName = (body.fullName || '').trim();
  const phone = normalizePhone(body.phone);
  const password = body.password || '';
  const passportNumber = (body.passportNumber || '').trim();

  if (fullName.length < 2) return sendJson(res, 400, { error: 'Толук атын туура киргизиңиз (Укажите корректное имя).' });
  if (phone.length !== 12) return sendJson(res, 400, { error: 'Телефон номерин туура киргизиңиз (Укажите корректный номер телефона).' });
  if (password.length < 6) return sendJson(res, 400, { error: 'Купуя сөз кеминде 6 белгиден турушу керек (Пароль должен быть не короче 6 символов).' });
  if (!passportNumber) return sendJson(res, 400, { error: 'Паспорттун номерин киргизиңиз (Укажите номер паспорта).' });
  if (findUserByPhone(phone)) return sendJson(res, 409, { error: 'Бул номер менен колдонуучу буга чейин катталган (Этот номер уже зарегистрирован).' });

  const { user, account } = createUserWithAccount({ fullName, phone, password });
  user.kyc = {
    passportNumber, passportIssuedBy: (body.passportIssuedBy || '').trim(),
    passportIssuedAt: body.passportIssuedAt || null, birthDate: body.birthDate || null,
    address: (body.address || '').trim(), facePhoto: body.facePhoto || null,
    verifiedByStaffId: staff.id, verifiedAt: new Date().toISOString()
  };
  storeDb.save();
  sendJson(res, 201, { client: { id: user.id, clientId: user.clientId, fullName: user.fullName, accountNumber: account.accountNumber } });
});

// --- Найти существующего клиента по паспортным данным (чтобы открыть ему карту) ---
route('POST', '/api/office/clients/find-by-passport', async (req, res) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const passportNumber = (body.passportNumber || '').trim();
  if (!passportNumber) return sendJson(res, 400, { error: 'Паспорттун номерин киргизиңиз (Укажите номер паспорта).' });
  const user = db().users.find(u => u.kyc && u.kyc.passportNumber === passportNumber);
  if (!user) return sendJson(res, 404, { error: 'Мындай паспорт боюнча кардар табылган жок (Клиент с таким паспортом не найден).' });
  sendJson(res, 200, { client: { id: user.id, clientId: user.clientId, fullName: user.fullName, phoneFormatted: formatPhone(user.phone) } });
});

// --- Выпуск карты клиенту сотрудником офиса ---
route('POST', '/api/office/clients/:id/cards', async (req, res, params) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const user = findUserById(params.id);
  if (!user) return sendJson(res, 404, { error: 'Клиент табылган жок (Клиент не найден).' });
  const body = await readJsonBody(req);
  const type = CARD_PLANS[body.type] ? body.type : null;
  if (!type) return sendJson(res, 400, { error: 'Картанын түрүн тандаңыз (Выберите тип карты).' });
  const card = issueCard(user.id, { type, themeId: body.themeId, nickname: body.nickname });
  sendJson(res, 201, { card: publicCard(card) });
});

// --- Офисы (адреса) ---
route('GET', '/api/office/offices', async (req, res) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  sendJson(res, 200, { offices: db().offices });
});

route('POST', '/api/office/offices', async (req, res) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const name = (body.name || '').trim();
  if (!name) return sendJson(res, 400, { error: 'Офистин атын киргизиңиз (Укажите название офиса).' });
  const office = {
    id: newId(), name, address: (body.address || '').trim(),
    lat: Number(body.lat) || null, lng: Number(body.lng) || null,
    phone: (body.phone || '').trim(), hours: (body.hours || '09:00–18:00').trim(),
    createdAt: new Date().toISOString()
  };
  db().offices.push(office);
  storeDb.save();
  sendJson(res, 201, { office });
});

// --- Устройства: список / создание ---
route('GET', '/api/office/devices', async (req, res) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  sendJson(res, 200, {
    devices: db().devices.map(dv => ({ ...publicDevice(dv, { withCash: true }), cashTotal: deviceCashTotal(dv) }))
  });
});

route('POST', '/api/office/devices', async (req, res) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const kind = ['atm', 'terminal', 'both'].includes(body.kind) ? body.kind : 'both';
  const password = body.password || '';
  if (password.length < 4) return sendJson(res, 400, { error: 'Сырсөз кеминде 4 белгиден турушу керек (Пароль должен быть не короче 4 символов).' });
  const { hash, salt } = hashPassword(password);
  const cash = {};
  DEVICE_DENOMS.forEach(d => { cash[d] = Number((body.cash && body.cash[d]) || 0); });
  const device = {
    id: newId(), deviceCode: genDeviceCode(kind), kind,
    label: (body.label || '').trim() || `Түзмөк ${db().meta.nextDeviceSeq}`,
    passwordHash: hash, passwordSalt: salt,
    officeId: body.officeId || null,
    location: { address: (body.location && body.location.address) || '', lat: Number(body.location && body.location.lat) || null, lng: Number(body.location && body.location.lng) || null },
    cash, scannedSerials: [], pairToken: newToken(),
    status: 'active', createdAt: new Date().toISOString()
  };
  db().meta.nextDeviceSeq++;
  db().devices.push(device);
  storeDb.save();
  sendJson(res, 201, { device: { ...publicDevice(device, { withCash: true }) } });
});

route('GET', '/api/office/devices/:id', async (req, res, params) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const device = findDeviceById(params.id);
  if (!device) return sendJson(res, 404, { error: 'Түзмөк табылган жок (Устройство не найдено).' });
  const receipts = db().deviceReceipts.filter(r => r.deviceId === device.id).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  sendJson(res, 200, { device: { ...publicDevice(device, { withCash: true }), cashTotal: deviceCashTotal(device) }, receipts });
});

// --- Пополнить устройство наличностью (инкассация) ---
route('POST', '/api/office/devices/:id/cash', async (req, res, params) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const device = findDeviceById(params.id);
  if (!device) return sendJson(res, 404, { error: 'Түзмөк табылган жок (Устройство не найдено).' });
  const body = await readJsonBody(req);
  DEVICE_DENOMS.forEach(d => {
    const add = Number((body.cash && body.cash[d]) || 0);
    if (add > 0) device.cash[d] = (device.cash[d] || 0) + add;
  });
  storeDb.save();
  sendJson(res, 200, { device: { ...publicDevice(device, { withCash: true }), cashTotal: deviceCashTotal(device) } });
});

route('POST', '/api/office/devices/:id/status', async (req, res, params) => {
  const staff = getStaffAuthUser(req);
  if (!staff) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const device = findDeviceById(params.id);
  if (!device) return sendJson(res, 404, { error: 'Түзмөк табылган жок (Устройство не найдено).' });
  const body = await readJsonBody(req);
  device.status = body.status === 'disabled' ? 'disabled' : 'active';
  storeDb.save();
  sendJson(res, 200, { device: publicDevice(device, { withCash: true }) });
});

// =======================================================================
//  БАНКОМАТ + ТЕРМИНАЛ (КИОСК) — публичная часть для сайта киоска
// =======================================================================

function getDeviceAuthFromReq(req) {
  const header = req.headers['authorization'] || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const d = db();
  const s = d.deviceAuthSessions.find(s => s.token === match[1]);
  if (!s || s.expiresAt < Date.now()) return null;
  return findDeviceById(s.deviceId);
}

// --- Вход на киоске (деж. сотрудник активирует устройство один раз) ---
route('POST', '/api/device/auth/login', async (req, res) => {
  const body = await readJsonBody(req);
  const device = findDeviceByCode((body.deviceCode || '').trim().toUpperCase());
  if (!device || device.status !== 'active') return sendJson(res, 404, { error: 'Түзмөк табылган жок же өчүрүлгөн (Устройство не найдено или отключено).' });
  if (!verifyPassword(body.password || '', device.passwordSalt, device.passwordHash)) {
    return sendJson(res, 401, { error: 'Сырсөз туура эмес (Неверный пароль).' });
  }
  const token = newToken();
  db().deviceAuthSessions.push({ token, deviceId: device.id, createdAt: new Date().toISOString(), expiresAt: Date.now() + 12 * 60 * 60 * 1000 });
  storeDb.save();
  sendJson(res, 200, { token, device: publicDevice(device), qrPayload: makeDevicePairPayload(device) });
});

// --- QR-код киоска для сканирования из приложения ---
route('GET', '/api/device/qr', async (req, res) => {
  const device = getDeviceAuthFromReq(req);
  if (!device) return sendJson(res, 401, { error: 'Киоск сессиясы аяктады (Сессия киоска истекла).' });
  // Токен привязки обновляем при каждом запросе нового QR, чтобы старые
  // скриншоты QR-кода нельзя было использовать повторно.
  device.pairToken = newToken();
  storeDb.save();
  sendJson(res, 200, { payload: makeDevicePairPayload(device) });
});

// --- Клиент сканирует QR киоска своим телефоном (из приложения, с авторизацией клиента) ---
route('POST', '/api/device/pair', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const parsed = parseDevicePairPayload(body.payload);
  if (!parsed) return sendJson(res, 400, { error: 'QR-код жараксыз (Недействительный QR-код терминала).' });
  const device = findDeviceByCode(parsed.deviceCode);
  if (!device || device.pairToken !== parsed.pairToken) return sendJson(res, 400, { error: 'QR-код эскирген, кайра аракет кылыңыз (QR-код устарел, попробуйте снова).' });

  const d = db();
  d.deviceSessions = d.deviceSessions.filter(s => s.deviceId !== device.id || !s.active); // чистим прошлые активные привязки этого устройства
  const session = { id: newId(), deviceId: device.id, userId: user.id, active: true, pairedAt: new Date().toISOString(), expiresAt: Date.now() + DEVICE_PAIR_TTL_MS };
  d.deviceSessions.push(session);
  storeDb.save();
  sendJson(res, 200, { ok: true, deviceLabel: device.label, deviceCode: device.deviceCode });
});

// --- Киоск узнаёт, привязан ли уже клиент, и подтягивает его данные ---
route('GET', '/api/device/session', async (req, res) => {
  const device = getDeviceAuthFromReq(req);
  if (!device) return sendJson(res, 401, { error: 'Киоск сессиясы аяктады (Сессия киоска истекла).' });
  const d = db();
  const session = d.deviceSessions.find(s => s.deviceId === device.id && s.active && s.expiresAt > Date.now());
  if (!session) return sendJson(res, 200, { paired: false });
  const user = findUserById(session.userId);
  const account = findAccountByUserId(session.userId);
  chargeDueCardFees(session.userId);
  sendJson(res, 200, {
    paired: true,
    user: { fullName: user.fullName, clientId: user.clientId },
    wallet: { balance: money(account.balance), isOwner: !!account.isOwner },
    cards: findCardsByUserId(session.userId).filter(c => c.status === 'active').map(publicCard)
  });
});

// --- Клиент отходит от киоска / завершает сессию ---
route('POST', '/api/device/session/end', async (req, res) => {
  const device = getDeviceAuthFromReq(req);
  if (!device) return sendJson(res, 401, { error: 'Киоск сессиясы аяктады (Сессия киоска истекла).' });
  const d = db();
  d.deviceSessions.forEach(s => { if (s.deviceId === device.id) s.active = false; });
  storeDb.save();
  sendJson(res, 200, { ok: true });
});

function activeDeviceSession(device) {
  const d = db();
  return d.deviceSessions.find(s => s.deviceId === device.id && s.active && s.expiresAt > Date.now());
}

// Фактическое исполнение выдачи наличных (вызывается только после того, как
// клиент подтвердил операцию в мобильном приложении).
function executeWithdraw(device, user, account, amount) {
  const breakdown = breakdownCash(device.cash, amount);
  if (!breakdown) {
    return { error: 'Банкоматта бул сумманы берүү үчүн купюралар жок (У банкомата нет нужных купюр для этой суммы).' };
  }
  if (!account.isOwner && account.balance < amount) {
    return { error: 'Эсепте каражат жетишсиз (На счету недостаточно средств).' };
  }
  if (!account.isOwner) account.balance = money(account.balance - amount);
  Object.entries(breakdown).forEach(([denom, count]) => { device.cash[denom] -= count; });

  const receiptNo = genReceiptNo();
  const tx = {
    id: newId(), kind: 'device_withdraw', userId: user.id,
    fromAccountId: account.id, toAccountId: null,
    fromName: user.fullName, toName: `Банкомат ${device.deviceCode}`,
    amount, currency: 'KGS', method: 'atm', note: `Накталай акча алуу — ${device.label}`,
    category: 'other', status: 'success', receiptNo, createdAt: new Date().toISOString(),
    deviceId: device.id, deviceCode: device.deviceCode
  };
  db().transactions.push(tx);
  const receipt = {
    id: newId(), deviceId: device.id, deviceCode: device.deviceCode, type: 'withdraw',
    amount, denominations: breakdown, userId: user.id, clientName: user.fullName,
    receiptNo, createdAt: new Date().toISOString()
  };
  db().deviceReceipts.push(receipt);
  return { receipt, newBalance: money(account.balance) };
}

// --- Банкомат СУРАЙТ клиенттин телефонунан накталай акча алууга уруксат ---
// (Акча дароо алынбайт — алгач кардар колдонмодон "Ырастоо" басышы керек.)
route('POST', '/api/device/withdraw/request', async (req, res) => {
  const device = getDeviceAuthFromReq(req);
  if (!device) return sendJson(res, 401, { error: 'Киоск сессиясы аяктады (Сессия киоска истекла).' });
  const session = activeDeviceSession(device);
  if (!session) return sendJson(res, 400, { error: 'Кардар байланышкан эмес (Клиент не привязан к устройству).' });
  const body = await readJsonBody(req);
  const amount = money(body.amount);
  if (!amount || amount <= 0) return sendJson(res, 400, { error: 'Сумманы туура киргизиңиз (Укажите корректную сумму).' });

  const user = findUserById(session.userId);
  const account = findAccountByUserId(session.userId);
  if (!account.isOwner && account.balance < amount) {
    return sendJson(res, 400, { error: 'Эсепте каражат жетишсиз (На счету недостаточно средств).' });
  }
  if (!breakdownCash(device.cash, amount)) {
    return sendJson(res, 400, { error: 'Банкоматта бул сумманы берүү үчүн купюралар жок (У банкомата нет нужных купюр для этой суммы).' });
  }

  const d = db();
  // Эски күтүүдөгү суроо-талаптарды тазалайбыз (бир учурда бир гана активдүү суроо)
  d.withdrawRequests.forEach(r => { if (r.deviceId === device.id && r.status === 'pending') r.status = 'expired'; });
  const reqObj = {
    id: newId(), deviceId: device.id, deviceCode: device.deviceCode, userId: user.id,
    amount, status: 'pending', createdAt: new Date().toISOString(), expiresAt: Date.now() + WITHDRAW_REQUEST_TTL_MS
  };
  d.withdrawRequests.push(reqObj);
  addNotification(user.id, 'withdraw_request',
    'Банкоматтан акча алууну ырастаңыз (Подтвердите снятие наличных)',
    `${device.label}: ${amount.toLocaleString('ru-RU')} сом`,
    { requestId: reqObj.id, amount, deviceLabel: device.label, expiresAt: reqObj.expiresAt });
  storeDb.save();
  sendJson(res, 201, { requestId: reqObj.id, expiresAt: reqObj.expiresAt });
});

// --- Банкомат суроо-талаптын абалын сурайт (клиент колдонмодон жооп берди беле) ---
route('GET', '/api/device/withdraw/status', async (req, res) => {
  const device = getDeviceAuthFromReq(req);
  if (!device) return sendJson(res, 401, { error: 'Киоск сессиясы аяктады (Сессия киоска истекла).' });
  const requestId = new URL(req.url, 'http://x').searchParams.get('requestId');
  const d = db();
  const reqObj = d.withdrawRequests.find(r => r.id === requestId && r.deviceId === device.id);
  if (!reqObj) return sendJson(res, 404, { error: 'Суроо-талап табылган жок (Запрос не найден).' });
  if (reqObj.status === 'pending' && reqObj.expiresAt < Date.now()) { reqObj.status = 'expired'; storeDb.save(); }
  sendJson(res, 200, {
    status: reqObj.status, amount: reqObj.amount, expiresAt: reqObj.expiresAt,
    receipt: reqObj.receipt || null, newBalance: reqObj.newBalance || null, error: reqObj.error || null
  });
});

// --- Колокольчик: колдонуучунун чыныгы билдирмелери (акыркы 50) ---
route('GET', '/api/notifications', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const list = db().notifications
    .filter(n => n.userId === user.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 50);
  const unreadCount = list.filter(n => !n.read).length;
  sendJson(res, 200, { notifications: list, unreadCount });
});

route('POST', '/api/notifications/:id/read', async (req, res, params) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const n = db().notifications.find(x => x.id === params.id && x.userId === user.id);
  if (n) { n.read = true; storeDb.save(); }
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/notifications/read-all', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  db().notifications.forEach(n => { if (n.userId === user.id) n.read = true; });
  storeDb.save();
  sendJson(res, 200, { ok: true });
});

// --- Клиенттин колдонмосу: учурда ырастоону күтүп жаткан суроо-талап барбы? ---
route('GET', '/api/withdraw-requests/pending', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const d = db();
  const reqObj = d.withdrawRequests.find(r => r.userId === user.id && r.status === 'pending' && r.expiresAt > Date.now());
  if (!reqObj) return sendJson(res, 200, { request: null });
  const device = findDeviceById(reqObj.deviceId);
  sendJson(res, 200, {
    request: {
      id: reqObj.id, amount: reqObj.amount, expiresAt: reqObj.expiresAt,
      deviceLabel: device ? device.label : reqObj.deviceCode, deviceCode: reqObj.deviceCode
    }
  });
});

// --- Клиент колдонмодон "Ырастоо" же "Четке кагуу" басат ---
route('POST', '/api/withdraw-requests/:id/respond', async (req, res, params) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const body = await readJsonBody(req);
  const d = db();
  const reqObj = d.withdrawRequests.find(r => r.id === params.id && r.userId === user.id);
  if (!reqObj) return sendJson(res, 404, { error: 'Суроо-талап табылган жок (Запрос не найден).' });
  if (reqObj.status !== 'pending') return sendJson(res, 400, { error: 'Бул суроо-талап мурда эле жооп алган (Этот запрос уже обработан).' });
  if (reqObj.expiresAt < Date.now()) {
    reqObj.status = 'expired';
    storeDb.save();
    return sendJson(res, 400, { error: 'Убакыт бүттү (Время истекло).' });
  }

  if (!body.approve) {
    reqObj.status = 'rejected';
    storeDb.save();
    return sendJson(res, 200, { status: 'rejected' });
  }

  const device = findDeviceById(reqObj.deviceId);
  const account = findAccountByUserId(user.id);
  if (!device || !account) {
    reqObj.status = 'rejected';
    reqObj.error = 'Түзмөк же эсеп табылган жок (Устройство или счёт не найдены).';
    storeDb.save();
    return sendJson(res, 400, { error: reqObj.error });
  }
  const result = executeWithdraw(device, user, account, reqObj.amount);
  if (result.error) {
    reqObj.status = 'rejected';
    reqObj.error = result.error;
    storeDb.save();
    return sendJson(res, 400, { error: result.error });
  }
  reqObj.status = 'approved';
  reqObj.receipt = result.receipt;
  reqObj.newBalance = result.newBalance;
  storeDb.save();
  sendJson(res, 200, { status: 'approved', newBalance: result.newBalance });
});

// --- Пополнение через терминал: старт сессии сканирования купюр (60 сек) ---
route('POST', '/api/device/deposit/start', async (req, res) => {
  const device = getDeviceAuthFromReq(req);
  if (!device) return sendJson(res, 401, { error: 'Киоск сессиясы аяктады (Сессия киоска истекла).' });
  const session = activeDeviceSession(device);
  if (!session) return sendJson(res, 400, { error: 'Кардар байланышкан эмес (Клиент не привязан к устройству).' });
  const d = db();
  d.depositSessions = d.depositSessions.filter(s => !(s.deviceId === device.id && s.status === 'active'));
  const ds = {
    id: newId(), deviceId: device.id, userId: session.userId,
    notes: [], total: 0, status: 'active',
    startedAt: new Date().toISOString(), expiresAt: Date.now() + DEPOSIT_SESSION_TTL_MS
  };
  d.depositSessions.push(ds);
  storeDb.save();
  sendJson(res, 200, { sessionId: ds.id, expiresAt: ds.expiresAt, minAmount: DEPOSIT_MIN_AMOUNT, commission: 0 });
});

// --- Пополнение через терминал: "сканирование" одной купюры камерой ---
// В демо-версии реальное компьютерное зрение не подключено: номинал
// передаёт сама камера-симуляция на фронтенде (выбор купюры по снимку),
// а сервер честно проверяет серийный номер на повтор и ведёт учёт.
route('POST', '/api/device/deposit/scan', async (req, res) => {
  const device = getDeviceAuthFromReq(req);
  if (!device) return sendJson(res, 401, { error: 'Киоск сессиясы аяктады (Сессия киоска истекла).' });
  const body = await readJsonBody(req);
  const d = db();
  const ds = d.depositSessions.find(s => s.id === body.sessionId && s.deviceId === device.id && s.status === 'active');
  if (!ds) return sendJson(res, 400, { error: 'Сессиянын мөөнөтү өттү (Сессия сканирования истекла).' });
  if (ds.expiresAt < Date.now()) { ds.status = 'expired'; storeDb.save(); return sendJson(res, 400, { error: 'Убакыт бүттү, баштан баштаңыз (Время вышло, начните заново).' }); }

  const denom = Number(body.denomination);
  if (!DEVICE_DENOMS.includes(denom)) return sendJson(res, 400, { error: 'Купюра таанылган жок, кайра аракет кылыңыз (Купюра не распознана, повторите попытку).' });
  const serial = (body.serial || '').trim();
  if (!serial || serial.length < 6) return sendJson(res, 400, { error: 'Сүрөттүн сапаты начар, кайра аракет кылыңыз (Качество снимка низкое, повторите попытку).' });

  if (device.scannedSerials.some(s => s.serial === serial)) {
    return sendJson(res, 400, { error: 'Бул купюра мурда эле скандалган (Эта купюра уже была отсканирована). Повторите попытку с другой купюрой.' });
  }
  if (ds.notes.some(n => n.serial === serial)) {
    return sendJson(res, 400, { error: 'Бул купюра учурдагы сессияда мурда скандалган (Эта купюра уже отсканирована в этой сессии).' });
  }

  ds.notes.push({ serial, denom, scannedAt: new Date().toISOString() });
  ds.total = money(ds.total + denom);
  device.scannedSerials.push({ serial, denom, scannedAt: new Date().toISOString() });
  // Повторное сканирование продлевает таймер — как в реальном терминале, пока купюры принимаются
  ds.expiresAt = Date.now() + DEPOSIT_SESSION_TTL_MS;
  storeDb.save();
  sendJson(res, 200, { sessionId: ds.id, total: ds.total, notesCount: ds.notes.length, expiresAt: ds.expiresAt, lastDenom: denom });
});

// --- Пополнение через терминал: настоящее сканирование купюры камерой ---
// Клиент присылает кадр с живой камеры (JPEG в base64). Сервер реально
// распознаёт номинал и серийный номер через OCR (tesseract.js) + анализ
// цвета, и проверяет перцептивный хэш фото по всей системе — чтобы одна и
// та же купюра не могла быть внесена дважды (даже на разных терминалах,
// даже если серийный номер в этот раз не прочитался чётко).
route('POST', '/api/device/deposit/scan-image', async (req, res) => {
  const device = getDeviceAuthFromReq(req);
  if (!device) return sendJson(res, 401, { error: 'Киоск сессиясы аяктады (Сессия киоска истекла).' });
  let body;
  try { body = await readJsonBody(req, 30e6); } // бир нече кадр (consensus) бир запросто келет
  catch (err) { return sendJson(res, 413, { error: 'Сүрөт өтө чоң (Снимок слишком большой), кайра аракет кылыңыз.' }); }

  const d = db();
  const ds = d.depositSessions.find(s => s.id === body.sessionId && s.deviceId === device.id && s.status === 'active');
  if (!ds) return sendJson(res, 400, { error: 'Сессиянын мөөнөтү өттү (Сессия сканирования истекла).' });
  if (ds.expiresAt < Date.now()) { ds.status = 'expired'; storeDb.save(); return sendJson(res, 400, { error: 'Убакыт бүттү, баштан баштаңыз (Время вышло, начните заново).' }); }

  // Бир нече кадр жиберилсе (images) — "кайра-кайра сканерлеп, эн туура
  // вариантты тандоо" режими: ар бир кадр өзүнчө талданат да, добуш
  // берүү менен эн ишенимдүү жыйынтык тандалат. Бир кадр (image) болсо —
  // ал калыбындай эле иштейт (артка карай шайкеш).
  const images = Array.isArray(body.images) && body.images.length ? body.images : (body.image ? [body.image] : null);
  if (!images) return sendJson(res, 400, { error: 'Сүрөт жок (Нет снимка).' });

  let result;
  try {
    result = images.length > 1 ? await recognizeBillConsensus(images) : await recognizeBill(images[0]);
  } catch (err) {
    console.error('[deposit/scan-image] распозноо катасы:', err);
    return sendJson(res, 500, { error: 'Таанып билүү системасында ката кетти (Ошибка системы распознавания). Кайра аракет кылыңыз.' });
  }
  if (!result.ok) return sendJson(res, 400, { error: result.error });

  const { denomination: denom, serial, fingerprint, confidence } = result;

  // Проверка на повтор: по серийному номеру (если распознался) и по
  // отпечатку самой фотографии (форма + цвет) — во всей системе и в этой
  // сессии. Это и есть ответ на "эгер ошол эле купюраны корсотсон, бул
  // базада бар дегени болушу керек": сравниваем не ввод с клавиатуры, а
  // саму картинку купюры.
  if (serial && device.scannedSerials.some(s => s.serial === serial)) {
    return sendJson(res, 400, { error: 'Бул купюра мурда эле скандалган (Эта купюра уже была отсканирована). Повторите попытку с другой купюрой.' });
  }
  if (serial && ds.notes.some(n => n.serial === serial)) {
    return sendJson(res, 400, { error: 'Бул купюра учурдагы сессияда мурда скандалган (Эта купюра уже отсканирована в этой сессии).' });
  }
  const dupInSession = ds.notes.some(n => n.fingerprint && isSameBill(n.fingerprint, fingerprint));
  const dupInSystem = !dupInSession && d.billImageHashes.some(n => isSameBill(n.fingerprint, fingerprint));
  if (dupInSession || dupInSystem) {
    return sendJson(res, 400, { error: 'Бул купюра мурда эле базада бар (Эта купюра уже есть в базе — уже вносилась ранее). Көрсөтүлгөн купюраны алып, башка купюраны көрсөтүңүз.' });
  }

  const scannedAt = new Date().toISOString();
  const noteSerial = serial || null;
  ds.notes.push({ serial: noteSerial, denom, fingerprint, confidence, scannedAt });
  ds.total = money(ds.total + denom);
  if (noteSerial) device.scannedSerials.push({ serial: noteSerial, denom, scannedAt });
  d.billImageHashes.push({ fingerprint, serial: noteSerial, denom, deviceId: device.id, deviceCode: device.deviceCode, userId: ds.userId, scannedAt });
  // Повторное сканирование продлевает таймер — как в реальном терминале, пока купюры принимаются
  ds.expiresAt = Date.now() + DEPOSIT_SESSION_TTL_MS;
  storeDb.save();
  sendJson(res, 200, {
    sessionId: ds.id, total: ds.total, notesCount: ds.notes.length, expiresAt: ds.expiresAt,
    lastDenom: denom, serial: noteSerial, confidence
  });
});

route('GET', '/api/device/deposit/status', async (req, res) => {
  const device = getDeviceAuthFromReq(req);
  if (!device) return sendJson(res, 401, { error: 'Киоск сессиясы аяктады (Сессия киоска истекла).' });
  const sessionId = new URL(req.url, 'http://x').searchParams.get('sessionId');
  const ds = db().depositSessions.find(s => s.id === sessionId && s.deviceId === device.id);
  if (!ds) return sendJson(res, 404, { error: 'Сессия табылган жок (Сессия не найдена).' });
  const expired = ds.status === 'active' && ds.expiresAt < Date.now();
  if (expired) { ds.status = 'expired'; storeDb.save(); }
  sendJson(res, 200, { sessionId: ds.id, total: ds.total, notesCount: ds.notes.length, status: expired ? 'expired' : ds.status, expiresAt: ds.expiresAt, minAmount: DEPOSIT_MIN_AMOUNT });
});

route('POST', '/api/device/deposit/cancel', async (req, res) => {
  const device = getDeviceAuthFromReq(req);
  if (!device) return sendJson(res, 401, { error: 'Киоск сессиясы аяктады (Сессия киоска истекла).' });
  const body = await readJsonBody(req);
  const d = db();
  const ds = d.depositSessions.find(s => s.id === body.sessionId && s.deviceId === device.id);
  if (ds && ds.status === 'active') { ds.status = 'cancelled'; storeDb.save(); }
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/device/deposit/confirm', async (req, res) => {
  const device = getDeviceAuthFromReq(req);
  if (!device) return sendJson(res, 401, { error: 'Киоск сессиясы аяктады (Сессия киоска истекла).' });
  const body = await readJsonBody(req);
  const d = db();
  const ds = d.depositSessions.find(s => s.id === body.sessionId && s.deviceId === device.id && s.status === 'active');
  if (!ds) return sendJson(res, 400, { error: 'Сессия табылган жок же аяктаган (Сессия не найдена или завершена).' });
  if (ds.expiresAt < Date.now()) { ds.status = 'expired'; storeDb.save(); return sendJson(res, 400, { error: 'Убакыт бүттү, баштан баштаңыз (Время вышло, начните заново).' }); }
  if (ds.total <= 0) {
    return sendJson(res, 400, { error: 'Жок дегенде бир купюра салыңыз (Внесите хотя бы одну купюру).' });
  }

  const user = findUserById(ds.userId);
  const account = findAccountByUserId(ds.userId);
  if (!account.isOwner) account.balance = money(account.balance + ds.total);
  ds.notes.forEach(n => { device.cash[n.denom] = (device.cash[n.denom] || 0) + 1; });
  ds.status = 'confirmed';

  const receiptNo = genReceiptNo();
  const denominations = {};
  ds.notes.forEach(n => { denominations[n.denom] = (denominations[n.denom] || 0) + 1; });
  const tx = {
    id: newId(), kind: 'device_deposit', userId: user.id,
    fromAccountId: null, toAccountId: account.id,
    fromName: `Терминал ${device.deviceCode}`, toName: user.fullName,
    amount: ds.total, currency: 'KGS', method: 'terminal', note: `Накталай акча менен толуктоо — ${device.label}`,
    category: 'other', status: 'success', receiptNo, createdAt: new Date().toISOString(),
    deviceId: device.id, deviceCode: device.deviceCode
  };
  db().transactions.push(tx);
  const receipt = {
    id: newId(), deviceId: device.id, deviceCode: device.deviceCode, type: 'deposit',
    amount: ds.total, denominations, userId: user.id, clientName: user.fullName,
    receiptNo, createdAt: new Date().toISOString()
  };
  db().deviceReceipts.push(receipt);
  addNotification(user.id, 'deposit_done',
    'Эсеп толукталды (Счёт пополнен)',
    `${device.label}: +${ds.total.toLocaleString('ru-RU')} сом`,
    { receiptNo, amount: ds.total });
  storeDb.save();
  sendJson(res, 200, { ok: true, receipt, newBalance: money(account.balance) });
});

// --- Курсы валют (реальные, обновляются раз в час) ---
route('GET', '/api/rates', async (req, res) => {
  try {
    const data = await buildRatesTable();
    sendJson(res, 200, data);
  } catch (err) {
    sendJson(res, 200, { table: [], live: false, fetchedAt: 0 });
  }
});

// --- Статистика по категориям трат за текущий календарный месяц ---
route('GET', '/api/stats/monthly', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const account = findAccountByUserId(user.id);
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const byCategory = {};
  let totalOut = 0, totalIn = 0;
  db().transactions.forEach(t => {
    const isOut = t.fromAccountId === account.id;
    const isIn = t.toAccountId === account.id;
    if (!isOut && !isIn) return;
    const txYm = (t.createdAt || '').slice(0, 7);
    if (txYm !== ym) return;
    if (isOut) {
      totalOut = money(totalOut + t.amount);
      const cat = normalizeCategory(t.category);
      byCategory[cat] = money((byCategory[cat] || 0) + t.amount);
    } else {
      totalIn = money(totalIn + t.amount);
    }
  });
  sendJson(res, 200, {
    month: ym,
    totalOut, totalIn,
    byCategory: Object.entries(byCategory).map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount)
  });
});

// --- История операций текущего пользователя ---
route('GET', '/api/transactions', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const account = findAccountByUserId(user.id);
  const cardIds = new Set(findCardsByUserId(user.id).map(c => c.id));
  const list = db().transactions
    .filter(t =>
      t.fromAccountId === account.id || t.toAccountId === account.id ||
      cardIds.has(t.fromCardId) || cardIds.has(t.toCardId) ||
      (t.userId === user.id && (t.kind === 'device_withdraw' || t.kind === 'device_deposit' || t.kind === 'piggy_deposit' || t.kind === 'piggy_withdraw' || t.kind === 'card_fee'))
    )
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(t => {
      const isOut = t.fromAccountId === account.id || cardIds.has(t.fromCardId);
      return {
        id: t.id,
        direction: isOut ? 'out' : 'in',
        counterparty: isOut ? t.toName : t.fromName,
        counterpartyPhone: isOut ? (t.toPhone || null) : (t.fromPhone || null),
        kind: t.kind || (t.method === 'phone' || t.method === 'qr' ? 'p2p' : t.method),
        amount: t.amount,
        currency: t.currency,
        method: t.method,
        note: t.note,
        category: t.category || 'other',
        status: t.status,
        receiptNo: t.receiptNo,
        deviceCode: t.deviceCode || null,
        createdAt: t.createdAt
      };
    });
  sendJson(res, 200, { transactions: list });
});

// --- Один чек по номеру (для экрана "чек как бумага") ---
route('GET', '/api/transactions/:id/receipt', async (req, res, params) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const account = findAccountByUserId(user.id);
  const cardIds = new Set(findCardsByUserId(user.id).map(c => c.id));
  const t = db().transactions.find(x => x.id === params.id);
  if (!t) return sendJson(res, 404, { error: 'Чек табылган жок (Чек не найден).' });
  const belongs = t.fromAccountId === account.id || t.toAccountId === account.id || cardIds.has(t.fromCardId) || cardIds.has(t.toCardId) || t.userId === user.id;
  if (!belongs) return sendJson(res, 403, { error: 'Жеткиликсиз (Доступ запрещён).' });
  sendJson(res, 200, { receipt: t });
});

// --- Удаление собственной учётной записи (владелец банка защищён от удаления) ---
route('DELETE', '/api/me', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return sendJson(res, 401, { error: 'Сессия аяктады (Сессия истекла).' });
  const account = findAccountByUserId(user.id);
  if (account && account.isOwner) {
    return sendJson(res, 400, { error: 'Банктын ээсинин аккаунтун өчүрүүгө болбойт (Нельзя удалить аккаунт владельца банка).' });
  }
  const d = db();
  d.users = d.users.filter(u => u.id !== user.id);
  if (account) d.accounts = d.accounts.filter(a => a.id !== account.id);
  d.sessions = d.sessions.filter(s => s.userId !== user.id);
  // Транзакции оставляем как есть (это исторические записи другой стороны тоже) —
  // имена в них уже сохранены как снимок на момент перевода.
  storeDb.save();
  sendJson(res, 200, { ok: true });
});

// ---------- HTTP-сервер ----------

const server = http.createServer(async (req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // CORS (на случай, если фронтенд когда-то будет на отдельном домене)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathname.startsWith('/api/')) {
    const matched = matchRoute(req.method, pathname);
    if (!matched) return sendJson(res, 404, { error: 'Маршрут табылган жок (Маршрут не найден).' });
    try {
      await matched.handler(req, res, matched.params);
    } catch (err) {
      console.error('[api error]', err);
      sendJson(res, 500, { error: 'Сервердин ички катасы (Внутренняя ошибка сервера).' });
    }
    return;
  }

  serveStatic(req, res, pathname);
});

function seedDemoUsersIfEmpty() {
  if (db().users.length > 0) return;

  // Владелец банка — настоящий аккаунт с безлимитным балансом (счёт
  // никогда не уменьшается при переводах, это касса/эмитент банка).
  const owner = createUserWithAccount({
    fullName: 'Эркебаев Самат Адылович',
    phone: '996995223667',
    password: '001esakg'
  });
  markAccountAsOwner(owner.account.id);
  console.log('[seed] Ээси түзүлдү: +996 995 223 667 (чексиз баланс)');
}

function markAccountAsOwner(accountId) {
  const account = findAccountById(accountId);
  account.isOwner = true;
  account.balance = OWNER_DISPLAY_BALANCE;
  storeDb.save();
}

// Одноразовая очистка: убираем старых тестовых клиентов (Айбек Асанов,
// Нурбек Токтосунов), которые раньше создавались автоматически для
// демонстрации — теперь в системе должен быть только реальный владелец,
// а новые клиенты регистрируются по-настоящему (через офис или телефон).
function purgeOldTestUsersOnce() {
  const d = db();
  if (d.meta.testUsersPurgedAt) return;
  const testPhones = new Set(['996700111111', '996700222222']);
  const removeIds = new Set(d.users.filter(u => testPhones.has(u.phone)).map(u => u.id));
  if (removeIds.size > 0) {
    d.users = d.users.filter(u => !removeIds.has(u.id));
    d.accounts = d.accounts.filter(a => !removeIds.has(a.userId));
    d.sessions = d.sessions.filter(s => !removeIds.has(s.userId));
    d.cards = d.cards.filter(c => !removeIds.has(c.userId));
    console.log(`[migrate] Эски тест-колдонуучулар өчүрүлдү (${removeIds.size}).`);
  }
  d.meta.testUsersPurgedAt = new Date().toISOString();
  storeDb.save();
}

// Владелец банка автоматически получает доступ к офисному сайту с теми же
// учётными данными, что и в приложении — отдельный пароль заводить не нужно.
function ensureOwnerStaffAccount() {
  const d = db();
  const ownerAccount = d.accounts.find(a => a.isOwner);
  if (!ownerAccount) return;
  const ownerUser = findUserById(ownerAccount.userId);
  if (!ownerUser) return;
  if (findStaffByPhone(ownerUser.phone)) return;
  d.staff.push({
    id: newId(), fullName: ownerUser.fullName, role: 'owner', phone: ownerUser.phone,
    passwordHash: ownerUser.passwordHash, passwordSalt: ownerUser.passwordSalt,
    createdAt: new Date().toISOString()
  });
  storeDb.save();
  console.log('[seed] Офис сайтына кирүү: +996 995 223 667 (ошол эле сырсөз).');
}

// Демо-офис и первое устройство банкомат+терминал — чтобы сайты офиса и
// киоска сразу было с чем проверять, без ручной настройки с нуля.
function ensureDemoDevices() {
  const d = db();
  if (d.offices.length > 0 || d.devices.length > 0) return;
  const office = {
    id: newId(), name: 'ESA Bank — Башкы офис', address: 'Бишкек ш., Чүй проспекти, 123',
    lat: 42.8746, lng: 74.5698, phone: '+996 995 223 667', hours: '09:00–18:00',
    createdAt: new Date().toISOString()
  };
  d.offices.push(office);

  const { hash, salt } = hashPassword('0000');
  const cash = {};
  DEVICE_DENOMS.forEach(denom => { cash[denom] = denom >= 1000 ? 40 : 100; });
  const device = {
    id: newId(), deviceCode: genDeviceCode('both'), kind: 'both',
    label: 'Банкомат + Терминал №1 (Башкы офис)',
    passwordHash: hash, passwordSalt: salt,
    officeId: office.id,
    location: { address: office.address, lat: office.lat, lng: office.lng },
    cash, scannedSerials: [], pairToken: newToken(),
    status: 'active', createdAt: new Date().toISOString()
  };
  d.meta.nextDeviceSeq++;
  d.devices.push(device);
  storeDb.save();
  console.log(`[seed] Демо түзмөк түзүлдү: ${device.deviceCode} (сырсөз: 0000)`);
}

async function start() {
  await storeDb.load();
  seedDemoUsersIfEmpty();
  purgeOldTestUsersOnce();
  ensureOwnerStaffAccount();
  ensureDemoDevices();

  warmupOcr(); // прогреваем OCR-воркер в фоне, чтобы первое сканирование купюры не ждало инициализацию

  server.listen(PORT, () => {
    console.log(`ESA Bank сервери иштеп жатат: http://localhost:${PORT}`);
    if (storeDb.isOnline()) {
      console.log('Маалымат базасы: Онлайн (Supabase) + локалдык кэш');
    } else {
      console.log(`Маалымат базасы: локалдык файл — ${path.join(__dirname, 'db', 'data.json')}`);
      console.log('Кеңеш: интернетте өмүр бою сакталуучу маалымат үчүн SUPABASE_URL жана SUPABASE_KEY өзгөрмөлөрүн коюңуз (README.md караңыз).');
    }
  });
}

start().catch(err => {
  console.error('[fatal] Сервер башталган жок:', err);
  process.exit(1);
});
