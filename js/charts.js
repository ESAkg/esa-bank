'use strict';
/* ESA Bank — легкие canvas-графики без внешних библиотек (офлайн-дружелюбно для PWA) */

function dpr() { return Math.min(window.devicePixelRatio || 1, 2); }

function prepCanvas(canvas) {
  const ratio = dpr();
  const w = canvas.clientWidth || canvas.parentElement.clientWidth || 300;
  const h = canvas.clientHeight || parseInt(canvas.getAttribute('height') || '180', 10);
  canvas.width = Math.round(w * ratio);
  canvas.height = Math.round(h * ratio);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w, h };
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// ---------- Line / area chart (income vs expense over N days) ----------
function drawLineChart(canvasId, series, labels) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);

  const padL = 38, padR = 10, padT = 14, padB = 24;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const allVals = series.flatMap(s => s.data);
  const maxV = Math.max(1, ...allVals);
  const niceMax = Math.ceil(maxV / 5) * 5 || 1;

  ctx.strokeStyle = cssVar('--border-subtle') || 'rgba(255,255,255,0.08)';
  ctx.fillStyle = cssVar('--text-dim') || '#9fb3d1';
  ctx.font = '10px Inter, sans-serif';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = padT + (plotH / 4) * i;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    const val = Math.round(niceMax - (niceMax / 4) * i);
    ctx.fillText(formatCompact(val), 2, y + 3);
  }

  const n = labels.length;
  const stepX = n > 1 ? plotW / (n - 1) : 0;

  series.forEach(s => {
    const pts = s.data.map((v, i) => [padL + stepX * i, padT + plotH - (v / niceMax) * plotH]);
    // area fill
    const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, s.color + '33');
    grad.addColorStop(1, s.color + '00');
    ctx.beginPath();
    ctx.moveTo(pts[0][0], padT + plotH);
    pts.forEach(p => ctx.lineTo(p[0], p[1]));
    ctx.lineTo(pts[pts.length - 1][0], padT + plotH);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    // line
    ctx.beginPath();
    pts.forEach((p, i) => i === 0 ? ctx.moveTo(p[0], p[1]) : ctx.lineTo(p[0], p[1]));
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2.2;
    ctx.lineJoin = 'round';
    ctx.stroke();
    // dots
    pts.forEach(p => {
      ctx.beginPath(); ctx.arc(p[0], p[1], 2.6, 0, Math.PI * 2);
      ctx.fillStyle = s.color; ctx.fill();
    });
  });

  ctx.fillStyle = cssVar('--text-dim') || '#9fb3d1';
  ctx.font = '10px Inter, sans-serif';
  ctx.textAlign = 'center';
  labels.forEach((lab, i) => {
    ctx.fillText(lab, padL + stepX * i, h - 6);
  });
  ctx.textAlign = 'left';
}

function formatCompact(n) {
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(n % 1000 === 0 ? 0 : 1) + 'k';
  return String(n);
}

// ---------- Donut chart (spending by category) ----------
function drawDonutChart(canvasId, slices) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const { ctx, w, h } = prepCanvas(canvas);
  ctx.clearRect(0, 0, w, h);
  const cx = w / 2, cy = h / 2;
  const r = Math.min(w, h) / 2 - 4;
  const inner = r * 0.62;
  const total = slices.reduce((a, s) => a + s.value, 0);

  if (!total) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = cssVar('--border-subtle') || 'rgba(255,255,255,0.12)';
    ctx.lineWidth = r - inner;
    ctx.stroke();
    return;
  }

  let start = -Math.PI / 2;
  slices.forEach(s => {
    const angle = (s.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, (r + inner) / 2, start, start + angle);
    ctx.lineWidth = r - inner;
    ctx.strokeStyle = s.color;
    ctx.lineCap = slices.length > 1 ? 'butt' : 'round';
    ctx.stroke();
    start += angle;
  });
}

window.ESACharts = { drawLineChart, drawDonutChart };
