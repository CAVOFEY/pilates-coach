// 把页面用到的文件存在手机里：第二次打开直接读本机，不用再下载，没网也能打开。
// 带 ?v= 的文件（app.js、fig3d.js、字体）换了版本号就是新地址，自然会取新的；其余文件不会变。
const SHELL = 'pilates-shell';
const BIG = /\.(task|wasm)$/;   // 两个大文件由页面自己存（pilates-assets），这里不重复存

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

async function save(href, res) {
  if (!res || res.status !== 200 || res.type !== 'basic') return;
  const cache = await caches.open(SHELL), url = new URL(href);
  if (url.search) {                                   // 同一个文件的旧版本删掉
    for (const k of await cache.keys()) {
      const u = new URL(k.url);
      if (u.pathname === url.pathname && u.search !== url.search) await cache.delete(k);
    }
  }
  await cache.put(href, res);
}

/** 其余文件：本机有就用本机的，没有才去下载 */
async function asset(e, req) {
  const cache = await caches.open(SHELL);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  const res = await fetch(req);
  e.waitUntil(save(req.url, res.clone()).catch(() => {}));
  return res;
}

/** 页面本身：先问网络要最新的，4 秒没回来就先用本机存的那份（新的在后台存好，下次打开生效） */
async function page(e, url) {
  const key = url.origin + url.pathname;
  const cache = await caches.open(SHELL);
  const old = await cache.match(key);
  const net = fetch(key, { cache: 'no-cache' }).then(async (res) => {
    if (res.ok) await save(key, res.clone()).catch(() => {});
    return res;
  });
  if (!old) return net;
  e.waitUntil(net.catch(() => {}));
  return Promise.race([
    net.then((r) => (r.ok ? r : old), () => old),
    new Promise((done) => setTimeout(() => done(old), 4000)),
  ]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || BIG.test(url.pathname) || req.headers.has('range')) return;
  e.respondWith(req.mode === 'navigate' ? page(e, url) : asset(e, req));
});

// 第一次打开时，页面的文件是在这个脚本接管之前下载的；页面把清单发过来，这里补存一遍
self.addEventListener('message', (e) => {
  const urls = e.data?.warm;
  if (!Array.isArray(urls)) return;
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    for (const u of urls) {
      try {
        const url = new URL(u, location.href);
        if (url.origin !== location.origin || BIG.test(url.pathname) || url.pathname.endsWith('/sw.js')) continue;
        if (await cache.match(url.href)) continue;
        await save(url.href, await fetch(url.href));
      } catch { /* 这个没存上，下次再补 */ }
    }
  })());
});
