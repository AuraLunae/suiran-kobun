// テンシで古典文法 service worker（オフライン対応）。英単語サイトの sw.js を参考にしている。
// 方針:
//   画面・CSS・JS（シェル）… キャッシュを即返す。裏で最新を確認し、変わっていれば「全部まとめて」入れ替える（次のリロードで反映）。
//   問題データ（data/）…… 通信を先に試し、だめ（オフライン・遅い）ならキャッシュ。問題を更新したときに、古い問題が混ざらないようにするため。
//   Google Fonts …… キャッシュがあれば即返し、裏で更新（オフラインでも同じ見た目で開く）。
// ★ 画面・JS・CSS を変えて公開したら、VERSION を上げると、確実に全員の端末が入れ替わる（上げ忘れても、裏の確認で数分〜次回起動までに反映される）。
const VERSION = 'kobun-v1';
const FONTS = 'kobun-fonts-v1';
const SHELL = ['index.html', 'style.css', 'app.js', 'portal-client.js', 'portal-config.js', 'manifest.json']; // これが取れないとインストール失敗（古いSWが残る）
const EXTRA = ['icons/icon.svg', 'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png']; // 取れなくてもOK
const RECHECK_MS = 5 * 60 * 1000;   // シェルの更新確認は5分に1回まで
const BG_TIMEOUT = 20000;           // 裏の更新確認は20秒で打ち切る
const NET_TIMEOUT = 4000;           // 問題データ：キャッシュがあるとき、通信を待つのは4秒まで
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

const scopeUrl = p => new URL(p, self.registration.scope).href;
// キャッシュのキー：?v=… などの付き物を取った URL（古い版と新しい版が並んで残らないように）
const keyOf = u => { const x = new URL(u, self.registration.scope); x.search = ''; x.hash = ''; return x.href; };
const cacheable = res => !!res && res.ok && res.type === 'basic';
// ホスティングによっては /index.html が / へリダイレクトされる。リダイレクト済みの応答は画面表示に使えないので作り直す
const clean = async res => res.redirected ? new Response(await res.blob(), { status: 200, statusText: 'OK', headers: res.headers }) : res;
const lookup = async key => { try { return await (await caches.open(VERSION)).match(key); } catch (_) { return undefined; } };
const store = async (key, res) => { try { await (await caches.open(VERSION)).put(key, res); } catch (_) { /* 容量不足などでも動作は止めない */ } };
const keep = (e, p) => { try { e.waitUntil(p); } catch (_) { /* イベント終了後でも例外にしない */ } };
const shellReq = u => (u === 'index.html' ? scopeUrl('./') : scopeUrl(u));
let lastShellCheck = 0;

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(VERSION);
    const get = async u => {
      const r = await fetch(new Request(u, { cache: 'reload' }));
      if (!r.ok) throw new Error(u + ' ' + r.status);
      return clean(r);
    };
    await Promise.all(SHELL.map(async u => c.put(keyOf(scopeUrl(u)), await get(shellReq(u)))));
    // 問題データも、manifest に載っている分を全部入れる（これで、最初の1回さえ開けば、あとはオフラインで解ける）
    const mres = await get(scopeUrl('data/manifest.json'));
    const manifest = await mres.clone().json();
    await c.put(keyOf(scopeUrl('data/manifest.json')), mres);
    await Promise.all((manifest.prints || []).map(async p => c.put(keyOf(scopeUrl('data/' + p.file)), await get(scopeUrl('data/' + p.file)))));
    await Promise.allSettled(EXTRA.map(async u => c.put(keyOf(scopeUrl(u)), await get(scopeUrl(u)))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VERSION && k !== FONTS).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// シェルを裏で確認する。1つでも変わっていたら、全部まとめて入れ替える（画面とJSの版がずれて壊れないように）
function refreshShell(e) {
  if (self.navigator && self.navigator.onLine === false) return;     // 確実にオフラインなら何もしない
  if (Date.now() - lastShellCheck < RECHECK_MS) return;
  lastShellCheck = Date.now();
  keep(e, (async () => {
    const t = new AbortController(), timer = setTimeout(() => t.abort(), BG_TIMEOUT);
    try {
      const c = await caches.open(VERSION);
      const fresh = await Promise.all(SHELL.map(async u => {
        const res = await fetch(shellReq(u), { cache: 'no-cache', signal: t.signal });
        if (!cacheable(res)) throw new Error('bad response');
        const old = await c.match(keyOf(scopeUrl(u)));
        const a = old && old.headers.get('etag'), b = res.headers.get('etag');
        return { u, res: await clean(res), changed: !(a && b && a === b) };
      }));
      if (fresh.some(x => x.changed)) await Promise.all(fresh.map(x => c.put(keyOf(scopeUrl(x.u)), x.res)));
    } catch (_) {
      lastShellCheck = 0;       // 失敗したら次回また確認する
    } finally {
      clearTimeout(timer);
    }
  })());
}

// 画面：キャッシュを即返し、裏で最新を取る。キャッシュが無い（初回など）ときだけ通信を待つ。
async function handleNav(e) {
  const hit = await lookup(keyOf(scopeUrl('index.html')));
  if (hit) { refreshShell(e); return hit; }
  try {
    const res = await fetch(e.request);
    if (cacheable(res)) keep(e, store(keyOf(scopeUrl('index.html')), res.clone()));
    return res;
  } catch (_) {
    return new Response('オフラインです。一度オンラインで開いてください。', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

// JS・CSS・アイコンなど：キャッシュ優先。無ければ通信。
async function assetFirst(e, r) {
  const key = keyOf(r.url);
  const hit = await lookup(key);
  if (hit) return hit;
  const res = await fetch(r);
  if (cacheable(res)) keep(e, store(key, res.clone()));
  return res;
}

// 問題データ：通信が先。キャッシュがあるときは、4秒待っても来なければキャッシュを使う。
async function dataFetch(e, r) {
  const key = keyOf(r.url);
  const hit = await lookup(key);
  if (hit && self.navigator && self.navigator.onLine === false) return hit;
  const t = hit ? new AbortController() : null;
  const timer = t ? setTimeout(() => t.abort(), NET_TIMEOUT) : 0;
  try {
    const res = await fetch(r, t ? { signal: t.signal } : undefined);
    if (res.ok) { if (res.type === 'basic') keep(e, store(key, res.clone())); return res; }
    return hit || res;
  } catch (err) {
    if (hit) return hit;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Google Fonts：キャッシュがあれば即返し、裏で更新
async function fontFirst(e, r) {
  const c = await caches.open(FONTS);
  const hit = await c.match(r);
  const net = fetch(r).then(res => {
    if (res && (res.ok || res.type === 'opaque')) keep(e, c.put(r, res.clone()));
    return res;
  });
  if (hit) { keep(e, net.catch(() => {})); return hit; }
  return net;           // オフラインでキャッシュも無ければ失敗 → ブラウザの代わりの書体で表示される
}

self.addEventListener('fetch', e => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET') return;
  if (FONT_HOSTS.includes(u.hostname)) { e.respondWith(fontFirst(e, r)); return; }
  if (u.origin !== location.origin) return;                 // Supabase など外部への通信には介入しない
  if (r.mode === 'navigate') { e.respondWith(handleNav(e)); return; }
  if (u.pathname.startsWith(new URL('data/', self.registration.scope).pathname)) { e.respondWith(dataFetch(e, r)); return; }
  e.respondWith(assetFirst(e, r));
});
