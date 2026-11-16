// 动作库里“跟着口令做”的动作：摄像头不纠正这些动作，只有 3D 小人示范、文字要领和口令节拍。
// 动作的名字、好处、要领整理自同学的《15min 普拉提计划》文档（内容做了压缩）；姿势是本项目自己用关节坐标摆的。
// 坐标：x 沿着垫子（头在小的一边），y 朝上，z 朝镜头；单位大约是米。

const T = 0.5, UA = 0.24, FA = 0.25, TH = 0.5, SH = 0.5, FT = 0.14, SW = 0.19, HW = 0.11;
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
/** 在侧面看的平面里，和垫子成多少度的方向（0 = 朝脚，90 = 朝上，180 = 朝头） */
const d = (deg, z = 0) => { const r = (deg * Math.PI) / 180; return [Math.cos(r), Math.sin(r), z]; };
/** 把 v 里和 t 平行的部分去掉，得到和 t 垂直的单位向量 */
const perp = (v, t) => norm(sub(v, mul(t, dot(v, t))));

/** 两节的肢体：已知根部和末端要到的位置，求中间的关节。pole = 关节往哪边拐 */
function ik(root, target, l1, l2, pole) {
  const v = sub(target, root), u = norm(v);
  const L = Math.max(Math.abs(l1 - l2) + 1e-4, Math.min(len(v), l1 + l2 - 1e-4));
  const a = (l1 * l1 - l2 * l2 + L * L) / (2 * L), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  let p = sub(pole, mul(u, dot(pole, u)));
  p = len(p) < 1e-5 ? [0, 1, 0] : norm(p);
  return add(root, add(mul(u, a), mul(p, h)));
}
/** 一条胳膊或一条腿。spec = [第一节的方向, 第二节的方向]，或者 { to: 末端位置, pole } */
function limb(root, spec, l1, l2) {
  if (Array.isArray(spec)) {
    const mid = add(root, mul(norm(spec[0]), l1));
    return [mid, add(mid, mul(norm(spec[1]), l2))];
  }
  const mid = ik(root, spec.to, l1, l2, spec.pole || [0, 1, 0]);
  return [mid, add(mid, mul(norm(sub(spec.to, mid)), l2))];
}
/** 把一个姿势的描述算成全身关节。hip = 骨盆中心，torso = 从骨盆指向肩，side = 身体的左边朝哪 */
function build(k) {
  const o = k.off || [0, 0, 0];
  const hip = add(k.hip, o), t = norm(k.torso), s = perp(k.side, t), ss = k.shSide ? perp(k.shSide, t) : s;
  const shC = add(hip, mul(t, T)), front = norm(cross(mul(t, -1), s));
  const J = {
    lHip: add(hip, mul(s, HW)), rHip: sub(hip, mul(s, HW)),
    lSh: add(shC, mul(ss, SW)), rSh: sub(shC, mul(ss, SW)),
    spine: add(add(shC, mul(sub(hip, shC), 0.53)), mul(front, k.bend || 0)),
    head: add(shC, norm(k.head || t)),
  };
  const shift = (spec) => (Array.isArray(spec) ? spec : { ...spec, to: add(spec.to, o) });
  for (const c of ['l', 'r']) {
    [J[c + 'El'], J[c + 'Wr']] = limb(J[c + 'Sh'], shift(k[c + 'a']), UA, FA);
    const leg = k[c + 'l'];
    [J[c + 'Kn'], J[c + 'An']] = limb(J[c + 'Hip'], shift(Array.isArray(leg) ? leg.slice(0, 2) : leg), TH, SH);
    J[c + 'Toe'] = add(J[c + 'An'], mul(norm((Array.isArray(leg) ? leg[2] : leg.foot) || [1, 0, 0]), FT));
  }
  return J;
}

// ---------- 几个常用的起始姿势（脸朝下的：左边是 +z；脸朝上、坐着的：左边是 -z；侧躺的：左边朝上） ----------
const UPZ = [0, 0, 1], DNZ = [0, 0, -1];
const hand = (x, z, pole = [1, 0, 0]) => ({ to: [x, 0.06, z], pole });
const QUAD = {     // 四足跪姿
  hip: [0.5, 0.57, 0], torso: [-1, -0.04, 0], side: UPZ, head: [-1, 0.2, 0],
  la: hand(0, 0.19), ra: hand(0, -0.19),
  ll: [d(-90), d(0), d(-15)], rl: [d(-90), d(0), d(-15)],
};
const heel = (z) => ({ to: [1.2, 0.07, z], pole: [0, 1, 0], foot: d(25) });
const seat = (lean, more = {}) => ({   // 坐姿后仰。lean = 躯干和垫子成多少度（90 = 坐直）
  hip: [0.5, 0.11, 0], torso: d(lean), side: DNZ, head: d(lean - 12),
  la: [d(-10), d(-5)], ra: [d(-10), d(-5)], ll: heel(-0.11), rl: heel(0.11), ...more,
});
const HEAD_L = [[-0.15, 0.55, -1], [-0.35, 0.45, 0.9]], HEAD_R = [[-0.15, 0.55, 1], [-0.35, 0.45, -0.9]];   // 手扶在头后
const KNEE_DN = [d(-14), [0.2, 0, -1], [0.3, 0, -1]];                        // 侧撑时下面那条腿：膝盖着地，小腿往后收
const LEG_STACK = [[0.97, -0.2, 0.1], [0.03, -0.22, -0.54], [0.3, 0, -1]];   // 上面的腿叠在下面的腿上
const LEG_OPEN = [[0.8, 0.55, 0.25], [0.116, -0.54, -0.61], [0.3, 0, -1]];   // 上面的膝盖向上打开，脚不离开
const LEG_LONG = [[1, 0.05, 0], [1, 0.05, 0], [1, 0, 0.2]];                  // 上面的腿伸直
const ON_HIP = [[0.75, -0.35, 0.55], [0.6, -0.1, -0.8]];                     // 手叉在腰上
const side = (more = {}) => ({         // 屈膝侧撑：右前臂和右膝着地，脸朝镜头
  hip: [0.5, 0.3, 0], torso: [-0.5, 0.18, 0], side: [0, 1, 0], head: [-1, 0.5, 0],
  ra: [[0, -1, 0], [0.15, 0, 1]], la: ON_HIP, rl: KNEE_DN, ll: LEG_STACK, ...more,
});
const SIT = {      // 坐直，脸朝镜头，左腿向旁边伸直，右腿盘起来
  hip: [0.3, 0.17, 0], torso: [0, 1, 0], side: [1, 0, 0], head: [0, 1, 0],
  ll: [[1, -0.03, 0.1], [1, -0.03, 0.1], [0.2, 1, 0]], rl: [[-0.25, 0, 1], [0.9, 0, -0.45], [1, 0, 0]],
  la: [[0.5, -0.8, 0.3], [0.6, -0.6, 0.3]], ra: [[-0.5, -0.8, 0.3], [0.2, -0.6, 0.7]],
};
const HANDS = { la: HEAD_L, ra: HEAD_R };
const REACH = { ...QUAD, head: [-1, 0.25, 0] };

/**
 * 动作库。每个动作都是“起始姿势 → 做到位 → 停住 → 回到起始姿势”算一次，和有摄像头纠正的三个动作同一个节拍。
 * tags = 练哪里；reps = 默认做几次；rest = 起始姿势；tops = 做到位的姿势（两个 = 左右交替）；
 * sides: 'half' = 做到一半提醒换另一边；steps = 四拍 [口令, 说明, 呼吸]，第一拍是起始姿势；view = 镜头对准哪
 */
const LIST = [
  {
    id: 'tablechild', name: '桌式 + 孩童式', tags: ['拉伸', '背部'], reps: 5,
    intro: '从四足跪姿把臀部坐向脚跟，手向前伸，再回到跪姿。',
    good: ['拉长脊柱，放松下背', '练“收紧”和“松开”之间的切换', '适合放在开头热身'],
    how: ['四足跪好，背放平', '呼气，手推地，臀部往后坐向脚跟', '手继续向前伸，后背鼓起来呼吸', '先收肚子，再推回跪姿'],
    easy: '坐不到脚跟：膝盖分开一点，或者在臀部下面垫个枕头。',
    steps: [['跪好', '手在肩下，膝在髋下，背放平', ''], ['后坐', '手推地，臀部坐向脚跟', 'out'], ['停住', '手向前伸，后背鼓起来', 'in'], ['回来', '收紧肚子，推回跪姿', 'out']],
    rest: QUAD,
    tops: [{
      ...QUAD, hip: [0.86, 0.31, 0], torso: d(196), bend: -0.06, head: [-1, 0.05, 0],
      la: hand(-0.07, 0.19, [0, 1, 0]), ra: hand(-0.07, -0.19, [0, 1, 0]),
      ll: [[-0.44, -0.24, 0], d(0), d(0)], rl: [[-0.44, -0.24, 0], d(0), d(0)],
    }],
    view: { x: 0.45, y: 0.3, dist: 3.0 }, hot: {},
  },
  {
    id: 'thread', name: '跪姿穿针引线', tags: ['拉伸', '背部', '肩臂'], reps: 6, sides: 'half',
    intro: '四足跪姿，一只手从另一只手下面穿过去，转开上背。',
    good: ['转开僵硬的上背', '放松肩颈', '左右都做，能发现哪一边更紧'],
    how: ['四足跪好，骨盆保持不动', '呼气，一只手掌心朝上，从另一只手下面贴着垫子穿过去', '肩膀和头轻轻落下，不要用力压', '手收回来撑好，做完一半换另一只手'],
    easy: '肩膀落不到垫子：穿到哪算哪，骨盆不歪就行。',
    steps: [['跪好', '手在肩下，膝在髋下', ''], ['穿过', '一只手掌心朝上，从另一只手下面穿过去', 'out'], ['停住', '肩和头轻轻落下，骨盆不动', 'in'], ['收回', '手收回来撑好', 'out']],
    rest: QUAD,
    tops: [{ ...QUAD, torso: [-1, -0.3, 0], shSide: [0, -0.5, 0.87], la: { to: [0, 0.06, -0.45], pole: [-1, 0, 0] }, ra: hand(0, -0.19, [0.3, 0, -1]), head: [-1, -0.2, -0.5] }],
    view: { x: 0.45, y: 0.42, dist: 3.2 }, hot: {},
  },
  {
    id: 'birddog', name: '对角伸展', tags: ['核心', '臀腿', '背部'], reps: 6,
    intro: '四足跪姿，对侧的手和脚伸直，停一下再收回，左右交替。',
    good: ['练到平时很难发力的深层稳定肌', '慢慢伸、慢慢收，没法借力，腰背不容易代偿', '缓解久坐后的腰背紧张'],
    how: ['手在肩正下方，膝盖在髋正下方', '收紧肚子，对侧手脚伸直，和身体成一条线', '伸直后停住，身体不晃', '轻轻落回垫子，下一次换另一边'],
    easy: '稳不住：只伸腿不伸手。',
    steps: [['跪好', '手在肩下，膝在髋下，收紧肚子', ''], ['伸展', '对侧的手和脚伸直，和身体成一条线', 'out'], ['停住', '身体不晃，腰不塌', 'in'], ['收回', '手和膝盖轻轻落回垫子，下次换边', 'out']],
    rest: QUAD,
    tops: [{ ...REACH, la: [d(177), d(177)], rl: [d(2), d(2), d(-10)] }, { ...REACH, ra: [d(177), d(177)], ll: [d(2), d(2), d(-10)] }],
    view: { x: 0.45, y: 0.4, dist: 3.1, mat: [1.24, 0.5] }, hot: { waist: 1, hip: 1 },
  },
  {
    id: 'leanhold', name: '坐姿后仰', tags: ['核心'], reps: 5,
    intro: '屈膝坐直，收紧肚子慢慢向后仰，停一下再坐起来。',
    good: ['练核心的控制和耐力', '学会“先收肚子再后仰”', '全程不用抬头，脖子不费力'],
    how: ['屈膝坐好，手臂前伸', '收紧肚子，上身慢慢向后仰', '停在快稳不住的位置，腰不塌', '用肚子的力量慢慢坐直'],
    easy: '腰酸：少仰一点，或者手扶在大腿后面。',
    steps: [['坐好', '屈膝坐直，双脚踩地，手臂前伸', ''], ['后仰', '收紧肚子，上身慢慢向后仰', 'out'], ['停住', '停在快稳不住的位置，腰不塌', 'in'], ['坐起', '用肚子的力量慢慢坐直', 'out']],
    rest: seat(97, { la: [d(-4), d(-2)], ra: [d(-4), d(-2)] }),
    tops: [seat(132)],
    view: { x: 0.6, y: 0.4, dist: 3.0 }, hot: { waist: 1 },
  },
  {
    id: 'diagcrunch', name: '后仰 + 对角卷腹', tags: ['侧腰', '核心'], reps: 6,
    intro: '坐着向后仰，手扶头，一侧手肘去找对侧抬起的膝盖，左右交替。',
    good: ['练侧腰', '转的时候骨盆要稳住', '左右交替，能发现哪边弱'],
    how: ['屈膝坐好后仰，手轻轻扶在头后', '呼气，转上身，手肘靠近对侧膝盖', '用肚子转，不要用手拉头', '回到中间，下一次换另一边'],
    easy: '太难：脚不离地，只转上身。',
    steps: [['坐好', '屈膝坐着向后仰，手轻扶头后', ''], ['转体', '手肘去找对侧抬起的膝盖', 'out'], ['停住', '用肚子转，不要拉头', 'in'], ['回正', '回到中间，下次换边', 'out']],
    rest: seat(128, HANDS),
    tops: [seat(110, { ...HANDS, shSide: [0.55, 0, -0.84], rl: [d(55), d(-15), d(20)] }), seat(110, { ...HANDS, shSide: [-0.55, 0, -0.84], ll: [d(55), d(-15), d(20)] })],
    view: { x: 0.6, y: 0.4, dist: 3.0 }, hot: { waist: 1 },
  },
  {
    id: 'sideclam', name: '侧撑 + 膝外张', tags: ['臀腿', '侧腰'], reps: 6, sides: 'half',
    intro: '屈膝侧撑，髋抬离垫子，上面的膝盖像蚌壳一样打开再合上。',
    good: ['练臀部外侧，改善膝盖内扣', '侧腰全程撑着', '骨盆不跟着翻，练控制'],
    how: ['手肘在肩膀正下方，屈膝，把髋抬起来', '呼气，上面的膝盖向上打开，两脚不分开', '骨盆不往后倒，下面的腰不塌', '膝盖慢慢合上'],
    easy: '撑不住：髋放在垫子上，只做开合。',
    steps: [['侧撑', '侧身，手肘在肩下，屈膝，把髋抬起来', ''], ['打开', '上面的膝盖向上打开，两脚不分开', 'out'], ['停住', '骨盆不往后倒', 'in'], ['合上', '膝盖慢慢合上', 'out']],
    rest: side(), tops: [side({ ll: LEG_OPEN })],
    view: { x: 0.5, y: 0.35, dist: 3.0 }, hot: { hip: 1, thigh: 0.6 },
  },
  {
    id: 'sideleg', name: '侧撑 + 直腿上下', tags: ['臀腿', '侧腰'], reps: 6, sides: 'half',
    intro: '屈膝侧撑，上面的腿伸直，慢慢抬高再放下。',
    good: ['练臀部外侧', '侧腰耐力', '抬腿时骨盆不歪，练稳定'],
    how: ['屈膝侧撑，髋抬起来，上面的腿伸直', '呼气，直腿向上抬，脚不往前甩', '身体一晃就把幅度减小', '慢慢放回髋的高度'],
    easy: '撑不住：髋放在垫子上，侧躺着抬腿。',
    steps: [['侧撑', '侧身，手肘在肩下，髋抬起，上面的腿伸直', ''], ['抬腿', '直腿向上抬，脚不往前甩', 'out'], ['停住', '身体不晃', 'in'], ['放下', '慢慢放回髋的高度', 'out']],
    rest: side({ ll: LEG_LONG }), tops: [side({ ll: [d(30), d(30), [1, 0, 0.2]] })],
    view: { x: 0.55, y: 0.4, dist: 3.3, mat: [1.24, 0.55] }, hot: { hip: 1, thigh: 0.6 },
  },
  {
    id: 'sitside', name: '直腿侧伸展', tags: ['拉伸', '侧腰', '臀腿'], reps: 4, sides: 'half',
    intro: '坐着，一条腿向旁边伸直，另一条腿盘起来，上身向直腿那一侧弯过去。',
    good: ['拉开侧腰', '拉伸大腿后侧和内侧', '练完之后放松收尾'],
    how: ['坐直，一条腿向旁边伸直，另一条腿屈膝收回', '呼气，远的那只手举过头顶，上身向直腿那边侧弯', '两边坐骨都不离开垫子', '慢慢坐直'],
    easy: '够不到脚：手放在小腿上，膝盖可以微弯。',
    steps: [['坐好', '一条腿向旁边伸直，另一条腿盘起来', ''], ['侧弯', '远的那只手举过头顶，上身弯向直腿', 'out'], ['停住', '两边坐骨都不离开垫子', 'in'], ['回正', '慢慢坐直', 'out']],
    rest: SIT,
    tops: [{ ...SIT, torso: [0.75, 0.66, 0], head: [0.75, 0.66, 0.1], ra: [[0.9, 0.45, 0], [0.95, 0.1, 0]], la: [[0.6, -0.75, 0.2], [0.9, -0.2, 0.2]] }],
    view: { x: 0.55, y: 0.42, dist: 3.4, mat: [1.1, 0.6] }, hot: {},
  },
];
export const MOVES = LIST.map((m) => ({ ...m, rest: build(m.rest), tops: m.tops.map(build) }));

/** 示范动画的关节位置。p = 做到位的程度 0~1；rep = 第几次（左右交替的动作靠它换边） */
export function movePose(m, p, rep = 0) {
  const A = m.rest, B = m.tops[rep % m.tops.length], J = {};
  for (const key in A) J[key] = [A[key][0] + (B[key][0] - A[key][0]) * p, A[key][1] + (B[key][1] - A[key][1]) * p, A[key][2] + (B[key][2] - A[key][2]) * p];
  return J;
}
