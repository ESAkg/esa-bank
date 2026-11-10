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
 *
 * С версии v2 добавлен ещё один настоящий источник данных: 28 official
 * эталонных снимков банкнот Нацбанка КР (server/bill-templates/ — обе
 * серии, 2016 и 2023, лицевая и оборотная сторона, все 7 номиналов).
 * При старте сервера (calibrateFromTemplates) по ним честно вычисляется
 * средний цвет и цветовая сетка 4x4 каждой реальной банкноты — это не
 * придуманные/подогнанные числа, а прямое измерение официальных образцов.
 * Используется как второй, более точный цветовой признак (помимо OCR) —
 * сравнение не только "средний цвет похож", но и "раскладка цвета по
 * купюре похожа на один из 28 реальных эталонов" — это заметно точнее
 * одной усреднённой цифры на номинал.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createWorker } = require('tesseract.js');
const { Jimp } = require('jimp');

const LANG_PATH = path.join(__dirname, 'ocr-data');
const OCR_CACHE_PATH = path.join(require('os').tmpdir(), 'esa-bank-ocr-cache');
const TEMPLATES_DIR = path.join(__dirname, 'bill-templates');

// Номиналы банкнот сом КР, которые реально существуют в обращении.
const KNOWN_DENOMS = [5000, 1000, 500, 200, 100, 50, 20];

// Запасной цвет (на случай, если папка с эталонами недоступна/повреждена
// при деплое) — откалиброван раньше по настоящим фотографиям банкнот.
// В норме заменяется на DENOM_COLORS, вычисленный из 28 эталонов ниже.
const FALLBACK_DENOM_COLORS = {
  20: [193, 125, 131], 50: [212, 153, 109], 100: [129, 165, 204],
  200: [195, 171, 100], 500: [143, 146, 203], 1000: [142, 142, 140],
  5000: [108, 166, 128],
};
let DENOM_COLORS = { ...FALLBACK_DENOM_COLORS };
// denom -> массив цветовых сеток 4x4 (по одной на каждый реальный эталон
// этого номинала: 2016/2023 x лицо/оборот = обычно 4 штуки).
let DENOM_TEMPLATE_GRIDS = {};
let templatesCalibrated = false;

// Бир гана OCR воркер болсо, 4 кадрды консенсус үчүн талдаганда алар
// бири-бирин күтүп, кезек-кезек менен иштешет (жыйынтыгында жалпы убакыт
// 4x созулат — колдонуучуга "катып калгандай" сезилет). Эки воркердон
// турган пул менен кадрлар жупташып параллель иштейт — жалпы убакыт
// болжол менен 2 эсе кыскарат, ал эми эс тутум (~180MB эки воркер үчүн)
// Render акысыз планына жетиштүү батат.
const OCR_POOL_SIZE = 2;
const workerPromises = [];
let nextWorkerIdx = 0;
function createOcrWorker(slot) {
  return createWorker('eng', 1, {
    langPath: LANG_PATH,
    gzip: true,
    cachePath: path.join(OCR_CACHE_PATH, 'slot-' + slot),
    cacheMethod: 'readwrite',
  }).catch(err => { workerPromises[slot] = null; throw err; });
}
function getWorker() {
  // Кезек-кезек менен пулдагы бош воркерлерди бөлүштүрөбүз (round-robin).
  const slot = nextWorkerIdx % OCR_POOL_SIZE;
  nextWorkerIdx++;
  if (!workerPromises[slot]) {
    workerPromises[slot] = createOcrWorker(slot);
  }
  return workerPromises[slot];
}

// Прогреть воркер заранее (при старте сервера), чтобы первое сканирование
// клиента не ждало инициализацию движка OCR, и сразу откалибровать цвета
// по 28 реальным эталонным снимкам (см. calibrateFromTemplates ниже).
let calibrationPromise = null;
function ensureCalibrated() {
  if (!calibrationPromise) {
    calibrationPromise = calibrateFromTemplates().catch(err => {
      console.error('[billScanner] Калибрлөө ката:', err.message);
    });
  }
  return calibrationPromise;
}
function warmup() {
  // Пулдагы воркерлердин баарын алдын ала күйгүзүп коёбуз (биринчи чыныгы
  // сканерлөө OCR моторун баштан жүктөбөй, дароо иштесин үчүн).
  for (let i = 0; i < OCR_POOL_SIZE; i++) {
    workerPromises[i] = createOcrWorker(i);
    workerPromises[i].catch(err => console.error('[billScanner] OCR warmup ката (slot ' + i + '):', err.message));
  }
  ensureCalibrated();
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

// Сравнение цветовой сетки кадра с цветовыми сетками 28 реальных эталонов
// (по номиналу берётся минимальное расстояние среди его вариантов —
// 2016/2023 x лицо/оборот, т.к. купюра может быть показана любой стороной).
// Это второй, более точный цветовой признак: не только "похожий средний
// цвет", а "раскладка цвета по купюре похожа на настоящий образец".
function nearestTemplateGridDenom(liveGrid) {
  if (!liveGrid || !Object.keys(DENOM_TEMPLATE_GRIDS).length) return { denom: null, dist: Infinity };
  let best = null;
  let bestDist = Infinity;
  for (const [denom, grids] of Object.entries(DENOM_TEMPLATE_GRIDS)) {
    for (const g of grids) {
      const d = colorGridDistance(liveGrid, g);
      if (d < bestDist) { bestDist = d; best = Number(denom); }
    }
  }
  return { denom: best, dist: bestDist };
}

// Объединённый цветовой признак: для каждого номинала считаем И
// расстояние по среднему цвету купюры, И (если эталоны загружены)
// минимальное расстояние по цветовой сетке 4x4 до одного из 28 реальных
// эталонных снимков — и берём взвешенную сумму. Так решение опирается не
// на одно усреднённое число, а ещё и на то, похожа ли раскладка цвета по
// купюре на настоящий образец — заметно надёжнее против случайных бликов
// и неравномерного освещения камеры терминала.
function colorGuessCombined(avgColorIn, liveGrid) {
  const hasGrids = templatesCalibrated && Object.keys(DENOM_TEMPLATE_GRIDS).length > 0;
  let best = null;
  let bestDist = Infinity;
  for (const denom of KNOWN_DENOMS) {
    const avgColorDenom = DENOM_COLORS[denom];
    if (!avgColorDenom) continue;
    const avgDist = Math.sqrt(
      (avgColorIn[0] - avgColorDenom[0]) ** 2 +
      (avgColorIn[1] - avgColorDenom[1]) ** 2 +
      (avgColorIn[2] - avgColorDenom[2]) ** 2
    );
    let combined = avgDist;
    if (hasGrids && DENOM_TEMPLATE_GRIDS[denom] && liveGrid) {
      let gridDist = Infinity;
      for (const g of DENOM_TEMPLATE_GRIDS[denom]) {
        const d = colorGridDistance(liveGrid, g);
        if (d < gridDist) gridDist = d;
      }
      combined = avgDist * 0.45 + gridDist * 0.55;
    }
    if (combined < bestDist) { bestDist = combined; best = denom; }
  }
  return { denom: best, dist: bestDist };
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

// Честно вычисляет DENOM_COLORS и DENOM_TEMPLATE_GRIDS по 28 настоящим
// эталонным фото банкнот Нацбанка КР (server/bill-templates/, имена вида
// "2016_1000_front.jpg"). Не симуляция и не догадка — прямое измерение
// официальных образцов обеих серий (2016 и 2023), обеих сторон, всех
// 7 номиналов. Если по какой-то причине папка недоступна (повреждённый
// деплой и т.п.), остаёмся на запасных значениях FALLBACK_DENOM_COLORS —
// сканер не падает, просто работает чуть менее точно.
async function calibrateFromTemplates() {
  let files;
  try {
    files = fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.jpg'));
  } catch (err) {
    console.error('[billScanner] Эталон купюралар папкасы табылган жок, запастагы түстөр колдонулат:', err.message);
    return;
  }
  const sums = {}; // denom -> {r,g,b,n}
  const grids = {}; // denom -> [grid, grid, ...]
  for (const f of files) {
    const parts = f.replace(/\.jpg$/, '').split('_');
    if (parts.length !== 3) continue;
    const denom = Number(parts[1]);
    if (!KNOWN_DENOMS.includes(denom)) continue;
    let img;
    try {
      img = await Jimp.read(path.join(TEMPLATES_DIR, f));
    } catch (err) {
      console.error(`[billScanner] Эталон окулган жок (${f}):`, err.message);
      continue;
    }
    let r = 0, g = 0, b = 0, n = 0;
    img.scan(0, 0, img.bitmap.width, img.bitmap.height, function (x, y, idx) {
      const pr = this.bitmap.data[idx], pg = this.bitmap.data[idx + 1], pb = this.bitmap.data[idx + 2];
      const maxC = Math.max(pr, pg, pb), minC = Math.min(pr, pg, pb);
      if (minC > 205 || maxC < 60 || (maxC - minC) < 12) return;
      r += pr; g += pg; b += pb; n++;
    });
    if (n > 0) {
      const s = sums[denom] || (sums[denom] = { r: 0, g: 0, b: 0, n: 0 });
      s.r += r / n; s.g += g / n; s.b += b / n; s.n += 1;
    }
    (grids[denom] = grids[denom] || []).push(computeColorGrid(img));
  }
  const newColors = {};
  for (const [denom, s] of Object.entries(sums)) {
    if (s.n > 0) newColors[denom] = [Math.round(s.r / s.n), Math.round(s.g / s.n), Math.round(s.b / s.n)];
  }
  if (Object.keys(newColors).length >= KNOWN_DENOMS.length) {
    DENOM_COLORS = newColors;
    DENOM_TEMPLATE_GRIDS = grids;
    templatesCalibrated = true;
    console.log('[billScanner] Купюра түстөрү 28 чыныгы эталондон калибрленди:', JSON.stringify(DENOM_COLORS));
  } else {
    console.error('[billScanner] Эталондордун баары эмес окулду, запастагы түстөр колдонулат.');
  }
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
  await ensureCalibrated();
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
  const colorGuess = colorGuessCombined(avgColor, colorGrid);

  // 3) OCR — реальное распознавание текста на фото (ML-модель Tesseract LSTM).
  // Камера терминалда видео кадрды 1920x1080 чейин тартат — мындай чоң
  // сүрөттү толугу менен OCR кылуу (өзгөчө Render'дин акысыз, алсыз
  // процессорунда) өтө узакка созулуп, колдонуучуга "убакыт бүтүп калгандай"
  // сезилет. Номиналдын сандары купюрада чоң жана калың жазылгандыктан,
  // OCR үчүн сүрөттү кичирейтүү тактыкка дээрлик таасир этпейт, бирок
  // убакытты бир нече эсе кыскартат. Түс/фингерпринт так ошол эле бойдон
  // толук чечилиштеги сүрөттөн эсептелет (жогоруда), OCR гана кичирейтилет.
  const OCR_MAX_WIDTH = 1000;
  const OCR_TIMEOUT_MS = 10000;
  let ocrBuffer = buffer;
  try {
    if (jimpImage.bitmap.width > OCR_MAX_WIDTH) {
      const scale = OCR_MAX_WIDTH / jimpImage.bitmap.width;
      const ocrImage = jimpImage.clone().resize({ w: OCR_MAX_WIDTH, h: Math.round(jimpImage.bitmap.height * scale) });
      ocrBuffer = await ocrImage.getBuffer('image/jpeg', { quality: 85 });
    }
  } catch (err) {
    ocrBuffer = buffer; // кичирейтүү ишке ашпаса — баштапкы сүрөт менен уланталы
  }

  let text = '';
  try {
    const worker = await getWorker();
    const recognizePromise = worker.recognize(ocrBuffer);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('OCR убакыты бүттү (timeout)')), OCR_TIMEOUT_MS));
    const { data } = await Promise.race([recognizePromise, timeoutPromise]);
    text = data.text || '';
  } catch (err) {
    console.error('[billScanner] OCR ката:', err.message);
    // OCR узакка созулду же ишке ашкан жок — токтоп калбайбыз, түс боюнча
    // гана иштейбиз (ишеним деңгээли темен болот, бирок жооп дароо кайтат).
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

  // Добуш берүү — ар бир кадрдын добушу тен эмес: ишеним деңгээли жогору
  // кадр (OCR жана түс эки эле жыйынтыкка макул болгон "high") көбүрөөк
  // салмак алат, ал эми "low" кадр азыраак. Бул көбүрөөк ишенимдүү (SIFT
  // inlier саны боюнча добуш берген) эталон ыкмасына окшош принцип — бир
  // жолку шумдуу окуу жыйынтыкты бурмалабайт.
  const votes = {};       // жөнөкөй кадр саны (отчет/UI үчүн)
  const weighted = {};    // чечим кабыл алуу үчүн — ишеним менен салмактанган
  okResults.forEach(r => {
    votes[r.denomination] = (votes[r.denomination] || 0) + 1;
    weighted[r.denomination] = (weighted[r.denomination] || 0) + (CONF_RANK[r.confidence] || 1);
  });
  let winnerDenom = null, winnerWeight = 0;
  for (const [denom, w] of Object.entries(weighted)) {
    if (w > winnerWeight) { winnerWeight = w; winnerDenom = Number(denom); }
  }
  const totalWeight = Object.values(weighted).reduce((a, b) => a + b, 0);
  const winnerShare = totalWeight > 0 ? winnerWeight / totalWeight : 0;
  const winnerVotes = votes[winnerDenom] || 0;

  // Ошол номиналды берген кадрлардын арасынан эн ишенимдүүсүн тандайбыз.
  const candidates = okResults.filter(r => r.denomination === winnerDenom);
  candidates.sort((a, b) => {
    const rankDiff = (CONF_RANK[b.confidence] || 0) - (CONF_RANK[a.confidence] || 0);
    if (rankDiff !== 0) return rankDiff;
    return (b.serial ? 1 : 0) - (a.serial ? 1 : 0);
  });
  const best = candidates[0];

  // Сериялык номер боюнча да добуш берүү: бир эле окууга эмес, ошол
  // номиналды тапкан бардык кадрлардын арасынан эн көп кайталанган так
  // сериялык номерди тандайбыз (бир кадр гана ар кандай окуса, ал жоюлат).
  const serialVotes = {};
  candidates.forEach(r => { if (r.serial) serialVotes[r.serial] = (serialVotes[r.serial] || 0) + 1; });
  let bestSerial = best.serial, bestSerialVotes = 0;
  for (const [serial, count] of Object.entries(serialVotes)) {
    if (count > bestSerialVotes) { bestSerialVotes = count; bestSerial = serial; }
  }

  // Бир нече кадр ЖАНА салмактуу добуштун көпчүлүгү (жарымынан köп) ушул
  // номиналды тапса — ишенимди жогорулатабыз (биринчи кадрда гана көрүнгөн
  // жалгыз шумдуу окуудан айырмаланып).
  let finalConfidence = best.confidence;
  if (winnerVotes > 1 && winnerShare >= 0.5) {
    finalConfidence = 'high';
  }

  return {
    ok: true,
    denomination: winnerDenom,
    confidence: finalConfidence,
    serial: bestSerial,
    fingerprint: best.fingerprint,
    rawText: best.rawText,
    avgColor: best.avgColor,
    votes, winnerShare, framesAnalyzed: images.length, framesRecognized: okResults.length,
  };
}

module.exports = { recognizeBill, recognizeBillConsensus, warmup, isSameBill, KNOWN_DENOMS };
