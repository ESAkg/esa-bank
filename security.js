'use strict';
const crypto = require('crypto');

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, expectedHash) {
  const { hash } = hashPassword(password, salt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expectedHash, 'hex');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

function newId() {
  return crypto.randomUUID();
}

function sixDigitCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

module.exports = { hashPassword, verifyPassword, newToken, newId, sixDigitCode };
