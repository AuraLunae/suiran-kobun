/* portal-client.js ― テンシ ポータル連携用クライアント（他のライブラリ不要。fetch だけ）
 *
 * 使い方は3ステップ（詳しくはガイドの手順4〜6）：
 *   1. このファイルをサイトに置き、<script src="portal-client.js"></script> で読み込む
 *   2. PortalClient.init({...}) を1回呼ぶ（設定4か所＋ getDailyCounts）
 *   3. 回答するたびに PortalClient.kick() を呼ぶ
 *
 * 送るのは「日付ごとの回答数」だけ。回答の中身は送らない。
 */
(function (global) {
  'use strict';

  var C = null;                                   // init() で設定が入る
  var state = { enabled: false, error: '', lastSync: 0 };
  var kickTimer = null, retryTimer = null, fails = 0, again = false, inflight = null, lastSent = null;

  /* ---------- 保存（localStorage。使えない環境ではメモリ） ---------- */
  var mem = {};
  function sget(k) { try { return global.localStorage.getItem(k); } catch (e) { return mem[k] === undefined ? null : mem[k]; } }
  function sset(k, v) { try { global.localStorage.setItem(k, v); } catch (e) { mem[k] = v; } }
  function skey() { return 'portal-session:' + C.site; }   // サイトごとに別のキー（ブラウザの保存先はサイトごとに分かれている）

  /* ---------- 通信 ---------- */
  function hdr(t) { return { 'apikey': C.key, 'Authorization': 'Bearer ' + (t || C.key), 'Content-Type': 'application/json' }; }
  function limit(ms) {
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return { signal: AbortSignal.timeout(ms), done: function () {} };
    var c = new AbortController(), t = setTimeout(function () { c.abort(); }, ms);
    return { signal: c.signal, done: function () { clearTimeout(t); } };
  }
  function http(path, body, token) {
    var t = limit(20000);
    return fetch(C.url + path, { method: 'POST', headers: hdr(token), body: JSON.stringify(body), signal: t.signal })
      .then(function (r) {
        return r.json().catch(function () { return null; }).then(function (j) {
          t.done();
          if (!r.ok) {
            var e = new Error((j && (j.message || j.msg || j.error_description)) || ('HTTP ' + r.status));
            e.status = r.status; throw e;
          }
          return j;
        });
      }, function (err) {
        t.done();
        var e = new Error(err && (err.name === 'TimeoutError' || err.name === 'AbortError') ? '通信がタイムアウトしました。' : 'ネットワークに接続できません。');
        e.network = true; throw e;
      });
  }
  function pack(r) {
    return { access_token: r.access_token, refresh_token: r.refresh_token,
             expires_at: r.expires_at || Math.floor(Date.now() / 1000 + (r.expires_in || 3600)) };
  }
  function readSession() { try { return JSON.parse(sget(skey()) || 'null'); } catch (e) { return null; } }
  function writeSession(s) { sset(skey(), JSON.stringify(s)); }
  function withLock(fn) {
    if (global.navigator && navigator.locks) return navigator.locks.request('portal-session:' + C.site, { mode: 'exclusive' }, fn);
    return Promise.resolve().then(fn);          // 排他が使えない古いブラウザ向け
  }
  // 匿名ログイン。通信エラーのときは、新しい匿名ユーザーを作らずに失敗させる（記録が別人になるのを防ぐ）
  function session(force) {
    return withLock(function () {
      var s = readSession();
      if (s && !force && s.expires_at - 60 > Date.now() / 1000) return s;
      var signup = function () {
        return http('/auth/v1/signup', { data: {}, gotrue_meta_security: {} }).then(function (r) { var n = pack(r); writeSession(n); return n; });
      };
      if (s && s.refresh_token) {
        return http('/auth/v1/token?grant_type=refresh_token', { refresh_token: s.refresh_token })
          .then(function (r) { var n = pack(r); writeSession(n); return n; },
                function (e) {
                  if (e.network || !e.status || e.status >= 500 || e.status === 429) throw e;
                  return signup();
                });
      }
      return signup();
    });
  }
  function rpc(name, body) {
    function go(attempt) {
      return session(attempt > 0).then(function (s) {
        return http('/rest/v1/rpc/' + name, body || {}, s.access_token).catch(function (e) {
          if (e.status === 401 && attempt === 0) return go(1);
          throw e;
        });
      });
    }
    return go(0);
  }

  /* ---------- 日別の回数（毎回、全日分を送る） ---------- */
  function cleanCounts(raw) {
    var out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.keys(raw).sort().slice(-400).forEach(function (k) {
      var n = raw[k];
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof n === 'number' && isFinite(n) && n >= 0) out[k] = Math.min(100000, Math.floor(n));
    });
    return out;
  }
  function syncNow() {
    if (!state.enabled) return Promise.resolve(false);
    if (inflight) { again = true; return inflight; }
    clearTimeout(retryTimer);
    inflight = (function () {
      if (global.navigator && navigator.onLine === false) { state.error = 'オフライン'; return Promise.resolve(false); }
      return Promise.resolve().then(function () { return C.getDailyCounts(); }).then(function (raw) {
        var days = cleanCounts(raw);
        if (!Object.keys(days).length) { lastSent = '{}'; return true; }
        return rpc(C.syncRpc, { p_days: days }).then(function () {
          lastSent = JSON.stringify(days); state.error = ''; state.lastSync = Date.now(); fails = 0; return true;
        });
      }).catch(function (e) {
        state.error = e && e.message ? e.message : '同期できませんでした。';
        fails++;
        retryTimer = setTimeout(syncNow, Math.min(5000 * Math.pow(2, fails), 600000));   // 5秒→10秒→…最大10分
        return false;
      });
    })().then(function (ok) {
      inflight = null;
      if (again) { again = false; return syncNow(); }
      return ok;
    });
    return inflight;
  }
  // 回答するたびに呼ぶ。1.5秒待って、まとめて送る
  function kick() {
    if (!state.enabled) return;
    clearTimeout(kickTimer);
    kickTimer = setTimeout(syncNow, 1500);
  }

  /* ---------- 連携・順位 ---------- */
  function need() {
    if (!state.enabled) throw new Error('PortalClient.init() が呼ばれていません。');
  }
  function wrap(p) {
    return p.catch(function (e) { if (e && e.network) throw new Error('オフラインのため実行できません。'); throw e; });
  }
  function link(key) { need(); return wrap(rpc('redeem_link_key', { p_key: String(key || '').trim(), p_site: C.site })); }
  function unlink() { need(); return wrap(rpc('unlink_self', { p_site: C.site })); }
  function linkStatus() { need(); return wrap(rpc('link_status', { p_site: C.site })); }
  function ranking() { need(); return syncNow().then(function () { return wrap(rpc(C.rankRpc)); }); }

  /* ---------- 連携画面（任意。自前の画面を作るなら使わなくてよい） ---------- */
  function mountLinkBox(target) {
    need();
    var root = typeof target === 'string' ? document.querySelector(target) : target;
    if (!root) throw new Error('mountLinkBox: 表示先の要素が見つかりません（' + target + '）');
    if (!document.getElementById('pc-style')) {
      var st = document.createElement('style'); st.id = 'pc-style';
      st.textContent = '.pc-box{font:inherit;color:inherit}.pc-box p{margin:8px 0;font-size:13px;line-height:1.8}' +
        '.pc-box input{width:100%;box-sizing:border-box;font:inherit;font-size:15px;letter-spacing:.1em;text-transform:uppercase;padding:10px 0;border:0;border-bottom:1px solid currentColor;background:none;color:inherit;border-radius:0}' +
        '.pc-box button{font:inherit;font-size:14px;padding:12px 18px;margin:14px 12px 0 0;border:1px solid currentColor;background:none;color:inherit;cursor:pointer;border-radius:0}' +
        '.pc-box button:disabled{opacity:.4;cursor:default}.pc-box .pc-muted{opacity:.65;font-size:12px}';
      document.head.appendChild(st);
    }
    function el(tag, text, cls) { var e = document.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; }
    var box = el('div', '', 'pc-box'), status = el('p', '確認しています…'), label = el('label', '連携キー'),
        input = document.createElement('input'), go = el('button', '連携する'), off = el('button', '連携を解除'),
        msg = el('p', '', 'pc-muted'), note = el('p', 'ポータルサイトで発行したキーを貼り付けると、他のサイトとランキングを共有できます。送られるのは日ごとの回答数だけです。', 'pc-muted');
    input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false; input.placeholder = 'XXXX-XXXX-XXXX-…';
    input.setAttribute('autocapitalize', 'characters');
    go.type = 'button'; off.type = 'button'; off.hidden = true;
    label.appendChild(input);
    [status, label, go, off, msg, note].forEach(function (n) { box.appendChild(n); });
    root.innerHTML = ''; root.appendChild(box);

    function refresh() {
      status.textContent = '確認しています…';
      return linkStatus().then(function (r) {
        if (r && r.linked) {
          status.textContent = '連携中：' + (r.nickname || '') + (r.banned ? '（ランキングには表示されていません。ポータルで確認してください）' : '');
          off.hidden = false;
        } else { status.textContent = 'まだ連携していません。'; off.hidden = true; }
      }).catch(function (e) { status.textContent = e.message || '連携の状態を確認できませんでした。'; });
    }
    go.addEventListener('click', function () {
      var v = input.value.trim();
      if (!v) { msg.textContent = 'キーを貼り付けてください。'; return; }
      go.disabled = true; msg.textContent = '連携しています…';
      link(v).then(function (r) {
        input.value = '';
        msg.textContent = r && r.replaced ? '連携しました。以前の連携は解除されました。' : '連携しました。';
        syncNow();
      }).catch(function (e) { msg.textContent = e.message || '連携できませんでした。'; })
        .then(function () { go.disabled = false; return refresh(); });
    });
    off.addEventListener('click', function () {
      if (!global.confirm('ポータルとの連携を解除しますか？記録は消えません。')) return;
      off.disabled = true; msg.textContent = '解除しています…';
      unlink().then(function () { msg.textContent = '連携を解除しました。'; })
        .catch(function (e) { msg.textContent = e.message || '解除できませんでした。'; })
        .then(function () { off.disabled = false; return refresh(); });
    });
    return refresh();
  }

  /* ---------- 初期化 ---------- */
  function init(cfg) {
    var errs = [];
    if (!cfg || typeof cfg !== 'object') throw new Error('PortalClient.init: 設定がありません。');
    if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/.test(cfg.url || '')) errs.push('url は https://xxxx.supabase.co の形で指定してください');
    if (!cfg.key || /service_role/i.test(cfg.key)) errs.push('key は publishable（anon）キーを指定してください（service_role は使えません）');
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(cfg.site || '')) errs.push('site は、英小文字で始まり、英小文字・数字・_ だけの2〜31文字にしてください');
    if (cfg.site && cfg.syncRpc !== cfg.site + '_sync_daily') errs.push('syncRpc は「' + cfg.site + '_sync_daily」にしてください（英単語サイトだけ sync_daily）');
    if (cfg.site && cfg.rankRpc !== cfg.site + '_get_ranking') errs.push('rankRpc は「' + cfg.site + '_get_ranking」にしてください（英単語サイトだけ get_ranking）');
    if (typeof cfg.getDailyCounts !== 'function') errs.push('getDailyCounts は関数にしてください（{ "2026-11-02": 12, … } を返す）');
    if (errs.length) throw new Error('PortalClient.init の設定エラー：\n・' + errs.join('\n・'));
    C = { url: cfg.url.replace(/\/$/, ''), key: cfg.key, site: cfg.site, syncRpc: cfg.syncRpc, rankRpc: cfg.rankRpc, getDailyCounts: cfg.getDailyCounts };
    state.enabled = true;

    global.addEventListener('online', function () { fails = 0; syncNow(); });
    global.addEventListener('focus', function () { syncNow(); });
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') syncNow(); });
    setInterval(function () {                       // 取りこぼし対策。数が変わっているときだけ送る
      if (!state.enabled || inflight) return;
      Promise.resolve().then(function () { return C.getDailyCounts(); }).then(function (raw) {
        if (JSON.stringify(cleanCounts(raw)) !== lastSent) syncNow();
      }).catch(function () {});
    }, 60000);
    kick();
  }

  global.PortalClient = { init: init, kick: kick, syncNow: syncNow, link: link, unlink: unlink,
                          linkStatus: linkStatus, ranking: ranking, mountLinkBox: mountLinkBox, state: state };
})(typeof window !== 'undefined' ? window : this);
