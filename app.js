// 普拉提 AI 教练 · 桥式验证版
// 流程：首页 → 摆放（看到全身、躺好）→ 跟练（计数 + 语音纠正）→ 小结
// 骨架识别用 Google MediaPipe Pose（开源模型，本地运行）；动作标准判定和教练逻辑是本项目自己写的。

const $ = (id) => document.getElementById(id);
const TARGET_REPS = 10;

// MediaPipe 33 个点里我们用到的 19 个
const P = {
  nose: 0, lEar: 7, rEar: 8,
  lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16,
  lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28,
  lHeel: 29, rHeel: 30, lToe: 31, rToe: 32,
};
const BONES = [
  [11, 12], [23, 24], [11, 23], [12, 24],
  [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28],
  [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
];
const VIS = 0.5; // 关键点可见度门槛

// ---------- 小工具 ----------
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
/** 以 b 为顶点的夹角，0–180 度 */
function angle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y, v2x = c.x - b.x, v2y = c.y - b.y;
  const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!m) return 0;
  return (Math.acos(clamp((v1x * v2x + v1y * v2y) / m, -1, 1)) * 180) / Math.PI;
}

// ---------- 动效小工具 ----------
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
/** 让元素重新播放一次 CSS 动画（比如计数跳动） */
function replay(el, cls) {
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}
/** 数字从 0 数到 n */
function countUp(el, n, ms = 700) {
  if (REDUCED || !n) { el.textContent = n; return; }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms);
    el.textContent = Math.round(n * (1 - Math.pow(1 - k, 4)));
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// ---------- 按钮按压反馈 ----------
// 手机上轻点一下时 :active 往往一闪而过，所以用 pressed 这个类保证至少显示 140 毫秒
let lastPress = null;
document.addEventListener('pointerdown', (e) => {
  const b = e.target.closest?.('button');
  if (!b) return;
  const r = b.getBoundingClientRect();
  b.style.setProperty('--rx', e.clientX - r.left + 'px');
  b.style.setProperty('--ry', e.clientY - r.top + 'px');
  b.classList.add('pressed');
  b.dataset.pressedAt = performance.now();
  if (b.matches('.go, .btn-primary, .btn-ghost, .pill')) replay(b, 'ripple');
  lastPress = { x: e.clientX, y: e.clientY, t: performance.now() };
  try { navigator.vibrate?.(8); } catch { /* 不支持震动就算了 */ }
});
const releaseButtons = () => {
  document.querySelectorAll('button.pressed').forEach((b) => {
    const wait = Math.max(0, 140 - (performance.now() - Number(b.dataset.pressedAt || 0)));
    setTimeout(() => b.classList.remove('pressed'), wait);
  });
};
addEventListener('pointerup', releaseButtons);
addEventListener('pointercancel', releaseButtons);
addEventListener('blur', releaseButtons);

// ---------- 语音 + 屏幕提示 ----------
const Voice = {
  ok: 'speechSynthesis' in window,
  voice: null,
  unlock() {
    if (!this.ok) return;
    const pick = () => {
      const vs = speechSynthesis.getVoices();
      this.voice = vs.find((v) => /zh[-_]CN/i.test(v.lang)) || vs.find((v) => /^zh/i.test(v.lang)) || null;
    };
    pick();
    speechSynthesis.onvoiceschanged = pick;
    // 手机浏览器要求第一次发声必须在点击里
    const u = new SpeechSynthesisUtterance(' ');
    u.volume = 0;
    speechSynthesis.speak(u);
  },
  /** priority: 2 = 打断别的立刻说；1 = 排队；0 = 有人在说就算了 */
  say(text, priority = 1) {
    if (!this.ok) return;
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      if (priority === 0) return;
      if (priority === 2) speechSynthesis.cancel();
      else if (speechSynthesis.pending) return; // 不积压
    }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    if (this.voice) u.voice = this.voice;
    u.rate = 1.05;
    speechSynthesis.speak(u);
  },
  stop() { if (this.ok) speechSynthesis.cancel(); },
};

let toastTimer = 0;
function toast(text, kind = 'cue', ms = 2600) {
  const el = $('toast');
  el.textContent = text;
  el.className = 'show ' + (kind === 'cue' ? '' : kind);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), ms);
}

// ---------- 从 33 个点里取出“朝向镜头那一侧”的身体 ----------
let lockedSide = 'l';
function readBody(lms) {
  if (!lms) return null;
  const score = (s) => ['Sh', 'Hip', 'Kn', 'An'].reduce((n, k) => n + (lms[P[s + k]]?.v ?? 0), 0);
  const l = score('l'), r = score('r');
  // 带一点粘性，避免左右来回跳
  if (lockedSide === 'l' ? r > l + 0.4 : l > r + 0.4) lockedSide = lockedSide === 'l' ? 'r' : 'l';
  const s = lockedSide;
  const ear = lms[P[s + 'Ear']], nose = lms[P.nose];
  const b = {
    side: s,
    head: ear.v >= nose.v ? ear : nose,
    shoulder: lms[P[s + 'Sh']],
    hip: lms[P[s + 'Hip']],
    knee: lms[P[s + 'Kn']],
    ankle: lms[P[s + 'An']],
  };
  b.seen = {
    head: b.head.v >= VIS,
    shoulder: b.shoulder.v >= VIS,
    hip: b.hip.v >= VIS,
    knee: b.knee.v >= VIS,
    ankle: b.ankle.v >= VIS,
  };
  b.core = b.seen.shoulder && b.seen.hip && b.seen.knee;
  b.all = b.core && b.seen.head && b.seen.ankle;
  if (b.core) {
    b.hipAngle = angle(b.shoulder, b.hip, b.knee);
    b.kneeAngle = b.seen.ankle ? angle(b.hip, b.knee, b.ankle) : null;
    b.torso = dist(b.shoulder, b.hip);
    // 躯干与水平线的夹角：躺着接近 0，站着接近 90
    b.torsoTilt = (Math.atan2(Math.abs(b.shoulder.y - b.hip.y), Math.abs(b.shoulder.x - b.hip.x)) * 180) / Math.PI;
  }
  return b;
}

// ---------- 摆放引导：缺哪个部位说哪个，躺好后自动开始 ----------
class SetupGuide {
  constructor(onReady) {
    this.onReady = onReady;
    this.lastSay = -1e9;
    this.lastKey = '';
    this.readySince = null;
    this.restSamples = [];
    this.seenSince = null;
  }
  hint(key, text, t, speak = true) {
    $('setupStatus').textContent = text;
    if (key !== 'hold') $('holdBar').style.transform = 'scaleX(0)';
    if (speak && (key !== this.lastKey ? t - this.lastSay > 2500 : t - this.lastSay > 9000)) {
      Voice.say(text, 1);
      this.lastSay = t;
      this.lastKey = key;
    }
  }
  update(b, t) {
    const parts = document.querySelectorAll('#parts .part');
    parts.forEach((el) => {
      const ok = !!b?.seen[el.dataset.k];
      el.classList.toggle('ok', ok);
      el.classList.toggle('miss', !!b && !ok);
    });
    if (!b || (!b.seen.shoulder && !b.seen.hip)) {
      this.readySince = null;
      return this.hint('none', '我还没看到你。把手机立稳，退后两三步。', t);
    }
    if (!b.seen.ankle || !b.seen.knee) {
      this.readySince = null;
      return this.hint('feet', '看不到你的腿和脚，手机再放远一点。', t);
    }
    if (!b.seen.head || !b.seen.shoulder) {
      this.readySince = null;
      return this.hint('head', '看不到你的头和肩，调一下手机角度。', t);
    }
    const lying = b.torsoTilt < 35;
    const kneesBent = b.kneeAngle != null && b.kneeAngle > 40 && b.kneeAngle < 140;
    if (!lying) {
      this.readySince = null;
      return this.hint('lie', '看到你了。侧对手机躺下，屈膝，双脚踩地。', t);
    }
    if (!kneesBent || b.hipAngle > 152) {
      this.readySince = null;
      return this.hint('bend', '把膝盖弯起来，双脚踩在垫子上。', t);
    }
    // 姿势对了，保持 1.5 秒确认，同时记录休息时的髋角
    if (this.readySince == null) { this.readySince = t; this.restSamples = []; }
    this.restSamples.push(b.hipAngle);
    this.hint('hold', '很好，保持不动…', t, false);
    $('holdBar').style.transform = `scaleX(${clamp((t - this.readySince) / 1500, 0, 1)})`;
    if (t - this.readySince > 1500) {
      const rest = this.restSamples.reduce((a, c) => a + c, 0) / this.restSamples.length;
      this.onReady(rest);
    }
  }
}

// ---------- 桥式教练：按固定节拍喊口令，再看人有没有跟上 ----------
// 普拉提的呼吸：呼气卷起，顶端吸气，呼气卷落，落地吸气准备。教练带节奏，人跟口令。
const TEMPO = { up: 4, hold: 3, down: 4, rest: 3 };   // 每段几秒
const REST_WITH_CUE = 6.5;                             // 要纠正动作时，底部多留点时间把话说完
const SEG_TEXT = { up: '呼气，抬起', hold: '停住，吸气', down: '呼气，放下', rest: '吸气，准备' };
const CUES = {
  miss: '跟着口令，把髋抬起来。',
  low: '再抬高一点，让肩、髋、膝成一条直线。',
  arch: '别用腰往上顶，肋骨收住，夹紧臀部。',
  feetFar: '脚跟离臀部近一点。',
  feetNear: '双脚再往前踩一点。',
  fast: '慢一点，用四拍一节一节卷上去。',
  noHold: '顶端停住，等我喊放下再放。',
};
const ISSUE_NAMES = {
  miss: '没跟上', low: '没抬到位', arch: '用腰顶', feetFar: '脚踩得太远', feetNear: '脚踩得太近', fast: '抬得太快', noHold: '顶端没停住',
};
const TOP_ANGLE = 165;   // 肩-髋-膝夹角达到这个值算“抬到位”
const FULL_ANGLE = 176;

class BridgeCoach {
  constructor(restAngle, onFinish) {
    this.rest = clamp(restAngle, 100, 142);
    this.startThr = this.rest + 15;
    this.onFinish = onFinish;
    this.a = this.rest;       // 平滑后的髋角
    this.seg = 'rest';        // 当前口令段：up / hold / down / rest
    this.segStart = 0;
    this.segLen = 0;
    this.rep = 0;             // 正在做第几次
    this.cur = null;
    this.reps = [];           // 每次 {ok, counted, issue, peak, dur}
    this.count = 0;           // 抬到位的次数
    this.t0 = null;
    this.lastCueRep = {};     // 每种提示上次是在第几次说的
    this.cueUntil = 0;
    this.atTop = false;
    this.done = false;
  }
  get progress() { return clamp((this.a - this.rest) / (FULL_ANGLE - this.rest), 0, 1); }
  /** 当前这段口令走了多少，0 到 1 */
  segK(t) { return this.segLen ? clamp((t - this.segStart) / (this.segLen * 1000), 0, 1) : 0; }

  /** b 可以是 null（暂时看不到人）：节拍照走，只是这段时间不判定 */
  update(b, t) {
    if (this.done) return;
    if (this.t0 == null) { this.t0 = t; this.enter('up', t); }
    if (b) this.a += (b.hipAngle - this.a) * 0.45;
    const a = this.a, c = this.cur;
    this.atTop = !!b && this.seg !== 'rest' && a >= TOP_ANGLE;
    if (b && c && this.seg !== 'rest') {
      if (a > c.peak) { c.peak = a; c.knee = b.kneeAngle; }
      if (this.atTop) {
        if (c.topAt == null) c.topAt = t;
        if (c.lastT != null) c.topMs += Math.min(t - c.lastT, 250);
        if (!c.counted && c.topMs > 250) { c.counted = true; this.count++; }
      }
      // 髋高出“肩-膝连线”太多，说明在用腰往上顶
      const dx = b.knee.x - b.shoulder.x;
      if (Math.abs(dx) > 10) {
        const lineY = b.shoulder.y + (b.knee.y - b.shoulder.y) * ((b.hip.x - b.shoulder.x) / dx);
        if ((lineY - b.hip.y) / b.torso > 0.1) c.archFrames++;
      }
    }
    if (c) c.lastT = b ? t : null;
    if (t - this.segStart >= this.segLen * 1000) {
      this.enter({ up: 'hold', hold: 'down', down: 'rest', rest: 'up' }[this.seg], t);
    }
  }

  enter(seg, t) {
    this.seg = seg; this.segStart = t; this.segLen = TEMPO[seg];
    if (seg === 'up') {
      this.rep++;
      this.cur = { t0: t, peak: this.a, topAt: null, topMs: 0, lastT: null, counted: false, archFrames: 0, knee: null };
      $('repNow').textContent = this.rep;
      replay($('repNow'), 'pop');
      Voice.say('呼气，抬起。', 2);
    } else if (seg === 'hold') {
      // 已经在抬但还差一点：趁停住的时候当场提醒
      const almost = this.a > this.startThr && this.a < TOP_ANGLE;
      Voice.say(almost ? '停住，再抬高一点。' : '停住，吸气。', 2);
    } else if (seg === 'down') {
      Voice.say('呼气，慢慢放下。', 2);
    } else {
      this.judge(t);
    }
  }

  /** 一次做完（落回地面）：判定这一次，并在底部休息时说点评 */
  judge(t) {
    const c = this.cur;
    let issue = null;
    if (c.peak <= this.startThr) issue = 'miss';
    else if (!c.counted) issue = 'low';
    else if (c.archFrames >= 4) issue = 'arch';
    else if (c.knee != null && c.knee > 115) issue = 'feetFar';
    else if (c.knee != null && c.knee < 58) issue = 'feetNear';
    else if (c.topAt - c.t0 < 1500) issue = 'fast';
    else if (c.topMs < 1500) issue = 'noHold';
    const ok = c.counted && (issue == null || issue === 'noHold');
    this.reps.push({ ok, counted: c.counted, issue, peak: c.peak, dur: (t - c.t0) / 1000 });
    const n = this.reps.length;
    this.atTop = false;

    if (n >= TARGET_REPS) { this.done = true; return this.onFinish(); }

    let say = `${n}。`;
    if (issue) {
      // 同一句提示至少隔一次再说；没跟上、没抬到位每次都说
      const last = this.lastCueRep[issue] ?? -9;
      if (issue === 'miss' || issue === 'low' || n - last >= 2) {
        this.lastCueRep[issue] = n;
        toast(CUES[issue], 'cue', 3200);
        this.cueUntil = performance.now() + 2500;
        say += CUES[issue];
        this.segLen = REST_WITH_CUE;
      }
    } else if (n % 3 === 0) {
      toast('很好，就是这样', 'good', 1800);
      say += '很好。';
    }
    const left = TARGET_REPS - n;
    if (left === 2) say += '还剩两个。';
    else if (left === 1) say += '最后一个。';
    Voice.say(say, 2);
  }

  summary(t) {
    const counted = this.reps.filter((r) => r.counted);
    const tally = {};
    this.reps.forEach((r) => { if (r.issue) tally[r.issue] = (tally[r.issue] || 0) + 1; });
    const top = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] || null;
    return {
      reps: this.reps,
      good: this.reps.filter((r) => r.ok).length,
      counted: counted.length,
      attempts: this.reps.length,
      avgPeak: counted.length ? counted.reduce((s, r) => s + r.peak, 0) / counted.length : 0,
      seconds: this.t0 == null ? 0 : (t - this.t0) / 1000,
      topIssue: top,
    };
  }
}

// ---------- 演示用的“假人”：不开摄像头也能跑完整流程 ----------
const DEMO_W = 360, DEMO_H = 640;
/** p = 抬起程度，0 躺平，1 标准顶端，>1 顶过头。返回 33 个点（像素坐标）。 */
function demoPose(p) {
  const S = { x: 96, y: 462 }, A = { x: 262, y: 468 };
  const th = (28 * p * Math.PI) / 180;
  const H = { x: S.x + 93 * Math.cos(th), y: S.y - 93 * Math.sin(th) };
  const thigh = 92, shin = 93;
  const d = dist(H, A), ux = (A.x - H.x) / d, uy = (A.y - H.y) / d;
  const a = (thigh * thigh - shin * shin + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, thigh * thigh - a * a));
  const K = { x: H.x + ux * a + uy * h, y: H.y + uy * a - ux * h };
  const pts = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 0 }));
  const set = (i, x, y, v = 0.95) => (pts[i] = { x, y, v });
  const put = (name, x, y) => { set(P['l' + name], x, y, 0.95); set(P['r' + name], x + 3, y - 4, 0.6); };
  set(P.nose, 50, 444); set(P.lEar, 60, 454); set(P.rEar, 62, 451, 0.4);
  put('Sh', S.x, S.y); put('El', 140, 468); put('Wr', 186, 471);
  put('Hip', H.x, H.y); put('Kn', K.x, K.y); put('An', A.x, A.y);
  put('Heel', 254, 474); put('Toe', 288, 472);
  return pts;
}
const ease = (x) => x * x * (3 - 2 * x);
// 演示脚本：第 3 次没抬到位，第 6 次抬得太快，其余标准。up/down = 假人用几秒抬起、放下
const DEMO_REPS = [
  { p: 1 }, { p: 1 }, { p: 0.5 }, { p: 1 }, { p: 1 },
  { p: 1, up: 1.0 }, { p: 1 }, { p: 1 }, { p: 1 }, { p: 1 },
];
class DemoSource {
  constructor() { this.coach = null; this.raf = 0; }
  start(onFrame, onDraw) {
    const loop = () => {
      const t = performance.now();
      const pose = demoPose(this.liftAt(t));
      onFrame(pose, t);
      onDraw(pose);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    return Promise.resolve({ w: DEMO_W, h: DEMO_H, mirror: false });
  }
  go() {}
  /** 假人跟着教练当前的口令段动 */
  liftAt(t) {
    const c = this.coach;
    if (!c || !c.rep || c.done) return 0;
    const r = DEMO_REPS[c.rep - 1] || { p: 1 };
    const sec = (t - c.segStart) / 1000;
    if (c.seg === 'up') return r.p * ease(clamp(sec / (r.up ?? 3.2), 0, 1));
    if (c.seg === 'hold') return r.p;
    if (c.seg === 'down') return r.p * (1 - ease(clamp(sec / (r.down ?? 3.4), 0, 1)));
    return 0;
  }
  drawBackground(ctx) {
    const g = ctx.createLinearGradient(0, 0, DEMO_W, DEMO_H);
    g.addColorStop(0, '#4a3b52'); g.addColorStop(1, '#2f4a4a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, DEMO_W, DEMO_H);
    ctx.fillStyle = 'rgba(249,201,220,.28)';
    ctx.beginPath(); ctx.roundRect(30, 474, 300, 12, 6); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.5)'; ctx.font = '13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('演示模式 · 这是模拟的人，没有使用摄像头', DEMO_W / 2, 150);
  }
  stop() { cancelAnimationFrame(this.raf); }
}

// ---------- 摄像头 + MediaPipe ----------
// 加载分几步，每一步都把进度写到加载界面上，卡在哪一步一眼能看出来
let loadStatus = '';
function setLoadStatus(text) {
  loadStatus = text;
  if (App.phase === 'loading' && App.mode !== 'demo') $('loadingText').textContent = text;
}
const withTimeout = (promise, ms, message) =>
  Promise.race([promise, new Promise((_, no) => setTimeout(() => no(new Error(message)), ms))]);
/** 自己下载文件，这样能显示已经下了多少 */
async function fetchBytes(url, label) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${label}下载失败（${r.status}）`);
  const reader = r.body?.getReader?.();
  if (!reader) return new Uint8Array(await r.arrayBuffer());
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    setLoadStatus(`${label}：已下载 ${(got / 1048576).toFixed(1)} MB`);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
/** 调试用：把被接住的错误也显示在屏幕底部的红框里，带上是哪一步出的 */
function debugNote(where, e) {
  console.warn(where, e);
  window.__report?.(`[${where}] ${e?.name || ''} ${e?.message || e}\n${String(e?.stack || '').split('\n').slice(0, 4).join('\n')}`);
}
let landmarkerPromise = null;
function loadModel() {
  return (landmarkerPromise ??= (async () => {
    setLoadStatus('第 1 步 / 共 3 步：下载识别程序…');
    const { PoseLandmarker, FilesetResolver } = await import('./vendor/tasks-vision/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks('./vendor/tasks-vision/wasm');
    // 先把最大的两个文件下到浏览器缓存里（约 10 MB + 6 MB），后面启动时就不用再等网络
    // 预下载只是为了显示进度和提速，失败了不影响后面：识别库会自己再去取
    const base = new URL('./vendor/', location.href).href;
    let model = null;
    try { await fetchBytes(base + 'tasks-vision/wasm/' + String(fileset.wasmBinaryPath).split('/').pop(), '第 1 步 / 共 3 步：识别程序'); }
    catch (e) { debugNote('预下载识别程序', e); }
    try { model = await fetchBytes(base + 'pose_landmarker_lite.task', '第 2 步 / 共 3 步：识别模型'); }
    catch (e) { debugNote('预下载识别模型', e); }
    const make = (delegate) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { ...(model ? { modelAssetBuffer: model } : { modelAssetPath: base + 'pose_landmarker_lite.task' }), delegate },
        runningMode: 'VIDEO',
        numPoses: 1,
      });
    setLoadStatus('第 3 步 / 共 3 步：启动识别（显卡加速）…');
    try {
      return await withTimeout(make('GPU'), 15000, 'GPU 启动超时');
    } catch (e) {
      debugNote('显卡加速启动', e);
      setLoadStatus('第 3 步 / 共 3 步：启动识别（兼容模式）…');
      try {
        return await withTimeout(make('CPU'), 45000, '识别模型启动超时。请刷新页面再试一次。');
      } catch (e2) { debugNote('兼容模式启动', e2); throw e2; }
    }
  })().then((m) => { setLoadStatus('识别已就绪，正在等待摄像头…'); return m; })
    .catch((e) => { landmarkerPromise = null; throw e; }));
}

class CameraSource {
  constructor(facing = 'user') { this.facing = facing; this.raf = 0; this.stream = null; }
  async start(onFrame, onDraw) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('这个地址打不开摄像头。手机上请用 https:// 开头的地址访问。');
    }
    const [landmarker, stream] = await Promise.all([
      loadModel(),
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: this.facing, width: { ideal: 720 }, height: { ideal: 1280 } },
      }).catch((e) => { debugNote('打开摄像头', e); throw e; }),
    ]);
    this.stream = stream;
    setLoadStatus('正在打开摄像头画面…');
    const video = $('video');
    video.srcObject = stream;
    try { await withTimeout(video.play(), 10000, '摄像头画面没有出来。请刷新页面再试一次。'); }
    catch (e) { debugNote('播放摄像头画面', e); throw e; }
    const w = video.videoWidth, h = video.videoHeight;
    let lastDetect = 0, lastVideoTime = -1, lms = null, shown = null, lastDraw = 0;
    const loop = () => {
      const t = performance.now();
      // 每秒最多识别约 15 次，普拉提动作慢，够用也省电
      if (t - lastDetect >= 66 && video.currentTime !== lastVideoTime && video.readyState >= 2) {
        lastDetect = t; lastVideoTime = video.currentTime;
        try {
          const res = landmarker.detectForVideo(video, t);
          const raw = res.landmarks?.[0];
          lms = raw ? raw.map((p) => ({ x: p.x * w, y: p.y * h, v: p.visibility ?? 0 })) : null;
        } catch (e) { console.warn('detect failed', e); }
        onFrame(lms, t);
      }
      // 识别每秒约 15 次，画出来的骨架按屏幕刷新率向最新结果靠拢，线条不跳
      if (!lms) shown = null;
      else if (!shown) shown = lms.map((q) => ({ ...q }));
      else {
        const k = 1 - Math.exp(-(t - lastDraw) / 55);
        shown.forEach((q, i) => { q.x += (lms[i].x - q.x) * k; q.y += (lms[i].y - q.y) * k; q.v = lms[i].v; });
      }
      lastDraw = t;
      onDraw(shown);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
    return { w, h, mirror: this.facing === 'user' };
  }
  go() {}
  stop() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((tr) => tr.stop());
    $('video').srcObject = null;
  }
}

// ---------- 画骨架 ----------
function drawSkeleton(ctx, lms, w, state) {
  if (!lms) return;
  const lw = Math.max(3, w / 80);
  ctx.lineCap = 'round';
  ctx.lineWidth = lw;
  ctx.strokeStyle = 'rgba(143,220,207,.9)';
  for (const [i, j] of BONES) {
    const a = lms[i], b = lms[j];
    if (a.v < 0.4 || b.v < 0.4) continue;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  }
  // 教练盯着看的那条线：肩 → 髋 → 膝
  if (state.core) {
    const sh = lms[P[state.side + 'Sh']], hip = lms[P[state.side + 'Hip']], kn = lms[P[state.side + 'Kn']];
    ctx.lineWidth = lw * 2.1;
    ctx.strokeStyle = state.cue ? '#e8789f' : state.atTop ? '#3bb8a6' : '#ffffff';
    ctx.beginPath(); ctx.moveTo(sh.x, sh.y); ctx.lineTo(hip.x, hip.y); ctx.lineTo(kn.x, kn.y); ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  for (const i of Object.values(P)) {
    const p = lms[i];
    if (p.v < 0.4 || i === P.rEar || i === P.lEar) continue;
    ctx.beginPath(); ctx.arc(p.x, p.y, lw * 0.9, 0, Math.PI * 2); ctx.fill();
  }
}

// ---------- 首页的动作示范小动画（发力部位高亮） ----------
function startHomeFigure() {
  const cv = $('demoFig'), ctx = cv.getContext('2d');
  const css = getComputedStyle($('home'));
  const rgb = (name) => css.getPropertyValue(name).trim();
  let BODY, HOT, MAT, W;
  const readColors = () => {
    BODY = `rgb(${rgb('--fig-body')})`; HOT = rgb('--fig-hot'); MAT = `rgba(${rgb('--fig-mat')},.3)`;
    W = parseFloat(rgb('--fig-w')) || 7;
  };
  const sx = (x) => (x - 20) * 2.02, sy = (y) => (y - 345) * 2.02;
  const path = (pts) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y)))); };
  const io = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2); // 慢起慢停
  // 一次呼吸：呼气抬起 2.4 秒 → 顶端停 2 秒 → 吸气放下 2.6 秒 → 休息 1.6 秒
  const UP = 2.4, HOLD = 2.0, DOWN = 2.6, REST = 1.6, CYCLE = UP + HOLD + DOWN + REST;
  let glow = 0, last = 0;
  const frame = (now) => {
    if (!$('home').hidden && !document.hidden) {
      const cyc = (now / 1000) % CYCLE;
      let p = cyc < UP ? io(cyc / UP) : cyc < UP + HOLD ? 1 : cyc < UP + HOLD + DOWN ? 1 - io((cyc - UP - HOLD) / DOWN) : 0;
      if (REDUCED) p = 1; // 减弱动效：停在顶端姿势
      // 发力的光比动作慢半拍亮起，停住时轻轻起伏
      const holdPulse = cyc >= UP && cyc < UP + HOLD ? 0.08 * Math.sin(((cyc - UP) / HOLD) * Math.PI * 2) : 0;
      const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now;
      glow += (clamp(p + holdPulse, 0, 1) - glow) * (REDUCED ? 1 : 1 - Math.exp(-dt * 4));
      $('home').style.setProperty('--breath', glow.toFixed(3));

      const L = demoPose(p), g = (k) => L[P[k]];
      const S = g('lSh'), H = g('lHip'), K = g('lKn');
      // 脊柱不是一块板：抬到一半时下背还贴近垫子，到顶才拉直
      const sag = 15 * Math.sin(Math.PI * p) ** 0.9;
      const C = { x: S.x + (H.x - S.x) * 0.56, y: S.y + (H.y - S.y) * 0.56 + sag };
      const spineAt = (u) => ({
        x: (1 - u) * (1 - u) * S.x + 2 * (1 - u) * u * C.x + u * u * H.x,
        y: (1 - u) * (1 - u) * S.y + 2 * (1 - u) * u * C.y + u * u * H.y,
      });
      readColors();
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      // 垫子
      ctx.strokeStyle = MAT; ctx.lineWidth = 4;
      path([{ x: 34, y: 480 }, { x: 306, y: 480 }]); ctx.stroke();
      // 发力部位：下背 → 臀 → 大腿后侧的一道柔光
      const half = { x: (H.x + K.x) / 2, y: (H.y + K.y) / 2 };
      ctx.save();
      ctx.shadowColor = `rgba(${HOT},${0.9 * glow})`; ctx.shadowBlur = 18 + 14 * glow;
      ctx.strokeStyle = `rgba(${HOT},${0.14 + 0.76 * glow})`; ctx.lineWidth = W * (2.2 + 0.6 * glow);
      path([spineAt(0.62), spineAt(0.8), H, half]); ctx.stroke();
      ctx.restore();
      // 身体：一笔连贯的线
      ctx.strokeStyle = BODY; ctx.lineWidth = W;
      ctx.beginPath();
      ctx.moveTo(sx(S.x), sy(S.y));
      ctx.quadraticCurveTo(sx(C.x), sy(C.y), sx(H.x), sy(H.y));
      for (const q of [K, g('lAn'), g('lToe')]) ctx.lineTo(sx(q.x), sy(q.y));
      ctx.stroke();
      path([S, g('lEl'), g('lWr')]); ctx.stroke();
      ctx.fillStyle = BODY; ctx.beginPath(); ctx.arc(sx(60), sy(452), W * 1.55, 0, Math.PI * 2); ctx.fill();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------- 页面流程 ----------
const App = {
  mode: 'camera',
  facing: 'user',
  source: null,
  phase: 'home', // home | loading | setup | countdown | work | done
  guide: null,
  coach: null,
  size: { w: DEMO_W, h: DEMO_H },
  lostSince: null,
  wake: null,

  /** 切换页面。from = 触发切换的按钮：进入跟练时，深色画面从这个按钮的位置展开 */
  show(id, from) {
    const all = ['home', 'stageScreen', 'summary'].map($);
    const next = $(id);
    const cur = all.find((el) => !el.hidden && el !== next);
    clearTimeout(this.showTimer);
    for (const el of all) {
      el.classList.remove('enter-reveal', 'enter-rise', 'enter-fade');
      el.style.zIndex = '';
      if (el !== next && el !== cur) el.hidden = true;
    }
    if (!cur || REDUCED && id !== 'summary') {
      if (cur) cur.hidden = true;
      next.hidden = false;
      return;
    }
    const kind = id === 'stageScreen' && from ? 'enter-reveal' : id === 'summary' ? 'enter-rise' : 'enter-fade';
    if (from) {
      // 从手指按下的位置展开；没有按压记录（比如键盘操作）就用按钮中心
      const r = from.getBoundingClientRect(), ph = $('phone').getBoundingClientRect();
      const hit = lastPress && performance.now() - lastPress.t < 900 ? lastPress : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      next.style.setProperty('--ox', hit.x - ph.left + 'px');
      next.style.setProperty('--oy', hit.y - ph.top + 'px');
    }
    next.hidden = false;
    next.style.zIndex = 2;
    next.classList.add(kind);
    this.showTimer = setTimeout(() => {
      cur.hidden = true;
      next.style.zIndex = '';
      next.classList.remove(kind);
    }, kind === 'enter-reveal' ? 620 : kind === 'enter-rise' ? 460 : 240);
  },

  fitView() {
    const st = $('stage').getBoundingClientRect();
    const { w, h } = this.size;
    const k = Math.min(st.width / w, st.height / h);
    $('view').style.width = w * k + 'px';
    $('view').style.height = h * k + 'px';
    $('view').style.aspectRatio = 'auto';
  },

  async start(mode, from) {
    this.mode = mode;
    Voice.unlock();
    this.show('stageScreen', from);
    this.phase = 'loading';
    $('loading').hidden = false;
    $('loadingText').textContent = mode === 'demo' ? '正在准备演示…' : (loadStatus || '正在加载动作识别模型，并请求摄像头权限…');
    $('setupPanel').hidden = false; $('hud').hidden = true;
    $('stageTitle').textContent = '摆放手机';
    $('btnFlip').hidden = mode === 'demo';
    $('video').hidden = mode === 'demo';
    $('repNow').textContent = '0';
    $('repAll').textContent = ' / ' + TARGET_REPS;
    this.source?.stop();
    this.source = mode === 'demo' ? new DemoSource() : new CameraSource(this.facing);
    this.guide = new SetupGuide((rest) => this.beginWorkout(rest));
    this.coach = null;
    try {
      const info = await this.source.start((lms, t) => this.onFrame(lms, t), (lms) => this.draw(lms));
      this.size = { w: info.w, h: info.h };
      const cv = $('overlay'); cv.width = info.w; cv.height = info.h;
      $('view').classList.toggle('mirror', info.mirror);
      this.fitView();
      $('loading').hidden = true;
      this.phase = 'setup';
      try { this.wake = await navigator.wakeLock?.request('screen'); } catch { /* 没有也不影响 */ }
    } catch (e) {
      console.error(e);
      debugNote('启动（最后停在：' + loadStatus + '）', e);
      const msg = e?.name === 'NotAllowedError' ? '没有拿到摄像头权限。请在浏览器里允许使用摄像头后再试。'
        : e?.name === 'NotFoundError' ? '这台设备没有找到摄像头。可以先看演示模式。'
        : (e?.message || '启动失败');
      $('loadingText').textContent = msg + '（点左上角返回）';
      document.querySelector('#loading .spinner').hidden = true;
    }
  },

  /** 每一帧屏幕刷新都画一次骨架 */
  draw(lms) {
    if (!this.source) return;
    const cv = $('overlay'), ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (this.mode === 'demo') this.source.drawBackground(ctx);
    drawSkeleton(ctx, lms, cv.width, {
      side: this.body?.side ?? 'l', core: !!this.body?.core,
      atTop: !!this.coach?.atTop, cue: !!this.coach && performance.now() < this.coach.cueUntil,
    });
  },

  /** 每次拿到新的识别结果，更新教练的判断 */
  onFrame(lms, t) {
    const b = readBody(lms);
    this.body = b;

    if (this.phase === 'setup') return this.guide.update(b, t);
    if (this.phase !== 'work') return;

    if (!b?.core) {
      // 跟练中看不到人：先暂停判定，超过 1.5 秒提醒
      if (this.lostSince == null) this.lostSince = t;
      if (t - this.lostSince > 1500) { this.lostSince = t + 6000; toast('看不到你了，回到画面里', 'info', 3000); Voice.say('看不到你了，回到画面里。', 0); }
    } else this.lostSince = null;
    const c = this.coach;
    c.update(b?.core ? b : null, t);
    $('phaseText').textContent = SEG_TEXT[c.seg];
    document.querySelector('#meter i').style.transform = `scaleX(${c.progress.toFixed(3)})`;
    $('meter').classList.toggle('good', c.atTop);
  },

  beginWorkout(rest) {
    if (this.phase !== 'setup') return;
    this.phase = 'countdown';
    $('setupPanel').hidden = true; $('hud').hidden = false;
    replay($('hud'), 'enter-hud');
    $('stageTitle').textContent = '桥式 · 10 次';
    $('phaseText').textContent = '准备';
    toast('准备好了', 'good', 2200);
    Voice.say('准备好了。不用看屏幕，跟着我的口令做。', 2);
    this.coach = new BridgeCoach(rest, () => this.finish());
    if (this.source instanceof DemoSource) this.source.coach = this.coach;
    setTimeout(() => {
      if (this.phase !== 'countdown') return;
      this.phase = 'work';
      this.source.go();
    }, 4600);
  },

  finish() {
    if (this.phase === 'done') return;
    const s = this.coach ? this.coach.summary(performance.now()) : null;
    this.phase = 'done';
    setTimeout(() => {
      this.source?.stop(); this.source = null;
      this.wake?.release?.(); this.wake = null;
      this.renderSummary(s);
      this.show('summary');
    }, s && s.attempts >= TARGET_REPS ? 1200 : 0);
  },

  renderSummary(s) {
    s ??= { reps: [], good: 0, counted: 0, attempts: 0, avgPeak: 0, seconds: 0, topIssue: null };
    countUp($('sumGood'), s.good);
    $('sumOf').textContent = `/ ${s.attempts} 次标准`;
    $('sumTime').textContent = `${Math.floor(s.seconds / 60)}:${String(Math.round(s.seconds % 60)).padStart(2, '0')}`;
    $('sumAngle').textContent = s.avgPeak ? Math.round(s.avgPeak) + '°' : '–';
    $('sumTry').textContent = s.attempts;
    $('sumReps').innerHTML = '';
    s.reps.forEach((r, i) => {
      const el = document.createElement('span');
      el.className = 'rep' + (r.ok ? '' : ' bad');
      el.textContent = i + 1;
      el.title = r.issue ? ISSUE_NAMES[r.issue] : '标准';
      el.style.animationDelay = 260 + Math.min(i * 32, 380) + 'ms'; // 一颗一颗出现，总时长封顶
      $('sumReps').appendChild(el);
    });
    let title, note;
    if (!s.attempts) {
      title = '这次还没开始。';
      note = '教练没有记录到完整的动作。确认全身都在画面里，再试一次。';
    } else if (!s.topIssue) {
      title = '全部标准，漂亮。';
      note = '<b>下次可以试试：</b>顶端多停一秒，放下的时候再慢一点，臀部会更有感觉。';
    } else {
      const [k, n] = s.topIssue;
      title = s.good >= s.attempts * 0.7 ? '做得不错。' : '有进步空间。';
      const advice = {
        low: '抬起时先夹紧臀部，再把髋往天花板送，直到肩、髋、膝连成一条直线。',
        arch: '抬到直线就够了，不用更高。想着把肋骨往下收，力量留在臀部而不是腰。',
        feetFar: '躺下时把脚跟往臀部方向收一点，抬起后小腿大约垂直地面。',
        feetNear: '双脚往前挪半个脚掌，抬起后小腿大约垂直地面。',
        miss: '听到“抬起”就开始动，跟不上也没关系，先把节奏对上。',
        fast: '听到“抬起”后用四拍慢慢卷上去，不用抢。慢，才练得到臀部和核心。',
        noHold: '到顶端先停住，等听到“放下”再往下放。',
      }[k];
      note = `<b>最常出现：${ISSUE_NAMES[k]}（${n} 次）。</b>${advice}`;
    }
    $('sumTitle').textContent = title;
    $('sumNote').innerHTML = note;
    Voice.say(s.attempts ? `完成。${s.attempts} 次里有 ${s.good} 次标准。` : '这次先到这里。', 2);
  },

  home() {
    Voice.stop();
    this.source?.stop(); this.source = null;
    this.wake?.release?.(); this.wake = null;
    this.phase = 'home';
    document.querySelector('#loading .spinner').hidden = false;
    this.show('home');
  },
};

// 首页主题：默认浅色；?theme=dark 或右上角按钮切到深色，并记住选择
const applyTheme = (dark) => $('home').classList.toggle('dark', dark);
let darkHome = false;
try { darkHome = localStorage.getItem('homeTheme') === 'dark'; } catch { /* 读不到就用浅色 */ }
const themeQ = new URLSearchParams(location.search).get('theme');
if (themeQ) darkHome = themeQ === 'dark';
applyTheme(darkHome);
$('btnTheme').onclick = () => {
  darkHome = !darkHome;
  // 支持的浏览器里，深浅色之间柔和地交叉淡化
  if (document.startViewTransition && !REDUCED) document.startViewTransition(() => applyTheme(darkHome));
  else applyTheme(darkHome);
  try { localStorage.setItem('homeTheme', darkHome ? 'dark' : 'light'); } catch { /* 忽略 */ }
};

$('btnStart').onclick = () => App.start('camera', $('btnStart'));
$('btnDemo').onclick = () => App.start('demo', $('btnDemo'));
$('btnBack').onclick = () => App.home();
$('btnHome').onclick = () => App.home();
$('btnAgain').onclick = () => App.start(App.mode);
$('btnEnd').onclick = () => App.finish();
$('btnForce').onclick = () => App.beginWorkout(130);
$('btnFlip').onclick = () => { App.facing = App.facing === 'user' ? 'environment' : 'user'; App.start('camera'); };
addEventListener('resize', () => App.phase !== 'home' && App.fitView());

startHomeFigure();
window.__app = App;
if (!new URLSearchParams(location.search).has('demo')) setTimeout(() => loadModel().catch(() => {}), 1200); // 方便调试
window.__test = { BridgeCoach, SetupGuide, DemoSource, demoPose, readBody };
if (new URLSearchParams(location.search).has('demo')) App.start('demo');
