// 3D 小人：用圆柱和球搭出来的人形，可以用手指拖着绕一圈看。
// 小人不靠骨骼动画，而是直接吃“关节位置”——所以标准示范和摄像头识别出的真人动作都能驱动它。
// 关节格式：{ head, spine, lSh, rSh, lEl, rEl, lWr, rWr, lHip, rHip, lKn, rKn, lAn, rAn, lToe, rToe }，每个是 [x, y, z]（米，y 朝上）

let THREE = null;
export async function load3D() {
  THREE ??= await import('./vendor/three.module.min.js');
  return THREE;
}

// [起点, 终点, 粗细（半径，米）, 是不是发力部位]
const BONES = [
  ['midSh', 'spine', 0.118, false], ['spine', 'midHip', 0.112, true],
  ['lSh', 'rSh', 0.062, false], ['lHip', 'rHip', 0.092, true],
  ['midSh', 'head', 0.046, false],
  ['lSh', 'lEl', 0.044, false], ['lEl', 'lWr', 0.036, false],
  ['rSh', 'rEl', 0.044, false], ['rEl', 'rWr', 0.036, false],
  ['lHip', 'lKn', 0.074, true], ['lKn', 'lAn', 0.05, false], ['lAn', 'lToe', 0.038, false],
  ['rHip', 'rKn', 0.074, true], ['rKn', 'rAn', 0.05, false], ['rAn', 'rToe', 0.038, false],
];
const HEAD_R = 0.1;

export class Viewer {
  constructor(canvas) {
    const T = THREE;
    this.canvas = canvas;
    this.r = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.scene = new T.Scene();
    this.cam = new T.PerspectiveCamera(30, 2, 0.1, 30);
    this.scene.add(new T.HemisphereLight(0xffffff, 0xcdb5c4, 1.25));
    const sun = new T.DirectionalLight(0xffffff, 1.5);
    sun.position.set(1.2, 3, 2.4);
    this.scene.add(sun);
    // 垫子
    const mat = new T.Mesh(
      new T.BoxGeometry(1.95, 0.024, 0.66),
      new T.MeshStandardMaterial({ color: 0x8fdccf, roughness: 0.95, transparent: true, opacity: 0.5 }),
    );
    mat.position.set(0.42, -0.012, 0);
    this.scene.add(mat);
    this.cyl = new T.CylinderGeometry(1, 1, 1, 16, 1, true);
    this.sph = new T.SphereGeometry(1, 18, 12);
    this.target = new T.Vector3(0.42, 0.2, 0);
    this.yaw = 0.55; this.pitch = 0.24; this.dist = 2.45;
    this.auto = true;          // 没人碰之前自己慢慢转
    this.figs = {};
    this.onTick = null;        // 每一帧渲染前调用，用来更新姿势
    this.raf = 0; this.last = 0; this.w = 0; this.h = 0;
    this._drag();
  }

  _drag() {
    const c = this.canvas;
    let px = 0, py = 0, on = false;
    c.addEventListener('pointerdown', (e) => {
      on = true; px = e.clientX; py = e.clientY; this.auto = false;
      c.setPointerCapture?.(e.pointerId);
    });
    c.addEventListener('pointermove', (e) => {
      if (!on) return;
      this.yaw -= (e.clientX - px) * 0.009;
      this.pitch = Math.min(1.45, Math.max(-0.08, this.pitch + (e.clientY - py) * 0.007));
      px = e.clientX; py = e.clientY;
    });
    const end = () => { on = false; };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.dist = Math.min(6, Math.max(1.8, this.dist * (e.deltaY > 0 ? 1.08 : 0.92)));
    }, { passive: false });
  }

  /** 新建一个小人。hot = 发力部位亮起来时的颜色；opacity < 1 就是半透明的“影子” */
  figure(key, { color, hot = color, opacity = 1 }) {
    const T = THREE;
    const mk = (hex) => new T.MeshStandardMaterial({
      color: hex, roughness: 0.62, metalness: 0, transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
    });
    const body = mk(color), glow = mk(color);
    const group = new T.Group();
    const parts = BONES.map(([a, b, r, isHot]) => {
      const m = isHot ? glow : body;
      const bone = new T.Mesh(this.cyl, m), ja = new T.Mesh(this.sph, m), jb = new T.Mesh(this.sph, m);
      group.add(bone, ja, jb);
      return { a, b, r, bone, ja, jb };
    });
    const head = new T.Mesh(this.sph, body);
    head.scale.setScalar(HEAD_R);
    group.add(head);
    this.scene.add(group);
    this.figs[key] = { group, parts, head, glow, base: new T.Color(color), hot: new T.Color(hot) };
    return this.figs[key];
  }

  show(key, visible) { if (this.figs[key]) this.figs[key].group.visible = visible; }

  /** 把小人摆成给定的关节位置。glow 0~1 = 发力部位亮多少 */
  pose(key, J, glow = 0) {
    const f = this.figs[key];
    if (!f || !J) return;
    const T = THREE;
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    const all = { ...J, midSh: mid(J.lSh, J.rSh), midHip: mid(J.lHip, J.rHip) };
    const A = this._a ??= new T.Vector3(), B = this._b ??= new T.Vector3(), D = this._d ??= new T.Vector3();
    const UP = this._up ??= new T.Vector3(0, 1, 0);
    for (const p of f.parts) {
      A.fromArray(all[p.a]); B.fromArray(all[p.b]);
      D.subVectors(B, A);
      const len = D.length() || 1e-4;
      p.bone.position.addVectors(A, B).multiplyScalar(0.5);
      p.bone.scale.set(p.r, len, p.r);
      p.bone.quaternion.setFromUnitVectors(UP, D.divideScalar(len));
      p.ja.position.copy(A); p.ja.scale.setScalar(p.r);
      p.jb.position.copy(B); p.jb.scale.setScalar(p.r);
    }
    f.head.position.fromArray(J.head);
    f.glow.color.copy(f.base).lerp(f.hot, glow);
    f.glow.emissive.copy(f.hot).multiplyScalar(glow * 0.35);
  }

  start() {
    if (this.raf) return;
    const loop = (now) => {
      this.raf = requestAnimationFrame(loop);
      const c = this.canvas;
      if (c.offsetParent === null || document.hidden) { this.last = now; return; } // 看不见的时候不画
      const w = c.clientWidth, h = c.clientHeight;
      if (!w || !h) return;
      if (w !== this.w || h !== this.h) {
        this.w = w; this.h = h;
        this.r.setSize(w, h, false);
        this.cam.aspect = w / h;
        // 画面越窄，镜头退得越远，保证整个人都在画面里
        this.cam.fov = 30;
        this.fit = Math.max(1, 1.7 / (w / h));
        this.cam.updateProjectionMatrix();
      }
      const dt = Math.min(0.05, (now - this.last) / 1000 || 0);
      this.last = now;
      if (this.auto) this.yaw += dt * 0.28;
      this.onTick?.(now);
      const d = this.dist * this.fit, cp = Math.cos(this.pitch);
      this.cam.position.set(
        this.target.x + d * Math.sin(this.yaw) * cp,
        this.target.y + d * Math.sin(this.pitch),
        this.target.z + d * Math.cos(this.yaw) * cp,
      );
      this.cam.lookAt(this.target);
      this.r.render(this.scene, this.cam);
    };
    this.raf = requestAnimationFrame(loop);
  }
}
