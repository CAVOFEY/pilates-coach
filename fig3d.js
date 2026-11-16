// 3D 小人：卡通比例（大头、圆手圆脚、约五头身），三渲二画风（色块分层 + 描边）。
// 小人不靠骨骼动画，而是直接吃“关节位置”——所以标准示范和摄像头识别出的真人动作都能驱动它。
// 关节格式：{ head, spine, lSh, rSh, lEl, rEl, lWr, rWr, lHip, rHip, lKn, rKn, lAn, rAn, lToe, rToe }，每个是 [x, y, z]（米，y 朝上）

let THREE = null;
export async function load3D() {
  THREE ??= await import('./vendor/three.module.min.js');
  return THREE;
}

// [起点, 终点, 起点粗细, 终点粗细（半径，米）, 用哪种颜色, 属于哪个发力部位（waist 腰 / hip 臀 / thigh 大腿；false = 不会亮）]
// 两头粗细不同 = 一头粗一头细的锥形，关节处不会鼓出一个球
const BONES = [
  // 躯干分三段：胸廓（上衣，比腰宽一圈）→ 肚子（核心，高腰瑜伽裤的裤腰）→ 骨盆（算臀部）
  ['midSh', 'rib', 0.13, 0.12, 'top', false], ['rib', 'belt', 0.104, 0.108, 'pants', 'waist'], ['belt', 'midHip', 0.11, 0.112, 'pants', 'hip'],
  ['lSh', 'rSh', 0.078, 0.078, 'top', false], ['lHip', 'rHip', 0.104, 0.104, 'pants', 'hip'],
  ['lSh', 'lEl', 0.052, 0.046, 'skin', false], ['lEl', 'lWr', 0.046, 0.041, 'skin', false],
  ['rSh', 'rEl', 0.052, 0.046, 'skin', false], ['rEl', 'rWr', 0.046, 0.041, 'skin', false],
  ['lHip', 'lKn', 0.088, 0.064, 'pants', 'thigh'], ['lKn', 'lAn', 0.064, 0.047, 'pants', false], ['lAn', 'lToe', 0.05, 0.05, 'skin', false],
  ['rHip', 'rKn', 0.088, 0.064, 'pants', 'thigh'], ['rKn', 'rAn', 0.064, 0.047, 'pants', false], ['rAn', 'rToe', 0.05, 0.05, 'skin', false],
];
const CORE_SPAN = [0.13, 0.72], CORE_R = [0.136, 0.113];   // 核心色块：占躯干的哪一段（0 = 肩，1 = 髋），两头各多粗
const HOT_ALL = { waist: 1, hip: 1, thigh: 1 };
const HEAD_R = 0.168, HAND_R = 0.058, BUN_R = 0.07, EDGE = 0.011;
export const PALETTE = { skin: 0xffe3d6, top: 0xf9c9dc, pants: 0x7d6873, hair: 0x513c4b, hot: 0xe8789f, edge: 0x45353f };

export class Viewer {
  constructor(canvas) {
    const T = THREE;
    this.canvas = canvas;
    this.r = new T.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.r.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.scene = new T.Scene();
    this.cam = new T.PerspectiveCamera(30, 2, 0.1, 30);
    this.scene.add(new T.HemisphereLight(0xffffff, 0xe6d3dd, 1.0));
    const sun = new T.DirectionalLight(0xffffff, 1.9);
    sun.position.set(1.0, 3, 2.2);
    this.scene.add(sun);
    // 三渲二：光照只分三档，不做平滑过渡
    this.ramp = new T.DataTexture(new Uint8Array([150, 215, 255]), 3, 1, T.RedFormat);
    this.ramp.minFilter = this.ramp.magFilter = T.NearestFilter;
    this.ramp.needsUpdate = true;
    // 垫子
    const mat = new T.Mesh(new T.BoxGeometry(1.95, 0.03, 0.7), new T.MeshToonMaterial({ color: 0xc9ecf0, gradientMap: this.ramp }));
    mat.position.set(0.42, -0.015, 0);
    this.scene.add(mat);
    this.mat = mat;
    this.cyl = new T.CylinderGeometry(1, 1, 1, 20, 1, true);
    this.sph = new T.SphereGeometry(1, 24, 16);
    // 头发：一块盖住头顶、后脑勺和两侧的“帽子”形色块，前面留出脸
    this.hairCap = new T.SphereGeometry(1, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.57);
    this.cones = {};
    // 提示箭头：髋两侧各一个，亮蓝绿色，开始抬起时往上“biu”一下
    this.arrowMat = new T.MeshBasicMaterial({ color: 0x19d9c3, transparent: true, depthWrite: false });
    const shaft = new T.CylinderGeometry(0.024, 0.024, 0.11, 16).translate(0, 0.055, 0);
    const tip = new T.ConeGeometry(0.062, 0.1, 20).translate(0, 0.16, 0);
    this.arrows = [0, 1].map(() => {
      const g = new T.Group();
      g.add(new T.Mesh(shaft, this.arrowMat), new T.Mesh(tip, this.arrowMat));
      g.visible = false; g.renderOrder = 5;
      this.scene.add(g);
      return g;
    });
    // 第三个箭头：在胸口上方朝下，提示“身体和腰往下贴住垫子”
    this.arrowDn = new T.Group();
    this.arrowDn.add(new T.Mesh(shaft, this.arrowMat), new T.Mesh(tip, this.arrowMat));
    this.arrowDn.visible = false; this.arrowDn.renderOrder = 5;
    this.arrowDn.rotation.z = Math.PI;                 // 掉个头，尖朝下
    this.scene.add(this.arrowDn);
    this.target = new T.Vector3(0.4, 0.22, 0);
    this.yaw = 0.55; this.pitch = 0.24; this.dist = 2.55;
    this.auto = true;          // 没人碰之前自己慢慢转
    this.figs = {};
    this.onTick = null;        // 每一帧渲染前调用，用来更新姿势
    this.raf = 0; this.last = 0; this.w = 0; this.h = 0; this.fit = 1;
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
      this.dist = Math.min(6, Math.max(1.6, this.dist * (e.deltaY > 0 ? 1.08 : 0.92)));
    }, { passive: false });
  }

  /**
   * 新建一个小人。
   * colors：{ skin, top, pants, hair }，不给就用默认配色；给一个数字就是整个人一个颜色。
   * opacity < 1 = 半透明的“影子”（不描边、不画脸）。
   */
  /** 一头粗一头细的圆柱，按粗细比例各做一份、重复使用 */
  _cone(ratio) {
    const k = ratio.toFixed(3);
    return (this.cones[k] ??= new THREE.CylinderGeometry(ratio, 1, 1, 20, 1, true));
  }

  figure(key, { colors = PALETTE, hot = PALETTE.hot, opacity = 1 } = {}) {
    const T = THREE;
    const solid = opacity >= 1;
    const pal = typeof colors === 'number' ? { skin: colors, top: colors, pants: colors, hair: colors } : colors;
    const mk = (hex) => new T.MeshToonMaterial({ color: hex, gradientMap: this.ramp, transparent: !solid, opacity, depthWrite: solid });
    const mats = { skin: mk(pal.skin), top: mk(pal.top), pants: mk(pal.pants), hair: mk(pal.hair) };
    const glow = { waist: mk(pal.pants), hip: mk(pal.pants), thigh: mk(pal.pants) };       // 发力部位单独一份材质，才能单独变色
    const edge = solid ? new T.MeshBasicMaterial({ color: PALETTE.edge, side: T.BackSide }) : null;
    const group = new T.Group();
    const add = (geo, m) => { const mesh = new T.Mesh(geo, m); group.add(mesh); return mesh; };
    // 每个零件都配一个稍大一圈、只画背面的深色壳，看起来就是描边
    const pair = (geo, m) => ({ fill: add(geo, m), line: edge ? add(geo, edge) : null });
    const parts = BONES.map(([a, b, r, rb, c, isHot]) => {
      const m = isHot ? glow[isHot] : mats[c];
      return { a, b, r, rb, core: isHot === 'waist', bone: pair(this._cone(rb / r), m), ja: pair(this.sph, m), jb: pair(this.sph, m) };
    });
    const f = {
      group, parts, glow, base: new T.Color(pal.pants), hot: new T.Color(hot),
      head: pair(this.sph, mats.skin), hair: pair(this.hairCap, mats.hair), bun: pair(this.sph, mats.hair),
      hands: [pair(this.sph, mats.skin), pair(this.sph, mats.skin)],
      face: solid ? {
        eyes: [add(this.sph, new T.MeshBasicMaterial({ color: 0x4a3a50 })), add(this.sph, new T.MeshBasicMaterial({ color: 0x4a3a50 }))],
        // 用力时的表情 > <：每只眼睛两根小短棍
        squint: [0, 1, 2, 3].map(() => add(this.cyl, new T.MeshBasicMaterial({ color: 0x4a3a50, side: T.DoubleSide }))),
        blush: [add(this.sph, new T.MeshBasicMaterial({ color: 0xf7a8c0 })), add(this.sph, new T.MeshBasicMaterial({ color: 0xf7a8c0 }))],
      } : null,
    };
    // 核心：贴在肚皮上的一块椭圆色块，边缘是渐变的。放松时大而柔，收紧时变小、边缘变清楚
    if (solid) {
      const mat = new T.ShaderMaterial({
        transparent: true, depthWrite: false,
        uniforms: { color: { value: new T.Color(hot) }, size: { value: 1 }, feather: { value: 0.85 }, alpha: { value: 0 } },
        vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
        // 圆柱展开后，横向 0.5 处是肚皮正中；椭圆横向占小半圈，纵向几乎占满这一段
        fragmentShader: `uniform vec3 color; uniform float size, feather, alpha; varying vec2 vUv;
          void main() {
            float d = length((vUv - vec2(0.5)) / (vec2(0.2, 0.52) * size));
            float a = (1.0 - smoothstep(1.0 - feather, 1.0, d)) * alpha;
            if (a < 0.004) discard;
            gl_FragColor = vec4(color, a);
          }`,
      });
      // 色块自己是一段略粗的锥形壳，从胸口下面一直包到骨盆上缘
      f.core = add(this._cone(CORE_R[1] / CORE_R[0]), mat);
      f.core.renderOrder = 3;
    }
    this.scene.add(group);
    this.figs[key] = f;
    return f;
  }

  /** 镜头和垫子对准某个动作的活动范围。mat = [垫子拉长几倍, 垫子中心的 x] */
  frame({ x = 0.4, y = 0.22, dist = 2.55, mat = [1, 0.42] } = {}) {
    this.target.x = x; this.target.y = y; this.dist = dist;
    this.mat.scale.x = mat[0]; this.mat.position.x = mat[1];
  }

  show(key, visible) { if (this.figs[key]) this.figs[key].group.visible = visible; }

  /** 把小人摆成给定的关节位置。glow 0~1 = 发力部位亮多少；effort = 是不是正在最用力（表情变成 > <）；hot = 这个动作哪些部位发力、各亮几成，比如 { waist: 1, thigh: 0.5 }；tuck 0~1 = 核心收紧多少（肚皮微微下沉，核心色块变小、边缘变清楚） */
  pose(key, J, glow = 0, effort = glow > 0.9, hot = HOT_ALL, tuck = 0) {
    const f = this.figs[key];
    if (!f || !J) return;
    const T = THREE;
    const v = (i) => (this._v ??= Array.from({ length: 8 }, () => new T.Vector3()))[i];
    const UP = this._up ??= new T.Vector3(0, 1, 0);
    const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2];
    const all = { ...J, midSh: mid(J.lSh, J.rSh), midHip: mid(J.lHip, J.rHip) };
    // 躯干从肩到髋，中间经过脊柱中段（在 53% 处）。肚子占其中 36%～72% 这一段：肋骨下缘到骨盆上缘
    const W = this._w ??= { side: new T.Vector3(), front: new T.Vector3(), x: new T.Vector3(), z: new T.Vector3(), off: new T.Vector3(), m: new T.Matrix4(), body: new T.Vector3() };
    W.side.fromArray(J.lSh).sub(v(0).fromArray(J.rSh)).normalize();
    // 身体正面朝哪（仰卧时朝上）
    W.body.fromArray(all.midHip).sub(v(0).fromArray(all.midSh)).cross(W.side).normalize();
    // 核心收紧时，躯干中段往后背方向沉：肩和髋不动，中间沉得最多（最多约 5.5 厘米）
    const along = (u) => {
      const [p, q, k] = u < 0.53 ? [all.midSh, J.spine, u / 0.53] : [J.spine, all.midHip, (u - 0.53) / 0.47];
      const sink = 0.055 * tuck * Math.sin(Math.PI * u);
      return [0, 1, 2].map((i) => p[i] + (q[i] - p[i]) * k - W.body.getComponent(i) * sink);
    };
    all.rib = along(0.36); all.belt = along(0.72);
    const ball = (p, pos, r) => {
      p.fill.position.copy(pos); p.fill.scale.setScalar(r);
      if (p.line) { p.line.position.copy(pos); p.line.scale.setScalar(r + EDGE); }
    };
    const A = v(0), B = v(1), D = v(2);
    for (const p of f.parts) {
      A.fromArray(all[p.a]); B.fromArray(all[p.b]);
      D.subVectors(B, A);
      const len = D.length() || 1e-4;
      D.divideScalar(len);
      // 肚子这一段：固定朝向（肚皮朝外），核心收紧时只微微下沉一点
      const flat = p.core ? 1 - 0.12 * tuck : 1;
      if (p.core) {
        W.front.crossVectors(D, W.side).normalize();          // 肚皮朝外的方向
        W.z.copy(W.front).negate();                           // 圆柱贴图的正中（0.5 处）在它自己的 -z 方向，所以把 -z 对准肚皮
        W.x.crossVectors(D, W.z).normalize();
        W.m.makeBasis(W.x, D, W.z);
        W.off.copy(W.front).multiplyScalar(-p.r * (1 - flat));
      }
      for (const [m, r] of [[p.bone.fill, p.r], [p.bone.line, p.r + EDGE]]) {
        if (!m) continue;
        m.position.addVectors(A, B).multiplyScalar(0.5);
        if (p.core) {
          m.position.add(W.off);
          m.scale.set(r, len, r * flat);
          m.quaternion.setFromRotationMatrix(W.m);
        } else {
          m.scale.set(r, len, r);
          m.quaternion.setFromUnitVectors(UP, D);
        }
      }
      ball(p.ja, A, p.r); ball(p.jb, B, p.rb);
    }
    if (f.core) {
      // 核心色块：从胸口下面到骨盆上缘，肚皮朝外。它是罩在身体外面的一层壳，不能跟着往下沉，否则会沉进胸口里被挡住
      A.fromArray(along(CORE_SPAN[0])); B.fromArray(along(CORE_SPAN[1]));
      D.subVectors(B, A);
      const len = D.length() || 1e-4;
      D.divideScalar(len);
      W.front.crossVectors(D, W.side).normalize();
      W.z.copy(W.front).negate();
      W.x.crossVectors(D, W.z).normalize();
      W.m.makeBasis(W.x, D, W.z);
      f.core.position.addVectors(A, B).multiplyScalar(0.5);
      f.core.scale.set(CORE_R[0], len, CORE_R[0]);
      f.core.quaternion.setFromRotationMatrix(W.m);
    }
    ball(f.hands[0], A.fromArray(J.lWr), HAND_R);
    ball(f.hands[1], A.fromArray(J.rWr), HAND_R);
    // 大头：沿着“肩 → 头”的方向放，离肩一个头的半径多一点
    const sh = v(3).fromArray(all.midSh), up = v(4).fromArray(J.head).sub(sh);
    if (up.lengthSq() < 1e-6) up.set(0, 1, 0);
    up.normalize();
    const head = v(5).copy(sh).addScaledVector(up, HEAD_R + 0.075);
    ball(f.head, head, HEAD_R);
    // 脸朝哪：左右肩的连线和“朝头顶”的方向都垂直的那一面
    const side = v(6).fromArray(J.lSh).sub(A.fromArray(J.rSh)).normalize();
    const front = v(7).crossVectors(side, up).normalize();
    // 头发盖在头顶偏后，发际线落在额头上方
    const axis = A.copy(up).multiplyScalar(0.76).addScaledVector(front, -0.65).normalize();
    ball(f.hair, head, HEAD_R + 0.012);
    f.hair.fill.quaternion.setFromUnitVectors(UP, axis);
    f.hair.line?.quaternion.copy(f.hair.fill.quaternion);
    ball(f.bun, B.copy(head).addScaledVector(axis, HEAD_R + 0.012 + BUN_R * 0.55), BUN_R);
    if (f.face) {
      f.face.eyes.forEach((m, i) => {
        m.position.copy(head).addScaledVector(front, HEAD_R * 0.9).addScaledVector(side, (i ? -1 : 1) * HEAD_R * 0.36).addScaledVector(up, HEAD_R * 0.02);
        m.scale.setScalar(0.021);
        m.visible = !effort;
      });
      // > <：尖角朝鼻子，两根短棍贴在脸的球面上
      const onFace = (out, s, sideK, upK) => out.copy(front).multiplyScalar(0.9).addScaledVector(side, s * sideK).addScaledVector(up, upK)
        .normalize().multiplyScalar(HEAD_R + 0.003).add(head);
      f.face.squint.forEach((m, n) => {
        m.visible = effort;
        if (!effort) return;
        const s = n < 2 ? 1 : -1, dir = n % 2 ? 1 : -1;
        onFace(A, s, 0.2, 0.02);                 // 尖角（靠鼻子）
        onFace(B, s, 0.58, 0.02 + dir * 0.22);    // 外侧上 / 下
        D.subVectors(B, A);
        const len = D.length();
        m.position.addVectors(A, B).multiplyScalar(0.5);
        m.scale.set(0.011, len, 0.011);
        m.quaternion.setFromUnitVectors(UP, D.divideScalar(len));
      });
      f.face.blush.forEach((m, i) => {
        m.position.copy(head).addScaledVector(front, HEAD_R * 0.74).addScaledVector(side, (i ? -1 : 1) * HEAD_R * 0.6).addScaledVector(up, -HEAD_R * 0.22);
        m.scale.setScalar(0.034);
      });
    }
    // 臀、大腿：整段变色。核心（肚子）不整段变色，用肚皮上的椭圆色块表示
    for (const k in HOT_ALL) f.glow[k].color.copy(f.base).lerp(f.hot, k === 'waist' ? 0 : glow * (hot[k] ?? 0));
    if (f.core) {
      const u = f.core.material.uniforms, w = hot.waist ?? 0;
      u.size.value = 1 - 0.26 * tuck;                 // 收紧：椭圆变小
      u.feather.value = 0.9 - 0.62 * tuck;            // 收紧：渐变的边缘变窄、变清楚
      u.alpha.value = w * (0.5 + 0.45 * tuck);        // 收紧：颜色更实
      f.core.visible = w > 0;
    }
  }

  /**
   * 提示箭头：告诉大家这个动作从哪儿、往哪个方向发力。
   * t = 动作开始后过了几秒，不在开头就传 null（箭头隐藏）；
   * at = 贴着哪个关节（Hip 髋 / Kn 膝 / An 脚踝）；dir = up 往上，out 贴着垫子往脚的方向；press = 胸口上方再加一个朝下的箭头（腰往下贴）
   */
  arrowAt(J, t, { at = 'Hip', dir = 'up', press = false } = {}) {
    const on = !!J && t != null && t >= 0 && t < 1.5;
    for (const g of this.arrows) g.visible = on;
    this.arrowDn.visible = on && press;
    if (!on) return;
    const T = THREE;
    const p = (t % 0.75) / 0.75;                       // 连着“biu”两下，每下 0.75 秒
    const rise = 1 - (1 - p) ** 3;                     // 先快后慢
    this.arrowMat.opacity = p < 0.12 ? p / 0.12 : 1 - ((p - 0.12) / 0.88) ** 2;
    const k = 0.75 + 0.35 * Math.min(1, p / 0.18);
    const L = J['l' + at], R = J['r' + at];
    const cx = (L[0] + R[0]) / 2, cy = (L[1] + R[1]) / 2, cz = (L[2] + R[2]) / 2;
    const dz = L[2] - R[2], dx = L[0] - R[0], w = Math.hypot(dx, dz) || 1;
    // 箭头指向：往上，或者从髋指向脚（贴着地面）
    const way = this._way ??= new T.Vector3();
    if (dir === 'out') way.set((J.lAn[0] + J.rAn[0] - J.lHip[0] - J.rHip[0]) / 2, 0, (J.lAn[2] + J.rAn[2] - J.lHip[2] - J.rHip[2]) / 2).normalize();
    else way.set(0, 1, 0);
    const UP = this._up ??= new T.Vector3(0, 1, 0);
    this.arrows.forEach((g, i) => {
      const s = i ? -1 : 1, off = w / 2 + 0.2;
      g.position.set(cx + (dx / w) * off * s, dir === 'out' ? cy + 0.04 : Math.max(0.02, cy - 0.16), cz + (dz / w) * off * s);
      g.position.addScaledVector(way, rise * 0.3);
      g.quaternion.setFromUnitVectors(UP, way);
      g.scale.setScalar(k);
    });
    if (press) {
      // 胸口到肚子之间的正上方，从高处往下“biu”，停在身体上面一点
      const u = 0.38, top = 0.13 + 0.07 + 0.21;        // 身体半径 + 留的空 + 箭头自己的长度
      const px = ((J.lSh[0] + J.rSh[0]) * (1 - u) + (J.lHip[0] + J.rHip[0]) * u) / 2;
      const py = ((J.lSh[1] + J.rSh[1]) * (1 - u) + (J.lHip[1] + J.rHip[1]) * u) / 2;
      const pz = ((J.lSh[2] + J.rSh[2]) * (1 - u) + (J.lHip[2] + J.rHip[2]) * u) / 2;
      this.arrowDn.position.set(px, py + top + 0.26 * (1 - rise), pz);
      this.arrowDn.scale.setScalar(k * 1.15);
    }
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
