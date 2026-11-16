// 普拉提 AI 教练 · 三个仰卧屈膝的动作：桥式、屈膝抬腿、脚跟滑动
// 流程：首页 → 摆放（看到全身、躺好）→ 跟练（计数 + 语音纠正）→ 小结
// 骨架识别用 Google MediaPipe Pose（开源模型，本地运行）；动作标准判定和教练逻辑是本项目自己写的。

import { MOVES, movePose } from './moves.js?v=42';
const $ = (id) => document.getElementById(id);
let TARGET_REPS = 10;   // 自由练习一组 10 次；按计划练时换成计划里定的次数

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

// ---------- 录像：摄像头画面 + 骨架 + 教练说的话，合成一段视频，只留在本机 ----------
const Rec = {
  mr: null, chunks: [], cv: null, ctx: null, stream: null, last: 0, t0: 0, caption: '', capAt: 0, mime: '',
  /** 教练每说一句话，记下来当字幕（系统朗读的声音录不进视频，所以用字幕代替） */
  note(text) { this.caption = text; this.capAt = performance.now(); },
  start(w, h) {
    this.stop(true);
    if (!window.MediaRecorder || !HTMLCanvasElement.prototype.captureStream) return;
    try {
      const k = Math.min(1, 720 / Math.max(w, h));
      this.cv = document.createElement('canvas');
      this.cv.width = Math.round((w * k) / 2) * 2; this.cv.height = Math.round((h * k) / 2) * 2;
      this.ctx = this.cv.getContext('2d');
      this.mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp8', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
      this.stream = this.cv.captureStream(15);
      this.chunks = [];
      const mr = new MediaRecorder(this.stream, { ...(this.mime ? { mimeType: this.mime } : {}), videoBitsPerSecond: 1200000 });
      mr.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
      mr.start(1000);
      this.mr = mr; this.t0 = performance.now(); this.caption = '';
    } catch (e) { debugNote('开始录像', e); this.mr = null; }
  },
  /** 每秒画约 15 帧：画面按原比例放进录像，手机中途转方向也不会变形 */
  frame(video, overlay, mirror, hud) {
    if (!this.mr) return;
    const t = performance.now();
    if (t - this.last < 60) return;
    this.last = t;
    const { cv, ctx } = this, W = cv.width, H = cv.height;
    if (t - this.t0 > 8 * 60000) return; // 最长录 8 分钟，避免占满内存
    ctx.fillStyle = '#2a2430'; ctx.fillRect(0, 0, W, H);
    const k = Math.min(W / overlay.width, H / overlay.height);
    const w = overlay.width * k, h = overlay.height * k, x = (W - w) / 2, y = (H - h) / 2;
    ctx.save();
    if (mirror) { ctx.translate(W, 0); ctx.scale(-1, 1); }
    try { if (video && video.readyState >= 2) ctx.drawImage(video, x, y, w, h); } catch { /* 这一帧跳过 */ }
    ctx.drawImage(overlay, x, y, w, h);
    ctx.restore();
    const u = Math.max(14, Math.round(Math.min(W, H) / 22));
    const label = (text, cx, cy, align, bg) => {
      ctx.font = `600 ${u}px "OPPO Sans", "PingFang SC", sans-serif`;
      ctx.textAlign = align; ctx.textBaseline = 'middle';
      const tw = ctx.measureText(text).width, pad = u * 0.6;
      const left = align === 'center' ? cx - tw / 2 - pad : align === 'right' ? cx - tw - pad : cx - pad;
      ctx.fillStyle = bg; ctx.fillRect(left, cy - u * 0.9, tw + pad * 2, u * 1.8);
      ctx.fillStyle = '#fff'; ctx.fillText(text, cx, cy);
    };
    const sec = Math.floor((t - this.t0) / 1000);
    label(hud, u * 1.2, u * 1.6, 'left', 'rgba(30,22,34,.6)');
    const tech = runInfo.delegate ? ` · ${runInfo.model} ${runInfo.delegate} ${Math.round(runInfo.detectMs)}ms` : '';
    label(`${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}${tech}`, W - u * 1.2, u * 1.6, 'right', 'rgba(30,22,34,.6)');
    if (this.caption && t - this.capAt < 4500) {
      // 太长的话分两行
      const max = Math.floor((W - u * 3) / u);
      const cut = Math.ceil(this.caption.length / 2);
      const lines = this.caption.length > max ? [this.caption.slice(0, cut), this.caption.slice(cut)] : [this.caption];
      lines.forEach((ln, i) => label('教练：' + ln, W / 2, H - u * 1.8 - (lines.length - 1 - i) * u * 1.9, 'center', 'rgba(215,92,136,.88)'));
    }
  },
  /** 停止录像，返回视频文件；discard = 不要了 */
  stop(discard) {
    const mr = this.mr;
    this.mr = null;
    if (!mr) return Promise.resolve(null);
    return new Promise((done) => {
      const end = () => {
        this.stream?.getTracks().forEach((tr) => tr.stop());
        const blob = discard || !this.chunks.length ? null : new Blob(this.chunks, { type: mr.mimeType || this.mime || 'video/mp4' });
        this.chunks = [];
        done(blob);
      };
      mr.onstop = end;
      try { mr.stop(); } catch { end(); }
      setTimeout(end, 3000); // 个别浏览器不触发 onstop
    });
  },
};

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
  say(text, priority = 1, onEnd = null) {
    if (!this.ok) return Rec.note(text);
    if (speechSynthesis.speaking || speechSynthesis.pending) {
      if (priority === 0) return;
      if (priority === 2) speechSynthesis.cancel();
      else if (speechSynthesis.pending) return; // 不积压
    }
    Rec.note(text);
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'zh-CN';
    if (this.voice) u.voice = this.voice;
    u.rate = 1.05;
    if (onEnd) u.onend = u.onerror = onEnd;
    speechSynthesis.speak(u);
  },
  stop() { if (this.ok) speechSynthesis.cancel(); },
};
/** 估计一句话要念多久（毫秒）：按字数算，逗号、句号各停一下 */
const estSpeak = (text) => 250 + ((text.replace(/[，。]/g, '').length * 215 + (text.match(/，/g) || []).length * 200 + (text.match(/。/g) || []).length * 380) / 1.05);
/** 念完一段话再做下一步。有的手机收不到“念完了”，所以另外按估计的时间兜底；minMs = 最少等这么久 */
function speakThen(text, cb, minMs = 0) {
  const t0 = performance.now();
  let done = false;
  const fire = () => {
    if (done) return;
    done = true;
    setTimeout(cb, Math.max(0, minMs - (performance.now() - t0)));
  };
  Voice.say(text, 2, fire);
  setTimeout(fire, estSpeak(text) * 1.25 + 2000);
}
/** 1～99 的中文数字 */
const cn = (n) => { const d = '零一二三四五六七八九'; return n < 10 ? d[n] : (n < 20 ? '' : d[Math.floor(n / 10)]) + '十' + (n % 10 ? d[n % 10] : ''); };

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
  /** loose = 只确认全身都在画面里，不要求先躺好（按计划练时，每个动作的起始姿势不一样） */
  constructor(onReady, loose = false) {
    this.onReady = onReady;
    this.loose = loose;
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
    if (App.mode === 'camera' && App.size.h > App.size.w * 1.1 && !b?.all) {
      this.readySince = null;
      return this.hint('rotate', '把手机横过来立稳，侧面对着你。已经横着放了的话，请先关掉手机的竖屏锁定。', t);
    }
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
    // 身体贴着画面下边或上边时，髋和肩容易被认错位置
    const ys = [b.shoulder.y, b.hip.y, b.ankle.y], H = App.size.h;
    if (Math.max(...ys) > H * 0.9) {
      this.readySince = null;
      return this.hint('low', '你太靠画面下边了。把手机往下压一点，让身体在画面中间。', t);
    }
    if (Math.min(...ys, b.knee.y) < H * 0.06) {
      this.readySince = null;
      return this.hint('high', '你太靠画面上边了。把手机往上抬一点，让身体在画面中间。', t);
    }
    const lying = b.torsoTilt < 35;
    const kneesBent = b.kneeAngle != null && b.kneeAngle > 40 && b.kneeAngle < 140;
    if (!this.loose && !lying) {
      this.readySince = null;
      // 画面是竖的，人在画面里也是“竖”的：多半是手机横着放了，但开着竖屏锁定，画面被转了 90 度
      if (App.mode === 'camera' && App.size.h > App.size.w * 1.1 && b.torsoTilt > 55) {
        return this.hint('locked', '画面方向不对。请先关掉手机的竖屏锁定，再把手机横过来。', t);
      }
      return this.hint('lie', '看到你了。侧对手机躺下，屈膝，双脚踩地。', t);
    }
    if (!this.loose && (!kneesBent || b.hipAngle > 152)) {
      this.readySince = null;
      return this.hint('bend', '把膝盖弯起来，双脚踩在垫子上。', t);
    }
    // 姿势对了，保持 1.5 秒确认，同时记录休息时的髋角
    if (this.readySince == null) { this.readySince = t; this.restSamples = []; }
    const v0 = this.loose ? null : EX.value(b);
    if (v0 != null) this.restSamples.push(v0);
    this.hint('hold', '很好，保持不动…', t, false);
    $('holdBar').style.transform = `scaleX(${clamp((t - this.readySince) / 1500, 0, 1)})`;
    if (t - this.readySince > 1500) {
      const n = this.restSamples.length;
      this.onReady(n ? this.restSamples.reduce((a, c) => a + c, 0) / n : null);
    }
  }
}

// ---------- 教练：按固定节拍喊口令，再看人有没有跟上 ----------
// 普拉提的呼吸：呼气发力，顶端吸气，呼气还原，落地吸气准备。教练带节奏，人跟口令。
const TEMPO = { up: 4, hold: 3, down: 4, rest: 3 };   // 每段几秒
const REST_WITH_CUE = 6.5;                             // 要纠正动作时，底部多留点时间把话说完

// ---------- 动作库 ----------
// 三个动作的起始姿势一样（仰卧、屈膝、双脚踩地），所以换动作不用重新摆手机。
// value = 教练盯着看的那个角度；dir = 1 表示角度越大越到位，-1 表示越小越到位；
// rest = 起始角度的合理范围；start = 离开起始角度多少度算“动了”；top = 到位线；full = 进度条满格
const EXERCISES = [
  {
    id: 'bridge', name: '桥式', muscles: ['臀部', '大腿后侧', '核心'],
    pos: '平躺在垫子上，双腿屈膝，双脚踩地', cue: '夹紧臀部，把髋往上顶，抬成一条直线',
    steps: [['躺好', '屈膝，双脚踩地，手放两边', ''], ['抬起', '夹紧臀部，抬成一条直线', 'out'], ['停住', '在最高处停一下', 'in'], ['放下', '慢慢放回垫子', 'out']],
    seg: { up: '呼气，抬起', hold: '停住，吸气', down: '呼气，放下', rest: '吸气，准备' },
    say: { up: '呼气，抬起。', hold: '停住，吸气。', almost: '停住，再抬高一点。', down: '呼气，慢慢放下。' },
    meter: '抬起高度', angleName: '平均抬起角度', ideal: 175,
    value: (b) => b.hipAngle, dir: 1, rest: [100, 142], start: 15, top: 160, full: 176,   // 理想是 170 以上，到位线留出识别误差
    line: ['Sh', 'Hip', 'Kn'],
    cues: {
      miss: '跟着口令，把髋抬起来。',
      low: '再抬高一点，让肩、髋、膝成一条直线。',
      arch: '别用腰往上顶，肋骨收住，夹紧臀部。',
      feetFar: '脚跟离臀部近一点。',
      feetNear: '双脚再往前踩一点。',
      fast: '慢一点，用四拍一节一节卷上去。',
      noHold: '顶端停住，等我喊放下再放。',
    },
    names: { miss: '没跟上', low: '没抬到位', arch: '用腰顶', feetFar: '脚踩得太远', feetNear: '脚踩得太近', fast: '抬得太快', noHold: '顶端没停住' },
    advice: {
      low: '抬起时先夹紧臀部，再把髋往天花板送，直到肩、髋、膝连成一条直线。',
      arch: '抬到直线就够了，不用更高。想着把肋骨往下收，力量留在臀部而不是腰。',
      feetFar: '躺下时把脚跟往臀部方向收一点，抬起后小腿大约垂直地面。',
      feetNear: '双脚往前挪半个脚掌，抬起后小腿大约垂直地面。',
      miss: '听到“抬起”就开始动，跟不上也没关系，先把节奏对上。',
      fast: '听到“抬起”后用四拍慢慢卷上去，不用抢。慢，才练得到臀部和核心。',
      noHold: '到顶端先停住，等听到“放下”再往下放。',
    },
    perfect: '顶端多停一秒，放下的时候再慢一点，臀部会更有感觉。',
    /** 髋高出“肩-膝连线”太多，说明在用腰往上顶 */
    watch(b, c) {
      const dx = b.knee.x - b.shoulder.x;
      if (Math.abs(dx) <= 10) return;
      const lineY = b.shoulder.y + (b.knee.y - b.shoulder.y) * ((b.hip.x - b.shoulder.x) / dx);
      if ((lineY - b.hip.y) / b.torso > 0.1) c.flag++;
    },
    extra: (c) => (c.flag >= 4 ? 'arch' : c.knee != null && c.knee > 115 ? 'feetFar' : c.knee != null && c.knee < 58 ? 'feetNear' : null),
    pose: bridgePose, sag: true, fit: 1, hot: { hip: 1, thigh: 1, waist: 0.55 }, glow2d: 'back', tuck: 0.5,
    // ↑ 主要是臀和大腿后侧，下背和核心帮忙稳住
    arrow: { at: 'Hip', dir: 'up' }, cam: { x: 0.4, dist: 2.55 },
    idealTop: idealBridge,
  },
  {
    id: 'kneefold', name: '屈膝抬腿', muscles: ['下腹', '核心', '髋前侧'],
    pos: '平躺在垫子上，双腿屈膝，双脚踩地', cue: '收紧肚子，把腿抬到大腿竖直，腰贴住垫子',
    steps: [['躺好', '屈膝，双脚踩地，手放两边', ''], ['抬腿', '收紧肚子，抬到大腿竖直', 'out'], ['停住', '小腿放平，脚放松，腰贴垫子', 'in'], ['放下', '脚尖慢慢点回垫子', 'out']],
    seg: { up: '呼气，抬腿', hold: '停住，吸气', down: '呼气，放下', rest: '吸气，准备' },
    say: { up: '呼气，抬腿。', hold: '停住，吸气。', almost: '停住，膝盖再抬高一点。', down: '呼气，慢慢放下。' },
    meter: '抬腿高度', angleName: '平均大腿角度', ideal: 90,
    value: (b) => b.hipAngle, dir: -1, rest: [112, 150], start: 10, top: 102, full: 90,   // 大腿竖直时肩-髋-膝是 90 度
    line: ['Sh', 'Hip', 'Kn'],
    cues: {
      miss: '跟着口令，把双腿抬起来。',
      low: '膝盖再抬高一点，抬到大腿竖直。',
      over: '膝盖不用往胸口收，大腿竖直就够了。',
      fast: '慢一点，用四拍把腿抬起来。',
      noHold: '抬到位先停住，等我喊放下再放。',
    },
    names: { miss: '没跟上', low: '腿没抬到位', over: '膝盖收得太多', fast: '抬得太快', noHold: '顶端没停住' },
    advice: {
      low: '抬腿时想着膝盖去找天花板，抬到大腿和地面垂直、小腿和地面平行。',
      over: '大腿竖直就停，再往胸口收，腰就离开垫子了，肚子反而不用力。',
      miss: '听到“抬腿”就开始动，跟不上也没关系，先把节奏对上。',
      fast: '用四拍慢慢抬，不要靠甩。慢，下腹才用得上力。',
      noHold: '到顶端先停住，等听到“放下”再往下放。',
    },
    perfect: '抬腿和放下的全程，试着让腰一直贴着垫子不拱起来。',
    extra: (c) => (c.peakAngle < 72 ? 'over' : null),
    pose: kneefoldPose, sag: false, fit: 1, hot: { waist: 1, thigh: 0.5 }, glow2d: 'front', tuck: 1,
    // ↑ 深层腹肌稳住骨盆，髋屈肌（大腿根前侧）把腿抬起来；臀部不是重点
    arrow: { at: 'Kn', dir: 'up' }, cam: { x: 0.45, dist: 2.6 },
    idealTop: idealKneefold,
  },
  {
    id: 'heelslide', name: '脚跟滑动', muscles: ['核心', '骨盆稳定'],
    pos: '平躺在垫子上，双腿屈膝，双脚踩地', cue: '脚跟贴着垫子把腿滑直，骨盆不要晃',
    steps: [['躺好', '屈膝，双脚踩地，手放两边', ''], ['伸腿', '勾脚，脚跟贴着垫子把腿滑直', 'out'], ['停住', '腿伸直，腰不要拱起来', 'in'], ['收回', '脚跟贴着垫子滑回来', 'out']],
    seg: { up: '呼气，伸腿', hold: '停住，吸气', down: '呼气，收回', rest: '吸气，准备' },
    say: { up: '呼气，伸腿。', hold: '停住，吸气。', almost: '停住，腿再伸直一点。', down: '呼气，慢慢收回。' },
    meter: '伸直程度', angleName: '平均膝盖角度', ideal: 175,
    value: (b) => b.kneeAngle, dir: 1, rest: [40, 115], start: 20, top: 150, full: 172,   // 看髋-膝-踝的夹角，伸直接近 180 度
    line: ['Hip', 'Kn', 'An'],
    cues: {
      miss: '跟着口令，把腿伸出去。',
      low: '腿再伸直一点，脚跟一直贴着垫子。',
      fast: '慢一点，用四拍把腿滑出去。',
      noHold: '伸直后先停住，等我喊收回再收。',
    },
    names: { miss: '没跟上', low: '腿没伸直', fast: '伸得太快', noHold: '伸直后没停住' },
    advice: {
      low: '脚跟贴着垫子一直往远处滑，滑到膝盖伸直为止。',
      miss: '听到“伸腿”就开始动，跟不上也没关系，先把节奏对上。',
      fast: '用四拍慢慢滑出去，不要一下蹬直。慢，核心才需要一直稳住。',
      noHold: '伸直后先停住，等听到“收回”再往回滑。',
    },
    perfect: '伸腿和收回的时候，试着让骨盆一点都不晃。',
    pose: heelslidePose, sag: false, fit: 0.8, hot: { waist: 1 }, glow2d: 'core', tuck: 1,
    // ↑ 练的是腿在动的时候核心稳住骨盆；腿本身只是在滑
    arrow: { at: 'An', dir: 'out', press: true }, cam: { x: 0.62, dist: 3.0, mat: [1.24, 0.63] },   // 腿伸直后比较长：垫子加长，镜头退远
    idealTop: idealHeelslide,
  },
];
let EX = EXERCISES[0];   // 当前选中的动作

class Coach {
  constructor(ex, restAngle, onFinish) {
    this.ex = ex;
    const d = this.d = ex.dir;
    // 内部都换算成“越大越到位”的数，这样三个动作用同一套判断
    this.rest = ex.free ? 0 : d * clamp(restAngle ?? (ex.rest[0] + ex.rest[1]) / 2, ex.rest[0], ex.rest[1]);
    this.startThr = this.rest + ex.start;
    this.top = d * ex.top; this.full = d * ex.full;
    this.onFinish = onFinish;
    // 摄像头不判定的动作：只按节拍喊口令，进度条跟着节拍走
    this.free = !!ex.free;
    if (this.free) { this.rest = 0; this.startThr = 0.2; this.top = 1; this.full = 1; }
    this.a = this.rest;       // 平滑后的角度
    this.seg = 'rest';        // 当前口令段：up / hold / down / rest
    this.segStart = 0;
    this.segLen = 0;
    this.rep = 0;             // 正在做第几次
    this.cur = null;
    this.reps = [];           // 每次 {ok, counted, issue, peak, dur}
    this.count = 0;           // 做到位的次数
    this.t0 = null;
    this.lastCueRep = {};     // 每种提示上次是在第几次说的
    this.cueUntil = 0;
    this.atTop = false;
    this.done = false;
  }
  get progress() { return clamp((this.a - this.rest) / (this.full - this.rest), 0, 1); }
  /** 当前这段口令走了多少，0 到 1 */
  segK(t) { return this.segLen ? clamp((t - this.segStart) / (this.segLen * 1000), 0, 1) : 0; }

  /** b 可以是 null（暂时看不到人）：节拍照走，只是这段时间不判定 */
  update(b, t) {
    if (this.done) return;
    if (this.t0 == null) { this.t0 = t; this.enter('up', t); }
    if (this.free) {
      this.a = stdLift(this.seg, (t - this.segStart) / 1000);
      this.atTop = this.seg === 'hold';
      if (t - this.segStart >= this.segLen * 1000) this.enter({ up: 'hold', hold: 'down', down: 'rest', rest: 'up' }[this.seg], t);
      return;
    }
    const val = b ? this.ex.value(b) : null;
    if (val == null) b = null;
    else this.a += (this.d * val - this.a) * 0.45;
    const a = this.a, c = this.cur;
    this.atTop = !!b && this.seg !== 'rest' && a >= this.top;
    if (b && c && this.seg !== 'rest') {
      if (a > c.peak) { c.peak = a; c.knee = b.kneeAngle; }
      if (this.atTop) {
        if (c.topAt == null) c.topAt = t;
        if (c.lastT != null) c.topMs += Math.min(t - c.lastT, 600);   // 手机识别慢、帧数低的时候，也不会少算停留时间
        if (!c.counted && c.topMs > 250) { c.counted = true; this.count++; }
      }
      this.ex.watch?.(b, c);
    }
    if (c) c.lastT = b ? t : null;
    if (t - this.segStart >= this.segLen * 1000) {
      this.enter({ up: 'hold', hold: 'down', down: 'rest', rest: 'up' }[this.seg], t);
    }
  }

  enter(seg, t) {
    this.seg = seg; this.segStart = t; this.segLen = TEMPO[seg];
    const say = this.ex.say;
    if (seg === 'up') {
      this.rep++;
      this.cur = { t0: t, peak: this.a, topAt: null, topMs: 0, lastT: null, counted: false, flag: 0, knee: null };
      $('repNow').textContent = this.rep;
      replay($('repNow'), 'pop');
      Voice.say(say.up, 2);
    } else if (seg === 'hold') {
      // 已经在动但还差一点：趁停住的时候当场提醒
      const almost = this.a > this.startThr && this.a < this.top;
      Voice.say(almost ? say.almost : say.hold, 2);
    } else if (seg === 'down') {
      Voice.say(say.down, 2);
    } else {
      this.judge(t);
    }
  }

  /** 一次做完（回到起始姿势）：判定这一次，并在底部休息时说点评 */
  judge(t) {
    const c = this.cur, ex = this.ex;
    c.peakAngle = this.d * c.peak;
    let issue = null;
    if (this.free) { c.counted = true; this.count++; }
    else if (c.peak <= this.startThr) issue = 'miss';
    else if (!c.counted) issue = 'low';
    else if ((issue = ex.extra?.(c) ?? null)) { /* 这个动作特有的问题 */ }
    else if (c.topAt - c.t0 < 1500) issue = 'fast';
    else if (c.topMs < 1500) issue = 'noHold';
    const ok = c.counted && (issue == null || issue === 'noHold');
    this.reps.push({
      ok, counted: c.counted, issue, peak: c.peakAngle, dur: (t - c.t0) / 1000,
      // lvl：做到了到位线的几成（1 = 刚好到线）
      lvl: Math.round(clamp((c.peak - this.rest) / (this.top - this.rest), 0, 1.3) * 100) / 100,
      topMs: Math.round(c.topMs), reach: c.topAt == null ? null : Math.round(c.topAt - c.t0), knee: c.knee == null ? null : Math.round(c.knee),
    });
    const n = this.reps.length;
    this.atTop = false;

    if (n >= TARGET_REPS) { this.done = true; return this.onFinish(); }

    let say = `${n}。`;
    if (issue) {
      // 同一句提示至少隔一次再说；没跟上、没到位每次都说
      const last = this.lastCueRep[issue] ?? -9;
      if (issue === 'miss' || issue === 'low' || n - last >= 2) {
        this.lastCueRep[issue] = n;
        toast(ex.cues[issue], 'cue', 3200);
        this.cueUntil = performance.now() + 2500;
        say += ex.cues[issue];
        this.segLen = REST_WITH_CUE;
      }
    } else if (n % 3 === 0 && !this.free) {
      toast('很好，就是这样', 'good', 1800);
      say += '很好。';
    }
    const left = TARGET_REPS - n;
    // 分左右做的动作：做到一半换边，多留几秒换姿势
    if (ex.sides === 'half' && n === Math.ceil(TARGET_REPS / 2)) {
      toast('换另一边', 'info', 3200);
      say += '换另一边。';
      this.segLen = REST_WITH_CUE + 1.5;
    }
    // 快做完了：报还剩几个，鼓一下劲
    if (left === 3 && TARGET_REPS >= 5) say += '加油，还剩三个。';
    else if (left === 1) say += '最后一个，坚持住。';
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
      avgHold: counted.length ? counted.reduce((s, r) => s + r.topMs, 0) / counted.length / 1000 : 0,
      seconds: this.t0 == null ? 0 : (t - this.t0) / 1000,
      topIssue: top,
    };
  }
}

// ---------- 示范用的平面小人（也是演示模式里的“假人”） ----------
const DEMO_W = 360, DEMO_H = 640;
const POSE_S = { x: 96, y: 462 }, POSE_H0 = { x: 189, y: 462 }, THIGH = 92, SHIN = 93;
const rad = (deg) => (deg * Math.PI) / 180;
/** 已知髋和脚踝，求膝盖（取朝上的那个解） */
function kneeOf(H, A) {
  const d = Math.min(dist(H, A), THIGH + SHIN - 0.01), ux = (A.x - H.x) / d, uy = (A.y - H.y) / d;
  const a = (THIGH * THIGH - SHIN * SHIN + d * d) / (2 * d);
  const h = Math.sqrt(Math.max(0, THIGH * THIGH - a * a));
  return { x: H.x + ux * a + uy * h, y: H.y + uy * a - ux * h };
}
/** 把髋、膝、踝拼成 33 个点（像素坐标）。footRot = 脚掌往上翘多少度 */
function makePose(H, K, A, footRot = 0) {
  const pts = Array.from({ length: 33 }, () => ({ x: 0, y: 0, v: 0 }));
  const set = (i, x, y, v = 0.95) => (pts[i] = { x, y, v });
  const put = (name, x, y) => { set(P['l' + name], x, y, 0.95); set(P['r' + name], x + 3, y - 4, 0.6); };
  const c = Math.cos(rad(footRot)), sn = Math.sin(rad(footRot));
  const foot = (ox, oy) => [A.x + ox * c + oy * sn, A.y - ox * sn + oy * c];
  set(P.nose, 50, 444); set(P.lEar, 60, 454); set(P.rEar, 62, 451, 0.4);
  put('Sh', POSE_S.x, POSE_S.y); put('El', 140, 468); put('Wr', 186, 471);
  put('Hip', H.x, H.y); put('Kn', K.x, K.y); put('An', A.x, A.y);
  put('Heel', ...foot(-8, 6)); put('Toe', ...foot(26, 4));
  return pts;
}
/** 桥式。p = 抬起程度，0 躺平，1 标准顶端，>1 顶过头 */
function bridgePose(p) {
  const A = { x: 262, y: 468 }, th = rad(28 * p);
  const H = { x: POSE_S.x + 93 * Math.cos(th), y: POSE_S.y - 93 * Math.sin(th) };
  return makePose(H, kneeOf(H, A), A);
}
/** 屈膝抬腿。p = 0 双脚踩地，1 大腿竖直、小腿放平 */
function kneefoldPose(p) {
  const al = rad(50 + 40 * p), be = rad(-55.3 * (1 - p)), H = POSE_H0;
  const K = { x: H.x + THIGH * Math.cos(al), y: H.y - THIGH * Math.sin(al) };
  const A = { x: K.x + SHIN * Math.cos(be), y: K.y - SHIN * Math.sin(be) };
  return makePose(H, K, A, 55.3 * p);
}
/** 脚跟滑动。p = 0 屈膝，1 双腿滑直 */
function heelslidePose(p) {
  const A = { x: 301 + 71 * p, y: 468 }, H = POSE_H0;
  return makePose(H, kneeOf(H, A), A, 55 * clamp(p, 0, 1));
}
/** 有的动作伸展开比较长：平面小人整体缩小一点，才放得进画面 */
const fitX = (x) => 50 + (x - 50) * EX.fit, fitY = (y) => 480 + (y - 480) * EX.fit;
const demoPose = (p) => EX.pose(p);
const ease = (x) => x * x * (3 - 2 * x);
// 演示脚本：第 3 次没到位，第 6 次做得太快，其余标准。up/down = 假人用几秒抬起、放下
const DEMO_REPS = [
  { p: 1 }, { p: 1 }, { p: 0.5 }, { p: 1 }, { p: 1 },
  { p: 1, up: 1.0 }, { p: 1 }, { p: 1 }, { p: 1 }, { p: 1 },
];
class DemoSource {
  constructor() { this.coach = null; this.raf = 0; }
  start(onFrame, onDraw) {
    const loop = () => {
      const t = performance.now();
      const pose = EX.pose(this.liftAt(t)).map((q) => ({ x: fitX(q.x), y: fitY(q.y), v: q.v }));
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
    ctx.fillText('演示模式 · 这是模拟的人，没有使用摄像头', DEMO_W / 2, 300);
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
/** 自己下载文件，这样能显示已经下了多少。给几个地址就同时去连，谁先响应用谁，其余的取消 */
async function fetchBytes(urls, label) {
  // 下过一次就存在手机里（浏览器的缓存存储），以后打开直接读，不再走网络
  const key = urls[0] + '?v=' + ASSET_VERSION;
  let store = null;
  try {
    store = await caches.open('pilates-assets');
    const hit = await store.match(key);
    if (hit) { setLoadStatus(`${label}：已在本机`); return new Uint8Array(await hit.arrayBuffer()); }
  } catch { /* 这个浏览器不让存，那就每次下载 */ }
  const bytes = await downloadBytes(urls, label);
  try { await store?.put(key, new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } })); } catch { /* 存不下就算了 */ }
  return bytes;
}
const ASSET_VERSION = 'tasks-vision-0.10.21';
// 识别模型：full 比 lite 准（尤其是躺着、衣服宽松时的髋部），文件大 3.6 MB，稍慢。网址加 ?model=lite 可切回
const MODEL_NAME = new URLSearchParams(location.search).get('model') === 'lite' ? 'pose_landmarker_lite.task' : 'pose_landmarker_full.task';
const runInfo = { model: MODEL_NAME.replace(/pose_landmarker_|\.task/g, ''), delegate: '', detectMs: 0 };
async function downloadBytes(urls, label) {
  const tries = urls.map((url) => {
    const ctl = new AbortController();
    return { ctl, p: fetch(url, { signal: ctl.signal }).then((r) => { if (!r.ok) throw new Error(`${label}下载失败（${r.status}）`); return r; }) };
  });
  const r = await Promise.any(tries.map((t) => t.p));
  tries.forEach((t) => t.p.then((x) => { if (x !== r) t.ctl.abort(); }, () => {}));
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
    setLoadStatus('第 1 步 / 共 3 步：准备识别程序…');
    const { PoseLandmarker, FilesetResolver } = await import('./vendor/tasks-vision/vision_bundle.mjs');
    const fileset = await FilesetResolver.forVisionTasks('./vendor/tasks-vision/wasm');
    // 先把最大的两个文件下到浏览器缓存里（约 10 MB + 6 MB），后面启动时就不用再等网络
    // 预下载只是为了显示进度和提速，失败了不影响后面：识别库会自己再去取
    const base = new URL('./vendor/', location.href).href;
    let model = null;
    // 两个大文件同时从本站和 jsDelivr 镜像下载，哪边快用哪边（github.io 在国内常常很慢）
    const wasmName = String(fileset.wasmBinaryPath).split('/').pop();
    const wasmJob = fetchBytes([
      base + 'tasks-vision/wasm/' + wasmName,
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm/' + wasmName,
    ], '第 1 步 / 共 3 步：识别程序').catch((e) => { debugNote('预下载识别程序', e); return null; });
    const modelJob = fetchBytes([
      base + MODEL_NAME,
      'https://cdn.jsdelivr.net/gh/CAVOFEY/pilates-coach@main/vendor/' + MODEL_NAME,
    ], '第 2 步 / 共 3 步：识别模型').catch((e) => { debugNote('预下载识别模型', e); return null; });
    const wasm = await wasmJob;
    // 下好的识别程序直接交给识别库，不让它再下一遍
    if (wasm) fileset.wasmBinaryPath = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
    model = await modelJob;
    const make = (delegate) =>
      PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { ...(model ? { modelAssetBuffer: model } : { modelAssetPath: base + MODEL_NAME }), delegate },
        runningMode: 'VIDEO',
        numPoses: 2,   // 最多找两个“人”，再从里面认准一开始的那个（见 Who）
      });
    setLoadStatus('第 3 步 / 共 3 步：启动识别（显卡加速）…');
    try {
      const m = await withTimeout(make('GPU'), 15000, 'GPU 启动超时');
      runInfo.delegate = 'GPU';
      return m;
    } catch (e) {
      debugNote('显卡加速启动', e);
      setLoadStatus('第 3 步 / 共 3 步：启动识别（兼容模式）…');
      try {
        const m = await withTimeout(make('CPU'), 45000, '识别模型启动超时。请刷新页面再试一次。');
        runInfo.delegate = 'CPU';
        return m;
      } catch (e2) { debugNote('兼容模式启动', e2); throw e2; }
    }
  })().then((m) => { setLoadStatus('识别已就绪，正在等待摄像头…'); return m; })
    .catch((e) => { landmarkerPromise = null; throw e; }));
}

/** 打开摄像头，并尽量用最广的视角 */
async function openCamera(facing) {
  const size = { width: { ideal: 1280 }, height: { ideal: 720 } };
  const open = (video) => navigator.mediaDevices.getUserMedia({ audio: false, video });
  let stream = await open({ facingMode: facing, ...size });
  try {
    if (facing === 'environment') {
      // 后置有超广角镜头的手机：有些浏览器会把它单独列出来，列出来就换过去
      const devs = await navigator.mediaDevices.enumerateDevices();
      const wide = devs.find((d) => d.kind === 'videoinput' && /ultra|超广角/i.test(d.label) && !/front|前置/i.test(d.label));
      if (wide && wide.deviceId !== stream.getVideoTracks()[0].getSettings().deviceId) {
        stream.getTracks().forEach((tr) => tr.stop());
        try { stream = await open({ deviceId: { exact: wide.deviceId }, ...size }); }
        catch { stream = await open({ facingMode: facing, ...size }); }
      }
    }
    // 支持变焦的摄像头：拉到最远（最广）
    const track = stream.getVideoTracks()[0];
    const zoom = track.getCapabilities?.().zoom;
    if (zoom && zoom.min < (track.getSettings().zoom ?? Infinity)) await track.applyConstraints({ advanced: [{ zoom: zoom.min }] });
  } catch (e) { console.warn('广角设置没成功，用默认视角', e); }
  return stream;
}

// ---------- 认准一个人：开始跟练时记住这个人在画面里的位置和大小，之后只认它 ----------
// 晾着的衣服、路过的人离得远，不会被换过去；认准的人暂时看不到时，宁可这一帧当作没看到
const Who = {
  c: null, size: 0, locked: false, last: null, lostSince: null,
  reset() { this.c = null; this.locked = false; this.last = null; this.lostSince = null; },
  lock() { this.locked = true; if (this.last) { this.c = this.last.c; this.size = this.last.size; } },
  box(p, w, h) {
    const m = (a, b) => [(p[a].x + p[b].x) / 2 * w, (p[a].y + p[b].y) / 2 * h];
    const S = m(P.lSh, P.rSh), H = m(P.lHip, P.rHip), K = m(P.lKn, P.rKn);
    return { c: [(S[0] + H[0]) / 2, (S[1] + H[1]) / 2], size: Math.hypot(S[0] - H[0], S[1] - H[1]) + Math.hypot(H[0] - K[0], H[1] - K[1]) };
  },
  /** 返回这一帧该用第几个人；-1 = 都不是 */
  choose(list, w, h, t) {
    if (!list?.length) { this.last = null; return -1; }
    const boxes = list.map((p) => this.box(p, w, h));
    if (!this.c) {                                   // 还没认准：先用画面里最大的那个
      let i = 0;
      boxes.forEach((b, k) => { if (b.size > boxes[i].size) i = k; });
      this.last = boxes[i];
      if (this.locked) { this.c = boxes[i].c; this.size = boxes[i].size; }
      return i;
    }
    let i = -1, best = Infinity;
    boxes.forEach((b, k) => { const d = Math.hypot(b.c[0] - this.c[0], b.c[1] - this.c[1]); if (d < best) { best = d; i = k; } });
    // 人躺在垫子上不会走远：离原来的位置超过大半个身位、或者大小差一倍，就不是同一个人
    const lost = this.lostSince == null ? 0 : (t - this.lostSince) / 1000;
    const reach = this.size * (0.55 + 0.45 * Math.min(1, lost / 4));
    const ratio = boxes[i].size / this.size;
    if (best > reach || ratio < 0.5 || ratio > 2) { this.lostSince ??= t; return -1; }
    this.lostSince = null;
    this.c = [this.c[0] + (boxes[i].c[0] - this.c[0]) * 0.2, this.c[1] + (boxes[i].c[1] - this.c[1]) * 0.2];
    this.size += (boxes[i].size - this.size) * 0.1;
    return i;
  },
};

class CameraSource {
  constructor(facing = 'user') { this.facing = facing; this.raf = 0; this.stream = null; }
  async start(onFrame, onDraw, onResize) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('这个地址打不开摄像头。手机上请用 https:// 开头的地址访问。');
    }
    const [landmarker, stream] = await Promise.all([
      loadModel(),
      openCamera(this.facing).catch((e) => { debugNote('打开摄像头', e); throw e; }),
    ]);
    this.stream = stream;
    Who.reset();
    setLoadStatus('正在打开摄像头画面…');
    const video = $('video');
    video.srcObject = stream;
    try { await withTimeout(video.play(), 10000, '摄像头画面没有出来。请刷新页面再试一次。'); }
    catch (e) { debugNote('播放摄像头画面', e); throw e; }
    let w = video.videoWidth, h = video.videoHeight;
    let lastDetect = 0, lastVideoTime = -1, lms = null, world = null, shown = null, lastDraw = 0;
    const loop = () => {
      const t = performance.now();
      // 手机转了方向，画面的宽高会对调：跟着更新
      if (video.videoWidth && (video.videoWidth !== w || video.videoHeight !== h)) {
        w = video.videoWidth; h = video.videoHeight; lms = null; shown = null; Who.c = null;
        onResize?.(w, h);
      }
      // 每秒最多识别约 15 次，普拉提动作慢，够用也省电
      if (t - lastDetect >= 66 && video.currentTime !== lastVideoTime && video.readyState >= 2) {
        lastDetect = t; lastVideoTime = video.currentTime;
        try {
          const res = landmarker.detectForVideo(video, t);
          const cost = performance.now() - t;
          runInfo.detectMs = runInfo.detectMs ? runInfo.detectMs * 0.9 + cost * 0.1 : cost;
          const who = Who.choose(res.landmarks, w, h, t), raw = who >= 0 ? res.landmarks[who] : null;
          lms = raw ? raw.map((p) => ({ x: p.x * w, y: p.y * h, v: p.visibility ?? 0 })) : null;
          world = raw ? res.worldLandmarks?.[who] ?? null : null;
        } catch (e) { console.warn('detect failed', e); }
        onFrame(lms, t, world);
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
  // 教练盯着看的那条线（桥式是肩 → 髋 → 膝）
  if (state.core && EX.line) {
    const [sh, hip, kn] = EX.line.map((n) => lms[P[state.side + n]]);
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
function startFigure(cvId, hostId) {
  const host = $(hostId);
  const cv = $(cvId), ctx = cv.getContext('2d');
  const css = getComputedStyle(host);
  const rgb = (name) => css.getPropertyValue(name).trim();
  let BODY, HOT, MAT, W;
  const readColors = () => {
    BODY = `rgb(${rgb('--fig-body')})`; HOT = rgb('--fig-hot'); MAT = `rgba(${rgb('--fig-mat')},.3)`;
    W = parseFloat(rgb('--fig-w')) || 7;
  };
  const sx = (x) => (fitX(x) - 20) * 2.02, sy = (y) => (fitY(y) - 345) * 2.02;
  const path = (pts) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y)))); };
  const io = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2); // 慢起慢停
  // 一次呼吸：呼气抬起 2.4 秒 → 顶端停 2 秒 → 吸气放下 2.6 秒 → 休息 1.6 秒
  const UP = 2.4, HOLD = 2.0, DOWN = 2.6, REST = 1.6, CYCLE = UP + HOLD + DOWN + REST;
  let glow = 0, last = 0;
  const frame = (now) => {
    if (!host.hidden && !document.hidden && EX.pose) {
      const cyc = (now / 1000) % CYCLE;
      let p = cyc < UP ? io(cyc / UP) : cyc < UP + HOLD ? 1 : cyc < UP + HOLD + DOWN ? 1 - io((cyc - UP - HOLD) / DOWN) : 0;
      if (REDUCED) p = 1; // 减弱动效：停在顶端姿势
      // 发力的光比动作慢半拍亮起，停住时轻轻起伏
      const holdPulse = cyc >= UP && cyc < UP + HOLD ? 0.08 * Math.sin(((cyc - UP) / HOLD) * Math.PI * 2) : 0;
      const dt = Math.min(0.05, (now - last) / 1000 || 0); last = now;
      glow += (clamp(p + holdPulse, 0, 1) - glow) * (REDUCED ? 1 : 1 - Math.exp(-dt * 4));
      host.style.setProperty('--breath', glow.toFixed(3));

      const L = EX.pose(p), g = (k) => L[P[k]];
      const S = g('lSh'), H = g('lHip'), K = g('lKn');
      // 桥式的脊柱不是一块板：抬到一半时下背还贴近垫子，到顶才拉直
      const sag = EX.sag ? 15 * Math.sin(Math.PI * p) ** 0.9 : 6 * p;   // 另外两个动作：核心收紧，腰往垫子沉一点
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
      path([{ x: 34, y: 480 }, { x: 34 + 292 / EX.fit, y: 480 }]); ctx.stroke();
      // 发力部位的一道柔光，每个动作亮的地方不一样
      const half = { x: (H.x + K.x) / 2, y: (H.y + K.y) / 2 };
      ctx.save();
      ctx.shadowColor = `rgba(${HOT},${0.9 * glow})`; ctx.shadowBlur = 18 + 14 * glow;
      ctx.strokeStyle = `rgba(${HOT},${0.14 + 0.76 * glow})`; ctx.lineWidth = W * (2.2 + 0.6 * glow);
      if (EX.glow2d === 'back') { path([spineAt(0.62), spineAt(0.8), H, half]); ctx.stroke(); }   // 下背 → 臀 → 大腿后侧
      else {
        if (EX.glow2d === 'front') {                                                // 大腿根前侧（把腿抬起来的髋屈肌）
          path([H, { x: H.x + (K.x - H.x) * 0.32, y: H.y + (K.y - H.y) * 0.32 }]); ctx.stroke();
        }
        // 核心：肚子上的一块椭圆。放松时大而柔，收紧时变小、下沉、边缘变清楚
        const c = spineAt(0.44), tilt = Math.atan2(sy(H.y) - sy(S.y), sx(H.x) - sx(S.x));
        ctx.shadowColor = `rgba(${HOT},${0.55 + 0.4 * glow})`; ctx.shadowBlur = 26 - 18 * glow;
        ctx.fillStyle = `rgba(${HOT},${0.3 + 0.6 * glow})`;
        ctx.beginPath();
        ctx.ellipse(sx(c.x), sy(c.y) - W * (1.5 - 0.5 * glow), 82 * EX.fit * (1 - 0.34 * glow), 13 * EX.fit * (1 - 0.3 * glow), tilt, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      // 身体：一笔连贯的线
      ctx.strokeStyle = BODY; ctx.lineWidth = W;
      ctx.beginPath();
      ctx.moveTo(sx(S.x), sy(S.y));
      ctx.quadraticCurveTo(sx(C.x), sy(C.y), sx(H.x), sy(H.y));
      for (const q of [K, g('lAn'), g('lToe')]) ctx.lineTo(sx(q.x), sy(q.y));
      ctx.stroke();
      path([S, g('lEl'), g('lWr')]); ctx.stroke();
      ctx.fillStyle = BODY; ctx.beginPath(); ctx.arc(sx(60), sy(452), W * 1.55 * (0.5 + EX.fit / 2), 0, Math.PI * 2); ctx.fill();
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

// ---------- 3D：标准示范、真人动作、两者对比 ----------
const V = {
  add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
  sub: (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]],
  mid: (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2],
  len: (a) => Math.hypot(a[0], a[1], a[2]),
  lerp: (a, b, k) => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k],
};
const mapJ = (J, fn) => Object.fromEntries(Object.entries(J).map(([k, v]) => [k, fn(v, k)]));
const lerpJ = (A, B, k) => mapJ(A, (v, key) => V.lerp(v, B[key], k));
const SIDE_PARTS = ['Sh', 'El', 'Wr', 'Hip', 'Kn', 'An', 'Toe'];
/** 标准示范的 3D 关节：把平面示范（demoPose）立起来，左右两侧各偏开一点。p = 抬起程度 0~1 */
function stdJoints(p, ex = EX) {
  const L = ex.pose(p), k = 0.0054, g = (n) => L[P[n]];
  const at = (q, z) => [(q.x - 96) * k, (480 - q.y) * k, z];
  const S = g('lSh'), H = g('lHip');
  // 脊柱中段：抬到一半时下背还贴近垫子，到顶才拉直
  const sag = ex.sag ? 15 * Math.sin(Math.PI * clamp(p, 0, 1)) ** 0.9 : 3 * clamp(p, 0, 1);
  const M = { x: S.x + (H.x - S.x) * 0.53, y: S.y + (H.y - S.y) * 0.53 + sag * 0.5 };
  const wide = { Sh: 0.19, El: 0.25, Wr: 0.26, Hip: 0.11, Kn: 0.11, An: 0.11, Toe: 0.12 };
  const J = { head: at({ x: 58, y: 448 }, 0), spine: at(M, 0) };
  for (const n of SIDE_PARTS) { J['l' + n] = at(g('l' + n), -wide[n]); J['r' + n] = at(g('l' + n), wide[n]); }
  return J;
}
/** 摄像头识别出的 3D 关节（以髋为原点，单位米；模型的 y 朝下、z 朝里，这里翻成 y 朝上、z 朝外） */
function userJoints(wl) {
  const q = (i) => [wl[i].x, -wl[i].y, -wl[i].z];
  const J = {};
  for (const s of ['l', 'r']) for (const n of SIDE_PARTS) J[s + n] = q(P[s + n]);
  J.head = V.mid(q(P.lEar), q(P.rEar));
  J.spine = V.mid(V.mid(J.lSh, J.rSh), V.mid(J.lHip, J.rHip));
  return J;
}
/** “按你的身材算出的标准顶端姿势”：肩和脚不动，把髋抬到肩、髋、膝成一条直线。R = 你躺平时的关节 */
function idealBridge(R) {
  const S = V.mid(R.lSh, R.rSh), H = V.mid(R.lHip, R.rHip), K = V.mid(R.lKn, R.rKn), A = V.mid(R.lAn, R.rAn);
  const Lt = V.len(V.sub(H, S)), Lth = V.len(V.sub(K, H)), Ls = V.len(V.sub(A, K));
  const dx = A[0] - S[0], dz = A[2] - S[2], run = Math.hypot(dx, dz) || 1e-6, e = [dx / run, dz / run];
  const ay = A[1] - S[1], R1 = Lt + Lth, d = Math.hypot(run, ay);
  if (d > R1 + Ls - 1e-3 || d < Math.abs(R1 - Ls) + 1e-3) return null; // 量出来的身体比例凑不成一个桥，放弃对比
  const a = (R1 * R1 - Ls * Ls + d * d) / (2 * d), h = Math.sqrt(Math.max(0, R1 * R1 - a * a));
  const ux = run / d, uy = ay / d;
  const c1 = [a * ux - h * uy, a * uy + h * ux], c2 = [a * ux + h * uy, a * uy - h * ux];
  const k2 = c1[1] > c2[1] ? c1 : c2;                       // 膝盖取朝上的那个解
  const to3 = (q) => [S[0] + e[0] * q[0], S[1] + q[1], S[2] + e[1] * q[0]];
  const K3 = to3(k2), H3 = to3([(k2[0] * Lt) / R1, (k2[1] * Lt) / R1]);
  const dH = V.sub(H3, H), dK = V.sub(K3, K);
  return { ...R, lHip: V.add(R.lHip, dH), rHip: V.add(R.rHip, dH), lKn: V.add(R.lKn, dK), rKn: V.add(R.rKn, dK), spine: V.mid(S, H3) };
}
/** 身体的朝向（从肩指向脚，贴着地面）和各段长度，给下面两个动作算标准姿势用 */
function bodyFrame(R) {
  const S = V.mid(R.lSh, R.rSh), H = V.mid(R.lHip, R.rHip), K = V.mid(R.lKn, R.rKn), A = V.mid(R.lAn, R.rAn);
  const dx = A[0] - S[0], dz = A[2] - S[2], run = Math.hypot(dx, dz) || 1e-6;
  return { H, K, A, e: [dx / run, 0, dz / run], Lth: V.len(V.sub(K, H)), Ls: V.len(V.sub(A, K)) };
}
const moveLegs = (R, dK, dA) => ({
  ...R, lKn: V.add(R.lKn, dK), rKn: V.add(R.rKn, dK),
  lAn: V.add(R.lAn, dA), rAn: V.add(R.rAn, dA), lToe: V.add(R.lToe, dA), rToe: V.add(R.rToe, dA),
});
/** 屈膝抬腿的标准顶端：髋不动，大腿竖直，小腿放平 */
function idealKneefold(R) {
  const { H, K, A, e, Lth, Ls } = bodyFrame(R);
  const K3 = [H[0], H[1] + Lth, H[2]], A3 = [K3[0] + e[0] * Ls, K3[1], K3[2] + e[2] * Ls];
  return moveLegs(R, V.sub(K3, K), V.sub(A3, A));
}
/** 脚跟滑动的标准顶端：髋不动，双腿沿着垫子伸直 */
function idealHeelslide(R) {
  const { H, K, A, e, Lth, Ls } = bodyFrame(R);
  const L = Lth + Ls, drop = A[1] - H[1], run = Math.sqrt(Math.max(1e-6, L * L - drop * drop));
  const A3 = [H[0] + e[0] * run, A[1], H[2] + e[2] * run], K3 = V.lerp(H, A3, Lth / L);
  return moveLegs(R, V.sub(K3, K), V.sub(A3, A));
}
/** 标准动作在每段口令里做到几成 */
const stdLift = (seg, sec) => (seg === 'up' ? ease(clamp(sec / 3.2, 0, 1)) : seg === 'hold' ? 1 : seg === 'down' ? 1 - ease(clamp(sec / 3.4, 0, 1)) : 0);
/** 这个动作“标准”的角度范围 [小, 大] */
/** 示范小人做到 p（0~1）时的关节位置。rep = 第几次（左右交替的动作靠它换边） */
const exJoints = (ex, p, rep = 0) => (ex.free ? movePose(ex.move, p, rep) : stdJoints(p, ex));
/** 示范动画循环到哪了：抬起 2.4 秒，停 2 秒，放下 2.6 秒，休息 1.6 秒。eff = 用力的表情：开始发力 1 秒后出现，开始放下 1 秒后恢复 */
function demoCycle(now) {
  const io = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
  const c = (now / 1000) % 8.6;
  const p = REDUCED ? 1 : c < 2.4 ? io(c / 2.4) : c < 4.4 ? 1 : c < 7 ? 1 - io((c - 4.4) / 2.6) : 0;
  return { c, p, rep: Math.floor(now / 8600), eff: !REDUCED && c >= 1 && c < 5.4 };
}
const stdRange = (ex) => (ex.id === 'kneefold' ? [72, ex.top] : [ex.top, 180]);
let fig3dPromise = null;
const get3D = () => (fig3dPromise ??= (async () => { const m = await import('./fig3d.js?v=42'); await m.load3D(); return m; })()
  .catch((e) => { fig3dPromise = null; throw e; }));

/** 讲解页的 3D 示范 */
const Intro3D = {
  viewer: null, mode: '3d',
  async set(mode) {
    this.mode = mode;
    if (mode === '3d' && !this.viewer) {
      try {
        const m = await get3D();
        if (!this.viewer) {
          const v = this.viewer = new m.Viewer($('intro3d'));
          v.figure('std');
          v.onTick = (now) => {
            const { c, p, rep, eff } = demoCycle(now);
            if (this.exId !== EX.id) { this.exId = EX.id; v.frame(EX.cam); }   // 换了动作：镜头对准新动作的范围
            const J = exJoints(EX, p, rep);
            v.arrowAt(J, REDUCED || !EX.arrow ? null : c, EX.arrow || {});
            v.pose('std', J, p, eff, EX.hot, p * EX.tuck);   // 最后一个数：核心收紧多少，肚子跟着变扁
          };
          v.start();
        }
      } catch (e) { debugNote('3D 示范', e); this.mode = '2d'; }   // 3D 起不来就留着平面小人
    }
    const use3d = this.mode === '3d' && !!this.viewer;
    $('introArt').classList.toggle('is3d', use3d);
    $('intro3d').hidden = !use3d;
    $('hint3d').hidden = !use3d;
  },
};

/** 小结页的 3D 对比：粉色是你，半透明蓝绿色是按你的身材算出的标准 */
const Cmp = {
  viewer: null, data: null, cur: 1, t0: 0,
  async build(track, summaryReps) {
    $('cmpBox').hidden = true;
    this.data = null;
    if (!track || track.length < 20) return;
    // 躺平时的姿势：取“落地休息”那几段的平均
    track = track.filter((f) => summaryReps[f.rep - 1]);     // 没做完的那一次不放进来
    if (track.length < 20) return;
    const restF0 = track.filter((f) => f.seg === 'rest');
    const src0 = restF0.length >= 5 ? restF0 : track.slice(0, 5);
    // 摄像头不知道哪边是“上”：手机歪着、或者画面被转了 90 度时，人会变成站着的。
    // 躺着屈膝时，肩和髋一样高、膝盖比髋和脚都高。四个方向里挑最符合的那个，把整段动作转正
    const ROT = [(v) => v, (v) => [-v[1], v[0], v[2]], (v) => [-v[0], -v[1], v[2]], (v) => [v[1], -v[0], v[2]]];
    const avgY = (rot, names) => names.reduce((n, k) => n + src0.reduce((m, f) => m + rot(f.J[k])[1], 0) / src0.length, 0) / names.length;
    const upright = (rot) => avgY(rot, ['lKn', 'rKn']) - (avgY(rot, ['lHip', 'rHip']) + avgY(rot, ['lAn', 'rAn'])) / 2
      - Math.abs(avgY(rot, ['lSh', 'rSh']) - avgY(rot, ['lHip', 'rHip']));
    const rot = ROT.reduce((a, b) => (upright(b) > upright(a) + 0.02 ? b : a));
    if (rot !== ROT[0]) track = track.map((f) => ({ ...f, J: mapJ(f.J, rot) }));
    const restF = track.filter((f) => f.seg === 'rest');
    const src = restF.length >= 5 ? restF : track.slice(0, 5);
    const R0 = mapJ(src[0].J, (_, k) => [0, 1, 2].map((i) => src.reduce((sum, f) => sum + f.J[k][i], 0) / src.length));
    // 挪到垫子中间、落到地面上
    const c = V.mid(V.mid(R0.lSh, R0.rSh), V.mid(R0.lAn, R0.rAn));
    const shift = [0.42 - c[0], 0.07 - Math.min(R0.lAn[1], R0.rAn[1], R0.lSh[1], R0.rSh[1]), -c[2]];
    const rest = mapJ(R0, (v) => V.add(v, shift)), top = EX.idealTop(rest);
    if (!top) return;
    const reps = {};
    for (const f of track) (reps[f.rep] ??= []).push({ ...f, J: mapJ(f.J, (v) => V.add(v, shift)) });
    const hipY = (J) => (J.lHip[1] + J.rHip[1]) / 2;
    const list = Object.keys(reps).map(Number).sort((a, b) => a - b).filter((n) => reps[n].length >= 8);
    if (!list.length) return;
    this.data = { rest, top, reps, list, gap: {}, sum: summaryReps };
    for (const n of list) this.data.gap[n] = Math.round((hipY(top) - Math.max(...reps[n].map((f) => hipY(f.J)))) * 100);
    try {
      const m = await get3D();
      if (!this.viewer) {
        const v = this.viewer = new m.Viewer($('cmp3d'));
        v.auto = false; v.yaw = 0.4;
        v.figure('std', { colors: 0x3bb8a6, opacity: 0.34 });
        v.figure('you', { colors: { skin: 0xffe3d6, top: 0xf4a9c4, pants: 0x7d6873, hair: 0x513c4b }, hot: 0xe8789f });
        v.onTick = (now) => this.tick(now);
        v.start();
      }
      this.viewer.frame(EX.cam);
    } catch (e) { debugNote('3D 对比', e); return; }
    const box = $('cmpReps');
    box.innerHTML = '';
    for (const n of list) {
      const el = document.createElement('button');
      el.className = 'rep' + (summaryReps[n - 1] && !summaryReps[n - 1].ok ? ' bad' : '');
      el.textContent = n;
      el.setAttribute('aria-label', `看第 ${n} 次`);
      el.onclick = () => this.pick(n);
      box.appendChild(el);
    }
    $('cmpBox').hidden = false;
    // 默认先看第一次不标准的；都标准就看第一次
    this.pick(list.find((n) => summaryReps[n - 1] && !summaryReps[n - 1].ok) ?? list[0]);
  },
  pick(n) {
    this.cur = n; this.t0 = performance.now();
    [...$('cmpReps').children].forEach((el) => el.classList.toggle('sel', Number(el.textContent) === n));
    const g = this.data.gap[n], r = this.data.sum[n - 1];
    let verdict;
    if (EX.id === 'bridge') verdict = g > 2 ? `髋比标准低约 ${g} 厘米。` : g < -2 ? `髋比标准高约 ${-g} 厘米，注意别用腰往上顶。` : '髋的高度和标准几乎重合。';
    else verdict = r ? `${r.issue ? EX.names[r.issue] : '和标准基本一致'}，量到 ${Math.round(r.peak)}°（标准约 ${EX.ideal}°）。` : '';
    $('cmpNote').textContent = `第 ${n} 次：${verdict}用手指拖动可以绕着看。3D 位置是摄像头估算的，前后方向的误差比较大，仅供参考。`;
  },
  tick(now) {
    const d = this.data;
    if (!d) return;
    const fr = d.reps[this.cur], first = fr[0].t, span = fr[fr.length - 1].t - first;
    const at = first + ((now - this.t0) % (span + 900));       // 放完停一下再循环
    let i = 0;
    while (i < fr.length - 2 && fr[i + 1].t < at) i++;
    const a = fr[i], b = fr[i + 1], k = clamp((at - a.t) / (b.t - a.t || 1), 0, 1);
    this.viewer.arrowAt(a.J, a.seg === 'up' ? a.sec : null, EX.arrow);
    this.viewer.pose('you', lerpJ(a.J, b.J, k), 0, a.seg === 'hold' || (a.seg === 'up' && a.sec >= 1) || (a.seg === 'down' && a.sec < 1));
    this.viewer.pose('std', lerpJ(d.rest, d.top, stdLift(a.seg, a.sec + ((b.t - a.t) * k) / 1000)));
  },
};

// ---------- 页面流程 ----------
// 讲解页的语音：一行一句，念到哪一行，屏幕上哪一行亮起来。[亮第几行（-1 = 都不亮）, 念什么]
const BREATH = { out: '呼气', in: '吸气' };
const introLines = () => [
  [-1, Run.plan ? `第${cn(Run.view + 1)}个，${EX.name}，${TARGET_REPS} 次。` : `${EX.name}。先看一遍。`],
  ...EX.steps.map(([word, detail, br], i) => [i, `${word}${br ? '，' + BREATH[br] : ''}。${detail}。`]),
  [-1, Run.plan && Run.view < Run.plan.items.length - 1 ? '往左滑，看下一个动作。' : '看明白了，就点开始。'],
];
const IntroTalk = {
  run: 0, timer: 0, keep: [],
  mark(n) { [...$('introSteps').children].forEach((li, i) => li.classList.toggle('on', i === n)); },
  play() {
    const id = ++this.run;
    clearTimeout(this.timer);
    this.mark(-1);
    if (!Voice.ok) return;
    speechSynthesis.cancel();
    const lines = introLines();
    let cur = -1;
    // 第 k 句开始念了。real = 语音自己报的（准）；否则是按估计时间走到的
    const begin = (k, real) => {
      if (id !== this.run || k < cur || (k === cur && !real)) return;
      cur = k;
      clearTimeout(this.timer);
      this.mark(k < lines.length ? lines[k][0] : -1);
      if (k < lines.length) this.timer = setTimeout(() => begin(k + 1, false), estSpeak(lines[k][1]));
    };
    // 句子对象要一直留着：有的手机会把排队中的句子回收掉，后面的“开始念了”就收不到
    this.keep = lines.map(([, text], k) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      if (Voice.voice) u.voice = Voice.voice;
      u.rate = 1.05;
      // 被打断的旧句子也会触发这些回调，begin 里用编号认出来、不理它
      u.onstart = () => begin(k, true);
      if (k === lines.length - 1) u.onend = () => begin(lines.length, true);
      speechSynthesis.speak(u);
      return u;
    });
    this.timer = setTimeout(() => begin(0, false), 700);
  },
  stop() { this.run++; clearTimeout(this.timer); this.keep = []; this.mark(-1); Voice.stop(); },
};
// ---------- 计划和训练记录：都只存在这台手机的浏览器里 ----------
const Store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 存不了就只在这一次打开期间有效 */ } },
};
const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const exById = (id) => EXERCISES.find((e) => e.id === id);
const REP_SEC = TEMPO.up + TEMPO.hold + TEMPO.down + TEMPO.rest;      // 做一次要多少秒
const WEEK = [[1, '一'], [2, '二'], [3, '三'], [4, '四'], [5, '五'], [6, '六'], [0, '日']];   // [Date.getDay() 的数, 显示的字]
const Log = {
  list: Store.get('pilates.log', []),
  add(r) { this.list.unshift(r); this.list.length = Math.min(this.list.length, 80); Store.set('pilates.log', this.list); },
  clear() { this.list = []; Store.set('pilates.log', this.list); },
};
// ---------- 动作库：三个有摄像头纠正的动作 + 八个跟着口令做的动作 ----------
const CAM_INFO = {
  bridge: { tags: ['臀腿', '核心'], intro: '仰卧屈膝，把髋抬起来，让肩、髋、膝成一条直线。', good: ['练臀部和大腿后侧', '学会一节一节卷动脊柱', '摄像头会数次数、纠正动作'] },
  kneefold: { tags: ['核心'], intro: '仰卧屈膝，双腿抬到大腿竖直、小腿放平，腰一直贴着垫子。', good: ['练下腹和核心的稳定', '学会抬腿时不拱腰', '摄像头会数次数、纠正动作'] },
  heelslide: { tags: ['核心', '臀腿'], intro: '仰卧屈膝，脚跟贴着垫子慢慢滑出去，把腿伸直再收回。', good: ['腿动的时候练骨盆不动', '对腰很友好的核心入门动作', '摄像头会数次数、纠正动作'] },
};
/** 跟着口令做的动作，也包成和 EXERCISES 里一样的样子，讲解页、跟练页就能走同一套流程。free = 摄像头不判定这个动作 */
const freeEx = (m) => {
  const [first, up, hold, down] = m.steps;
  return {
    id: m.id, name: m.name, free: true, move: m, muscles: m.tags, steps: m.steps, sides: m.sides,
    pos: first[1], cue: `${up[1]}。${hold[1]}`,
    seg: { up: `呼气，${up[0]}`, hold: '停住，吸气', down: `呼气，${down[0]}`, rest: '吸气，准备' },
    say: { up: `呼气，${up[0]}。`, hold: '停住，吸气。', almost: '停住，吸气。', down: `呼气，慢慢${down[0]}。` },
    meter: '动作节拍', hot: m.hot, tuck: m.hot.waist ? 0.6 : 0, cam: m.view,
  };
};
const LIB = [
  ...EXERCISES.map((ex) => ({ id: ex.id, name: ex.name, cam: true, ex, reps: 5, ...CAM_INFO[ex.id], how: ex.steps.map(([w, t]) => `${w}：${t}`), easy: '' })),
  ...MOVES.map((m) => ({ ...m, ex: freeEx(m) })),
];
const libById = (id) => LIB.find((m) => m.id === id);
const TAGS = ['核心', '侧腰', '臀腿', '肩臂', '背部', '拉伸'];
const PREP_SEC = 18;   // 每个动作开始前，念名字、起始姿势和要领，大约要这么久
/** 计划里的一项要多少秒。n = 做几次 */
const itemSec = (it) => it.n * REP_SEC + PREP_SEC;
const itemText = (it) => `${it.n} 次`;
const planOf = (list) => list.map(([id, n]) => ({ id, n }));
const DEFAULT_PLANS = [
  { id: 'd15', fixed: true, name: '15 分钟全身普拉提', items: planOf([['tablechild', 5], ['thread', 6], ['birddog', 6], ['bridge', 6], ['leanhold', 5], ['diagcrunch', 6], ['sideclam', 6], ['sideleg', 6], ['sitside', 4]]) },
  { id: 'dside', fixed: true, name: '6 分钟侧腰臀腿', items: planOf([['bridge', 6], ['sideclam', 6], ['sideleg', 6], ['sitside', 4]]) },
  { id: 'dcam', fixed: true, name: '仰卧基础三式', items: planOf(EXERCISES.map((e) => [e.id, 5])) },
];
const Plans = {
  mine: Store.get('pilates.plans', []),          // 自己建的计划：[{ id, name, items: [{ id 动作, n 次数或秒数 }] }]
  last: Store.get('pilates.lastPlan', null),     // 上一次练的是哪个计划
  save() { Store.set('pilates.plans', this.mine); },
  get(id) { return this.mine.find((p) => p.id === id) || DEFAULT_PLANS.find((p) => p.id === id); },
  items(p) { return p.items.filter((it) => libById(it.id)); },
  /** 这个计划主要练哪里：把每个动作的部位按时长加起来，取最多的四个 */
  tags(p) {
    const sum = {};
    for (const it of this.items(p)) libById(it.id).tags.forEach((t, i) => { sum[t] = (sum[t] || 0) + itemSec(it) / (i + 1); });
    return Object.keys(sum).sort((a, b) => sum[b] - sum[a]).slice(0, 4);
  },
  mins(p) { return Math.max(1, Math.round(this.items(p).reduce((n, it) => n + itemSec(it), 0) / 60)); },
  meta(p) { const n = this.items(p).length; return n ? `约 ${this.mins(p)} 分钟 · ${n} 个动作` : '还没有动作'; },
};
// 以前的版本里，没有摄像头纠正的动作是按秒数存的；现在都按次数
for (const p of Plans.mine) for (const it of p.items) if (it.n > 15) it.n = libById(it.id)?.reps ?? 5;
const tagHtml = (tags, lead) => (lead ? `<span>${lead}</span>` : '') + tags.map((t) => `<b>${t}</b>`).join('');
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 动作详情里的 3D 示范：每块画布一个小人 */
const MoveView = {
  views: {},
  async show(cvId, move) {
    const cv = $(cvId);
    try {
      const m = await get3D();
      let o = this.views[cvId];
      if (!o) {
        const v = new m.Viewer(cv);
        v.figure('std');
        o = this.views[cvId] = { v, ex: null };
        v.onTick = (now) => {
          const ex = o.ex;
          if (!ex) return;
          const { p, rep, eff } = demoCycle(now);
          v.pose('std', exJoints(ex, p, rep), p, eff, ex.hot, p * ex.tuck);
        };
        v.start();
      }
      o.ex = move.ex;
      o.v.frame(move.ex.cam);
      cv.parentElement.hidden = false;
    } catch (e) { debugNote('3D 示范', e); cv.parentElement.hidden = true; }
  },
};

/** 动作详情：动画、介绍、练哪里、怎么做 */
const MoveSheet = {
  move: null,
  open(id, canAdd) {
    const m = this.move = libById(id);
    if (!m) return;
    $('moveName').textContent = m.name;
    $('moveTags').innerHTML = tagHtml(m.tags, '练到');
    $('moveKind').textContent = m.cam ? '摄像头会数次数、纠正动作' : '跟着口令和小人做，摄像头不纠正这个动作';
    $('moveIntro').textContent = m.intro;
    $('moveGood').innerHTML = m.good.map((t) => `<li>${t}</li>`).join('');
    $('moveHow').innerHTML = m.how.map((t) => `<li>${t}</li>`).join('');
    $('moveEasy').textContent = m.easy || '';
    $('moveEasy').hidden = !m.easy;
    $('btnMoveAdd').hidden = !canAdd;
    $('moveSheet').hidden = false;
    $('moveSheet').querySelector('.sheet').scrollTop = 0;
    MoveView.show('move3d', m);
  },
  close() { $('moveSheet').hidden = true; },
};

const PlanUI = {
  cur: null, filter: '',
  /** 计划列表 */
  render() {
    const card = (p) => `<div class="plancard" data-open="${p.id}" role="button" tabindex="0">
      <span class="tx"><b>${esc(p.name || '未命名计划')}</b><small>${Plans.meta(p)}</small>
      <span class="ptags">${Plans.tags(p).map((t) => `<i>${t}</i>`).join('')}</span></span>
      <button class="pgo" data-go="${p.id}"${Plans.items(p).length ? '' : ' disabled'}>开始</button></div>`;
    $('planMine').innerHTML = Plans.mine.map(card).join('') || '<p class="empty">还没有自己的计划。<br>点下面的按钮建一个。</p>';
    $('planDefault').innerHTML = DEFAULT_PLANS.map(card).join('');
  },
  /** 打开一个计划；id 不给 = 新建 */
  open(id) {
    this.cur = id ? Plans.get(id) : { id: 'p' + Date.now().toString(36), name: '', items: [] };
    this.filter = '';
    this.renderEdit();
    App.show('planEdit');
    $('planEdit').scrollTop = 0;
  },
  renderEdit() {
    const p = this.cur, fixed = !!p.fixed;
    $('planName').value = p.name; $('planName').readOnly = fixed;
    $('btnPlanDel').textContent = fixed ? '复制一份来改' : '删除计划';
    const tags = Plans.tags(p);
    $('planTags').innerHTML = tags.length ? tagHtml(tags, '练到') : '<span>加入动作后，这里会自动标出练到的部位</span>';
    const items = p.items;
    $('planItemCount').textContent = items.length ? `${items.length} 个` : '';
    $('planItems').innerHTML = items.map((it, i) => {
      const m = libById(it.id);
      if (!m) return '';
      const [lo, hi, unit] = [3, 15, '次'];
      const amount = fixed ? `<span class="amt">${itemText(it)}</span>`
        : `<span class="stepper"><button data-i="${i}" data-step="-1" aria-label="${m.name}减少"${it.n <= lo ? ' disabled' : ''}>−</button><output>${it.n}<small>${unit}</small></output><button data-i="${i}" data-step="1" aria-label="${m.name}增加"${it.n >= hi ? ' disabled' : ''}>+</button></span>
        <button class="del" data-del="${i}" aria-label="去掉${m.name}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg></button>`;
      return `<div class="pitem"><button class="nm" data-info="${m.id}"><b><i class="no">${i + 1}</i>${m.name}</b><small>${m.tags.join(' · ')}${m.sides === 'half' ? ' · 左右各一半' : ''}</small></button>${amount}</div>`;
    }).join('') || '<p class="empty">还没有动作。从下面的动作库里加进来。</p>';
    $('planTotal').textContent = items.length ? `约 ${Plans.mins(p)} 分钟` : '–';
    $('libCard').hidden = fixed;
    $('libFilter').innerHTML = ['', ...TAGS].map((t) => `<button class="fchip${t === this.filter ? ' on' : ''}" data-filter="${t}">${t || '全部'}</button>`).join('');
    $('libList').innerHTML = LIB.filter((m) => !this.filter || m.tags.includes(this.filter)).map((m) =>
      `<div class="pitem"><button class="nm" data-info="${m.id}"><b>${m.name}${m.cam ? '<em>摄像头纠正</em>' : ''}</b><small>${m.tags.join(' · ')}</small></button><button class="addbtn" data-add="${m.id}" aria-label="把${m.name}加入计划">+</button></div>`).join('');
    $('btnPlanGo').disabled = !Plans.items(p).length;
  },
  /** 改动马上存起来（默认计划不能改） */
  commit() {
    const p = this.cur;
    if (p.fixed) return;
    if (!Plans.mine.includes(p)) Plans.mine.unshift(p);
    Plans.save();
  },
  add(id) {
    const p = this.cur, m = libById(id);
    if (!m || p.fixed || p.items.length >= 30) return;
    p.items.push({ id, n: m.reps });
    this.commit(); this.renderEdit();
  },
  back() {
    const p = this.cur;
    // 空的、没起名的新计划不留
    if (p && !p.fixed && !p.items.length && !p.name.trim()) { Plans.mine = Plans.mine.filter((x) => x !== p); Plans.save(); }
    this.cur = null;
    this.render();
    App.show('plan');
  },
  click(e) {
    const el = e.target.closest('button');
    if (!el) return;
    const p = this.cur, x = el.dataset;
    if (x.info) return MoveSheet.open(x.info, !p.fixed);
    if (x.filter != null) { this.filter = x.filter; return this.renderEdit(); }
    if (x.add) return this.add(x.add);
    if (x.step) { const it = p.items[x.i]; it.n = clamp(it.n + Number(x.step), 3, 15); }
    else if (x.del != null) p.items.splice(Number(x.del), 1);
    else return;
    this.commit(); this.renderEdit();
  },
};

/** 按计划练：先在讲解页左右滑着把每个动作看一遍，点开始后在跟练画面里一个接一个做 */
const Run = {
  plan: null, i: 0, view: 0,
  start(p) {
    if (!p || !Plans.items(p).length) return;
    this.plan = { name: p.name || '未命名计划', items: Plans.items(p) };
    this.i = 0;
    Plans.last = p.id; Store.set('pilates.lastPlan', p.id);
    this.look(0, 0);
  },
  /** 讲解页翻到计划里的第 k 个动作。dir = 1 往后翻，-1 往前翻 */
  look(k, dir) {
    const items = this.plan?.items;
    if (!items || k < 0 || k >= items.length) return;
    this.view = k;
    EX = libById(items[k].id).ex; TARGET_REPS = items[k].n;
    App.intro(dir);
  },
  stop() { this.plan = null; this.i = 0; this.view = 0; },
};

/** 按计划练时，跟练画面上的示范小人：换动作时铺满屏幕，开始做了就缩到角上，跟着口令的节拍动 */
const Card = {
  viewer: null,
  async show(big) {
    const el = $('moveCard');
    el.hidden = false;
    el.classList.toggle('mini', !big);
    $('stageTitle').style.visibility = big ? 'hidden' : '';   // 铺满时卡片上已经写了第几个、什么动作
    try {
      const m = await get3D();
      if (!this.viewer) {
        const v = this.viewer = new m.Viewer($('card3d'));
        v.figure('std');
        v.auto = false; v.yaw = 0.3;
        v.onTick = (now) => {
          const co = App.phase === 'work' ? App.coach : null;
          let p, rep, eff;
          if (co && !co.done && co.t0 != null) {
            const sec = (now - co.segStart) / 1000;
            p = stdLift(co.seg, sec); rep = Math.max(0, co.rep - 1);
            eff = co.seg === 'hold' || (co.seg === 'up' && sec >= 1) || (co.seg === 'down' && sec < 1);
          } else ({ p, rep, eff } = demoCycle(now));
          v.pose('std', exJoints(EX, p, rep), p, eff, EX.hot, p * EX.tuck);
        };
        v.start();
      }
      const c = EX.cam;
      this.viewer.frame({ ...c, y: (c.y ?? 0.22) + 0.1, dist: (c.dist ?? 2.55) * 0.9 });   // 镜头拉近一点，小人尽量大
    } catch (e) { debugNote('3D 示范', e); }
  },
  hide() { $('moveCard').hidden = true; $('stageTitle').style.visibility = ''; },
};
const MeUI = {
  render() {
    const list = Log.list, now = new Date();
    // 这一周（周一到周日）每天的日期
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
    const week = WEEK.map(([d, w], i) => ({ d, w, key: dayKey(new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + i)) }));
    const days = new Set(list.map((r) => dayKey(new Date(r.at))));
    const good = list.reduce((n, r) => n + (r.good || 0), 0), all = list.reduce((n, r) => n + (r.attempts || 0), 0);
    $('meCount').innerHTML = `${list.length}<small>组</small>`;
    $('meWeek').innerHTML = `${week.filter((x) => days.has(x.key)).length}<small>天</small>`;
    $('meRate').textContent = all ? Math.round((good / all) * 100) + '%' : '–';
    $('meWeekRow').innerHTML = week.map((x) =>
      `<span class="wd${days.has(x.key) ? ' did' : ''}${x.key === dayKey() ? ' today' : ''}"><i></i>${x.w}</span>`).join('');
    $('meLogCount').textContent = list.length ? `最近 ${Math.min(list.length, 30)} 组` : '';
    $('meLog').innerHTML = list.slice(0, 30).map((r) => {
      const ex = exById(r.ex), t = new Date(r.at), mv = libById(r.ex);
      const when = `${t.getMonth() + 1}月${t.getDate()}日 ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
      if (r.kind === 'f') return `<div class="logitem"><b>${mv?.name ?? r.ex}<small>${when}</small></b><span class="sc full">${r.n ?? r.secs}<small>${r.n != null ? '次' : '秒'} · 跟做</small></span>${r.plan ? `<p>${esc(r.plan)}${r.full ? '' : ' · 没做完'}</p>` : ''}</div>`;
      const note = r.top && ex?.names[r.top] ? `最常出现：${ex.names[r.top]}` : r.good >= r.attempts ? '全部标准' : '';
      return `<div class="logitem"><b>${ex?.name ?? r.ex}<small>${when}</small></b><span class="sc${r.good >= r.attempts ? ' full' : ''}">${r.good} / ${r.attempts}<small>次标准</small></span>
        <span class="dots">${(r.reps || []).map((ok) => `<i${ok ? '' : ' class="bad"'}></i>`).join('')}</span>${note || r.plan ? `<p>${[note, r.plan && esc(r.plan)].filter(Boolean).join(' · ')}</p>` : ''}</div>`;
    }).join('') || '<p class="empty">还没有记录。<br>练完一个动作，记录会出现在这里。</p>';
    $('btnClearLog').hidden = !list.length;
    $('btnClearLog').textContent = '清空记录';
  },
};

const App = {
  /** 底部三个按钮：计划 / 跟练 / 我的 */
  tab(name) {
    if (this.phase !== 'home' || $(name).hidden === false) return;
    if (name === 'plan') PlanUI.render();
    if (name === 'me') MeUI.render();
    if (name === 'home') this.renderToday();
    this.show(name);
  },
  /** 首页的那一条：上次练的计划，点一下直接开始 */
  renderToday() {
    const p = Plans.get(Plans.last) || Plans.mine[0], el = $('todayPlan');
    el.hidden = !p;
    if (!p) return;
    this.homePlan = p;
    $('todayHead').textContent = Plans.last === p.id ? '上次练的计划' : '我的计划';
    $('todayText').textContent = `${p.name || '未命名计划'} · ${Plans.mins(p)} 分钟`;
    $('todayGo').textContent = '开始';
  },
  mode: 'camera',
  facing: 'user',
  source: null,
  phase: 'home', // home | loading | setup | countdown | work | done
  guide: null,
  coach: null,
  size: { w: DEMO_W, h: DEMO_H },
  lostSince: null,
  wake: null,
  exIndex: 0,
  prepId: 0,

  /** 切换页面。from = 触发切换的按钮：进入跟练时，深色画面从这个按钮的位置展开 */
  show(id, from) {
    const all = ['home', 'intro', 'stageScreen', 'summary', 'plan', 'me', 'planEdit'].map($);
    // 底部三个按钮只在首页、计划、我的这三页出现；当前这一页的按钮变大变亮
    $('tabs').hidden = !['home', 'plan', 'me'].includes(id);
    $('tabs').classList.toggle('over', id !== 'home');
    document.querySelectorAll('#tabs .tab').forEach((el) => el.classList.toggle('on', el.dataset.tab === id));
    const next = $(id);
    const cur = all.find((el) => !el.hidden && el !== next);
    clearTimeout(this.showTimer);
    for (const el of all) {
      el.classList.remove('enter-reveal', 'enter-rise', 'enter-fade', 'enter-intro', 'leave-fade');
      el.style.zIndex = '';
      if (el !== next && el !== cur) el.hidden = true;
    }
    if (!cur || REDUCED && id !== 'summary') {
      if (cur) cur.hidden = true;
      next.hidden = false;
      return;
    }
    const toIntro = id === 'intro' && cur.id === 'home';
    const kind = toIntro ? 'enter-intro' : id === 'stageScreen' && from ? 'enter-reveal' : id === 'summary' ? 'enter-rise' : 'enter-fade';
    if (from) {
      // 从手指按下的位置展开；没有按压记录（比如键盘操作）就用按钮中心
      const r = from.getBoundingClientRect(), ph = $('phone').getBoundingClientRect();
      const hit = lastPress && performance.now() - lastPress.t < 900 ? lastPress : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      next.style.setProperty('--ox', hit.x - ph.left + 'px');
      next.style.setProperty('--oy', hit.y - ph.top + 'px');
    }
    next.hidden = false;
    next.style.zIndex = 2;
    if (toIntro) {
      // 讲解页的示范区从首页示范区的位置出发，滑到自己的位置
      const st = $('introArt').style;
      const a = cur.querySelector('.art').getBoundingClientRect();
      // 把讲解页的内容往下推，让示范区和首页示范区在同一个高度，两页的方框就在同一个位置
      // 多出来的空当放在标题上面，标题和标签紧挨着方框
      const h1 = next.querySelector('h1').style;
      h1.marginTop = '';
      h1.marginTop = Math.max(0, a.top - $('introArt').getBoundingClientRect().top) + 'px';
      const b = $('introArt').getBoundingClientRect();
      st.setProperty('--dx', a.left - b.left + 'px'); st.setProperty('--dy', a.top - b.top + 'px');
      st.setProperty('--sx', a.width / (b.width || 1)); st.setProperty('--sy', a.height / (b.height || 1));
      cur.classList.add('leave-fade');
    }
    next.classList.add(kind);
    this.showTimer = setTimeout(() => {
      cur.hidden = true;
      next.style.zIndex = '';
      next.classList.remove(kind);
      cur.classList.remove('leave-fade');
    }, kind === 'enter-intro' ? 800 : kind === 'enter-reveal' ? 620 : kind === 'enter-rise' ? 460 : 240);
  },

  /** 开始前的动作讲解：放示范动画，念一遍要领 */
  intro(dir = 0) {
    Voice.unlock();
    this.phase = 'intro';
    // 按计划练：可以左右翻着把每个动作都看一遍
    const pl = Run.plan;
    $('introPager').hidden = !pl;
    if (pl) {
      $('introPage').textContent = `${Run.view + 1} / ${pl.items.length} · ${TARGET_REPS} 次`;
      $('btnIntroPrev').disabled = Run.view === 0;
      $('btnIntroNext').disabled = Run.view === pl.items.length - 1;
      if (dir) for (const el of [$('introName'), $('introSteps')]) { el.classList.remove('swap-next', 'swap-prev'); replay(el, dir > 0 ? 'swap-next' : 'swap-prev'); }
    }
    // 讲解页的内容跟着选中的动作换
    $('introName').textContent = EX.name;
    $('introMuscles').innerHTML = '<span>练到</span>' + EX.muscles.map((m) => `<b>${m}</b>`).join('');
    $('introSteps').innerHTML = EX.steps.map(([word, detail, br]) =>
      `<li><b>${word}</b><span>${detail}</span>${br ? `<em class="${br}">${BREATH[br]}</em>` : ''}</li>`).join('');
    this.show('intro');
    Intro3D.set(Intro3D.mode);
    IntroTalk.play();
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
    this.guide = new SetupGuide((rest) => this.beginWorkout(rest), !!Run.plan);
    Card.hide();
    this.coach = null;
    try {
      const resize = (w, h) => {
        const turned = this.size.w !== w || this.size.h !== h;
        this.size = { w, h };
        const cv = $('overlay'); cv.width = w; cv.height = h;
        this.fitView();
        // 摆放阶段转了手机：录像按新的方向重新开始，免得横画面缩在竖视频中间
        if (turned && this.phase === 'setup' && !Run.plan) Rec.start(w, h);
      };
      const info = await this.source.start((lms, t, world) => this.onFrame(lms, t, world), (lms) => this.draw(lms), resize);
      $('view').classList.toggle('mirror', info.mirror);
      resize(info.w, info.h);
      if (!Run.plan) Rec.start(info.w, info.h);   // 按计划练一次十几分钟，录像太大，不录
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
    const hud = this.phase === 'setup' ? '摆放：' + $('setupStatus').textContent
      : `第 ${$('repNow').textContent} 次 / ${TARGET_REPS} · ${$('phaseText').textContent}`;
    Rec.frame(this.mode === 'camera' ? $('video') : null, cv, $('view').classList.contains('mirror'), hud);
  },

  /** 每次拿到新的识别结果，更新教练的判断 */
  onFrame(lms, t, world) {
    const b = readBody(lms);
    this.body = b;

    if (this.phase === 'setup') return this.guide.update(b, t);
    if (this.phase === 'prep') {
      // 念要领的这段时间里，顺便量一下躺好时的角度，给后面的判定当起点
      if (!EX.free && b?.all && b.torsoTilt < 35 && b.kneeAngle > 40 && b.kneeAngle < 140 && b.hipAngle <= 152) {
        const v = EX.value(b);
        if (v != null) { this.restS.push(v); if (this.restS.length > 20) this.restS.shift(); }
      }
      return;
    }
    if (this.phase !== 'work') return;

    if (EX.free) this.lostSince = null;      // 不判定的动作：看不到人也不用提醒
    else if (!b?.core) {
      // 跟练中看不到人：先暂停判定，超过 1.5 秒提醒
      if (this.lostSince == null) this.lostSince = t;
      if (t - this.lostSince > 1500) { this.lostSince = t + 6000; toast('看不到你了，回到画面里', 'info', 3000); Voice.say('看不到你了，回到画面里。', 0); }
    } else this.lostSince = null;
    const c = this.coach;
    c.update(b?.core ? b : null, t);
    // 记下这一刻的 3D 姿势，练完后用来和标准动作对比
    let J = Run.plan ? null : this.mode === 'demo' ? stdJoints(this.source.liftAt(t)) : world && b?.core ? userJoints(world) : null;
    if (J && c.rep && !c.done) {
      if (this.trackJ) J = lerpJ(this.trackJ, J, 0.5);   // 轻轻平滑一下，减少抖动
      this.trackJ = J;
      this.track.push({ rep: c.rep, seg: c.seg, sec: (t - c.segStart) / 1000, t, J });
    }
    $('phaseText').textContent = EX.seg[c.seg];
    document.querySelector('#meter i').style.transform = `scaleX(${c.progress.toFixed(3)})`;
    $('meter').classList.toggle('good', c.atTop);
  },

  beginWorkout(rest) {
    if (this.phase !== 'setup') return;
    if (Run.plan) {
      $('setupPanel').hidden = true; $('hud').hidden = false;
      replay($('hud'), 'enter-hud');
      Who.lock();
      return this.prepMove(true);
    }
    this.phase = 'countdown';
    $('setupPanel').hidden = true; $('hud').hidden = false;
    replay($('hud'), 'enter-hud');
    $('stageTitle').textContent = `${EX.name} · ${TARGET_REPS} 次`;
    $('meterLabel').textContent = EX.meter;
    $('phaseText').textContent = '准备';
    toast('准备好了', 'good', 2200);
    Voice.say('准备好了。不用看屏幕，跟着我的口令做。', 2);
    this.coach = new Coach(EX, rest, () => this.finish());
    Who.lock();
    this.track = []; this.trackJ = null;
    if (this.source instanceof DemoSource) this.source.coach = this.coach;
    setTimeout(() => {
      if (this.phase !== 'countdown') return;
      this.phase = 'work';
      this.source.go();
    }, 4600);
  },

  /** 按计划练：轮到第 Run.i 个动作。先把示范铺满屏幕，念“第几个、什么动作、起始姿势、要领”，念完再开始喊节拍 */
  prepMove(first) {
    const pl = Run.plan, it = pl.items[Run.i], N = pl.items.length;
    EX = libById(it.id).ex; TARGET_REPS = it.n;
    this.phase = 'prep';
    this.coach = null; this.restS = []; this.track = []; this.trackJ = null; this.lostSince = null;
    const id = ++this.prepId;
    $('stageTitle').textContent = `${Run.i + 1} / ${N} · ${EX.name}`;
    $('repNow').textContent = '0';
    $('repAll').textContent = ' / ' + TARGET_REPS;
    $('meterLabel').textContent = EX.meter;
    $('phaseText').textContent = '准备';
    document.querySelector('#meter i').style.transform = 'scaleX(0)';
    $('meter').classList.remove('good');
    $('cardNo').textContent = `第 ${Run.i + 1} 个 / 共 ${N} 个 · ${TARGET_REPS} 次`;
    $('cardName').textContent = EX.name;
    $('cardCue').textContent = EX.pos;
    Card.show(true);
    const no = N > 1 && Run.i === N - 1 ? '最后一个' : `第${cn(Run.i + 1)}个`;
    speakThen(`${first ? '准备好了。' : ''}${no}，${EX.name}。${EX.pos}。${EX.cue}。准备。`, () => {
      if (id !== this.prepId || this.phase !== 'prep') return;
      const n = this.restS.length;
      this.coach = new Coach(EX, n ? this.restS.reduce((a, c) => a + c, 0) / n : null, () => this.moveDone());
      Card.show(false);
      this.phase = 'work';
    }, 5000);
  },

  /** 把刚做的这个动作记到“我的”里。full = 是不是做完了 */
  logMove(full) {
    const c = this.coach;
    if (!c || !c.reps.length || this.mode !== 'camera') return null;
    const s = c.summary(performance.now()), plan = Run.plan ? { plan: Run.plan.name } : {};
    if (EX.free) Log.add({ at: Date.now(), ex: EX.id, kind: 'f', n: s.attempts, full, ...plan });
    else Log.add({
      at: Date.now(), ex: EX.id, good: s.good, attempts: s.attempts, target: TARGET_REPS, seconds: Math.round(s.seconds),
      avgPeak: Math.round(s.avgPeak || 0), top: s.topIssue?.[0] ?? null, reps: s.reps.map((r) => (r.ok ? 1 : 0)), ...plan,
    });
    return s;
  },

  /** 按计划练：一个动作做完了。说一句结束语，歇几秒，再轮到下一个 */
  moveDone() {
    const s = this.logMove(true), name = EX.name, last = Run.i >= Run.plan.items.length - 1;
    this.phase = 'between';
    const id = ++this.prepId;
    toast(`${name} 完成`, 'good', 2400);
    $('phaseText').textContent = '完成';
    const score = s && !EX.free ? `${s.attempts} 次里有 ${s.good} 次标准。` : '';
    speakThen(`OK，${name}完成。${score}${last ? '' : '休息一下。'}`, () => {
      if (id !== this.prepId || !Run.plan) return;
      if (last) return this.planEnd(true);
      Run.i++;
      this.prepMove(false);
    }, last ? 1500 : 4500);
  },

  /** 按计划练结束（done = 全部做完；否则是中途点了结束）：回到“我的”，看记录 */
  planEnd(done) {
    if (!done) this.logMove(false);
    this.home();
    if (done) Voice.say('计划完成，辛苦了。', 2);
    this.tab('me');
  },

  finish() {
    if (this.phase === 'done') return;
    if (Run.plan) return this.planEnd(false);
    const s = this.coach ? this.coach.summary(performance.now()) : null;
    this.lastRun = s && {
      at: new Date().toISOString(), mode: this.mode, facing: this.facing, video: this.size,
      screen: [innerWidth, innerHeight], rest: Math.round(this.coach.d * this.coach.rest), startThr: Math.round(this.coach.d * this.coach.startThr),
      exercise: EX.id, topAngle: EX.top, tempo: TEMPO, model: runInfo.model, delegate: runInfo.delegate, detectMs: Math.round(runInfo.detectMs), good: s.good, attempts: s.attempts, seconds: Math.round(s.seconds),
      reps: s.reps.map((r) => ({ ...r, peak: Math.round(r.peak), dur: Math.round(r.dur * 10) / 10 })),
      ua: navigator.userAgent,
    };
    $('btnCopy').textContent = '复制本次数据';
    this.logMove(true);
    this.phase = 'done';
    setTimeout(async () => {
      const video = await Rec.stop();
      this.source?.stop(); this.source = null;
      this.wake?.release?.(); this.wake = null;
      this.renderSummary(s);
      this.showRecording(video);
      this.show('summary');
      Cmp.build(this.track, s ? s.reps : []);
    }, s && s.attempts >= TARGET_REPS ? 1200 : 0);
  },

  /** 小结页里放上刚才的录像 */
  showRecording(blob) {
    if (this.recUrl) URL.revokeObjectURL(this.recUrl);
    this.recUrl = null; this.recBlob = blob && blob.size ? blob : null;
    $('recBox').hidden = !this.recBlob;
    $('btnSaveRec').textContent = '保存录像到手机';
    if (this.recBlob) { this.recUrl = URL.createObjectURL(this.recBlob); $('recVideo').src = this.recUrl + '#t=0.05'; }   // 停在开头的画面上，而不是一块黑
    else $('recVideo').removeAttribute('src');
  },

  /** 点柱状图里的一根柱子：说明那一次的情况 */
  pickRep(i) {
    const r = this.sumReps?.[i];
    if (!r) return;
    [...$('sumBars').children].forEach((el, k) => el.classList.toggle('sel', k === i));
    const what = r.issue ? EX.names[r.issue] : '标准';
    const detail = r.issue === 'miss' ? '没有量到明显的动作。'
      : r.counted ? `量到 ${Math.round(r.peak)}°，到位后停了 ${(r.topMs / 1000).toFixed(1)} 秒。`
        : `量到 ${Math.round(r.peak)}°，标准是 ${stdRange(EX).join('°–')}°。`;
    $('sumRepNote').innerHTML = `<b class="${r.ok ? 'ok' : 'bad'}">第 ${i + 1} 次 · ${what}</b>　${detail}`;
  },

  /** 首页换动作。dir = 1 往后一个，-1 往前一个（决定新内容从哪边进来） */
  pick(i, dir = 1) {
    const n = EXERCISES.length;
    this.exIndex = ((i % n) + n) % n;
    EX = EXERCISES[this.exIndex];
    $('exName').textContent = EX.name;
    for (const el of [$('demoFig'), $('exName')]) {
      el.classList.remove('swap-next', 'swap-prev');
      replay(el, dir > 0 ? 'swap-next' : 'swap-prev');
    }
  },

  renderSummary(s) {
    s ??= { reps: [], good: 0, counted: 0, attempts: 0, avgPeak: 0, seconds: 0, topIssue: null };
    countUp($('sumGood'), s.good);
    $('sumOf').textContent = `/ ${s.attempts} 次标准 · ${EX.name}`;
    $('sumTime').textContent = `${Math.floor(s.seconds / 60)}:${String(Math.round(s.seconds % 60)).padStart(2, '0')}`;
    $('sumAngle').textContent = s.avgPeak ? Math.round(s.avgPeak) + '°' : '–';
    const [lo, hi] = stdRange(EX);
    $('sumAngleName').innerHTML = `${EX.angleName}<small>标准 ${lo}°–${hi}°</small>`;
    $('sumHold').innerHTML = s.avgHold ? `${s.avgHold.toFixed(1)}<small>秒</small>` : '–';
    // 柱状图：柱子的高度 = 这一次量到的角度（从躺着的起始角度算起），绿色那一条是标准范围
    const bars = $('sumBars');
    bars.innerHTML = '';
    $('sumChart').hidden = !s.reps.length;
    this.sumReps = s.reps;
    const c = this.coach, d = EX.dir, restA = c ? c.rest : d * (EX.rest[0] + EX.rest[1]) / 2;
    const lvlOf = (deg) => (d * deg - restA) / (d * EX.top - restA);        // 0 = 没动，1 = 刚到标准范围
    const far = lvlOf(d > 0 ? hi : lo), lvls = s.reps.map((r) => Math.max(0, lvlOf(r.peak)));
    const M = Math.max(far, ...lvls, 1.2) * 1.12;
    const plot = $('sumChart').querySelector('.plot');
    plot.style.setProperty('--lo', (1 / M).toFixed(3));
    plot.style.setProperty('--hi', (far / M).toFixed(3));
    $('sumGoal').textContent = `${lo}–${hi}°`;
    s.reps.forEach((r, i) => {
      const el = document.createElement('button');
      el.className = 'bar' + (r.ok ? '' : ' bad');
      el.style.setProperty('--h', Math.max(0.04, lvls[i] / M).toFixed(3));
      el.style.setProperty('--i', i);
      el.innerHTML = `<u>${r.issue === 'miss' ? '–' : Math.round(r.peak) + '°'}</u><i></i><span>${i + 1}</span>`;
      el.setAttribute('aria-label', `第 ${i + 1} 次：${r.issue ? EX.names[r.issue] : '标准'}`);
      el.onclick = () => this.pickRep(i);
      bars.appendChild(el);
    });
    // 默认先看第一次不标准的；都标准就看第一次
    if (s.reps.length) this.pickRep(Math.max(0, s.reps.findIndex((r) => !r.ok)));
    let title, note;
    if (!s.attempts) {
      title = '这次还没开始。';
      note = '教练没有记录到完整的动作。确认全身都在画面里，再试一次。';
    } else if (!s.topIssue) {
      title = '全部标准，漂亮。';
      note = `<b>下次可以试试：</b>${EX.perfect}`;
    } else {
      const [k, n] = s.topIssue;
      title = s.good >= s.attempts * 0.7 ? '做得不错。' : '有进步空间。';
      const advice = EX.advice[k] || '';
      note = `<b>最常出现：${EX.names[k]}（${n} 次）。</b>${advice}`;
    }
    $('sumTitle').textContent = title;
    $('sumNote').innerHTML = note;
    Voice.say(s.attempts ? `OK，完成。${s.attempts} 次里有 ${s.good} 次标准。` : '这次先到这里。', 2);
  },

  home() {
    Voice.stop();
    Rec.stop(true);
    this.source?.stop(); this.source = null;
    this.wake?.release?.(); this.wake = null;
    this.phase = 'home';
    this.prepId++;                      // 还在等“念完再继续”的那一步作废
    Card.hide();
    Run.stop(); TARGET_REPS = 10;
    EX = EXERCISES[this.exIndex];       // 计划里可能换成了别的动作，首页还是显示原来选中的那个
    this.renderToday();
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

$('btnStart').onclick = () => { Run.stop(); TARGET_REPS = 10; EX = EXERCISES[App.exIndex]; App.intro(); };
$('todayPlan').onclick = () => Run.start(App.homePlan);
document.querySelectorAll('#tabs .tab').forEach((el) => { el.onclick = () => App.tab(el.dataset.tab); });
// 计划列表：点“开始”直接练，点卡片其余地方进去看和改
$('plan').addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]'), open = e.target.closest('[data-open]');
  if (go) Run.start(Plans.get(go.dataset.go));
  else if (e.target.closest('#btnPlanNew')) PlanUI.open(null);
  else if (open) PlanUI.open(open.dataset.open);
});
$('planEdit').addEventListener('click', (e) => PlanUI.click(e));
$('planName').oninput = () => { const p = PlanUI.cur; if (p && !p.fixed) { p.name = $('planName').value.slice(0, 16); PlanUI.commit(); } };
$('btnPlanBack').onclick = () => PlanUI.back();
$('btnPlanGo').onclick = () => Run.start(PlanUI.cur);
$('btnPlanDel').onclick = () => {
  const p = PlanUI.cur, el = $('btnPlanDel');
  if (p.fixed) {            // 默认计划不能改：复制一份到“我的计划”再改
    const copy = { id: 'p' + Date.now().toString(36), name: p.name.slice(0, 14), items: p.items.map((it) => ({ ...it })) };
    Plans.mine.unshift(copy); Plans.save();
    return PlanUI.open(copy.id);
  }
  if (el.textContent === '删除计划') { el.textContent = '再点一次，确认删除'; return; }
  Plans.mine = Plans.mine.filter((x) => x !== p); Plans.save();
  p.items = []; p.name = '';
  PlanUI.back();
};
$('btnMoveClose').onclick = () => MoveSheet.close();
$('moveSheet').addEventListener('click', (e) => { if (e.target === $('moveSheet')) MoveSheet.close(); });
$('btnMoveAdd').onclick = () => { PlanUI.add(MoveSheet.move.id); MoveSheet.close(); };
// 清空记录：点两次才真的清，免得误触
$('btnClearLog').onclick = () => {
  if ($('btnClearLog').textContent === '清空记录') { $('btnClearLog').textContent = '再点一次，确认清空'; return; }
  Log.clear(); MeUI.render();
};
App.renderToday();
$('btnPrev').onclick = () => App.pick(App.exIndex - 1, -1);
$('btnNext').onclick = () => App.pick(App.exIndex + 1, 1);
// 在示范区左右滑也能换动作
{
  let sx = 0, sy = 0, on = false;
  const art = $('homeArt');
  art.addEventListener('pointerdown', (e) => { on = !e.target.closest('.nav'); sx = e.clientX; sy = e.clientY; });
  art.addEventListener('pointerup', (e) => {
    if (!on) return;
    on = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 36 && Math.abs(dx) > Math.abs(dy) * 1.4) App.pick(App.exIndex + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
  });
  art.addEventListener('pointercancel', () => { on = false; });
}
$('btnIntroBack').onclick = () => { IntroTalk.stop(); App.home(); };
$('btnReplay').onclick = () => IntroTalk.play();
$('btnIntroGo').onclick = () => { IntroTalk.stop(); Run.i = 0; App.start('camera', $('btnIntroGo')); };
$('btnIntroPrev').onclick = () => Run.look(Run.view - 1, -1);
$('btnIntroNext').onclick = () => Run.look(Run.view + 1, 1);
// 按计划练时，在讲解页左右滑：往左滑看下一个动作，往右滑回上一个（和首页换动作的方向一样）
{
  let sx = 0, sy = 0, on = false;
  const el = $('intro');
  el.addEventListener('pointerdown', (e) => { on = !!Run.plan && !e.target.closest('button, #introArt');   // 示范区里的拖动是用来转着看小人的，不算翻页 sx = e.clientX; sy = e.clientY; });
  el.addEventListener('pointerup', (e) => {
    if (!on) return;
    on = false;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.4) Run.look(Run.view + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
  });
  el.addEventListener('pointercancel', () => { on = false; });
}
$('btnSaveRec').onclick = async () => {
  const blob = App.recBlob;
  if (!blob) return;
  const d = new Date(), z = (n) => String(n).padStart(2, '0');
  const name = `pilates-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}.${/mp4/.test(blob.type) ? 'mp4' : 'webm'}`;
  const file = new File([blob], name, { type: blob.type });
  // 手机上弹出系统的分享面板，里面有“存储视频”；电脑上直接下载
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = App.recUrl; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  $('btnSaveRec').textContent = '已保存到下载';
};
$('btnCopy').onclick = async () => {
  const text = JSON.stringify(App.lastRun || { note: '没有数据' });
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch { /* 下面用老办法再试 */ }
  if (!ok) {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { /* 都不行就算了 */ }
    ta.remove();
  }
  $('btnCopy').textContent = ok ? '已复制，可以粘贴发出去' : '复制失败';
};
$('btnDemo').onclick = () => App.start('demo', $('btnDemo'));
$('btnBack').onclick = () => App.home();
$('btnHome').onclick = () => App.home();
$('btnAgain').onclick = () => App.start(App.mode);
$('btnEnd').onclick = () => App.finish();
$('btnForce').onclick = () => App.beginWorkout(null);
$('btnFlip').onclick = () => { App.facing = App.facing === 'user' ? 'environment' : 'user'; App.start('camera'); };
addEventListener('resize', () => App.phase !== 'home' && App.fitView());
addEventListener('orientationchange', () => setTimeout(() => App.phase !== 'home' && App.fitView(), 300));

startFigure('demoFig', 'home');
startFigure('introFig', 'intro');
window.__app = App;
// 首页一打开就在后台把 3D 小人准备好（下载 3D 库、建好场景），这样点“开始跟练”时 3D 直接出现，不用先看一会儿平面小人
setTimeout(() => Intro3D.set('3d'), 250);
// 识别模型比较大，排在 3D 后面再开始下载
if (!new URLSearchParams(location.search).has('demo')) setTimeout(() => loadModel().catch(() => {}), 2000); // 方便调试
window.__test = { TEMPO, MOVES, movePose, LIB, Plans, PlanUI, Run, Card, MoveSheet, MoveView, Voice, stdJoints, Cmp, Coach, SetupGuide, DemoSource, demoPose, readBody, EXERCISES, pick: (i) => App.pick(i, 1) };
if (new URLSearchParams(location.search).has('demo')) App.start('demo');

// 把页面文件存在本机（见 sw.js）：第二次打开不用再下载
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').then(() => navigator.serviceWorker.ready).then((reg) => {
    const warm = () => reg.active?.postMessage({
      warm: [location.origin + location.pathname, ...performance.getEntriesByType('resource').map((r) => r.name)],
    });
    warm(); setTimeout(warm, 10000);
  }).catch(() => { /* 这个浏览器不支持，就和以前一样 */ });
}
