'use strict';

// ═══════════════════════════════════════════════════════════
//  ЕГЭ РАННЕР — бесконечный пиксельный раннер
// ═══════════════════════════════════════════════════════════

// ── Canvas & масштаб ─────────────────────────────────────────────
// Виртуальное разрешение игры. PIXEL — сколько реальных пикселей на 1 виртуальный.
// Итог: canvas = 768×432 пикс, масштабируется CSS под экран без потери чёткости.
const W = 256, H = 144, PIXEL = 3;

const canvas = document.getElementById('c');
if (!canvas) throw new Error('canvas #c not found');
canvas.width  = W * PIXEL;
canvas.height = H * PIXEL;

const ctx = canvas.getContext('2d');
if (!ctx) throw new Error('2d context not available');
ctx.imageSmoothingEnabled = false;
ctx.scale(PIXEL, PIXEL);   // все дальнейшие координаты — виртуальные

// ── Определяем устройство ─────────────────────────────────────────
const isMobile = ('ontouchstart' in window) ||
  (typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches);

function resize() {
  const s = Math.min(window.innerWidth / (W * PIXEL), window.innerHeight / (H * PIXEL));
  canvas.style.width  = Math.round(W * PIXEL * s) + 'px';
  canvas.style.height = Math.round(H * PIXEL * s) + 'px';
}
window.addEventListener('resize', resize);
resize();

// ── Константы ────────────────────────────────────────────────────
const GROUND_Y  = 114;
const GRAVITY   = 0.38;
const JUMP1     = -8;
const JUMP2     = -7;
const COYOTE    = 8;
const JUMP_BUF  = 10;
const SPD_START = 2.5;
const SPD_MAX   = 9;
const SPD_ACCEL = 0.0006;

// Фазы неба: [метры, [верх, середина, горизонт]]
const SKY_PHASES = [
  [0,   [[10,35,100],  [25,118,210],  [179,229,252]]],  // день
  [300, [[20,8,50],    [120,0,140],   [255,130,0  ]]],  // закат
  [600, [[2,2,12],     [8,15,40],     [15,30,70   ]]],  // ночь
];

// Города: сгенерировать один раз
let cityScrollX = 0;
const CITY_W = W * 4;
const CITY_BLDS = [];
(function() {
  let x = 0;
  while (x < CITY_W) {
    const w = 10 + ~~(Math.random() * 18);
    const h = 20 + ~~(Math.random() * 40);
    const wins = [];
    for (let wy = 4; wy < h - 4; wy += 6) {
      for (let wx = 2; wx < w - 2; wx += 5) {
        wins.push({ dx: wx, dy: wy, lit: Math.random() > 0.4 });
      }
    }
    CITY_BLDS.push({ x, w, h, wins });
    x += w + 2 + ~~(Math.random() * 6);
  }
})();

// Передний план (камни, кустики, пеньки)
let fgScrollX = 0;
const FGRD = Array.from({ length: 18 }, () => ({
  x:    ~~(Math.random() * W * 2.5),
  type: ~~(Math.random() * 3),
  w:    3 + ~~(Math.random() * 7),
  h:    2 + ~~(Math.random() * 5),
}));

// ── Глобальное состояние ─────────────────────────────────────────
let state   = 'start';   // start | playing | dying | gameover
let gSpeed  = SPD_START;
let frame   = 0;
let meters  = 0;
let dodged  = 0;
let combo   = 0;
let score   = 0;
let hiScore = +localStorage.getItem('hi') || 0;
let shake   = 0;
let flash   = 0;

// ── Ввод ─────────────────────────────────────────────────────────
let jumpBuf = 0;

function onJump() {
  jumpBuf = JUMP_BUF;
  if (state === 'start' || state === 'gameover') { startGame(); return; }
}

window.addEventListener('keydown', e => {
  if (e.code === 'Space' || e.code === 'ArrowUp') { e.preventDefault(); onJump(); }
});
function getVirtualCoords(e) {
  const rect = canvas.getBoundingClientRect();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  return {
    x: (clientX - rect.left) * (W * PIXEL / rect.width)  / PIXEL,
    y: (clientY - rect.top)  * (H * PIXEL / rect.height) / PIXEL,
  };
}

canvas.addEventListener('pointerdown', e => {
  if (state === 'quiz') {
    if (quizAnswered) return;
    const v = getVirtualCoords(e);
    for (const btn of QUIZ_BTNS) {
      if (v.x >= btn.x && v.x <= btn.x + btn.w && v.y >= btn.y && v.y <= btn.y + btn.h) {
        answerQuiz(btn.idx);
        return;
      }
    }
    return;
  }
  onJump();
});

// ── Вспомогательные функции ───────────────────────────────────────
function box(x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(~~x, ~~y, w, h); }

function lerpRGB(a, b, t) {
  return a.map((v, i) => ~~(v + (b[i] - v) * t));
}
function rgbStr([r, g, b]) { return `rgb(${r},${g},${b})`; }

function skyColor() {
  const m = Math.min(meters, SKY_STOPS[SKY_STOPS.length - 1][0]);
  for (let i = 0; i < SKY_STOPS.length - 1; i++) {
    const [ma, ca] = SKY_STOPS[i];
    const [mb, cb] = SKY_STOPS[i + 1];
    if (m >= ma && m <= mb) {
      return rgbStr(lerpRGB(ca, cb, (m - ma) / (mb - ma)));
    }
  }
  return rgbStr(SKY_STOPS[SKY_STOPS.length - 1][1]);
}

function nightness() { return Math.min(Math.max((meters - 300) / 200, 0), 1); }

function getSkyGradient() {
  const m = Math.min(meters, 600);
  let a, b, t;
  if (m < 300) { a = SKY_PHASES[0][1]; b = SKY_PHASES[1][1]; t = m / 300; }
  else          { a = SKY_PHASES[1][1]; b = SKY_PHASES[2][1]; t = (m - 300) / 300; }
  const cols = a.map((ca, i) => lerpRGB(ca, b[i], t));
  const g = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  g.addColorStop(0,    rgbStr(cols[0]));
  g.addColorStop(0.45, rgbStr(cols[1]));
  g.addColorStop(1,    rgbStr(cols[2]));
  return g;
}

function drawSun(night) {
  const day = 1 - Math.min(night * 2.5, 1);
  if (day < 0.05) return;
  const t = Math.min(meters / 500, 1);
  const sx = W * 0.82 - t * W * 0.65;
  const sy = 13 + Math.sin(t * Math.PI) * (-4);
  ctx.save();
  ctx.globalAlpha = day * 0.12; ctx.fillStyle = '#fff8dc';
  ctx.beginPath(); ctx.arc(sx, sy, 16, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = day * 0.22;
  ctx.beginPath(); ctx.arc(sx, sy, 11, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = day * 0.95; ctx.fillStyle = '#fdd835';
  ctx.beginPath(); ctx.arc(sx, sy, 6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#fffde7'; ctx.globalAlpha = day;
  ctx.beginPath(); ctx.arc(sx, sy, 3.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawMoon(night) {
  if (night < 0.3) return;
  const alpha = Math.min((night - 0.3) / 0.4, 1);
  const mx = 28 + Math.sin(meters * 0.0015) * 18, my = 14;
  const skyTop = lerpRGB(SKY_PHASES[1][1][0], SKY_PHASES[2][1][0],
                         Math.min(Math.max((meters - 300) / 300, 0), 1));
  ctx.save();
  ctx.globalAlpha = alpha * 0.2; ctx.fillStyle = '#fffde7';
  ctx.beginPath(); ctx.arc(mx, my, 11, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = alpha; ctx.fillStyle = '#fffde7';
  ctx.beginPath(); ctx.arc(mx, my, 6.5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = rgbStr(skyTop);   // crescent cut-out
  ctx.beginPath(); ctx.arc(mx + 3.5, my - 1, 5.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawAurora(night) {
  const v = Math.min(Math.max((meters - 700) / 150, 0), 1) * night;
  if (v < 0.05) return;
  const bands = [[0,220,100],[80,180,255],[100,60,220],[200,0,255]];
  ctx.save();
  bands.forEach((c, i) => {
    const yw = 16 + i * 10 + Math.sin(frame * 0.018 + i * 1.4) * 9;
    const bh =  8 + Math.cos(frame * 0.013 + i * 0.8) * 5;
    const al = v * (0.12 + Math.sin(frame * 0.022 + i) * 0.07);
    const g = ctx.createLinearGradient(0, yw, 0, yw + bh);
    const cs = `rgba(${c.join(',')},`;
    g.addColorStop(0, cs + '0)'); g.addColorStop(0.4, cs + al + ')');
    g.addColorStop(0.6, cs + al + ')'); g.addColorStop(1, cs + '0)');
    ctx.fillStyle = g; ctx.fillRect(0, yw, W, bh);
  });
  ctx.restore();
}

function drawCity(night) {
  if (night < 0.1) return;
  // Плавное появление: начинается при night=0.1, полностью при night=0.55
  const cityAlpha = Math.min(Math.max((night - 0.1) / 0.45, 0), 0.92);
  if (cityAlpha < 0.02) return;
  ctx.save();
  for (const b of CITY_BLDS) {
    const bx = ((b.x - cityScrollX * 0.32) % CITY_W + CITY_W) % CITY_W - 15;
    if (bx > W + 20 || bx + b.w < -5) continue;
    // Плавное появление у правого края экрана
    const edgeFade = bx > W - 30 ? Math.max(0, (W - bx) / 30) : 1;
    ctx.globalAlpha = cityAlpha * edgeFade;
    const by = GROUND_Y - 5 - b.h;
    ctx.fillStyle = '#0a1220'; ctx.fillRect(bx, by, b.w, b.h);
    // Крыша
    ctx.fillStyle = '#111d30'; ctx.fillRect(bx, by, b.w, 2);
    if (night > 0.35) {
      for (const w of b.wins) {
        if (w.lit) {
          if (Math.random() > 0.9985) w.lit = false;
          ctx.fillStyle = Math.random() > 0.9 ? '#ff8f00' : '#ffd54f';
          ctx.fillRect(bx + w.dx, by + w.dy, 2, 2);
        } else if (Math.random() > 0.9992) { w.lit = true; }
      }
    }
  }
  ctx.restore();
}

// ── Pixel art sprites ─────────────────────────────────────────────
// Каждый спрайт — массив строк; символ → CSS-цвет (null = прозрачно).
const PAL = {
  '.': null,
  'H': '#3e2723', 'K': '#6d4c41', 'k': '#a1887f',   // волосы
  'S': '#ffcc80', 's': '#ffb74d',                     // кожа
  'E': '#1a1a1a',                                      // глаз
  'R': '#ef5350', 'r': '#b71c1c', 'd': '#ff8a80',    // рубашка
  'B': '#1565c0', 'b': '#0d47a1',                     // штаны
  'W': '#f5f5f5', 'w': '#e0e0e0',                     // кроссовок
  'G': '#546e7a', 'g': '#37474f',                     // подошва
};

const PLAYER_W = 12, PLAYER_H = 18;

// 5 кадров: run0-3 + jump  (dead = run1 с поворотом)
// Формат: 12 колонок × 18 строк, персонаж смотрит вправо
const SPR_DATA = {
  run0: [                          // широкий шаг, левая нога вперёд
    '..KKKk......',
    '.KHHHKk.....',
    '.KSSSSsK....',
    '.KSESEsK....',
    '..SSSSs.....',
    '..RRRRRr....',
    '.RRRRRRRr...',
    'SrRRdRRRr...',                // S col0 = рука назад (вверх)
    '.rRRRRRRrs..',                // s col9 = рука вперёд (вниз)
    '.rRRRRRRr...',
    '..rRRRRr....',
    '..BBbBBB....',
    '.bBBbBBBb...',
    'bBBb..bBBb..',                // ноги широко расставлены
    'bBb....bBb..',
    '.b......b...',
    '.Ww.....Ww..',
    '.GG.....GG..',
  ],
  run1: [                          // ноги вместе, руки нейтрально
    '..KKKk......',
    '.KHHHKk.....',
    '.KSSSSsK....',
    '.KSESEsK....',
    '..SSSSs.....',
    '..RRRRRr....',
    '.RRRRRRRr...',
    '.RRRdRRRr...',
    'sRRRRRRRrs..',
    '.rRRRRRRr...',
    '..rRRRRr....',
    '..BBbBBB....',
    '.bBBbBBBb...',
    '.bBBbbBBb...',
    '.bBb.bBbb...',
    '..Ww.wWw....',
    '..GG.GG.....',
    '............',
  ],
  run2: [                          // широкий шаг, правая нога вперёд
    '..KKKk......',
    '.KHHHKk.....',
    '.KSSSSsK....',
    '.KSESEsK....',
    '..SSSSs.....',
    '..RRRRRr....',
    '.RRRRRRRRs..',               // s col9 = рука вперёд (вверх)
    '.rRRdRRRRs..',
    'srRRRRRRr...',               // s col0 = рука назад (вниз)
    '.rRRRRRRr...',
    '..rRRRRr....',
    '..BBbBBB....',
    '.bBBbBBBb...',
    'bBBb..bBBb..',
    'bBb....bBb..',
    '.b......b...',
    '.Ww.....Ww..',
    '.GG.....GG..',
  ],
  run3: [                          // ноги вместе (= run1)
    '..KKKk......',
    '.KHHHKk.....',
    '.KSSSSsK....',
    '.KSESEsK....',
    '..SSSSs.....',
    '..RRRRRr....',
    '.RRRRRRRr...',
    '.RRRdRRRr...',
    'sRRRRRRRrs..',
    '.rRRRRRRr...',
    '..rRRRRr....',
    '..BBbBBB....',
    '.bBBbBBBb...',
    '.bBBbbBBb...',
    '.bBb.bBbb...',
    '..Ww.wWw....',
    '..GG.GG.....',
    '............',
  ],
  jump: [                          // ноги поджаты, руки раскинуты
    '..KKKk......',
    '.KHHHKk.....',
    '.KSSSSsK....',
    '.KSESEsK....',
    '..SSSSs.....',
    '..RRRRRr....',
    'sRRRRRRRRs..',               // руки широко
    'sRRRdRRRRs..',
    '.rRRRRRRr...',
    '..rRRRRr....',
    '..BBbBBB....',
    '.bBBbBBBb...',
    'bBBbbBBBb...',               // колени согнуты
    '.bBb.bBbb...',
    '..Ww.Ww.....',               // стопы подтянуты
    '..GG.GG.....',
    '............',
    '............',
  ],
};

const SPR = {};

function makeSpr(rows) {
  const h = rows.length, w = rows[0].length;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const cx = c.getContext('2d');
  cx.imageSmoothingEnabled = false;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = PAL[row[x]];
      if (col) { cx.fillStyle = col; cx.fillRect(x, y, 1, 1); }
    }
  });
  return c;
}

function initSprites() {
  for (const name in SPR_DATA) SPR[name] = makeSpr(SPR_DATA[name]);
}

// ── Плавная отрисовка персонажа (vector canvas, без пиксельных спрайтов) ──
function drawPlayerSmooth(px, py, grounded) {
  const cx  = px + PLAYER_W / 2;
  const ph  = frame * 0.19;
  const lg  = grounded ? Math.sin(ph) * 4.5 : 0;
  const arm = grounded ? Math.sin(ph) * 3.0 : -2.5;

  ctx.save();
  ctx.lineCap = 'round';

  // ── Тень ──
  if (grounded) {
    ctx.globalAlpha = 0.22; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(cx + 1, GROUND_Y - 0.3, 6, 1.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
  }

  // ── ЗАДНЯЯ НОГА (нога дальней стороны, таз сдвинут вправо) ──
  const bKnX = cx + 1 - lg * 0.28 - 1;
  const bFtX = cx + 1 - lg * 0.55;
  ctx.strokeStyle = '#0d47a1'; ctx.lineWidth = 2.4; ctx.globalAlpha = 0.7;
  ctx.beginPath();
  ctx.moveTo(cx + 1, py + 12.5); ctx.lineTo(bKnX, py + 15.2); ctx.lineTo(bFtX, py + 17.2);
  ctx.stroke();
  // Задний ботинок (путь, не эллипс)
  const bsx = bFtX - 2.5, bsy = py + 16.5;
  ctx.fillStyle = '#455a64';
  ctx.beginPath();
  ctx.moveTo(bsx, bsy + 2); ctx.bezierCurveTo(bsx, bsy + 0.5, bsx + 0.8, bsy, bsx + 1.8, bsy);
  ctx.lineTo(bsx + 4.5, bsy - 0.2); ctx.quadraticCurveTo(bsx + 6, bsy + 0.3, bsx + 5.8, bsy + 1.6);
  ctx.lineTo(bsx + 5.2, bsy + 2.5); ctx.lineTo(bsx, bsy + 2.5); ctx.closePath(); ctx.fill();
  ctx.fillStyle = '#263238';
  ctx.beginPath();
  ctx.moveTo(bsx - 0.2, bsy + 2.5); ctx.lineTo(bsx + 5.2, bsy + 2.5);
  ctx.lineTo(bsx + 6.2, bsy + 1.6); ctx.quadraticCurveTo(bsx + 6.5, bsy + 2.2, bsx + 5.8, bsy + 3.2);
  ctx.lineTo(bsx - 0.2, bsy + 3.2); ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;

  // ── ЗАДНЯЯ РУКА (плечо на дальней стороне) ──
  const bElX = cx + 0.5 + arm * 0.3;
  const bHdX = cx - 1 + arm * 0.6;
  ctx.strokeStyle = '#c62828'; ctx.lineWidth = 2.1; ctx.globalAlpha = 0.65;
  ctx.beginPath();
  ctx.moveTo(cx + 0.5, py + 6.5); ctx.lineTo(bElX, py + 9); ctx.lineTo(bHdX, py + 11.5);
  ctx.stroke();
  ctx.fillStyle = '#ef9a9a';
  ctx.beginPath(); ctx.arc(bHdX, py + 11.8, 1.1, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;

  // ── ТЕЛО (сдвинуто вправо — ракурс 3/4, персонаж смотрит вправо) ──
  const bx0 = cx - 1.5, bw = 7.5;
  const bodyG = ctx.createLinearGradient(bx0, py + 4.5, bx0 + bw, py + 12.5);
  bodyG.addColorStop(0, '#b71c1c'); bodyG.addColorStop(0.25, '#e53935');
  bodyG.addColorStop(0.7, '#f44336'); bodyG.addColorStop(1, '#d32f2f');
  ctx.fillStyle = bodyG; rRect(bx0, py + 4.5, bw, 8.2, 1.8); ctx.fill();
  // Левая тень (дальняя сторона)
  ctx.globalAlpha = 0.32; ctx.fillStyle = '#000'; ctx.fillRect(bx0, py + 5.5, 1.5, 6.5);
  // Правый блик (ближняя)
  ctx.fillStyle = '#ffcdd2'; ctx.globalAlpha = 0.18; ctx.fillRect(bx0 + bw - 2, py + 5.5, 1.5, 6.5);
  ctx.globalAlpha = 1;
  // Воротник V-neck (смещён правее)
  ctx.strokeStyle = 'rgba(255,220,220,0.7)'; ctx.lineWidth = 0.65;
  ctx.beginPath();
  ctx.moveTo(bx0 + 1, py + 4.5); ctx.lineTo(bx0 + 3, py + 7); ctx.lineTo(bx0 + 5, py + 4.5);
  ctx.stroke();
  // Ремень
  ctx.fillStyle = '#1a237e'; rRect(bx0, py + 12, bw, 1.6, 0.4); ctx.fill();
  // Пряжка
  ctx.fillStyle = '#ffd54f'; ctx.fillRect(bx0 + bw / 2 - 1, py + 12.2, 2, 1.2);
  ctx.fillStyle = '#f9a825'; ctx.fillRect(bx0 + bw / 2 - 0.6, py + 12.4, 1.2, 0.8);
  // Номер
  ctx.globalAlpha = 0.35; ctx.fillStyle = '#fff'; ctx.font = 'bold 5px monospace';
  ctx.textAlign = 'center'; ctx.fillText('1', bx0 + bw / 2, py + 11.5);
  ctx.textAlign = 'left'; ctx.globalAlpha = 1;

  // ── ПЕРЕДНЯЯ НОГА (нога ближней стороны) ──
  const fKnX = cx + 2 + lg * 0.28 + 1;
  const fFtX = cx + 2 + lg * 0.55;
  ctx.strokeStyle = '#1565c0'; ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(cx + 2, py + 12.5); ctx.lineTo(fKnX, py + 15.2); ctx.lineTo(fFtX, py + 17.2);
  ctx.stroke();
  // Передний кроссовок (путь)
  const fsx = fFtX - 3, fsy = py + 16.5;
  ctx.fillStyle = '#f0f0f0';
  ctx.beginPath();
  ctx.moveTo(fsx, fsy + 2); ctx.bezierCurveTo(fsx, fsy + 0.5, fsx + 1, fsy, fsx + 2.5, fsy);
  ctx.lineTo(fsx + 5.5, fsy - 0.3); ctx.quadraticCurveTo(fsx + 7.2, fsy + 0.2, fsx + 7, fsy + 1.8);
  ctx.lineTo(fsx + 6.2, fsy + 2.8); ctx.lineTo(fsx, fsy + 2.8); ctx.closePath(); ctx.fill();
  // Подошва
  ctx.fillStyle = '#1a1a1a';
  ctx.beginPath();
  ctx.moveTo(fsx - 0.2, fsy + 2.8); ctx.lineTo(fsx + 6.2, fsy + 2.8);
  ctx.lineTo(fsx + 7.5, fsy + 1.8); ctx.quadraticCurveTo(fsx + 7.8, fsy + 2.5, fsx + 7, fsy + 3.6);
  ctx.lineTo(fsx - 0.2, fsy + 3.6); ctx.closePath(); ctx.fill();
  // Красная брендовая полоска
  ctx.strokeStyle = '#ef5350'; ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.moveTo(fsx + 0.5, fsy + 1.8); ctx.quadraticCurveTo(fsx + 3.5, fsy + 0.8, fsx + 5.8, fsy + 1.5);
  ctx.stroke();
  // Шнурки
  ctx.fillStyle = '#bdbdbd'; ctx.fillRect(fsx + 2, fsy + 0.7, 3, 0.5);
  ctx.fillStyle = '#e0e0e0'; ctx.fillRect(fsx + 2.2, fsy + 0.4, 2.6, 0.3);

  // ── ПЕРЕДНЯЯ РУКА (плечо на ближней стороне) ──
  const fElX = cx + 4.5 - arm * 0.3;
  const fHdX = cx + 6 - arm * 0.6;
  ctx.strokeStyle = '#ef5350'; ctx.lineWidth = 2.1;
  ctx.beginPath();
  ctx.moveTo(cx + 4, py + 6); ctx.lineTo(fElX, py + 9); ctx.lineTo(fHdX, py + 11.5);
  ctx.stroke();
  ctx.fillStyle = '#ffb74d';
  ctx.beginPath(); ctx.arc(fHdX, py + 11.8, 1.3, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#ff8a65';
  ctx.beginPath(); ctx.arc(fHdX + 0.3, py + 11.4, 0.6, 0, Math.PI * 2); ctx.fill();

  // ── ШЕЯ (сдвинута правее) ──
  const nG = ctx.createLinearGradient(cx, 0, cx + 4, 0);
  nG.addColorStop(0, '#c96840'); nG.addColorStop(1, '#ffb74d');
  ctx.fillStyle = nG; rRect(cx + 0.5, py + 2.8, 3.2, 2.8, 0.6); ctx.fill();

  // ── ГОЛОВА ──
  const hcx = cx + 0.5, hcy = py + 0.8;
  ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 4;
  const faceG = ctx.createRadialGradient(hcx + 1.5, hcy - 1, 0.3, hcx, hcy, 5.2);
  faceG.addColorStop(0, '#ffe0b2'); faceG.addColorStop(0.55, '#ffb74d'); faceG.addColorStop(1, '#e64a19');
  ctx.fillStyle = faceG;
  ctx.beginPath(); ctx.ellipse(hcx, hcy, 4.7, 4.5, 0, 0, Math.PI * 2); ctx.fill();
  ctx.shadowBlur = 0;

  // Щёчный румянец
  ctx.globalAlpha = 0.2; ctx.fillStyle = '#f44336';
  ctx.beginPath(); ctx.ellipse(hcx + 2.5, hcy + 1.5, 1.5, 0.9, 0, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;

  // УХО (левая, дальняя сторона)
  ctx.fillStyle = '#ff8a65';
  ctx.beginPath(); ctx.ellipse(hcx - 4.2, hcy + 0.5, 0.85, 1.25, 0.2, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#d84315'; ctx.lineWidth = 0.45;
  ctx.beginPath(); ctx.ellipse(hcx - 4.2, hcy + 0.5, 0.42, 0.75, 0.2, 0, Math.PI * 2); ctx.stroke();

  // ── ВОЛОСЫ (чёткий аниме-стиль) ──
  const hairG = ctx.createLinearGradient(hcx, hcy - 8, hcx + 1, hcy + 1);
  hairG.addColorStop(0, '#8d6e63'); hairG.addColorStop(0.5, '#5d4037'); hairG.addColorStop(1, '#3e2723');
  ctx.fillStyle = hairG;
  // Основная масса
  ctx.beginPath();
  ctx.arc(hcx, hcy, 4.8, Math.PI * 1.1, Math.PI * 2.1);
  ctx.lineTo(hcx + 5.5, hcy + 1.5);
  ctx.bezierCurveTo(hcx + 5.5, hcy - 1, hcx + 4, hcy - 3.5, hcx + 3.5, hcy - 5.5);
  ctx.bezierCurveTo(hcx + 2, hcy - 7.5, hcx - 1, hcy - 7, hcx - 3.5, hcy - 5.5);
  ctx.bezierCurveTo(hcx - 5.5, hcy - 4, hcx - 5.5, hcy - 0.5, hcx - 5.5, hcy + 0.8);
  ctx.closePath(); ctx.fill();
  // Шип 1 (главный)
  ctx.beginPath();
  ctx.moveTo(hcx + 2, hcy - 5.5);
  ctx.bezierCurveTo(hcx + 3, hcy - 9.0, hcx + 6, hcy - 8.5, hcx + 5, hcy - 5.5);
  ctx.closePath(); ctx.fill();
  // Шип 2
  ctx.beginPath();
  ctx.moveTo(hcx - 0.5, hcy - 6.5);
  ctx.bezierCurveTo(hcx + 0.5, hcy - 9.5, hcx + 3.5, hcy - 9.0, hcx + 2.5, hcy - 6.5);
  ctx.closePath(); ctx.fill();
  // Прядь на ветру (влево = за спину при беге вправо)
  ctx.globalAlpha = 0.68;
  ctx.beginPath();
  ctx.moveTo(hcx - 2, hcy - 3.5);
  ctx.bezierCurveTo(hcx - 5, hcy - 5, hcx - 8, hcy - 4, hcx - 8.5, hcy - 2.5);
  ctx.bezierCurveTo(hcx - 8, hcy - 1.8, hcx - 5.5, hcy - 2.5, hcx - 3, hcy - 2.2);
  ctx.closePath(); ctx.fill();
  ctx.globalAlpha = 1;
  // Блик на волосах
  ctx.globalAlpha = 0.22; ctx.fillStyle = '#d7ccc8';
  ctx.beginPath(); ctx.ellipse(hcx + 1, hcy - 4.5, 2, 0.9, -0.3, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;

  // ── ОСНОВНОЙ ГЛАЗ (чистый, без длинных ресниц) ──
  const ex = hcx + 1.8, ey = hcy + 0.7;
  // Белок
  ctx.fillStyle = 'rgba(255,255,255,0.96)';
  ctx.beginPath(); ctx.ellipse(ex, ey, 1.8, 1.4, 0.06, 0, Math.PI * 2); ctx.fill();
  // Тень верхнего века
  ctx.globalAlpha = 0.15; ctx.fillStyle = '#4e342e';
  ctx.beginPath(); ctx.ellipse(ex, ey - 0.3, 1.8, 0.9, 0.06, Math.PI, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  // Радужка
  const iG = ctx.createRadialGradient(ex - 0.2, ey - 0.2, 0, ex, ey, 1.0);
  iG.addColorStop(0, '#80d8ff'); iG.addColorStop(0.5, '#0288d1'); iG.addColorStop(1, '#01579b');
  ctx.fillStyle = iG;
  ctx.beginPath(); ctx.arc(ex, ey, 1.0, 0, Math.PI * 2); ctx.fill();
  // Зрачок
  ctx.fillStyle = '#080818';
  ctx.beginPath(); ctx.arc(ex + 0.15, ey + 0.1, 0.52, 0, Math.PI * 2); ctx.fill();
  // Блики
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.arc(ex + 0.4, ey - 0.35, 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.7;
  ctx.beginPath(); ctx.arc(ex - 0.3, ey + 0.4, 0.15, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 1;
  // Верхнее веко (одна дуга вместо ресниц)
  ctx.strokeStyle = '#1a1a2e'; ctx.lineWidth = 0.6;
  ctx.beginPath(); ctx.ellipse(ex, ey, 1.8, 1.4, 0.06, Math.PI * 1.12, Math.PI * 1.95); ctx.stroke();
  // Бровь (одна плавная дуга)
  ctx.strokeStyle = '#4e342e'; ctx.lineWidth = 0.82;
  ctx.beginPath();
  ctx.moveTo(ex - 1.5, ey - 1.5); ctx.quadraticCurveTo(ex, ey - 2.2, ex + 1.6, ey - 1.5);
  ctx.stroke();

  // ── ВТОРОЙ ГЛАЗ (дальний, частичный) ──
  const ex2 = hcx - 1.4, ey2 = hcy + 0.9;
  ctx.globalAlpha = 0.55;
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.beginPath(); ctx.ellipse(ex2, ey2, 0.95, 0.8, 0.15, 0, Math.PI * 2); ctx.fill();
  const iG2 = ctx.createRadialGradient(ex2, ey2, 0, ex2, ey2, 0.6);
  iG2.addColorStop(0, '#4fc3f7'); iG2.addColorStop(1, '#01579b');
  ctx.fillStyle = iG2;
  ctx.beginPath(); ctx.arc(ex2, ey2, 0.6, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = '#080818';
  ctx.beginPath(); ctx.arc(ex2 + 0.1, ey2 + 0.1, 0.3, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = '#4e342e'; ctx.lineWidth = 0.65;
  ctx.beginPath();
  ctx.moveTo(ex2 - 0.9, ey2 - 1.0); ctx.quadraticCurveTo(ex2, ey2 - 1.4, ex2 + 0.9, ey2 - 0.9);
  ctx.stroke();
  ctx.globalAlpha = 1;

  // Нос (едва заметный)
  ctx.fillStyle = 'rgba(180,90,40,0.25)';
  ctx.beginPath(); ctx.ellipse(hcx + 3.1, hcy + 2, 0.65, 0.45, 0.2, 0, Math.PI * 2); ctx.fill();

  // Рот (лёгкая улыбка)
  ctx.strokeStyle = '#bf360c'; ctx.lineWidth = 0.6; ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(hcx + 1, hcy + 2.8); ctx.quadraticCurveTo(hcx + 2, hcy + 3.5, hcx + 3.2, hcy + 2.9);
  ctx.stroke();

  ctx.restore();
}

// ── Игрок ────────────────────────────────────────────────────────
const PL = {
  x: 36, y: 0, vy: 0,
  W: PLAYER_W, H: PLAYER_H,
  grounded: false,
  jumpsLeft: 2,
  coyoteT: 0,
  animF: 0, animT: 0,
  dead: false, deadT: 0,

  reset() {
    this.y = GROUND_Y - this.H;
    this.vy = 0; this.grounded = true;
    this.jumpsLeft = 2; this.coyoteT = 0;
    this.animF = 0; this.animT = 0;
    this.dead = false; this.deadT = 0;
  },

  doJump() {
    this.vy = (this.jumpsLeft === 2) ? JUMP1 : JUMP2;
    this.jumpsLeft--;
    this.coyoteT = 0;
    jumpBuf = 0;
    spawnPuff(this.x + this.W / 2, this.y + this.H);
  },

  update() {
    if (this.dead) {
      this.deadT++;
      this.vy = Math.min(this.vy + GRAVITY * 0.7, 12);
      this.y  = Math.min(this.y + this.vy, GROUND_Y + 40);
      if (this.deadT > 90) {
        submitScore(score);
        state = 'gameover';
      }
      return;
    }
    if (jumpBuf > 0 && (this.jumpsLeft > 0 || this.coyoteT > 0)) this.doJump();

    this.vy = Math.min(this.vy + GRAVITY, 18);
    this.y += this.vy;

    const gY = GROUND_Y - this.H;
    if (this.y >= gY) {
      this.y = gY; this.vy = 0;
      this.grounded = true; this.jumpsLeft = 2; this.coyoteT = COYOTE;
    } else {
      this.grounded = false;
      if (this.coyoteT > 0) this.coyoteT--;
    }

    if (this.grounded) {
      const rate = Math.max(2, ~~(9 - gSpeed * 0.5));
      if (++this.animT >= rate) { this.animT = 0; this.animF = (this.animF + 1) & 3; }
    }
  },

  hitbox() { return { x: this.x + 1, y: this.y + 1, w: this.W - 2, h: this.H - 2 }; },

  draw() {
    const x = ~~this.x, y = ~~this.y;
    if (this.dead) {
      ctx.save();
      ctx.translate(x + PLAYER_W / 2, y + PLAYER_H / 2);
      ctx.rotate(Math.min(this.deadT * 0.055, Math.PI * 0.55));
      drawPlayerSmooth(-PLAYER_W / 2, -PLAYER_H / 2, false);
      ctx.restore();
    } else {
      drawPlayerSmooth(x, y, this.grounded);
    }
  }
};


// ── Препятствия ───────────────────────────────────────────────────
const OBS_DEFS = [
  { id: 'bug',      w: 8,  h: 10, weight: 30 },
  { id: 'glitch',   w: 14, h: 16, weight: 25 },
  { id: 'deadline', w: 7,  h: 16, weight: 20 },
  { id: 'loop',     w: 12, h: 12, weight: 15 },
  { id: 'double',   w: 22, h: 10, weight: 10 },
  // Летающие враги (fly: y позиция фиксирована, появляются после 200м)
  { id: 'drone',    w: 16, h: 8,  weight: 18, fly: true, fy: 65 },
  { id: 'bat',      w: 12, h: 7,  weight: 14, fly: true, fy: 72 },
  // Снайпер-спутник: летит высоко, стреляет пулей вниз (появляется после 400м)
  { id: 'sniper',   w: 18, h: 10, weight: 8,  fly: true, fy: 24 },
];

let obstacles    = [];
let spawnTimer   = 90;

function weightedRandom() {
  const pool = OBS_DEFS.filter(d => {
    if (d.id === 'sniper') return meters > 400;  // снайпер с 400м
    if (d.fly) return meters > 200;              // остальные летающие с 200м
    return meters > 150 || OBS_DEFS.indexOf(d) < 3;
  });
  const total = pool.reduce((s, d) => s + d.weight, 0);
  let r = Math.random() * total;
  for (const d of pool) { r -= d.weight; if (r <= 0) return d; }
  return pool[0];
}

function spawnObs() {
  const def = weightedRandom();
  const yPos = def.fly ? def.fy : GROUND_Y - def.h;
  obstacles.push({ ...def, x: W + 6, y: yPos, passed: false, animT: 0 });
}

function updateObs(dt) {
  if (PL.dead) return;
  spawnTimer -= dt;
  if (spawnTimer <= 0) {
    spawnObs();
    const base = Math.max(18, 78 - gSpeed * 5);
    const rnd  = Math.random();
    let extra;
    if      (rnd < 0.12) extra = 38 + Math.random() * 30;  // длинная пауза
    else if (rnd < 0.22) extra = -Math.random() * 6;        // очень близко
    else                 extra = Math.random() * 30 - 5;    // обычно
    spawnTimer = Math.max(14, base + extra);
  }

  const pl = PL.hitbox();
  for (const o of obstacles) {
    o.x -= gSpeed * dt;
    o.animT++;

    if (!o.passed && o.x + o.w < PL.x) {
      o.passed = true;
      dodged++;
      combo++;
      const bonus = combo >= 5 ? 25 : 10;
      score += bonus;
      spawnText(PL.x + 5, PL.y - 8, combo >= 5 ? `COMBO x${combo}!` : `+${bonus}`);
      spawnBurst(o.x + o.w / 2, o.y, '#a5d6a7', 6);
    }

    if (!PL.dead) {
      const m = 1;
      if (pl.x + pl.w - m > o.x && pl.x + m < o.x + o.w &&
          pl.y + pl.h - m > o.y && pl.y + m < o.y + o.h) {
        PL.dead = true; combo = 0; shake = 18; flash = 0.55;
        spawnBurst(PL.x + 6, PL.y + 9, '#ef5350', 14);
      }
    }

    // Снайпер стреляет, когда залетает в зону выстрела
    if (o.id === 'sniper' && !o.fired && o.x + o.w / 2 < W * 0.62) {
      o.fired = true;
      spawnBullet(o.x + o.w / 2, o.y + o.h + 2);
    }
  }
  obstacles = obstacles.filter(o => o.x > -40);
}

// ── Отрисовка препятствий (smooth canvas graphics) ────────────────

function rRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawObs(o) {
  const { id, x, y, w, h, animT, fired } = o;
  ctx.save();

  if (id === 'double') {
    ctx.restore();
    drawObs({ id: 'bug', x, y, w: 8, h: 10, animT });
    drawObs({ id: 'bug', x: x + 14, y, w: 8, h: 10, animT });
    return;
  }

  if (id === 'bug') {
    const cx = x + w / 2, cy = y + h / 2;
    // Glow
    ctx.shadowColor = '#ff1744'; ctx.shadowBlur = 5;
    // Body
    const bg = ctx.createRadialGradient(cx - 1, cy - 2, 0.5, cx, cy, w / 2);
    bg.addColorStop(0, '#ef5350'); bg.addColorStop(1, '#b71c1c');
    ctx.fillStyle = bg;
    ctx.beginPath(); ctx.ellipse(cx, cy, w / 2 - 0.5, h / 2 - 0.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // Shell divider
    ctx.strokeStyle = '#7f0000'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(cx, y + 1.5); ctx.lineTo(cx, y + h - 1.5); ctx.stroke();
    // Spots
    ctx.fillStyle = 'rgba(183,28,28,0.5)';
    ctx.beginPath(); ctx.arc(cx - 1.8, cy + 0.8, 1.1, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 2.2, cy - 0.5, 0.8, 0, Math.PI * 2); ctx.fill();
    // Eyes
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(x + 1.8, y + 2.2, 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w - 1.8, y + 2.2, 1.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath(); ctx.arc(x + 2.1, y + 2, 0.7, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w - 1.5, y + 2, 0.7, 0, Math.PI * 2); ctx.fill();
    // Legs
    ctx.strokeStyle = '#c62828'; ctx.lineWidth = 0.6;
    const la = (~~(animT / 4)) & 1;
    for (let i = 0; i < 3; i++) {
      const ly = y + 3.5 + i * 2;
      ctx.beginPath(); ctx.moveTo(x, ly);
      ctx.quadraticCurveTo(x - 2, ly + la, x - 4 + la * 0.5, ly + 1); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + w, ly);
      ctx.quadraticCurveTo(x + w + 2, ly + la, x + w + 4 - la * 0.5, ly + 1); ctx.stroke();
    }
    // Antennae
    ctx.strokeStyle = '#c62828'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(x + 2, y); ctx.quadraticCurveTo(x, y - 3, x - 1, y - 4); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + w - 2, y); ctx.quadraticCurveTo(x + w, y - 3, x + w + 1, y - 4); ctx.stroke();
    ctx.fillStyle = '#ff8a80';
    ctx.beginPath(); ctx.arc(x - 1, y - 4, 0.9, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(x + w + 1, y - 4, 0.9, 0, Math.PI * 2); ctx.fill();
    ctx.restore(); return;
  }

  if (id === 'glitch') {
    // RGB split
    ctx.globalAlpha = 0.5; ctx.fillStyle = '#f50057';
    ctx.fillRect(x + 1.5, y, w, h);
    ctx.fillStyle = '#00e5ff';
    ctx.fillRect(x - 1, y, w, h);
    ctx.globalAlpha = 1;
    // Main body
    ctx.fillStyle = '#0d1117'; ctx.fillRect(x, y, w, h);
    // Gradient overlay
    const gg = ctx.createLinearGradient(x, y, x + w, y + h);
    gg.addColorStop(0, 'rgba(0,229,255,0.28)');
    gg.addColorStop(0.5, 'rgba(245,0,87,0.18)');
    gg.addColorStop(1, 'rgba(0,229,255,0.1)');
    ctx.fillStyle = gg; ctx.fillRect(x, y, w, h);
    // Scanlines
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    for (let i = y + 1; i < y + h; i += 2) ctx.fillRect(x, i, w, 1);
    // Text
    ctx.shadowColor = '#00e5ff'; ctx.shadowBlur = 4;
    ctx.fillStyle = '#00e5ff'; ctx.font = 'bold 5px monospace'; ctx.textAlign = 'center';
    const gx = x + w / 2 + ((~~(animT / 3)) % 2 ? 0.8 : -0.8);
    ctx.fillText('ERR', gx, y + 6);
    ctx.fillStyle = '#f50057'; ctx.font = 'bold 6px monospace'; ctx.fillText('404', x + w / 2, y + h - 3);
    ctx.textAlign = 'left'; ctx.shadowBlur = 0;
    ctx.restore(); return;
  }

  if (id === 'deadline') {
    const cx = x + w / 2, cy = y + h * 0.44;
    const r = Math.min(w, h * 0.88) / 2 - 0.5;
    // Glow ring
    ctx.shadowColor = '#e040fb'; ctx.shadowBlur = 7;
    ctx.strokeStyle = '#7b1fa2'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(cx, cy, r + 1.2, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
    // Face gradient
    const cg = ctx.createRadialGradient(cx - 0.8, cy - 1, 0, cx, cy, r);
    cg.addColorStop(0, '#f3e5f5'); cg.addColorStop(0.65, '#ce93d8'); cg.addColorStop(1, '#7b1fa2');
    ctx.fillStyle = cg;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    // Clock marks
    ctx.strokeStyle = '#4a148c'; ctx.lineWidth = 0.5;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 - Math.PI / 2;
      const ri = i % 3 === 0 ? 0.74 : 0.86;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r * ri, cy + Math.sin(a) * r * ri);
      ctx.lineTo(cx + Math.cos(a) * r * 0.95, cy + Math.sin(a) * r * 0.95);
      ctx.stroke();
    }
    // Hands (spinning fast)
    const t = animT * 0.13;
    ctx.strokeStyle = '#1a1a1a'; ctx.lineWidth = 0.8; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(t - Math.PI / 2) * r * 0.52, cy + Math.sin(t - Math.PI / 2) * r * 0.52);
    ctx.stroke();
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(t * 12 - Math.PI / 2) * r * 0.7, cy + Math.sin(t * 12 - Math.PI / 2) * r * 0.7);
    ctx.stroke();
    ctx.lineCap = 'butt';
    // Exclamation
    ctx.fillStyle = '#b71c1c'; ctx.shadowColor = '#f44336'; ctx.shadowBlur = 2;
    ctx.font = 'bold 5px monospace'; ctx.textAlign = 'center';
    ctx.fillText('!', cx, y + h - 0.5);
    ctx.textAlign = 'left'; ctx.shadowBlur = 0;
    ctx.restore(); return;
  }

  if (id === 'loop') {
    const cx = x + w / 2, cy = y + h / 2;
    const r = Math.min(w, h) / 2 - 1;
    const t = animT * 0.06;
    // Glow
    ctx.shadowColor = '#2979ff'; ctx.shadowBlur = 8;
    const rg = ctx.createLinearGradient(x, y, x + w, y + h);
    rg.addColorStop(0, '#42a5f5'); rg.addColorStop(1, '#0d47a1');
    ctx.strokeStyle = rg; ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.shadowBlur = 0;
    // Inner fill
    ctx.fillStyle = '#050d1a';
    ctx.beginPath(); ctx.arc(cx, cy, r - 1.5, 0, Math.PI * 2); ctx.fill();
    // Rotating arcs
    ctx.strokeStyle = '#64b5f6'; ctx.lineWidth = 0.9;
    for (let i = 0; i < 3; i++) {
      const a = t + i * Math.PI * 2 / 3;
      ctx.beginPath(); ctx.arc(cx, cy, r - 2.5, a, a + 1.5); ctx.stroke();
    }
    // Center
    ctx.fillStyle = '#42a5f5'; ctx.shadowColor = '#2979ff'; ctx.shadowBlur = 4;
    ctx.beginPath(); ctx.arc(cx, cy, 1, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    ctx.restore(); return;
  }

  if (id === 'drone') {
    const cx = x + w / 2, cy = y + h / 2;
    // Arms
    ctx.fillStyle = '#37474f';
    ctx.fillRect(x, cy - 0.8, w, 1.6);
    ctx.fillRect(cx - 0.8, y, 1.6, h - 1);
    // Body
    ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
    const dg = ctx.createLinearGradient(x + 3, y + 2, x + 3, y + h);
    dg.addColorStop(0, '#607d8b'); dg.addColorStop(1, '#263238');
    ctx.fillStyle = dg;
    rRect(x + 3, y + 1.5, w - 6, h - 3, 1.5); ctx.fill();
    ctx.shadowBlur = 0;
    // Rotors
    const spin = animT * 0.28;
    [[x + 1.5, y + 1.5], [x + w - 1.5, y + 1.5], [x + 1.5, y + h - 1.5], [x + w - 1.5, y + h - 1.5]]
      .forEach(([rx, ry]) => {
        ctx.fillStyle = '#546e7a';
        ctx.beginPath(); ctx.arc(rx, ry, 2.8, 0, Math.PI * 2); ctx.fill();
        ctx.save(); ctx.translate(rx, ry); ctx.rotate(spin);
        ctx.strokeStyle = '#b0bec5'; ctx.lineWidth = 0.7;
        ctx.beginPath(); ctx.moveTo(-2.5, 0); ctx.lineTo(2.5, 0); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, -2.5); ctx.lineTo(0, 2.5); ctx.stroke();
        ctx.restore();
      });
    // Camera LED
    ctx.shadowColor = '#ff1744'; ctx.shadowBlur = 5;
    ctx.fillStyle = '#d50000';
    ctx.beginPath(); ctx.arc(cx, cy, 1.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff8a80';
    ctx.beginPath(); ctx.arc(cx - 0.4, cy - 0.4, 0.5, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // Laser
    const lx = cx, lh = GROUND_Y - (y + h);
    ctx.globalAlpha = 0.07; ctx.fillStyle = '#ff1744'; ctx.fillRect(lx - 5, y + h, 10, lh);
    ctx.globalAlpha = 0.18; ctx.fillStyle = '#ff5252'; ctx.fillRect(lx - 2, y + h, 4, lh);
    ctx.globalAlpha = 0.72; ctx.fillStyle = '#ff1744'; ctx.fillRect(lx - 0.8, y + h, 1.6, lh);
    ctx.globalAlpha = 1;
    ctx.restore(); return;
  }

  if (id === 'bat') {
    const cx = x + w / 2, cy = y + h / 2;
    const flap = Math.sin(animT * 0.28) * 2.5;
    // Wings
    const wg = ctx.createLinearGradient(x, y, x, y + h);
    wg.addColorStop(0, '#6a1b9a'); wg.addColorStop(1, '#311b92');
    ctx.fillStyle = wg;
    ctx.beginPath();
    ctx.moveTo(cx - 1, cy);
    ctx.bezierCurveTo(cx - 3, cy - 1.5, x - 2, cy - 3.5 + flap, x - 1, cy + flap * 0.5);
    ctx.bezierCurveTo(x + 1, cy + 2.5, cx - 2, cy + 1.5, cx - 1, cy);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(cx + 1, cy);
    ctx.bezierCurveTo(cx + 3, cy - 1.5, x + w + 2, cy - 3.5 + flap, x + w + 1, cy + flap * 0.5);
    ctx.bezierCurveTo(x + w - 1, cy + 2.5, cx + 2, cy + 1.5, cx + 1, cy);
    ctx.fill();
    // Body
    ctx.shadowColor = '#9c27b0'; ctx.shadowBlur = 4;
    const bbg = ctx.createRadialGradient(cx, cy - 0.8, 0, cx, cy, 2.8);
    bbg.addColorStop(0, '#ce93d8'); bbg.addColorStop(1, '#6a1b9a');
    ctx.fillStyle = bbg;
    ctx.beginPath(); ctx.ellipse(cx, cy, 2.5, 3, 0, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // Eyes
    ctx.fillStyle = '#ff6d00';
    ctx.beginPath(); ctx.arc(cx - 1, cy - 1.2, 0.9, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 1, cy - 1.2, 0.9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#212121';
    ctx.beginPath(); ctx.arc(cx - 0.8, cy - 1.2, 0.4, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(cx + 1.2, cy - 1.2, 0.4, 0, Math.PI * 2); ctx.fill();
    // Ears
    ctx.fillStyle = '#4a148c';
    ctx.beginPath(); ctx.moveTo(cx - 1.5, cy - 3); ctx.lineTo(cx - 0.5, cy - 1); ctx.lineTo(cx - 2.5, cy - 1.5); ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.moveTo(cx + 1.5, cy - 3); ctx.lineTo(cx + 0.5, cy - 1); ctx.lineTo(cx + 2.5, cy - 1.5); ctx.closePath(); ctx.fill();
    ctx.restore(); return;
  }

  if (id === 'sniper') {
    const cx = x + w / 2, cy = y + h / 2;
    const pulse = 0.5 + Math.sin(animT * 0.12) * 0.5;
    // Солнечные панели
    ctx.fillStyle = '#0d47a1';
    ctx.fillRect(x - 1, cy - 1.5, 5, 3);
    ctx.fillRect(x + w - 4, cy - 1.5, 5, 3);
    // Сетка панелей
    ctx.strokeStyle = '#42a5f5'; ctx.lineWidth = 0.3;
    [0, 1.7, 3.4].forEach(dx => {
      ctx.beginPath(); ctx.moveTo(x - 1 + dx, cy - 1.5); ctx.lineTo(x - 1 + dx, cy + 1.5); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x + w - 4 + dx, cy - 1.5); ctx.lineTo(x + w - 4 + dx, cy + 1.5); ctx.stroke();
    });
    ctx.beginPath(); ctx.moveTo(x - 1, cy); ctx.lineTo(x + 4, cy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x + w - 4, cy); ctx.lineTo(x + w + 1, cy); ctx.stroke();
    // Корпус
    const eyeCol = fired ? '#42a5f5' : '#f50057';
    ctx.shadowColor = eyeCol; ctx.shadowBlur = 3 + pulse * 4;
    const sg = ctx.createLinearGradient(cx, y + 1, cx, y + h - 1);
    sg.addColorStop(0, '#90a4ae'); sg.addColorStop(0.5, '#546e7a'); sg.addColorStop(1, '#263238');
    ctx.fillStyle = sg;
    rRect(x + 4, y + 1, w - 8, h - 2, 2); ctx.fill();
    ctx.shadowBlur = 0;
    // Ствол
    ctx.fillStyle = '#37474f'; ctx.fillRect(cx - 1, y + h - 1, 2, 4);
    ctx.fillStyle = '#000';    ctx.fillRect(cx - 0.5, y + h + 2, 1, 2);
    // Прицел-линза
    ctx.shadowColor = eyeCol; ctx.shadowBlur = fired ? 3 : 5 * pulse;
    ctx.fillStyle = eyeCol;
    ctx.beginPath(); ctx.arc(cx, cy - 1.5, 2.2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = fired ? '#bbdefb' : '#ff80ab';
    ctx.beginPath(); ctx.arc(cx - 0.5, cy - 2.2, 0.9, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;
    // Лазерный прицел (до выстрела)
    if (!fired) {
      const lh2 = GROUND_Y - (y + h) - 4;
      const la = 0.35 + pulse * 0.35;
      ctx.globalAlpha = la * 0.07; ctx.fillStyle = '#f50057';
      ctx.fillRect(cx - 9, y + h + 3, 18, lh2);
      ctx.globalAlpha = la * 0.20; ctx.fillRect(cx - 3, y + h + 3, 6, lh2);
      ctx.globalAlpha = la * 0.70; ctx.fillRect(cx - 0.8, y + h + 3, 1.6, lh2);
      ctx.globalAlpha = 1;
    }
    ctx.restore(); return;
  }

  ctx.restore();
}

// ── Частицы ───────────────────────────────────────────────────────
let particles = [];

function spawnBurst(x, y, color, n = 8) {
  for (let i = 0; i < n; i++) {
    const a = (Math.PI * 2 * i / n) + Math.random() * 0.5;
    const s = 1.5 + Math.random() * 2.5;
    particles.push({ x, y, vx: Math.cos(a)*s, vy: Math.sin(a)*s - 1.5,
      life: 28 + ~~(Math.random()*18), maxLife: 46, color, size: 1 });
  }
}

function spawnPuff(x, y) {
  for (let i = 0; i < 4; i++) {
    particles.push({ x: x + Math.random()*4-2, y,
      vx: (Math.random()-0.5)*2, vy: -Math.random()*1.8-0.5,
      life: 14, maxLife: 14, color: '#b0bec5', size: 3 });
  }
}

function spawnDust(x, y) {
  const col = nightness() > 0.5 ? '#546e7a' : '#a1887f';
  for (let i = 0; i < 2; i++) {
    particles.push({ x: x + Math.random()*4 - 2, y: y - Math.random()*0.5,
      vx: -(Math.random()*0.9 + 0.2), vy: -(Math.random()*0.5 + 0.05),
      life: 16 + ~~(Math.random()*14), maxLife: 30, color: col, size: 0.9 + Math.random()*0.8 });
  }
}

function spawnText(x, y, text) {
  particles.push({ x, y, vx: 0, vy: -0.7,
    life: 65, maxLife: 65, text, color: '#ffd700' });
}

function updateParticles() {
  particles = particles.filter(p => {
    p.x += p.vx; p.y += p.vy; p.vy += 0.07; return --p.life > 0;
  });
}

function drawParticles() {
  particles.forEach(p => {
    ctx.globalAlpha = p.life / p.maxLife;
    if (p.text) {
      ctx.fillStyle = p.color; ctx.font = 'bold 7px monospace';
      ctx.textAlign = 'center'; ctx.fillText(p.text, p.x, p.y); ctx.textAlign = 'left';
    } else {
      ctx.fillStyle = p.color; ctx.fillRect(~~p.x, ~~p.y, p.size, p.size);
    }
  });
  ctx.globalAlpha = 1;
}

// ── Пули снайпера ─────────────────────────────────────────────────
let bullets = [];

function spawnBullet(x, y) {
  bullets.push({ x, y, vy: 0.6, falling: true, landTimer: 0, hit: false });
}

function updateBullets(dt) {
  const pl = PL.hitbox();
  for (const b of bullets) {
    b.x -= gSpeed * dt;
    if (b.falling) {
      b.vy = Math.min(b.vy + 0.40 * dt, 10);
      b.y  += b.vy * dt;
      if (b.y >= GROUND_Y - 3) {
        b.falling = false;
        b.y = GROUND_Y - 3;
        b.landTimer = 95;
        spawnBurst(b.x, GROUND_Y - 1, '#ff6d00', 8);
      }
    } else {
      b.landTimer -= dt;
    }
    if (!PL.dead && !b.hit) {
      const bx = b.x - 2.5, bw = 5;
      const by = b.falling ? b.y - 2 : GROUND_Y - 4, bh = b.falling ? 5 : 4;
      if (pl.x + pl.w > bx && pl.x < bx + bw &&
          pl.y + pl.h > by && pl.y < by + bh) {
        b.hit = true;
        PL.dead = true; combo = 0; shake = 18; flash = 0.55;
        spawnBurst(PL.x + 6, PL.y + 9, '#ff6d00', 14);
      }
    }
  }
  bullets = bullets.filter(b => b.x > -30 && (b.falling || b.landTimer > 0));
}

function drawBullets() {
  for (const b of bullets) {
    ctx.save();
    if (b.falling) {
      // Огненная пуля с хвостом
      const trail = Math.min(b.vy * 2, 16);
      ctx.shadowColor = '#ff6d00'; ctx.shadowBlur = 6;
      const tg = ctx.createLinearGradient(b.x, b.y, b.x, b.y + trail);
      tg.addColorStop(0, 'rgba(255,152,0,0.85)');
      tg.addColorStop(1, 'rgba(255,109,0,0)');
      ctx.fillStyle = tg; ctx.fillRect(b.x - 1, b.y, 2, trail);
      // Ядро
      ctx.fillStyle = '#ffcc02';
      ctx.beginPath(); ctx.arc(b.x, b.y, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(b.x - 0.5, b.y - 0.5, 0.9, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    } else {
      // Опасная зона на земле
      const fa = Math.min(b.landTimer / 35, 1);
      ctx.globalAlpha = fa * 0.25; ctx.fillStyle = '#ff6d00';
      ctx.fillRect(b.x - 6, GROUND_Y - 5, 12, 5);
      ctx.globalAlpha = fa * 0.75; ctx.shadowColor = '#ff6d00'; ctx.shadowBlur = 4;
      ctx.fillStyle = '#ff8f00';
      ctx.fillRect(b.x - 3, GROUND_Y - 4, 6, 4);
      ctx.globalAlpha = fa;
      ctx.fillStyle = '#ffcc02'; ctx.fillRect(b.x - 1.5, GROUND_Y - 3, 3, 2);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }
}

// ── Фон и параллакс ───────────────────────────────────────────────
const clouds = Array.from({ length: 7 }, (_, i) => ({
  x: i * 75, y: 10 + ~~(Math.random() * 28),
  w: 20 + ~~(Math.random() * 18), h: 7 + ~~(Math.random() * 5)
}));

const mountains = Array.from({ length: 9 }, (_, i) => ({
  x: i * 65, w: 26 + ~~(Math.random() * 24), h: 20 + ~~(Math.random() * 26)
}));

const stars = Array.from({ length: 90 }, () => ({
  x: ~~(Math.random() * W), y: ~~(Math.random() * 70),
  s: Math.random() > 0.75 ? 2 : 1, b: Math.random()
}));

let groundX = 0;

function updateBg(dt) {
  if ((state !== 'playing' && !PL.dead) || state === 'quiz') return;
  groundX    = (groundX + gSpeed * dt) % 16;
  cityScrollX = (cityScrollX + gSpeed * dt) % (CITY_W / 0.32);
  fgScrollX   = (fgScrollX   + gSpeed * dt) % (W * 2.5);
  for (const c of clouds) { c.x -= gSpeed * dt * 0.09; if (c.x + c.w < 0) c.x = W + c.w; }
  for (const m of mountains) { m.x -= gSpeed * dt * 0.20; if (m.x + m.w < 0) m.x = W + m.w; }
}

function drawBg() {
  const night = nightness();

  // ── Небо (градиент) ──────────────────────────────────────────────
  ctx.fillStyle = getSkyGradient();
  ctx.fillRect(0, 0, W, GROUND_Y);

  // ── Звёзды ───────────────────────────────────────────────────────
  if (night > 0.05) {
    ctx.lineCap = 'round';
    stars.forEach(s => {
      const twinkle = 0.6 + Math.sin(s.b * 7 + frame * 0.04) * 0.4;
      const sa = night * twinkle * 0.95;
      ctx.globalAlpha = sa;
      const sc = s.b > 0.8 ? '#cfe8ff' : '#ffffff';
      if (s.b > 0.75) {
        // 4-лучевая искра для ярких звёзд
        const r = s.s * 1.1;
        ctx.strokeStyle = sc; ctx.lineWidth = s.s * 0.55;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y - r*2); ctx.lineTo(s.x, s.y + r*2);
        ctx.moveTo(s.x - r*2, s.y); ctx.lineTo(s.x + r*2, s.y);
        ctx.stroke();
        ctx.globalAlpha = sa * 0.35; ctx.lineWidth = s.s * 0.3;
        ctx.beginPath();
        ctx.moveTo(s.x - r*1.2, s.y - r*1.2); ctx.lineTo(s.x + r*1.2, s.y + r*1.2);
        ctx.moveTo(s.x + r*1.2, s.y - r*1.2); ctx.lineTo(s.x - r*1.2, s.y + r*1.2);
        ctx.stroke();
        ctx.globalAlpha = sa;
      } else {
        ctx.fillStyle = sc; ctx.fillRect(s.x, s.y, s.s, s.s);
      }
    });
    ctx.globalAlpha = 1;
  }

  // ── Солнце / Луна / Аврора ───────────────────────────────────────
  drawAurora(night);
  drawSun(night);
  drawMoon(night);

  // ── Горы (дальний план) ──────────────────────────────────────────
  const mAlpha = 0.3 + (1 - night) * 0.55;
  ctx.globalAlpha = mAlpha;
  mountains.forEach(m => {
    const mCol = night > 0.5 ? '#0d1b2e' : '#546e7a';
    ctx.fillStyle = mCol;
    ctx.beginPath();
    ctx.moveTo(m.x, GROUND_Y - 8);
    ctx.lineTo(m.x + m.w * 0.5, GROUND_Y - 8 - m.h);
    ctx.lineTo(m.x + m.w, GROUND_Y - 8);
    ctx.fill();
    // Снежные шапки
    if (m.h > 28) {
      ctx.fillStyle = night > 0.4 ? 'rgba(200,220,255,0.7)' : 'rgba(236,239,241,0.85)';
      ctx.beginPath();
      const px = m.x + m.w * 0.5, py = GROUND_Y - 8 - m.h;
      ctx.moveTo(px - 4, py + 8); ctx.lineTo(px, py); ctx.lineTo(px + 4, py + 8);
      ctx.fill();
    }
  });
  ctx.globalAlpha = 1;

  // ── Силуэт города (появляется ночью) ─────────────────────────────
  drawCity(night);

  // ── Атмосферная дымка у горизонта ────────────────────────────────
  {
    const hr = night > 0.5 ? [8,18,45] : [170,215,250];
    const haze = ctx.createLinearGradient(0, GROUND_Y - 35, 0, GROUND_Y);
    haze.addColorStop(0, `rgba(${hr[0]},${hr[1]},${hr[2]},0)`);
    haze.addColorStop(1, `rgba(${hr[0]},${hr[1]},${hr[2]},0.32)`);
    ctx.fillStyle = haze; ctx.fillRect(0, GROUND_Y - 35, W, 35);
  }

  // ── Облака ───────────────────────────────────────────────────────
  const cAlpha = Math.max(0.04, 1 - night * 1.2);
  ctx.globalAlpha = cAlpha;
  clouds.forEach(c => {
    const cDark  = night > 0.15 ? '#152244' : '#c8e8f8';
    const cMid   = night > 0.15 ? '#1e3060' : '#ddf0ff';
    const cLight = night > 0.15 ? '#283d72' : '#f2fbff';
    const r = c.h * 0.56;
    // Основа — 3 перекрывающихся круга для объёма
    ctx.fillStyle = cDark;
    ctx.beginPath(); ctx.arc(c.x + c.w*0.18, c.y + r*0.9,  r*0.85, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(c.x + c.w*0.5,  c.y + r*0.65, r*1.1,  0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(c.x + c.w*0.82, c.y + r*0.9,  r*0.8,  0, Math.PI*2); ctx.fill();
    // Средний слой
    ctx.fillStyle = cMid;
    ctx.beginPath(); ctx.arc(c.x + c.w*0.35, c.y + r*0.45, r*0.9, 0, Math.PI*2); ctx.fill();
    ctx.beginPath(); ctx.arc(c.x + c.w*0.65, c.y + r*0.55, r*0.8, 0, Math.PI*2); ctx.fill();
    // Световой пик сверху
    ctx.fillStyle = cLight;
    ctx.beginPath(); ctx.arc(c.x + c.w*0.5, c.y + r*0.28, r*0.52, 0, Math.PI*2); ctx.fill();
  });
  ctx.globalAlpha = 1;

  // ── Земля ────────────────────────────────────────────────────────
  // Основа
  ctx.fillStyle = night > 0.5 ? '#1a0e08' : '#3e2723';
  ctx.fillRect(0, GROUND_Y, W, H - GROUND_Y);
  // Трава
  const g1 = ctx.createLinearGradient(0, GROUND_Y, 0, GROUND_Y + 4);
  g1.addColorStop(0, night > 0.5 ? '#1b5e20' : '#43a047');
  g1.addColorStop(1, night > 0.5 ? '#1a3a10' : '#388e3c');
  ctx.fillStyle = g1; ctx.fillRect(0, GROUND_Y, W, 4);
  // ── Травяные стебли (покачиваются) ───────────────────────────────
  {
    const gc1 = night > 0.5 ? '#2e7d32' : '#66bb6a';
    const gc2 = night > 0.5 ? '#1b5e20' : '#4caf50';
    ctx.lineWidth = 0.5; ctx.lineCap = 'round';
    const goff = groundX % 3;
    for (let bx = -goff; bx < W + 3; bx += 2.5) {
      const bi = ~~(bx);
      const lean = Math.sin(bx * 0.85 + frame * 0.022) * 1.4;
      const bh   = 1.5 + ((bi * 7919 + 3) % 3) * 0.85;
      ctx.strokeStyle = bi % 2 === 0 ? gc1 : gc2;
      ctx.globalAlpha = 0.65;
      ctx.beginPath();
      ctx.moveTo(bx, GROUND_Y + 0.5);
      ctx.quadraticCurveTo(bx + lean*0.45, GROUND_Y - bh*0.5, bx + lean, GROUND_Y - bh);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Линия света у горизонта (только днём)
  if (night < 0.5) {
    ctx.globalAlpha = (1 - night * 2) * 0.4;
    ctx.fillStyle = '#a5d6a7'; ctx.fillRect(0, GROUND_Y, W, 1);
    ctx.globalAlpha = 1;
  }
  // Плитки земли
  ctx.fillStyle = night > 0.5 ? '#2d1a14' : '#4e342e';
  for (let tx = -groundX; tx < W; tx += 16) ctx.fillRect(tx, GROUND_Y + 5, 14, 2);

  // ── Галька на земле ─────────────────────────────────────────────
  {
    const pc = night > 0.5 ? '#4e342e' : '#6d4c41';
    for (let i = 0; i < 20; i++) {
      const px2 = ((i * 14.3 + groundX * 0.85) % (W + 4)) - 2;
      const py2 = GROUND_Y + 2 + (i * 3.7 % 9);
      ctx.globalAlpha = 0.3;
      ctx.fillStyle = i % 3 === 0 ? '#795548' : pc;
      ctx.beginPath();
      ctx.ellipse(px2, py2, 1.2 + (i%2)*0.7, 0.55 + (i%3)*0.2, (i*0.4)%Math.PI, 0, Math.PI*2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // ── Передний план (камни/кусты/пеньки) ───────────────────────────
  const tileW = W * 2.5;
  FGRD.forEach(f => {
    const fx = ((f.x - fgScrollX) % tileW + tileW) % tileW;
    if (fx > W + 10 || fx < -10) return;
    ctx.save();
    if (f.type === 0) {         // камень — сглаженный эллипс
      const rg = ctx.createRadialGradient(fx + f.w * 0.35, GROUND_Y - f.h * 0.55, 0.5, fx + f.w * 0.5, GROUND_Y - f.h * 0.5, f.w * 0.6);
      rg.addColorStop(0, '#90a4ae'); rg.addColorStop(1, '#37474f');
      ctx.fillStyle = rg;
      ctx.beginPath(); ctx.ellipse(fx + f.w / 2, GROUND_Y - f.h * 0.45, f.w / 2, f.h * 0.52, 0, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 0.25; ctx.fillStyle = '#eceff1';
      ctx.beginPath(); ctx.ellipse(fx + f.w * 0.38, GROUND_Y - f.h * 0.72, f.w * 0.22, f.h * 0.18, -0.3, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    } else if (f.type === 1) {  // кустик — перекрывающиеся круги
      const c1 = night > 0.4 ? '#1b5e20' : '#2e7d32';
      const c2 = night > 0.4 ? '#388e3c' : '#66bb6a';
      const bY = GROUND_Y, r = f.w * 0.42;
      ctx.fillStyle = c1;
      ctx.beginPath(); ctx.arc(fx + f.w * 0.5, bY - f.h * 0.68, r, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(fx + f.w * 0.28, bY - f.h * 0.52, r * 0.78, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(fx + f.w * 0.72, bY - f.h * 0.52, r * 0.78, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = c2;
      ctx.beginPath(); ctx.arc(fx + f.w * 0.5, bY - f.h * 0.88, r * 0.55, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(fx + f.w * 0.3, bY - f.h * 0.68, r * 0.38, 0, Math.PI * 2); ctx.fill();
    } else {                    // столбик — с градиентом и highlight
      const ph = fx;
      const pg = ctx.createLinearGradient(fx, 0, fx + 2, 0);
      pg.addColorStop(0, '#795548'); pg.addColorStop(1, '#4e342e');
      ctx.fillStyle = pg; ctx.fillRect(fx, GROUND_Y - f.h, 2, f.h);
      ctx.globalAlpha = 0.4; ctx.fillStyle = '#d7ccc8';
      ctx.fillRect(fx, GROUND_Y - f.h, 0.7, f.h); ctx.globalAlpha = 1;
      ctx.fillStyle = '#ffd54f';
      ctx.fillRect(fx + 0.4, GROUND_Y - f.h + 2, 1.2, 0.7);
      ctx.fillRect(fx + 0.4, GROUND_Y - f.h * 0.42, 1.2, 0.7);
    }
    ctx.restore();
  });

  // ── Полосы скорости ──────────────────────────────────────────────
  if (gSpeed > 6.5) {
    const alpha = Math.max(0, Math.min((gSpeed - 6.5) / 2.5, 0.18));
    if (alpha > 0) {
      ctx.globalAlpha = alpha; ctx.fillStyle = '#ffffff';
      for (let i = 0; i < 10; i++) {
        const ly = (i * 12 + frame * 4) % (GROUND_Y - 6);
        ctx.fillRect(0, ly, ~~(W * 0.15 + Math.random() * 8), 1);
      }
      ctx.globalAlpha = 1;
    }
  }
}

// ── HUD ──────────────────────────────────────────────────────────
function drawHUD() {
  const HH = 20; // panel height

  // === Фон панели ===
  const pbg = ctx.createLinearGradient(0, 0, 0, HH);
  pbg.addColorStop(0, 'rgba(0,4,18,0.88)');
  pbg.addColorStop(1, 'rgba(0,8,28,0.60)');
  ctx.fillStyle = pbg; ctx.fillRect(0, 0, W, HH);

  // Верхняя цветная полоска (цвет = уровень скорости)
  const spd = (gSpeed - SPD_START) / (SPD_MAX - SPD_START);
  const sCol = spd < 0.45 ? '#4caf50' : spd < 0.75 ? '#ff9800' : '#f44336';
  const topLine = ctx.createLinearGradient(0, 0, W, 0);
  topLine.addColorStop(0,   'transparent');
  topLine.addColorStop(0.1, sCol);
  topLine.addColorStop(0.9, sCol);
  topLine.addColorStop(1,   'transparent');
  ctx.fillStyle = topLine; ctx.fillRect(0, 0, W, 1);

  // Нижняя разделительная линия
  ctx.fillStyle = 'rgba(255,255,255,0.06)'; ctx.fillRect(0, HH - 1, W, 1);

  ctx.save();

  // ═══ ЛЕВЫЙ БЛОК: дистанция + очки ═══
  const mx = ~~meters;
  // Иконка бега (треугольник)
  ctx.fillStyle = '#ffd700';
  ctx.beginPath(); ctx.moveTo(3, 5); ctx.lineTo(3, 11); ctx.lineTo(7, 8); ctx.closePath(); ctx.fill();
  // Метры (большой)
  ctx.font = 'bold 7px monospace'; ctx.textAlign = 'left';
  ctx.fillStyle = '#ffd700';
  ctx.fillText(`${mx}m`, 9, 9);
  // Очки (маленький)
  ctx.font = '5px monospace';
  ctx.fillStyle = '#80deea';
  ctx.fillText(`\u2605${score}`, 9, 17);

  // ═══ БЛОК КВИЗ-ПРОГРЕСС ═══
  const qPct = Math.min(Math.max(1 - (nextQuizAt - meters) / 250, 0), 1);
  const qX = 58, qY = 4, qW = 48, qH = 5;
  // Фон полоски
  ctx.fillStyle = 'rgba(255,255,255,0.07)'; rRect(qX, qY, qW, qH, 2); ctx.fill();
  // Заливка
  if (qPct > 0) {
    const qg = ctx.createLinearGradient(qX, 0, qX + qW, 0);
    qg.addColorStop(0, '#7c4dff'); qg.addColorStop(1, '#ea80fc');
    ctx.fillStyle = qg; rRect(qX, qY, Math.max(3, qPct * qW), qH, 2); ctx.fill();
  }
  // Блик на полоске
  ctx.globalAlpha = 0.3; ctx.fillStyle = '#fff'; ctx.fillRect(qX + 2, qY + 1, qW - 4, 1); ctx.globalAlpha = 1;
  // Подпись
  ctx.fillStyle = '#ce93d8'; ctx.font = '4px monospace'; ctx.textAlign = 'left';
  ctx.fillText('QUIZ', qX, 15);
  const qleft = ~~Math.max(0, nextQuizAt - meters);
  ctx.fillStyle = 'rgba(200,150,255,0.7)'; ctx.font = '4px monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${qleft}m`, qX + qW, 15);

  // ═══ КОМБО ═══
  if (combo >= 3) {
    const comboX = 164;
    ctx.textAlign = 'center';
    const blink = (frame >> 3) & 1;
    // Фоновый пузырь
    ctx.fillStyle = blink ? 'rgba(255,109,0,0.25)' : 'rgba(255,152,0,0.15)';
    rRect(comboX - 12, 2, 24, 16, 3); ctx.fill();
    ctx.strokeStyle = blink ? '#ff6d00' : '#ff9800'; ctx.lineWidth = 0.5;
    rRect(comboX - 12, 2, 24, 16, 3); ctx.stroke();
    ctx.fillStyle = blink ? '#ffcc02' : '#ffab40';
    ctx.font = 'bold 7px monospace';
    ctx.fillText(`\xD7${combo}`, comboX, 11);
    ctx.fillStyle = 'rgba(255,204,2,0.65)'; ctx.font = '4px monospace';
    ctx.fillText('COMBO', comboX, 17);
    ctx.textAlign = 'left';
  }

  // ═══ БЛОК СКОРОСТЬ ═══
  const sX = W - 50, sY = 4, sW = 46, sH = 5;
  // Иконка молнии
  ctx.fillStyle = sCol;
  ctx.beginPath();
  ctx.moveTo(W - 52, 4); ctx.lineTo(W - 54, 9); ctx.lineTo(W - 52, 9);
  ctx.lineTo(W - 54, 15); ctx.lineTo(W - 49, 8); ctx.lineTo(W - 51, 8);
  ctx.closePath(); ctx.fill();
  // Фон полоски
  ctx.fillStyle = 'rgba(255,255,255,0.07)'; rRect(sX, sY, sW, sH, 2); ctx.fill();
  // Градиент заливки (зелёный→оранжевый→красный)
  const sg = ctx.createLinearGradient(sX, 0, sX + sW, 0);
  sg.addColorStop(0, '#66bb6a'); sg.addColorStop(0.5, '#ffa726'); sg.addColorStop(1, '#ef5350');
  ctx.save(); ctx.beginPath(); rRect(sX, sY, sW, sH, 2); ctx.clip();
  ctx.fillStyle = sg; ctx.fillRect(sX, sY, Math.max(3, spd * sW), sH);
  ctx.restore();
  // Блик
  ctx.globalAlpha = 0.28; ctx.fillStyle = '#fff'; ctx.fillRect(sX + 2, sY + 1, sW - 4, 1); ctx.globalAlpha = 1;
  // Подпись
  ctx.fillStyle = '#90caf9'; ctx.font = '4px monospace'; ctx.textAlign = 'left';
  ctx.fillText('SPD', sX, 15);
  const spdKmh = ~~(spd * 100);
  ctx.fillStyle = sCol; ctx.textAlign = 'right';
  ctx.fillText(`${spdKmh}%`, sX + sW, 15);

  ctx.textAlign = 'left';
  ctx.restore();
}

// ── Milestone-сообщения ───────────────────────────────────────────
let mMsg = '', mTimer = 0;
const milestoneDone = new Set();

// ── Квиз ─────────────────────────────────────────────────────────
let nextQuizAt    = 250;
let questionIdx   = 0;
let quizData      = null;
let quizAnswered  = false;
let quizCorrect   = false;
let quizTimer     = 0;
const QUIZ_BTNS   = [];
const MILESTONES = [
  [50,   '50 метров! Так держать!'],
  [100,  '💯 100 метров — хорошее начало!'],
  [200,  '200м — ты входишь во вкус!'],
  [350,  '350м — скорость нарастает!'],
  [500,  '💥 500 метров! Серьёзно!'],
  [750,  '750м — это уже мастерство!'],
  [1000, '🏆 КИЛОМЕТР! Легенда!'],
  [1500, '1500м — это невозможно. Но ты смог.'],
];

function checkMilestones() {
  for (const [m, msg] of MILESTONES) {
    if (meters >= m && !milestoneDone.has(m)) {
      milestoneDone.add(m); mMsg = msg; mTimer = 130;
    }
  }
}

function triggerQuiz() {
  state = 'quiz';
  const fn = (typeof getQuestion === 'function') ? getQuestion : (i => QUESTIONS[i % QUESTIONS.length]);
  quizData = fn(questionIdx++, meters);
  quizAnswered = false; quizCorrect = false; quizTimer = 0;
  QUIZ_BTNS.length = 0;
  for (let i = 0; i < 4; i++) {
    QUIZ_BTNS.push({ x: 4, y: 82 + i * 15, w: W - 8, h: 13, idx: i });
  }
}

function answerQuiz(idx) {
  if (quizAnswered) return;
  quizAnswered = true;
  quizCorrect  = idx === quizData.correct;
  quizTimer    = 90;
  if (quizCorrect) {
    score += 50;
    combo++;
    spawnBurst(W / 2, H / 2, '#4caf50', 12);
  } else {
    gSpeed = Math.min(gSpeed + 1.8, SPD_MAX);   // неверно → быстрее!
    flash  = 0.4;
    shake  = 14;
    spawnBurst(W / 2, H / 2, '#ef5350', 10);
  }
}

function updateQuiz() {
  updateParticles();
  if (flash > 0) flash -= 0.045;
  if (shake > 0) shake--;
  if (quizAnswered) {
    quizTimer--;
    if (quizTimer <= 0) {
      state = 'playing';
      nextQuizAt = ~~meters + 250;
      quizData = null;
    }
  }
}

function wrapText(text, maxW) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function drawQuiz() {
  ctx.fillStyle = 'rgba(8,14,28,0.93)';
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = '#ffd700'; ctx.lineWidth = 1;
  ctx.strokeRect(2, 2, W - 4, H - 4);

  ctx.textAlign = 'center';

  // Тема
  ctx.fillStyle = '#80cbc4'; ctx.font = 'bold 4px monospace';
  ctx.fillText('🐍 ' + quizData.topic.toUpperCase(), W / 2, 11);

  ctx.fillStyle = '#263238'; ctx.fillRect(4, 13, W - 8, 1);

  // Вопрос
  ctx.font = '4px monospace';
  const qLines = quizData.q.split('\n');
  let qY = 22;
  for (const line of qLines) {
    const isCode = line.startsWith('    ') || (line.includes('(') && !line.endsWith('?'));
    ctx.fillStyle = isCode ? '#80deea' : '#eceff1';
    ctx.fillText(line, W / 2, qY);
    qY += 7;
  }

  // Кнопки
  QUIZ_BTNS.forEach(btn => {
    let bg, border, tc;
    if (!quizAnswered) {
      bg = '#0d2137'; border = '#1e88e5'; tc = '#90caf9';
    } else if (btn.idx === quizData.correct) {
      bg = '#1b5e20'; border = '#4caf50'; tc = '#c8e6c9';
    } else {
      bg = '#111'; border = '#263238'; tc = '#455a64';
    }
    ctx.fillStyle = bg; ctx.fillRect(btn.x, btn.y, btn.w, btn.h);
    ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.strokeRect(btn.x, btn.y, btn.w, btn.h);

    ctx.fillStyle = tc; ctx.font = '4px monospace';
    const full  = String.fromCharCode(65 + btn.idx) + ') ' + quizData.a[btn.idx];
    const lines = wrapText(full, btn.w - 10);
    const lineH = 5;
    const startY = btn.y + Math.floor(btn.h / 2) - Math.floor(lines.length * lineH / 2) + 4;
    lines.forEach((l, i) => ctx.fillText(l, btn.x + btn.w / 2, startY + i * lineH));
  });

  // Результат
  if (quizAnswered) {
    ctx.font = 'bold 5px monospace';
    ctx.fillStyle = quizCorrect ? '#4caf50' : '#ef5350';
    ctx.fillText(quizCorrect ? '✓ ВЕРНО!  +50 очков' : '✗ Неверно — скорость растёт!', W / 2, H - 4);
  } else {
    ctx.fillStyle = '#546e7a'; ctx.font = '3px monospace';
    ctx.fillText('выбери правильный ответ', W / 2, H - 4);
  }
  ctx.textAlign = 'left';
}

function drawMilestone() {
  if (mTimer <= 0) return;
  mTimer--;
  ctx.globalAlpha = Math.min(mTimer / 20, 1);
  ctx.fillStyle = 'rgba(0,0,0,0.62)'; ctx.fillRect(W/2 - 55, H/2 - 10, 110, 14);
  ctx.fillStyle = '#ffd700'; ctx.font = 'bold 5px monospace'; ctx.textAlign = 'center';
  ctx.fillText(mMsg, W/2, H/2 + 2);
  ctx.textAlign = 'left'; ctx.globalAlpha = 1;
}

// ── Стартовый экран ───────────────────────────────────────────────
function drawStart() {
  ctx.fillStyle = 'rgba(0,0,0,0.68)'; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';

  ctx.fillStyle = '#ffd700'; ctx.font = 'bold 11px monospace';
  ctx.fillText('ЕГЭ РАННЕР', W/2, 36);

  ctx.fillStyle = '#ef9a9a'; ctx.font = '4px monospace';
  ctx.fillText('Убегай от Багов, Глюков и Дедлайнов!', W/2, 47);

  ctx.fillStyle = '#80cbc4'; ctx.font = '4px monospace';
  ctx.fillText(isMobile ? 'ТАП — прыжок' : 'ПРОБЕЛ / ТАП — прыжок', W/2, 60);
  ctx.fillText('двойной прыжок доступен!', W/2, 66);

  ctx.fillStyle = '#b0bec5'; ctx.font = '4px monospace';
  ctx.fillText('метры + препятствия = твой рекорд', W/2, 74);

  if ((frame >> 5) & 1) {
    ctx.fillStyle = '#a5d6a7'; ctx.font = 'bold 5px monospace';
    ctx.fillText(isMobile ? '[ ТАП — НАЧАТЬ ]' : '[ ПРОБЕЛ / ТАП — НАЧАТЬ ]', W/2, 86);
  }

  if (hiScore > 0) {
    ctx.fillStyle = '#ffd700'; ctx.font = '5px monospace';
    ctx.fillText(`Рекорд: ${hiScore}`, W/2, 98);
  }

  // Персонаж на стартовом экране
  ctx.drawImage(SPR['run' + ((frame >> 3) & 3)], ~~(W / 2) - PLAYER_W / 2, GROUND_Y - PLAYER_H);

  ctx.textAlign = 'left';
}

// ── Game Over экран ───────────────────────────────────────────────
function drawGameOver() {
  ctx.fillStyle = 'rgba(0,0,0,0.74)'; ctx.fillRect(0, 0, W, H);
  ctx.textAlign = 'center';

  ctx.fillStyle = '#ef5350'; ctx.font = 'bold 9px monospace';
  ctx.fillText('GAME OVER', W/2, 34);

  ctx.fillStyle = '#eceff1'; ctx.font = '5px monospace';
  ctx.fillText(`Метров: ${~~meters}`, W/2, 48);
  ctx.fillText(`Препятствий: ${dodged}`, W/2, 57);

  ctx.fillStyle = '#546e7a';
  ctx.fillRect(W/2 - 48, 62, 96, 1);

  if (score >= hiScore) {
    ctx.fillStyle = '#ffd700'; ctx.font = 'bold 5px monospace';
    ctx.fillText(`★ РЕКОРД: ${score} ★`, W/2, 71);
  } else {
    ctx.fillStyle = '#90caf9'; ctx.font = '5px monospace';
    ctx.fillText(`Очки: ${score}  Рекорд: ${hiScore}`, W/2, 71);
  }

  ctx.fillStyle = '#78909c'; ctx.font = '4px monospace';
  ctx.fillText('Очки = метры + препятствия × 15', W/2, 79);

  if ((frame >> 5) & 1) {
    ctx.fillStyle = '#a5d6a7'; ctx.font = 'bold 5px monospace';
    ctx.fillText(isMobile ? '[ ТАП — ЕЩЁ РАЗ ]' : '[ ПРОБЕЛ / ТАП — ЕЩЁ РАЗ ]', W/2, 92);
  }

  ctx.textAlign = 'left';
}

// ── Счёт ─────────────────────────────────────────────────────────
function calcScore() { return ~~meters + dodged * 15; }

// ── Telegram интеграция ───────────────────────────────────────────
function submitScore(s) {
  try { if (window.TelegramGameProxy) window.TelegramGameProxy.shareScore(); } catch (_) {}
  try {
    var tgApp = window.Telegram && window.Telegram.WebApp;
    if (tgApp) tgApp.sendData(JSON.stringify({ score: s, meters: ~~meters, dodged }));
  } catch (_) {}
}

// ── Сброс и старт ─────────────────────────────────────────────────
function reset() {
  gSpeed = SPD_START; frame = 0; meters = 0; dodged = 0; combo = 0; score = 0;
  shake = 0; flash = 0; spawnTimer = 100;
  obstacles = []; particles = []; bullets = [];
  milestoneDone.clear(); mMsg = ''; mTimer = 0;
  nextQuizAt = 250; questionIdx = 0; quizData = null; quizAnswered = false;
  QUIZ_BTNS.length = 0;
  PL.reset();
}

function startGame() { reset(); state = 'playing'; }

// ── Игровой цикл ─────────────────────────────────────────────────
function update(dt) {
  frame++;
  if (jumpBuf > 0) jumpBuf--;
  updateBg(dt);

  if (state === 'quiz')    { updateQuiz(); return; }
  if (state === 'start' || state === 'gameover') return;

  if (!PL.dead) {
    gSpeed  = Math.min(gSpeed + SPD_ACCEL * dt, SPD_MAX);
    meters += gSpeed * 0.034 * dt;
    score   = calcScore();
    if (score > hiScore) { hiScore = score; localStorage.setItem('hi', hiScore); }
    checkMilestones();
    if (meters >= nextQuizAt && quizData === null) triggerQuiz();
    updateObs(dt);
    updateBullets(dt);
    if (PL.grounded && frame % 6 === 0) spawnDust(PL.x + PL.W * 0.4, GROUND_Y);
  }

  PL.update();
  updateParticles();
  if (flash > 0) flash -= 0.045;
  if (shake > 0) shake--;
}

// ── Линии скорости ────────────────────────────────────────────────
function drawSpeedLines() {
  const t = Math.max(0, (gSpeed - SPD_START - 0.8) / (SPD_MAX - SPD_START));
  if (t <= 0) return;
  ctx.save();
  ctx.strokeStyle = '#ffffff'; ctx.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    const s = i * 6.28 + 1;
    const yPos = 22 + ((s * 11.3 + frame * gSpeed * 1.2) % (H - 30));
    const xPos = (s * 19.7 + frame * gSpeed * 2.5) % W;
    const len = 4 + (i % 5) * 3;
    ctx.globalAlpha = t * (0.04 + (i % 4) * 0.03);
    ctx.lineWidth = 0.35 + (i % 3) * 0.25;
    ctx.beginPath(); ctx.moveTo(xPos, yPos); ctx.lineTo(xPos - len, yPos); ctx.stroke();
  }
  ctx.restore();
}

// ── Виньетка (кино-эффект) ────────────────────────────────────────
function drawVignette() {
  const vg = ctx.createRadialGradient(W/2, H/2, H*0.22, W/2, H/2, H*0.9);
  vg.addColorStop(0, 'transparent');
  vg.addColorStop(0.55, 'transparent');
  vg.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);
}

function draw() {
  ctx.clearRect(0, 0, W, H);   // сброс артефактов предыдущего кадра
  ctx.save();
  if (shake > 0) ctx.translate((Math.random()-0.5)*shake, (Math.random()-0.5)*shake*0.4);

  drawBg();
  drawSpeedLines();
  obstacles.forEach(drawObs);
  drawBullets();
  PL.draw();
  drawParticles();
  drawMilestone();

  if (state === 'playing' || PL.dead) drawHUD();

  if (flash > 0) {
    ctx.globalAlpha = flash; ctx.fillStyle = '#ef5350'; ctx.fillRect(0,0,W,H); ctx.globalAlpha = 1;
  }

  if (state === 'quiz')     drawQuiz();
  if (state === 'start')    drawStart();
  if (state === 'gameover') drawGameOver();

  drawVignette();
  ctx.restore();
}

initSprites();

try {
  let lastTime = 0;
  (function loop(ts) {
    const dt = lastTime ? Math.min((ts - lastTime) / (1000 / 60), 3) : 1;
    lastTime = ts;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  })(0);
} catch (e) {
  var el = document.getElementById('err');
  if (el) { el.style.display = 'block'; el.textContent = 'Init error: ' + e.message; }
}
