'use strict';

function normalizePhone(raw) {
  if (!raw) return '';
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 9) digits = '996' + digits;
  else if (digits.length === 10 && digits.startsWith('0')) digits = '996' + digits.slice(1);
  else if (digits.length === 12 && digits.startsWith('996')) { /* ok */ }
  return digits;
}

function formatPhone(digits) {
  if (!digits || digits.length !== 12) return digits;
  // 996 700 123 456
  return `+${digits.slice(0,3)} ${digits.slice(3,6)} ${digits.slice(6,9)}-${digits.slice(9,12)}`;
}

function genAccountNumber(clientId) {
  const part = (n) => String(n).padStart(4, '0');
  const rnd = () => Math.floor(Math.random() * 10000);
  return `KY${part(12)}${String(clientId).slice(-4).padStart(4,'0')}${part(rnd())}${part(rnd())}`.match(/.{1,4}/g).join(' ');
}

function genReceiptNo() {
  const d = new Date();
  const y = d.getFullYear() % 100;
  const stamp = `${y}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const rnd = Math.floor(Math.random() * 1e6);
  return `ESA${stamp}${String(rnd).padStart(6, '0')}`;
}

function money(n) {
  return Math.round(Number(n) * 100) / 100;
}

// ---------- Карты ----------
// BIN-подобные префиксы — вымышленные, принадлежат только ESA Bank.
const CARD_BIN = { visa: '4169', elkart: '6220' };
function genCardNumberSimple(type) {
  const bin = CARD_BIN[type] || '9999';
  const g = () => String(Math.floor(1000 + Math.random() * 9000));
  return `${bin} ${g()} ${g()} ${g()}`;
}
function genCvv() {
  return String(Math.floor(100 + Math.random() * 900));
}
function cardExpiry(yearsFromNow) {
  const d = new Date();
  d.setFullYear(d.getFullYear() + yearsFromNow);
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getFullYear()).slice(-2)}`;
}
function maskCardNumber(number) {
  const digits = String(number).replace(/\s/g, '');
  return `•• ${digits.slice(-4)}`;
}

// ---------- Устройства (банкоматы / терминалы) ----------
function genDeviceCode(kind) {
  const prefix = kind === 'atm' ? 'ATM' : kind === 'terminal' ? 'TRM' : 'ESA';
  const rnd = Math.floor(1000 + Math.random() * 9000);
  return `${prefix}-${rnd}`;
}

module.exports = {
  normalizePhone, formatPhone, genAccountNumber, genReceiptNo, money,
  genCardNumberSimple, genCvv, cardExpiry, maskCardNumber, genDeviceCode
};
