'use strict';
/**
 * ESA Bank — слой хранения данных с двумя режимами:
 *
 * 1) Онлайн-режим (рекомендуется для публикации в интернете): если заданы
 *    переменные окружения SUPABASE_URL и SUPABASE_KEY, все данные хранятся
 *    в бесплатной облачной базе Supabase (Postgres). Это важно для
 *    бесплатных хостингов вроде Render — там диск не постоянный, и при
 *    каждом новом деплое локальный файл обнулился бы. С онлайн-базой
 *    данные переживают любые передеплои.
 *
 * 2) Локальный режим (по умолчанию, для разработки на своём компьютере):
 *    если переменные Supabase не заданы, всё хранится в файле
 *    db/data.json рядом с этим файлом, с атомарной записью и резервной
 *    копией — как и раньше.
 *
 * Даже в онлайн-режиме локальный файл продолжает вестись как "тёплый
 * кэш": это ускоряет чтение и служит подстраховкой, если на секунду
 * пропадёт связь с облаком.
 */

const fs = require('fs');
const path = require('path');

const DB_DIR = __dirname;
const DB_FILE = path.join(DB_DIR, 'data.json');
const BACKUP_FILE = path.join(DB_DIR, 'data.backup.json');

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '') || null;
const SUPABASE_KEY = process.env.SUPABASE_KEY || null;
const SUPABASE_ENABLED = !!(SUPABASE_URL && SUPABASE_KEY);
const SUPABASE_TABLE = 'kv_store';
const SUPABASE_ROW_KEY = 'esa_bank_main';

function emptyDb() {
  return {
    meta: { nextClientId: 10000001, nextDeviceSeq: 1, createdAt: new Date().toISOString() },
    users: [],        // {id, clientId, fullName, phone, passwordHash, passwordSalt, createdAt, kyc?:{...}}
    accounts: [],      // электронный кошелёк: {id, userId, accountNumber, balance, currency, isOwner, createdAt}
    cards: [],         // {id, userId, type:'visa'|'elkart', number, holderName, expiry, cvv, themeId, nickname, balance, annualFee, feeDueAt, status, createdAt}
    transactions: [],  // {id, fromRef, toRef, fromName, toName, amount, currency, method, note, status, createdAt, receiptNo}
    sessions: [],      // {token, userId, createdAt, expiresAt}
    resetCodes: [],    // {phone, code, expiresAt, used}
    piggyBanks: [],    // {id, userId, name, icon, targetAmount, balance, mode, autoAmount, lastAutoAt, createdAt}
    staff: [],         // {id, fullName, role, phone, passwordHash, passwordSalt, createdAt}
    staffSessions: [], // {token, staffId, createdAt, expiresAt}
    offices: [],       // {id, name, address, lat, lng, phone, hours, createdAt}
    devices: [],        // {id, deviceCode, kind, label, passwordHash, passwordSalt, officeId, location:{address,lat,lng}, cash:{denomination:count}, scannedSerials:[], pairToken, status, createdAt}
    deviceAuthSessions: [], // {token, deviceId, createdAt, expiresAt} — сессия киоска (банкомат/терминал)
    deviceSessions: [], // {id, deviceId, userId, pairedAt, active, expiresAt} — привязка телефона клиента к конкретному киоску
    depositSessions: [], // {id, deviceId, userId, notes:[{serial,denom,scannedAt}], total, startedAt, expiresAt, status}
    deviceReceipts: [], // {id, deviceId, deviceCode, type, amount, denominations, userId, receiptNo, createdAt}
    applications: [],   // {id, type:'passport_kyc', passport fields + facePhoto, createdByStaffId, userId, createdAt}
    withdrawRequests: [], // {id, deviceId, deviceCode, userId, amount, status:'pending'|'approved'|'rejected'|'expired', receipt?, newBalance?, error?, createdAt, expiresAt}
    billImageHashes: [], // {hash (64-bit dHash hex), serial, denom, deviceId, deviceCode, userId, scannedAt} — для распознавания повторного сканирования одной и той же купюры по фото (во всей системе, не только на одном устройстве)
    notifications: [] // {id, userId, type, title, body, data, read, createdAt} — реалдуу билдирмелер (колокольчик), ойдон чыгарылган эмес: акыркы учурлардын негизинде түзүлөт (которуу келди, терминалдан толукталды, банкоматтан алуу талабы/жыйынтыгы)
  };
}

// На случай обновления схемы в уже существующей базе — добиваем
// отсутствующие коллекции пустыми массивами, чтобы старые базы не падали.
function migrate(d) {
  const blank = emptyDb();
  for (const key of Object.keys(blank)) {
    if (!(key in d)) d[key] = blank[key];
  }
  if (!('nextDeviceSeq' in d.meta)) d.meta.nextDeviceSeq = 1;
  return d;
}

let db = null;
let pendingRemoteWrite = Promise.resolve();

// ---------- Локальный файл (кэш / единственное хранилище в офлайн-режиме) ----------

function loadLocalFile() {
  try {
    if (fs.existsSync(DB_FILE)) {
      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    }
  } catch (err) {
    console.error('[db] Локалдык файл бузулган, камдык көчүрмө сыналууда:', err.message);
    try {
      if (fs.existsSync(BACKUP_FILE)) {
        return JSON.parse(fs.readFileSync(BACKUP_FILE, 'utf8'));
      }
    } catch (err2) {
      console.error('[db] Камдык көчүрмө дагы бузулган:', err2.message);
    }
  }
  return null;
}

function persistLocalFile() {
  try {
    if (fs.existsSync(DB_FILE)) fs.copyFileSync(DB_FILE, BACKUP_FILE);
  } catch (_) { /* не критично */ }
  try {
    const tmpFile = DB_FILE + '.tmp';
    fs.writeFileSync(tmpFile, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmpFile, DB_FILE); // атомарная операция на уровне ФС
  } catch (err) {
    // На некоторых бесплатных хостингах файловая система доступна только
    // для чтения вне рабочей директории — не критично, если включён
    // онлайн-режим, т.к. основной источник истины тогда в Supabase.
    if (!SUPABASE_ENABLED) console.error('[db] Жазуу катасы (локалдык файл):', err.message);
  }
}

// ---------- Supabase (онлайн-режим) ----------

async function loadFromSupabase() {
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}?key=eq.${SUPABASE_ROW_KEY}&select=value`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase жүктөө катасы: ${res.status} ${text}`);
  }
  const rows = await res.json();
  if (rows && rows.length && rows[0].value) return rows[0].value;
  return null;
}

async function writeToSupabase(snapshot) {
  const url = `${SUPABASE_URL}/rest/v1/${SUPABASE_TABLE}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify([{ key: SUPABASE_ROW_KEY, value: snapshot, updated_at: new Date().toISOString() }])
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Supabase жазуу катасы: ${res.status} ${text}`);
  }
}

function queueSupabaseWrite() {
  if (!SUPABASE_ENABLED) return;
  // Снимок текущего состояния в момент вызова — чтобы параллельные
  // изменения не перепутали порядок записей.
  const snapshot = JSON.parse(JSON.stringify(db));
  pendingRemoteWrite = pendingRemoteWrite
    .then(() => writeToSupabase(snapshot))
    .catch(err => console.error('[db] Supabase-ге жазуу ишке ашкан жок (локалдык файл сакталды):', err.message));
}

// ---------- Публичный интерфейс ----------

async function load() {
  if (SUPABASE_ENABLED) {
    try {
      const remote = await loadFromSupabase();
      if (remote) {
        db = migrate(remote);
        console.log('[db] Онлайн база (Supabase) ийгиликтүү жүктөлдү.');
        persistLocalFile(); // держим локальный кэш актуальным
        return db;
      }
      console.log('[db] Supabase боюнча маалымат табылган жок — баштапкы абал түзүлөт.');
    } catch (err) {
      console.error('[db] Supabase менен байланыш жок, учурда локалдык файл колдонулат:', err.message);
    }
  }

  db = migrate(loadLocalFile() || emptyDb());
  persistLocalFile();
  if (SUPABASE_ENABLED) queueSupabaseWrite(); // выгружаем состояние в облако при первом удачном подключении
  return db;
}

function save() {
  persistLocalFile();
  queueSupabaseWrite();
}

function get() {
  if (!db) throw new Error('База маалымат жүктөлгөн жок — алгач load() чакырылышы керек.');
  return db;
}

function isOnline() {
  return SUPABASE_ENABLED;
}

module.exports = { get, save, load, isOnline };
