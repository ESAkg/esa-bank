'use strict';
/**
 * ESA Bank — backend (чистый Node.js, без внешних npm-зависимостей,
 * чтобы проект запускался где угодно без риска ошибок установки).
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const storeDb = require('./db/store');
const { hashPassword, verifyPassword, newToken, newId, sixDigitCode } = require('./lib/security');
const { normalizePhone, formatPhone, genAccountNumber, genReceiptNo, money } = require('./lib/helpers');

const PORT = process.env.PORT || 3000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
const RESET_CODE_TTL_MS = 10 * 60 * 1000; // 10 минут
const STARTING_BALANCE = 25000; // стартовый бонус для новых клиентов (демо)
const OWNER_DISPLAY_BALANCE = 999999999; // счёт владельца — безлимитный, баланс не уменьшается

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

// ---------- HTTP-утилиты ----------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1e6) { reject(new Error('Payload too large')); req.destroy(); return; }
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

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');

  // Жёсткий запрет: никогда не отдавать содержимое server/ (там исходный
  // код бэкенда и файл базы данных с хэшами паролей и токенами сессий).
  const firstSegment = filePath.replace(/^[/\\]+/, '').split(/[/\\]/)[0];
  if (DENYLIST_PREFIXES.includes(firstSegment)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }

  const fullPath = path.join(WEB_ROOT, filePath);
  if (!fullPath.startsWith(WEB_ROOT)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // SPA fallback -> index.html
      fs.readFile(path.join(WEB_ROOT, 'index.html'), (err2, data2) => {
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

// ---------- API-роуты ----------

const routes = [];
function route(method, pattern, handler) {
  routes.push({ method, pattern, handler });
}

function matchRoute(method, pathname) {
  for (const r of routes) {
    if (r.method !== method) continue;
    if (r.pattern === pathname) return { handler: r.handler, params: {} };
  }
  return null;
}

// --- Регистрация ---
route('POST', '/api/auth/register', async (req, res) => {
  const body = await readJsonBody(req);
  const fullName = (body.fullName || '').trim();
  const phone = normalizePhone(body.phone);
  const password = body.password || '';

  if (fullName.length < 2) return sendJson(res, 400, { error: 'Толук атыңызды туура киргизиңиз (Укажите корректное имя).' });
  if (phone.length !== 12) return sendJson(res, 400, { error: 'Телефон номерин туура киргизиңиз (Укажите корректный номер телефона).' });
  if (password.length < 6) return sendJson(res, 400, { error: 'Купуя сөз кеминде 6 белгиден турушу керек (Пароль должен быть не короче 6 символов).' });
  if (findUserByPhone(phone)) return sendJson(res, 409, { error: 'Бул номер менен колдонуучу буга чейин катталган (Этот номер уже зарегистрирован).' });

  const { user, account } = createUserWithAccount({ fullName, phone, password });
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
  storeDb.save();

  return {
    ok: true,
    transaction: tx,
    newBalance: money(fromAccount.balance)
  };
}

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
  const list = db().transactions
    .filter(t => t.fromAccountId === account.id || t.toAccountId === account.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(t => ({
      id: t.id,
      direction: t.fromAccountId === account.id ? 'out' : 'in',
      counterparty: t.fromAccountId === account.id ? t.toName : t.fromName,
      counterpartyPhone: t.fromAccountId === account.id ? (t.toPhone || null) : (t.fromPhone || null),
      amount: t.amount,
      currency: t.currency,
      method: t.method,
      note: t.note,
      category: t.category || 'other',
      status: t.status,
      receiptNo: t.receiptNo,
      createdAt: t.createdAt
    }));
  sendJson(res, 200, { transactions: list });
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
      await matched.handler(req, res);
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

  // Два тестовых клиента с обычным балансом — удобно, чтобы сразу было
  // с кем проверять переводы, не трогая счёт владельца.
  createUserWithAccount({ fullName: 'Айбек Асанов', phone: '996700111111', password: '123456' });
  createUserWithAccount({ fullName: 'Нурбек Токтосунов', phone: '996700222222', password: '123456' });
  console.log('[seed] Тест-колдонуучулар түзүлдү: +996 700 111 111 жана +996 700 222 222 (сырсөз: 123456)');
}

function markAccountAsOwner(accountId) {
  const account = findAccountById(accountId);
  account.isOwner = true;
  account.balance = OWNER_DISPLAY_BALANCE;
  storeDb.save();
}

async function start() {
  await storeDb.load();
  seedDemoUsersIfEmpty();

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
