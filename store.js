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
    meta: { nextClientId: 10000001, createdAt: new Date().toISOString() },
    users: [],        // {id, clientId, fullName, phone, passwordHash, passwordSalt, createdAt}
    accounts: [],      // {id, userId, accountNumber, balance, currency, isOwner, createdAt}
    transactions: [],  // {id, fromAccountId, toAccountId, fromName, toName, amount, currency, method, note, status, createdAt, receiptNo}
    sessions: [],      // {token, userId, createdAt, expiresAt}
    resetCodes: []     // {phone, code, expiresAt, used}
  };
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
        db = remote;
        console.log('[db] Онлайн база (Supabase) ийгиликтүү жүктөлдү.');
        persistLocalFile(); // держим локальный кэш актуальным
        return db;
      }
      console.log('[db] Supabase боюнча маалымат табылган жок — баштапкы абал түзүлөт.');
    } catch (err) {
      console.error('[db] Supabase менен байланыш жок, учурда локалдык файл колдонулат:', err.message);
    }
  }

  db = loadLocalFile() || emptyDb();
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
