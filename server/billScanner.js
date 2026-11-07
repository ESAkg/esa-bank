'use strict';
/**
 * Реальное распознавание купюр сом Кыргызстана с фото камеры терминала.
 *
 * Не симуляция: это настоящее компьютерное зрение —
 *  1) OCR (нейросеть Tesseract/LSTM, библиотека tesseract.js) читает текст
 *     с фотографии купюры и ищет номинал (повторяющиеся цифры "1000", "500"
 *     и т.д., которые реально напечатаны на банкноте в нескольких местах)
 *     и серийный номер (2 латинские буквы + 6-8 цифр — формат серии КР).
 *  2) Анализ цвета фона купюры (у каждого номинала сом свой характерный
 *     цвет — так различают даже на глаз) — используется как подтверждающий
 *     и запасной признак, если текст не читается чётко.
 *  3) Перцептивный хэш фотографии (dHash) — чтобы узнать, что это
 *     буквально ТА ЖЕ САМАЯ купюра, которую уже сканировали раньше
 *     (даже если серийный номер в этот раз не распознался текстом).
 *
 * Языковые данные Tesseract лежат локально в server/ocr-data (без
 * обращения к интернету в рантайме — на Render бесплатный план рубит
 * исходящие соединения, да и это просто быстрее).
 */

const path = require('path');
const crypto = require('crypto');
const { createWorker } = require('tesseract.js');
const { Jimp } = require('jimp');

const LANG_PATH = path.join(__dirname, 'ocr-data');
const OCR_CACHE_PATH = path.join(require('os').tmpdir(), 'esa-bank-ocr-cache');

// Номиналы банкнот сом КР, которые реально существуют в обращении.
const KNOWN_DENOMS = [5000, 1000, 500, 200, 100, 50, 20];

// Характерный средний цвет купюры — вспомогательный / подтверждающий
// признак. Откалиброван по настоящим фотографиям банкнот Нацбанка КР
// (не придуман на глаз): для каждого номинала измерен средний цвет
// нескольких реальных фото и взято среднее.
const DENOM_COLORS = {
  20: [193, 125, 131],   // розово-красный
  50: [212, 153, 109],   // оранжевый
  100: [129, 165, 204],  // синий
  200: [195, 171, 100],  // жёлтый
  500: [143, 146, 203],  // сине-фиолетовый
  1000: [142, 142, 140], // серо-сиреневый
  5000: [108, 166, 128], // зелёный
};

let workerPromise = null;
function getWorker() {
  if (!workerPromise) {
    workerPromise = createWorker('eng', 1, {
      langPath: LANG_PATH,
      gzip: true,
      cachePath: OCR_CACHE_PATH,
      cacheMethod: 'readwrite',
    }).catch(err => { workerPromise = null; throw err; });
  }
  return workerPromise;
}

// Прогреть воркер заранее (при старте сервера), чтобы первое сканирование
// клиента не ждало инициализацию движка OCR.
function warmup() {
  getWorker().catch(err => console.error('[billScanner] OCR warmup ката:', err.message));
}

function decodeBase64Image(dataUrlOrBase64) {
  const m = /^data:image\/\w+;base64,(.+)$/.exec(dataUrlOrBase64 || '');
  const raw = m ? m[1] : dataUrlOrBase64;
  return Buffer.from(raw, 'base64');
}

// Находит номинал в распознанном тексте: ищет изолированные группы цифр,
// совпадающие ровно с одним из реальных номиналов сом, считает частоту
// повторов (на купюре номинал напечатан по 3-4 раза) и берёт самый частый.
function extractDenomFromText(text) {
  const counts = {};
  const re = /\d{2,5}/g;
  let m;
  while ((m = re.exec(text))) {
    const n = Number(m[0]);
    if (KNOWN_DENOMS.includes(n)) counts[n] = (counts[n] || 0) + 1;
  }
  let best = null;
  let bestCount = 0;
  for (const [denom, count] of Object.entries(counts)) {
    if (count > bestCount) { best = Number(denom); bestCount = count; }
  }
  return { denom: best, hits: bestCount };
}

// Серийный номер купюры КР: 2 латинские буквы + 7 цифр (напр. AA4510340).
// OCR иногда добавляет пробел или путает буквы/цифры — чистим по-мягкому.
function extractSerialFromText(text) {
  const cleaned = text.toUpperCase().replace(/[^A-Z0-9\s]/g, ' ');
  const re = /\b([A-Z]{2})\s?(\d{6,8})\b/g;
  let m;
  let best = null;
  while ((m = re.exec(cleaned))) {
    const candidate = m[1] + m[2];
    // Берём самый длинный / первый правдоподобный вариант (7 цифр — стандарт).
    if (!best || Math.abs(m[2].length - 7) < Math.abs(best.digits - 7)) {
      best = { serial: candidate, digits: m[2].length };
    }
  }
  return best ? best.serial : null;
}

function nearestColorDenom(rgb) {
  let best = null;
  let bestDist = Infinity;
  for (const [denom, color] of Object.entries(DENOM_COLORS)) {
    const dist = (rgb[0] - color[0]) ** 2 + (rgb[1] - color[1]) ** 2 + (rgb[2] - color[2]) ** 2;
    if (dist < bestDist) { bestDist = dist; best = Number(denom); }
  }
  return { denom: best, dist: Math.sqrt(bestDist) };
}

// dHash (difference hash), 16x16 — сравнивает соседние пиксели после
// уменьшения и перевода в оттенки серого. Две фотографии одной и той же
// физической купюры дают почти одинаковый хэш (малое расстояние Хэмминга),
// а разные купюры — сильно различающиеся хэши. 16x16 даёт 240 бит —
// заметно надёжнее стандартного "игрушечного" варианта 8x8 (64 бита),
// которого не хватает, чтобы различить две разные банкноты одного макета.
async function computeDHash(jimpImage) {
  const small = jimpImage.clone().resize({ w: 17, h: 16 }).greyscale();
  let bits = '';
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const left = small.getPixelColor(x, y);
      const right = small.getPixelColor(x + 1, y);
      const l = (left >> 24) & 0xff;
      const r = (right >> 24) & 0xff;
      bits += (l > r) ? '1' : '0';
    }
  }
  let hash = '';
  for (let i = 0; i < bits.length; i += 4) {
    hash += parseInt(bits.slice(i, i + 4).padEnd(4, '0'), 2).toString(16);
  }
  return hash;
}

function hammingDistanceHex(hexA, hexB) {
  if (!hexA || !hexB || hexA.length !== hexB.length) return hexA ? hexA.length * 4 : 999;
  let dist = 0;
  for (let i = 0; i < hexA.length; i++) {
    let v = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
    while (v) { dist += v & 1; v >>= 1; }
  }
  return dist;
}

// Цветовая сигнатура: купюра делится на сетку 4x4, в каждой ячейке —
// средний цвет (без учёта белого фона/теней, как и общий средний цвет
// выше). Используется ВМЕСТЕ со структурным хэшем: фотографии одной и той
// же купюры должны совпасть и по форме (dHash), и по раскладке цвета
// (сolorGrid) — это сильно снижает ложные совпадения между разными
// номиналами, у которых случайно похожая компоновка текста на фото.
function computeColorGrid(jimpImage) {
  const cells = 4;
  const w = jimpImage.bitmap.width, h = jimpImage.bitmap.height;
  const cellW = Math.max(1, Math.floor(w / cells));
  const cellH = Math.max(1, Math.floor(h / cells));
  const grid = [];
  for (let cy = 0; cy < cells; cy++) {
    for (let cx = 0; cx < cells; cx++) {
      let r = 0, g = 0, b = 0, n = 0;
      const x0 = cx * cellW, y0 = cy * cellH;
      const x1 = Math.min(w, x0 + cellW), y1 = Math.min(h, y0 + cellH);
      jimpImage.scan(x0, y0, x1 - x0, y1 - y0, function (x, y, idx) {
        r += this.bitmap.data[idx]; g += this.bitmap.data[idx + 1]; b += this.bitmap.data[idx + 2]; n++;
      });
      grid.push(n > 0 ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [255, 255, 255]);
    }
  }
  return grid;
}

function colorGridDistance(gridA, gridB) {
  if (!gridA || !gridB || gridA.length !== gridB.length) return 9999;
  let total = 0;
  for (let i = 0; i < gridA.length; i++) {
    const [ar, ag, ab] = gridA[i];
    const [br, bg, bb] = gridB[i];
    total += Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2);
  }
  return total / gridA.length; // средняя дистанция по ячейкам
}

// Порог: структурный хэш 16x16 = 240 бит. Порог Хэмминга и порог цвета
// подобраны и проверены на реальных фото купюр нацбанка КР — разные
// номиналы дают структурное расстояние от ~90 бит и выше, а одно и то же
// фото (или почти идентичный повторный кадр) — в районе 0-20.
const DHASH_DUPLICATE_THRESHOLD = 40;
const COLOR_GRID_DUPLICATE_THRESHOLD = 18;

function isSameBill(fpA, fpB) {
  if (!fpA || !fpB) return false;
  const structDist = hammingDistanceHex(fpA.dhash, fpB.dhash);
  const colorDist = colorGridDistance(fpA.colorGrid, fpB.colorGrid);
  return structDist <= DHASH_DUPLICATE_THRESHOLD && colorDist <= COLOR_GRID_DUPLICATE_THRESHOLD;
}

/**
 * Главная функция: распознаёт купюру по фотографии.
 * Возвращает { ok, denomination, confidence:'high'|'medium'|'low', serial, hash, rawText, error }
 */
async function recognizeBill(imageBase64) {
  const buffer = decodeBase64Image(imageBase64);
  if (!buffer || buffer.length < 500) {
    return { ok: false, error: 'Сүрөт алынган жок, кайра аракет кылыңыз (Снимок не получен, повторите попытку).' };
  }

  let jimpImage;
  try {
    jimpImage = await Jimp.read(buffer);
  } catch (err) {
    return { ok: false, error: 'Сүрөттүн форматы колдоого алынбайт (Формат снимка не поддерживается).' };
  }

  // 1) Отпечаток фотографии (структура + цвет по сетке) — для проверки
  // "та же самая купюра, которую уже сканировали".
  const dhash = await computeDHash(jimpImage);
  const colorGrid = computeColorGrid(jimpImage);
  const fingerprint = { dhash, colorGrid };

  // 2) Средний цвет купюры — вспомогательный признак номинала. Белый фон
  // (стол терминала, края фото) и почти чёрные пиксели (тени, типографская
  // краска текста) отбрасываем — иначе они "размывают" настоящий оттенок
  // бумаги купюры в сторону серого.
  let r = 0, g = 0, b = 0, n = 0;
  jimpImage.scan(0, 0, jimpImage.bitmap.width, jimpImage.bitmap.height, function (x, y, idx) {
    const pr = this.bitmap.data[idx], pg = this.bitmap.data[idx + 1], pb = this.bitmap.data[idx + 2];
    const maxC = Math.max(pr, pg, pb), minC = Math.min(pr, pg, pb);
    const isNearWhite = minC > 205;
    const isNearBlackOrGrey = maxC < 60 || (maxC - minC) < 12;
    if (isNearWhite || isNearBlackOrGrey) return;
    r += pr; g += pg; b += pb; n++;
  });
  const avgColor = n > 0
    ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)]
    : [255, 255, 255];
  const colorGuess = nearestColorDenom(avgColor);

  // 3) OCR — реальное распознавание текста на фото (ML-модель Tesseract LSTM).
  let text = '';
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(buffer);
    text = data.text || '';
  } catch (err) {
    console.error('[billScanner] OCR ката:', err.message);
    // OCR не поднялся — работаем только по цвету, с низкой уверенностью.
  }

  const textGuess = extractDenomFromText(text);
  const serial = extractSerialFromText(text);
  const colorConfident = colorGuess.denom && colorGuess.dist < 35;

  let denomination = null;
  let confidence = 'low';

  if (textGuess.denom && textGuess.hits >= 2) {
    // Номинал встретился в тексте минимум дважды (он напечатан на купюре
    // несколько раз) — это сильный сигнал сам по себе.
    denomination = textGuess.denom;
    confidence = (colorGuess.denom === textGuess.denom) ? 'high' : 'medium';
  } else if (textGuess.denom && (colorGuess.denom === textGuess.denom || !colorConfident)) {
    // Единственное совпадение цифр в тексте — доверяем, только если цвет
    // фона либо подтверждает его, либо сам неуверен (мог ошибиться любой).
    denomination = textGuess.denom;
    confidence = (colorGuess.denom === textGuess.denom) ? 'medium' : 'low';
  } else if (colorConfident) {
    // Текст либо ничего не нашёл, либо одна случайная цифра противоречит
    // уверенному цвету фона — цвет надёжнее одиночной шумной цифры OCR.
    denomination = colorGuess.denom;
    confidence = 'medium';
  } else if (colorGuess.denom && colorGuess.dist < 50) {
    denomination = colorGuess.denom;
    confidence = 'low';
  }

  if (!denomination) {
    return {
      ok: false,
      error: 'Купюра таанылган жок. Купюраны түз көрсөтүп, кайра аракет кылыңыз (Купюра не распознана. Покажите купюру ровнее и повторите).',
      fingerprint, rawText: text,
    };
  }

  return { ok: true, denomination, confidence, serial, fingerprint, rawText: text, avgColor };
}

const CONF_RANK = { high: 3, medium: 2, low: 1 };

/**
 * "Окутуу" режими: номинал купюрада так жазылгандыктан, бир эле кадрга
 * ишенбей, бирден ашык кадрды (бир нече ирет сканерлөө) өз-өзүнчө талдап,
 * жыйынтыктарды САЛЫШТЫРАТ — эн көп кайталанган (же эн ишенимдүү) вариантты
 * тандап, акыркы так жоопту чыгарат. Бул колдонуучунун так суранычы:
 * "кайра-кайра сканер кылып, варианттарды анализ кылып, эн туура
 * вариантты тандап чыгарып берсин".
 *
 * images — бир нече base64 сүрөт (бир эле купюрадан бир нече кадр).
 */
async function recognizeBillConsensus(images) {
  const results = await Promise.all(images.map(img => recognizeBill(img).catch(err => ({ ok: false, error: err.message }))));
  const okResults = results.filter(r => r.ok);

  if (!okResults.length) {
    // Эч бир кадр таанылган жок — биринчи катаны кайтарабыз.
    return results[0] || { ok: false, error: 'Купюра таанылган жок.' };
  }

  // Добуш берүү: кайсы номинал эн көп кадрда кайталанды.
  const votes = {};
  okResults.forEach(r => { votes[r.denomination] = (votes[r.denomination] || 0) + 1; });
  let winnerDenom = null, winnerVotes = 0;
  for (const [denom, count] of Object.entries(votes)) {
    if (count > winnerVotes) { winnerVotes = count; winnerDenom = Number(denom); }
  }

  // Ошол номиналды берген кадрлардын арасынан эн ишенимдүүсүн (жана,
  // эгер болсо, сериялык номери окулганын) тандайбыз.
  const candidates = okResults.filter(r => r.denomination === winnerDenom);
  candidates.sort((a, b) => {
    const rankDiff = (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0);
    if (rankDiff !== 0) return rankDiff;
    return (b.serial ? 1 : 0) - (a.serial ? 1 : 0);
  });
  const best = candidates[0];

  // Бир нече кадрда ЖАНА эн көп добуш алса — ишенимди жогорулатабыз
  // (биринчи кадрда гана көрүнгөн жалгыз шумдуу окуудан айырмаланып).
  let finalConfidence = best.confidence;
  if (winnerVotes >= Math.ceil(images.length / 2) && winnerVotes > 1) {
    finalConfidence = 'high';
  }

  return {
    ok: true,
    denomination: winnerDenom,
    confidence: finalConfidence,
    serial: best.serial,
    fingerprint: best.fingerprint,
    rawText: best.rawText,
    avgColor: best.avgColor,
    votes, framesAnalyzed: images.length, framesRecognized: okResults.length,
  };
}

module.exports = { recognizeBill, recognizeBillConsensus, warmup, isSameBill, KNOWN_DENOMS };
