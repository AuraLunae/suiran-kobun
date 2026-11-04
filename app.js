/* テンシで古典文法
 * ・問題は data/ から最初に一括でダウンロードし、localStorage に保存（次回からは保存分を使う）
 * ・プリントの「回」(助動詞①など)ごとに、ステップ(= 回の半分)のボタンを用意。押すと、そのステップの問題がいっきに始まる
 * ・出す順番は、まだ解いていない問題が最優先
 * ・ステップごとに「一巡」を覚えておく。一巡し終わるまでは、まだ答えていない問題だけを出す（途中でやめても、つづきから。ゲージは戻らない）
 * ・一巡が終わったら結果を出し、まちがえた問題だけを順番にやり直せる。「わからない」「たまたま当たった」もまちがいに入る
 * ・オフライン対応は sw.js（画面・プログラム・問題をキャッシュ）。順位は、ポータルと連携しなくても出る
 * ・Supabase は「テンシ ポータル」のものだけを使う（連携しなくても、すべて遊べる）
 */
(() => {
'use strict';

/* ============================== 設定 ============================== */
const KEYS = {
	data: 'kobunbunpou-data-v1',             // ダウンロードした問題（キャッシュ）
	progress: 'kobunbunpou-progress-v1',     // 問題ごとの記録
	session: 'kobunbunpou-session-v1',       // （旧）途中の回。runs に引き継ぐ
	runs: 'kobunbunpou-runs-v1',             // 回ごとの「いまの一巡」（途中の進み具合）
	rank: 'kobunbunpou-rank-v1',             // 最後に取れた順位（オフラインで見せる用）
	daily: 'kobunbunpou-daily-counts'        // ポータルに送る、日ごとの回答数
};
const FORMS_SHORT = ['未然', '連用', '終止', '連体', '已然', '命令'];
const CIRC = '①②③④⑤⑥⑦⑧⑨';
const PRAISE = ['せいかい', 'お見事', 'その調子', 'いいですね', 'すばらしい'];
const REDUCED = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ============================== 保存 ============================== */
const mem = {};
const store = {
	get(k) { try { return localStorage.getItem(k); } catch (e) { return mem[k] === undefined ? null : mem[k]; } },
	set(k, v) { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } },
	del(k) { try { localStorage.removeItem(k); } catch (e) { delete mem[k]; } }
};
function readJSON(k, fallback) {
	try { const v = store.get(k); return v ? JSON.parse(v) : fallback; } catch (e) { return fallback; }
}
function writeJSON(k, v) { store.set(k, JSON.stringify(v)); }

/* ============================== 小道具 ============================== */
const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function shuffle(a) {
	a = a.slice();
	for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
	return a;
}
function jstDay(ms) { return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10); }

/* ---- 問題文の記法（data/ の文字列）を HTML にする ---- */
const RE = {
	ruby: /\{([^|}]+)\|([^}]+)\}/y,
	ul: /\[\[(?:(\d+):)?(.+?)\]\]/y,
	bk: /<<(?:(\d+):)?(.+?)>>/y,
	fn: /〔(.+?)〕/y
};
function rich(str, notes) {
	let out = '', i = 0, m;
	while (i < str.length) {
		const c = str[i];
		m = null;
		if (c === '{') {
			RE.ruby.lastIndex = i; m = RE.ruby.exec(str);
			if (m) out += `<ruby>${esc(m[1])}<rp>（</rp><rt>${esc(m[2])}</rt><rp>）</rp></ruby>`;
		} else if (c === '[' && str[i + 1] === '[') {
			RE.ul.lastIndex = i; m = RE.ul.exec(str);
			if (m) out += m[1]
				? `<span class="blank" data-blank="${m[1]}"><b class="bn">${CIRC[m[1] - 1]}</b>${esc(m[2])}</span>`
				: `<span class="ul">${esc(m[2])}</span>`;
		} else if (c === '<' && str[i + 1] === '<') {
			RE.bk.lastIndex = i; m = RE.bk.exec(str);
			if (m) out += m[1]
				? `<span class="blank" data-blank="${m[1]}"><b class="bn">${CIRC[m[1] - 1]}</b>${esc(m[2])}</span>`
				: `<span class="bk">《${esc(m[2])}》</span>`;
		} else if (c === '〔') {
			RE.fn.lastIndex = i; m = RE.fn.exec(str);
			if (m) {
				const k = m[1].lastIndexOf('|');
				const word = m[1].slice(0, k), note = m[1].slice(k + 1);
				notes.push({ word: plain(word), note });
				out += `<span class="fn">${rich(word, [])}<sup>※${notes.length}</sup></span>`;
			}
		}
		if (m) { i += m[0].length; continue; }
		out += esc(c); i++;
	}
	return out;
}
function plain(str) {
	return str
		.replace(/\{([^|}]+)\|[^}]+\}/g, '$1')
		.replace(/〔([^|〕]+)\|[^〕]*〕/g, '$1')
		.replace(/\[\[(?:\d+:)?(.+?)\]\]/g, '$1')
		.replace(/<<(?:\d+:)?(.+?)>>/g, '《$1》');
}
function notesHTML(notes) {
	return notes.map((n, i) => `<li><b>※${i + 1}</b><span class="w">${esc(n.word)}</span>　${esc(n.note)}</li>`).join('');
}

/* ---- 花のイラスト(index.html の <symbol id="f-…"> を使う) ---- */
const BLOOMS = ['sakura', 'ume', 'kiku', 'kikyo', 'tsubaki', 'cosmos'];   // 桜・梅・菊・桔梗・椿・秋桜
const ROUND_FLOWERS = ['ume', 'kikyo', 'tsubaki', 'cosmos', 'kiku', 'sakura'];
const TOP_FLOWERS = ['kiku', 'sakura', 'ume'];                             // ランキング 1〜3位
function flower(kind, size, cls, style) {
	return `<svg class="flower${cls ? ' ' + cls : ''}" width="${size}" height="${size}"${style ? ` style="${style}"` : ''} aria-hidden="true"><use href="#f-${kind}"/></svg>`;
}
function flowerTrio() {
	return `<div class="flower-trio" aria-hidden="true">${flower('kikyo', 46)}${flower('sakura', 58)}${flower('kiku', 46)}</div>`;
}

/* ============================== 日ごとの回答数(ポータル用) ============================== */
let dailyMemory = {};
function loadDaily() {
	try {
		const parsed = JSON.parse(store.get(KEYS.daily) || '{}');
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
	} catch (e) { return { ...dailyMemory }; }
	return {};
}
function recordDaily() {
	const days = loadDaily();
	const today = jstDay(Date.now());
	days[today] = (Number.isInteger(days[today]) && days[today] >= 0 ? days[today] : 0) + 1;
	Object.keys(days).sort().slice(0, -400).forEach(d => { delete days[d]; });
	dailyMemory = days;
	writeJSON(KEYS.daily, days);
	if (window.PortalClient) window.PortalClient.kick();
}
function calcStreak() {
	const daily = loadDaily();
	let d = Date.now(), n = 0;
	if (!(daily[jstDay(d)] > 0)) d -= 864e5;
	while (daily[jstDay(d)] > 0) { n++; d -= 864e5; }
	return n;
}

/* ============================== 問題データ(一括ダウンロード + キャッシュ) ============================== */
let DATA = null;          // { version, prints, questions, byId }
let pendingRaw = null;    // 新しい版を見つけたが、クイズ中なので保留

function isValidRaw(d) {
	return !!d && typeof d.version === 'string' && Array.isArray(d.prints) && d.prints.length > 0 &&
		d.prints.every(p => p && p.id && Array.isArray(p.questions) && p.questions.length > 0);
}
// 同じ空欄（group・問番号・空欄番号がおなじ）の問題は、ひとつの「まとめた問題」にして、組み合わせで答えさせる
// （基本形・文法的意味・活用形 など。ひとつでもまちがえたら、まちがい）
function makeSet(parts) {
	const f = parts[0];
	const m = /^(.*?《[^》]*》)/.exec(f.prompt || '');
	const head = m ? m[1] : /^傍線部/.test(f.prompt || '') ? '傍線部の助動詞' : (f.ref || 'この問題');
	return {
		...f, composite: true, parts,
		id: parts.map(p => p.id).join('+'),
		tag: parts.map(p => p.tag).join('・'),
		prompt: `${head}について、すべて答えよう`,
		choices: [], answer: parts.map(p => `${p.tag} ${p.answer}`).join('　'), note: ''
	};
}
function mergeSets(list) {
	const out = [], sets = new Map();
	list.forEach(q => {
		if (!q.group) { out.push(q); return; }
		const key = [q.group, q.ref || '', q.blank == null ? '' : q.blank].join('|');
		if (!sets.has(key)) { const set = { parts: [] }; sets.set(key, set); out.push(set); }
		sets.get(key).parts.push(q);
	});
	return out.map(x => x.parts ? (x.parts.length > 1 ? makeSet(x.parts) : x.parts[0]) : x);
}
function buildIndex(raw) {
	const questions = [], byId = new Map(), partMap = new Map();     // partMap: ばらばらだった頃の問題の id → まとめた問題の id
	const prints = raw.prints.map(p0 => {
		const p = { ...p0 };
		if (!p.round || !p.step) {
			const parts = String(p.title || '').split(/\s+/);
			p.round = p.round || parts[0] || p.id;
			p.step = p.step || parts.slice(1).join(' ') || p.id;
		}
		p.questions = mergeSets(p0.questions).map(q => {
			q.printId = p.id; q.order = questions.length;
			if (q.parts) q.parts.forEach(pt => { pt.printId = p.id; partMap.set(pt.id, q.id); });
			questions.push(q); byId.set(q.id, q);
			return q;
		});
		return p;
	});
	return { version: raw.version, prints, questions, byId, partMap };
}
async function fetchJSON(url, opts) {
	const r = await fetch(url, opts);
	if (!r.ok) throw new Error(`HTTP ${r.status}`);
	return r.json();
}
async function downloadAll(onProgress) {
	const manifest = await fetchJSON('data/manifest.json', { cache: 'no-cache' });
	let done = 0;
	const prints = await Promise.all(manifest.prints.map(p =>
		fetchJSON(`data/${p.file}?v=${encodeURIComponent(manifest.version)}`).then(j => {
			done++; if (onProgress) onProgress(done, manifest.prints.length);
			return j;
		})));
	const raw = { version: manifest.version, savedAt: Date.now(), prints };
	if (!isValidRaw(raw)) throw new Error('問題データの形式が正しくありません。');
	return raw;
}
function saveData(raw) { try { store.set(KEYS.data, JSON.stringify(raw)); } catch (e) { console.error('問題データを保存できませんでした。', e); } }

async function checkForUpdate(currentVersion) {
	try {
		const manifest = await fetchJSON('data/manifest.json', { cache: 'no-cache' });
		if (manifest.version === currentVersion) return;
		const raw = await downloadAll();
		saveData(raw);
		pendingRaw = raw;
		if (view === 'home') applyPending();
	} catch (e) { /* オフラインなど。保存済みの問題で続ける */ }
}
function applyPending() {
	if (!pendingRaw) return;
	DATA = buildIndex(pendingRaw);
	migrateParts();
	pendingRaw = null;
	renderHome();
	toast('問題を新しくしました');
}

/* ============================== 記録 ============================== */
let progress = readJSON(KEYS.progress, {});
if (!progress || typeof progress !== 'object' || Array.isArray(progress)) progress = {};

const isSeen = q => !!(progress[q.id] && progress[q.id].n > 0);
function coverage() {
	let touched = 0;
	DATA.questions.forEach(q => { if (isSeen(q)) touched++; });
	return { touched, total: DATA.questions.length };
}
function totalAnswers() {
	let n = 0;
	DATA.questions.forEach(q => { if (progress[q.id]) n += progress[q.id].n || 0; });
	return n;
}
function recordResult(q, ok, why) {
	const p = progress[q.id] || { n: 0, c: 0 };
	const wasNew = !p.n;
	p.n++; if (ok) p.c++;
	p.last = Date.now(); p.ok = ok;
	if (why) p.why = why; else delete p.why;      // why: 'unknown'(わからない) / 'lucky'(たまたま当たった)
	progress[q.id] = p;
	writeJSON(KEYS.progress, progress);
	recordDaily();
	return wasNew;
}
// 「たまたま当たった」：正解として記録した問題を、まちがいに送る（回答数は増やさない）
function demoteResult(q, why) {
	const p = progress[q.id];
	if (!p) return;
	if (p.ok === true && p.c > 0) p.c--;
	p.ok = false; p.why = why; p.last = Date.now();
	writeJSON(KEYS.progress, progress);
}

/* ============================== 出題 ============================== */
// そのステップの問題を全部出す。順番は、まだ解いていない問題 → まちがえた問題 → いちばん前に解いた問題。
// 同じ古文・同じ文の問題は、続けて出す。
function pickSession(printId) {
	const groups = new Map();
	DATA.questions.filter(q => q.printId === printId).forEach(q => {
		const key = q.group || q.id;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(q);
	});
	const rank = g => {
		const seen = g.filter(isSeen);
		const unseen = g.length - seen.length;
		if (unseen > 0) return [0, -unseen / g.length];
		const wrong = seen.filter(q => progress[q.id].ok === false).length;
		if (wrong > 0) return [1, -wrong];
		return [2, Math.min(...seen.map(q => progress[q.id].last || 0))];
	};
	const list = shuffle(Array.from(groups.values())).map(g => ({ g: g.sort((a, b) => a.order - b.order), r: rank(g) }));
	list.sort((a, b) => (a.r[0] - b.r[0]) || (a.r[1] - b.r[1]));   // 同じ順位は、シャッフルのまま
	const ordered = [];
	list.forEach(x => ordered.push(...x.g));
	return ordered;
}

/* ---- 回(ステップ)ごとの「いまの一巡」 ----
   runs[printId] = { printId, kind: 'main' | 'retry', round, ids, results, newIds, startedAt, updatedAt }
   ・ids … 出す順番。results … 答えた問題（増えるだけ。ゲージはここから数えるので、戻らない）
   ・main … その回の全問を一巡する。一巡し終わるまでは、まだ答えていない問題だけを出す。途中でやめても、つづきから
   ・retry … 一巡が終わったあとの、まちがえた問題だけのやり直し */
let runs = readJSON(KEYS.runs, {});
if (!runs || typeof runs !== 'object' || Array.isArray(runs)) runs = {};
let session = null;       // いま解いている run
function saveRuns() { writeJSON(KEYS.runs, runs); }
function saveSession() {
	if (!session) return;
	session.updatedAt = Date.now();
	runs[session.printId] = session;
	saveRuns();
}
const runDone = r => Object.keys(r.results).length;
const runComplete = r => r.ids.every(id => id in r.results);
const openIndex = r => r.ids.findIndex(id => !(id in r.results));   // まだ答えていない、いちばん前の問題

function newRun(printId, kind, ids, round) {
	return { printId, kind, round: round || 0, ids, results: {}, newIds: [], startedAt: Date.now(), updatedAt: Date.now() };
}
// 保存されていた run を、いまの問題データに合わせて整える。もう終わっている・問題が無い run は null
function cleanRun(r) {
	if (!r || typeof r !== 'object' || !Array.isArray(r.ids) || !r.results || typeof r.results !== 'object') return null;
	// ばらばらの問題で作られていた一巡は、まとめた問題に直す（部分が全部そろっているときだけ答え済み。全部せいかいなら正解）
	const mapId = id => DATA.byId.has(id) ? id : (DATA.partMap.get(id) || null);
	const ids = [...new Set(r.ids.map(mapId).filter(Boolean))];
	if (!ids.length) return null;
	const results = {};
	ids.forEach(id => {
		if (typeof r.results[id] === 'boolean') { results[id] = r.results[id]; return; }
		const q = DATA.byId.get(id);
		if (q.parts && q.parts.every(p => typeof r.results[p.id] === 'boolean')) results[id] = q.parts.every(p => r.results[p.id] === true);
	});
	const newIds = [...new Set((Array.isArray(r.newIds) ? r.newIds : []).map(mapId).filter(id => id && ids.includes(id)))];
	const printId = r.printId || (DATA.byId.get(ids[0]) || {}).printId;
	if (!printId) return null;
	if (ids.every(id => id in results)) return null;
	return { printId, kind: r.kind === 'retry' ? 'retry' : 'main', round: r.round || 0, ids, results, newIds, startedAt: r.startedAt || Date.now(), updatedAt: r.updatedAt || 0 };
}
function activeRun(printId) {
	if (!runs[printId]) return null;
	const run = cleanRun(runs[printId]);
	if (!run) { delete runs[printId]; saveRuns(); return null; }
	runs[printId] = run;
	return run;
}
function activeRuns() { return DATA.prints.map(p => activeRun(p.id)).filter(Boolean); }
function latestRun() { return activeRuns().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0] || null; }
// 旧い「途中の回」(v1) があれば、新しい形に引き継ぐ
function migrateOldSession() {
	const old = readJSON(KEYS.session, null);
	if (old === null) return;
	store.del(KEYS.session);
	if (!old || !Array.isArray(old.ids) || !old.results) return;
	const firstId = old.ids.find(id => DATA.byId.has(id));
	const printId = old.printId || (firstId && DATA.byId.get(firstId).printId);
	if (!printId || runs[printId]) return;
	const run = cleanRun({ ...old, printId, kind: 'main' });
	if (run) { runs[printId] = run; saveRuns(); }
}
// ばらばらだった頃の記録を、まとめた問題の記録に引き継ぐ（部分の記録が全部あるときだけ）
function migrateParts() {
	let changed = false;
	DATA.questions.forEach(q => {
		if (!q.parts || progress[q.id]) return;
		const ps = q.parts.map(p => progress[p.id]);
		if (!ps.every(p => p && p.n > 0)) return;
		progress[q.id] = { n: Math.max(...ps.map(p => p.n)), c: Math.min(...ps.map(p => p.c || 0)), last: Math.max(...ps.map(p => p.last || 0)), ok: ps.every(p => p.ok === true) };
		changed = true;
	});
	if (changed) writeJSON(KEYS.progress, progress);
}
// その回で、いちばん最近の答えがまちがいの問題（order があれば、その順番。なければプリントの順番）
function wrongIds(printId, order) {
	const wrong = DATA.questions.filter(q => q.printId === printId && progress[q.id] && progress[q.id].ok === false);
	const pos = new Map((order || []).map((id, i) => [id, i]));
	const at = q => pos.has(q.id) ? pos.get(q.id) : 1e9 + q.order;
	return wrong.sort((a, b) => at(a) - at(b)).map(q => q.id);
}

/* ============================== 画面の切り替え ============================== */
let view = 'loading';
function show(name) {
	view = name;
	['loading', 'home', 'quiz', 'result'].forEach(v => { $(v + '-view').hidden = v !== name; });
	window.scrollTo(0, 0);
	if (name === 'home') loadRanking(false);
}
let toastTimer = 0;
function toast(msg) {
	const t = $('toast');
	t.textContent = msg; t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

/* ============================== ホーム ============================== */
let justTouched = new Set();
function renderHome() {
	const { touched, total } = coverage();
	$('hero-total').textContent = total;
	$('hero-total2').textContent = total;
	$('hero-touched').textContent = touched;
	$('hero-mascot').innerHTML = flowerTrio();
	$('stat-streak').textContent = calcStreak();
	$('stat-total').textContent = totalAnswers();

	// 点の地図：1問 = 1つの点
	const dm = $('dotmap');
	dm.innerHTML = '';
	let popIndex = 0;
	DATA.prints.forEach(p => {
		const qs = p.questions;
		const done = qs.filter(isSeen).length;
		const g = document.createElement('div');
		g.className = 'dg';
		g.innerHTML = `<div class="dg-label"><span>${esc(p.title)}</span><span>${done} / ${qs.length}</span></div>`;
		const dots = document.createElement('div');
		dots.className = 'dg-dots';
		qs.forEach(q => {
			const d = document.createElement('i');
			const pr = progress[q.id];
			d.className = 'dot' + (pr && pr.n ? (pr.ok === false ? ' ng' : ' ok') : '');
			if (justTouched.has(q.id) && !REDUCED) { d.classList.add('pop'); d.style.setProperty('--d', (popIndex++ * 22) + 'ms'); }
			dots.appendChild(d);
		});
		g.appendChild(dots);
		dm.appendChild(g);
	});
	justTouched = new Set();

	// 回ごとのボタン
	const rounds = [];
	DATA.prints.forEach(p => {
		let r = rounds.find(x => x.name === p.round);
		if (!r) { r = { name: p.round, prints: [] }; rounds.push(r); }
		r.prints.push(p);
	});
	$('rounds').innerHTML = rounds.map((r, ri) => {
		const all = r.prints.reduce((n, p) => n + p.questions.length, 0);
		const done = r.prints.reduce((n, p) => n + p.questions.filter(isSeen).length, 0);
		const steps = r.prints.map(p => {
			const d = p.questions.filter(isSeen).length;
			const run = activeRun(p.id);                                  // 途中の一巡があれば、その進み具合を見せる
			const wrongN = wrongIds(p.id).length;
			let cls = '', prog, pct;
			if (run) {
				const k = runDone(run), n = run.ids.length;
				cls = ' going'; pct = Math.round(k / n * 100);
				prog = `${run.kind === 'retry' ? 'やり直し' : 'つづき'}　${k} / ${n}問`;
			} else {
				pct = Math.round(d / p.questions.length * 100);
				if (d >= p.questions.length) cls = ' done';
				prog = d >= p.questions.length ? 'ぜんぶ解いた' : `${d} / ${p.questions.length}問`;
			}
			const retry = !run && wrongN ? `<button class="step-retry" type="button" data-retry="${esc(p.id)}">まちがえた${wrongN}問を、やり直す</button>` : '';
			return `<div class="step"><button class="step-btn${cls}" type="button" data-print="${esc(p.id)}">
				<span class="step-name">${esc(p.step)}</span>
				<span class="step-prog">${prog}</span>
				<span class="step-bar"><i style="width:${pct}%"></i></span>
			</button>${retry}</div>`;
		}).join('');
		return `<div class="round-card"><div class="round-head">${flower(ROUND_FLOWERS[ri % ROUND_FLOWERS.length], 30, 'round-flower')}<h3 class="round-name">${esc(r.name)}</h3><span class="round-num"><b>${done}</b> / ${all}問</span></div><div class="steps">${steps}</div></div>`;
	}).join('');

	const s = latestRun();
	$('resume-area').hidden = !s;
	if (s) {
		const pr = DATA.prints.find(p => p.id === s.printId);
		$('resume-count').textContent = `${pr ? pr.title + '　' : ''}${s.kind === 'retry' ? 'やり直し　' : ''}${runDone(s)} / ${s.ids.length}問`;
	}
}

/* ============================== クイズ ============================== */
let cur = null, locked = false, praiseIndex = 0, shownPassage = null;

function openRun(run) {
	session = run;
	enterQuiz();
	show('quiz');
	renderQuestion();
}
// ステップのボタン：途中の一巡があればその続き、なければ新しい一巡（まだ解いていない問題が先）
function startStep(printId) {
	let run = activeRun(printId);
	if (!run) {
		const ids = pickSession(printId).map(q => q.id);
		if (!ids.length) return;
		run = newRun(printId, 'main', ids, 0);
		runs[printId] = run; saveRuns();
	}
	openRun(run);
}
function startFresh(printId) {
	delete runs[printId]; saveRuns();
	startStep(printId);
}
// まちがえた問題だけを、順番に出す。ids を渡さなければ、その回のいまのまちがい全部
function startRetry(printId, ids, round) {
	const list = ids && ids.length ? ids : wrongIds(printId);
	if (!list.length) { toast('まちがえた問題は、いまありません'); return; }
	const run = newRun(printId, 'retry', list, round || 1);
	runs[printId] = run; saveRuns();
	openRun(run);
}

// ブラウザの「戻る」：クイズの途中なら、ホームに戻るだけ（答えは保存済みなので、ゲージは戻らない）
let skipPop = false;
function enterQuiz() {
	if (history.state && history.state.quiz) return;
	try { history.pushState({ quiz: 1 }, ''); } catch (e) { /* 使えない環境では何もしない */ }
}
function goHome() {
	renderHome(); show('home');
	if (pendingRaw) applyPending();
	if (history.state && history.state.quiz) {
		skipPop = true;
		setTimeout(() => { skipPop = false; }, 600);
		try { history.back(); } catch (e) { skipPop = false; }
	}
}
window.addEventListener('popstate', () => {
	if (skipPop) { skipPop = false; return; }
	if (view === 'quiz' || view === 'result') {
		const d = $('quit-dialog');
		if (d.open) d.close();
		renderHome(); show('home');
		if (pendingRaw) applyPending();
	}
});

function setGauge(done, n) {
	const pct = n ? Math.round(done / n * 100) : 0;
	$('progress-fill').style.width = pct + '%';
	$('progress-petal').style.left = pct + '%';
	$('progress').setAttribute('aria-valuenow', pct);
}

function stripHTML(q) {
	if (!q.row) return '';
	const hit = q.hit || [];
	const cells = q.row.map((v, i) =>
		`<div class="cs-cell${hit.includes(i) ? ' hit' : ''}"><small>${FORMS_SHORT[i]}</small><b>${esc(v)}</b></div>`).join('');
	return `<div class="conj-strip"><p class="cs-title">「${esc(q.verb)}」の活用</p><div class="cs-grid">${cells}</div></div>`;
}

function renderPassage(q) {
	const box = $('passage');
	if (!q.passage) { box.hidden = true; shownPassage = null; return; }
	const print = DATA.prints.find(p => p.id === q.printId);
	const ps = print && print.passages && print.passages[q.passage];
	if (!ps) { box.hidden = true; shownPassage = null; return; }
	box.hidden = false;
	const key = q.printId + ':' + q.passage;
	if (shownPassage !== key) {
		const notes = [];
		$('passage-text').innerHTML = rich(ps.text, notes);
		$('passage-notes').innerHTML = notesHTML(notes);
		$('passage-title').textContent = '古文　' + ps.title;
		$('passage-scroll').scrollTop = 0;
		shownPassage = key;
	}
	const scroller = $('passage-scroll');
	scroller.querySelectorAll('.blank').forEach(el => el.classList.toggle('is-active', el.dataset.blank === String(q.blank)));
	const el = scroller.querySelector(`.blank[data-blank="${q.blank}"]`);
	if (el) {
		const top = el.offsetTop - scroller.clientHeight / 2 + el.offsetHeight / 2;
		scroller.scrollTo({ top: Math.max(0, top), behavior: REDUCED ? 'auto' : 'smooth' });
	}
}

function renderQuestion() {
	const idx = openIndex(session);          // いつも「まだ答えていない、いちばん前の問題」から（途中で戻っても、同じ続きになる）
	if (idx < 0) { finish(); return; }
	const q = DATA.byId.get(session.ids[idx]);
	cur = q; locked = false;
	const n = session.ids.length;

	// 進み具合（答えた数から数えるので、戻らない）
	const done = runDone(session);
	setGauge(done, n);
	$('quiz-count').textContent = `${Math.min(done + 1, n)} / ${n}`;

	renderPassage(q);

	$('q-tag').textContent = q.tag;
	$('q-new').hidden = isSeen(q);
	const print = DATA.prints.find(p => p.id === q.printId);
	$('q-ref').textContent = `${print ? print.title : ''}　${q.ref || ''}`;
	$('q-prompt').textContent = q.prompt;

	// 問題の見せ方
	const vis = $('q-visual');
	if (q.type === 'table') {
		vis.innerHTML = `<div class="tbl-q"><div class="tbl-wrap"><p class="tbl-cap">${esc(q.caption)}</p><div class="tbl-row"><div class="tbl-cell"><small>基本形</small><b>${esc(q.verb)}</b></div><span class="tbl-arrow" aria-hidden="true">→</span><div class="tbl-cell ask"><small>${esc(q.form)}</small><b>？</b></div></div></div></div>`;
	} else if (q.sentence) {
		const notes = [];
		vis.innerHTML = `<p class="q-sentence">${rich(q.sentence, notes)}</p><ol class="notes">${notesHTML(notes)}</ol>`;
	} else {
		vis.innerHTML = '';
	}

	// 選択肢
	const ch = $('choices');
	ch.innerHTML = '';
	ch.classList.toggle('is-set', !!q.composite);
	if (q.composite) renderParts(q);
	else q.choices.forEach((c, idx) => {
		const b = document.createElement('button');
		b.type = 'button';
		b.className = 'choice';
		b.dataset.idx = idx;
		b.innerHTML = `<span class="key">${idx + 1}</span><span class="ctext">${esc(c)}</span>`;
		b.addEventListener('click', () => choose(idx));
		ch.appendChild(b);
	});

	$('feedback').hidden = true;
	$('feedback').innerHTML = '';
	$('next-bar').hidden = true;
	$('fx').innerHTML = '';
	$('dk-row').hidden = false;
	$('next-btn').textContent = n - done > 1 ? 'つぎへ' : 'けっかを見る';
	window.scrollTo({ top: 0 });
}

// まとめた問題：項目ごとに選んで、ぜんぶ選んだら「こたえあわせ」
let setSel = [], lastOks = null;
function renderParts(q) {
	setSel = q.parts.map(() => null); lastOks = null;
	const items = q.parts.map((p, i) => `<div class="part" data-part="${i}" data-qid="${esc(p.id)}"><p class="part-label">${esc(p.tag)}</p><div class="part-choices">${
		p.choices.map((c, j) => `<button type="button" class="pchip" data-part="${i}" data-c="${j}" aria-pressed="false">${esc(c)}</button>`).join('')
	}</div></div>`).join('');
	const ch = $('choices');
	ch.innerHTML = items + '<div class="part-submit"><button class="btn-sticker small" id="submit-btn" type="button" disabled>こたえあわせ</button><span class="fb-hint">ぜんぶ選んでから。ひとつでもまちがえたら、まちがいになります</span></div>';
	ch.querySelectorAll('.pchip').forEach(b => b.addEventListener('click', () => pickPart(Number(b.dataset.part), Number(b.dataset.c))));
	$('submit-btn').addEventListener('click', () => answerSet(false));
}
function pickPart(i, j) {
	if (locked || !cur || !cur.composite) return;
	setSel[i] = j;
	document.querySelectorAll(`#choices .pchip[data-part="${i}"]`).forEach(b => {
		const on = Number(b.dataset.c) === j;
		b.classList.toggle('is-selected', on);
		b.setAttribute('aria-pressed', on ? 'true' : 'false');
	});
	$('submit-btn').disabled = setSel.some(v => v === null);
}
function partsHTML(q, kind) {
	return `<ul class="fb-parts">${q.parts.map((p, i) => {
		const good = lastOks ? lastOks[i] : null;
		const mark = good === null ? '' : good ? '<span class="fp-mark ok">○</span>' : '<span class="fp-mark ng">×</span>';
		const picked = kind === 'ng' && !good && setSel[i] != null && p.choices[setSel[i]] != null
			? `<small class="fp-you">あなたの答え：${esc(p.choices[setSel[i]])}</small>` : '';
		return `<li>${mark}<span class="fp-tag">${esc(p.tag)}</span><span class="fp-ans"><b>${esc(p.answer)}</b></span>${picked}<p class="fp-note">${esc(p.note || '')}</p></li>`;
	}).join('')}</ul>`;
}

// ふりかえりの中身。kind: ok(せいかい) / ng(まちがい) / unknown(わからない) / lucky(たまたま当たった)
function fbHTML(q, kind) {
	const ok = kind === 'ok';
	const face = ok ? flower(BLOOMS[Math.floor(Math.random() * BLOOMS.length)], 52) : flower('bud', 52);
	const title = ok ? PRAISE[praiseIndex++ % PRAISE.length] : kind === 'unknown' ? 'だいじょうぶ' : kind === 'lucky' ? 'まちがいに入れました' : 'おしい';
	const sent = kind === 'unknown' ? 'まちがえた問題に入れました。あとで、もう一度出ます。'
		: kind === 'lucky' ? 'たまたま当たった問題は、まちがえた問題に入れました。あとで、もう一度出ます。' : '';
	return `<div class="fb-face">${face}</div>
		<div class="fb-body">
			<p class="fb-title">${title}</p>
			${ok || q.composite ? '' : `<p class="fb-ans">正解は <b>${esc(q.answer)}</b></p>`}
			${sent ? `<p class="fb-sent">${sent}</p>` : ''}
			${q.composite ? partsHTML(q, kind) : `<p class="fb-note">${esc(q.note || '')}</p>`}
			${stripHTML(q)}
			${ok ? '<div class="fb-actions"><button class="lucky-btn" id="lucky-btn" type="button">たまたま当たった</button><span class="fb-hint">自信がなければ、まちがいに入れて、あとで復習できます</span></div>' : ''}
		</div>`;
}
function showFeedback(q, kind) {
	const fb = $('feedback');
	fb.className = 'feedback ' + (kind === 'ok' ? 'ok' : 'ng');
	fb.innerHTML = fbHTML(q, kind);
	fb.hidden = false;
}

function choose(idx) { answer(idx); }
function giveUp() { if (cur && cur.composite) answerSet(true); else answer(-1); }          // 「わからない」：まちがい扱い

// 答えを記録して、ふりかえりを出す（ひとつの問題も、まとめた問題も共通）
function settle(q, ok, unknown, oks) {
	const wasNew = recordResult(q, ok, unknown ? 'unknown' : null);
	session.results[q.id] = ok;
	if (wasNew && !session.newIds.includes(q.id)) session.newIds.push(q.id);
	saveSession();
	setGauge(runDone(session), session.ids.length);
	$('dk-row').hidden = true;
	lastOks = oks || null;
	showFeedback(q, ok ? 'ok' : unknown ? 'unknown' : 'ng');
	$('next-bar').hidden = false;
	if (ok) burst();
	$('next-btn').focus({ preventScroll: true });
	$('feedback').scrollIntoView({ block: 'nearest', behavior: REDUCED ? 'auto' : 'smooth' });
}

function answer(idx) {
	if (locked || !cur || cur.composite) return;
	locked = true;
	const q = cur;
	const unknown = idx < 0;
	const ok = !unknown && q.choices[idx] === q.answer;
	document.querySelectorAll('#choices .choice').forEach((b, i) => {
		b.disabled = true;
		const isAns = q.choices[i] === q.answer;
		if (isAns) b.classList.add('is-correct');
		else if (i === idx) { b.classList.add('is-wrong'); if (!REDUCED) b.classList.add('shake'); }
		else b.classList.add('is-dim');
	});
	settle(q, ok, unknown, null);
}

// まとめた問題：ぜんぶの項目が合っていたときだけ正解（ひとつでもまちがえたら、まちがい）
function answerSet(unknown) {
	if (locked || !cur || !cur.composite) return;
	if (!unknown && setSel.some(v => v === null)) return;
	locked = true;
	const q = cur;
	const oks = q.parts.map((p, i) => !unknown && p.choices[setSel[i]] === p.answer);
	const ok = oks.every(Boolean);
	document.querySelectorAll('#choices .pchip').forEach(b => {
		const i = Number(b.dataset.part), j = Number(b.dataset.c), p = q.parts[i];
		b.disabled = true;
		b.classList.remove('is-selected');
		if (p.choices[j] === p.answer) b.classList.add('is-correct');
		else if (!unknown && j === setSel[i]) { b.classList.add('is-wrong'); if (!REDUCED) b.classList.add('shake'); }
		else b.classList.add('is-dim');
	});
	const sub = document.querySelector('#choices .part-submit');
	if (sub) sub.hidden = true;
	settle(q, ok, unknown, oks);
}

// 「たまたま当たった」：正解にしていた答えを、まちがいに送る
function markLucky() {
	if (!locked || !cur || !session || session.results[cur.id] !== true) return;
	demoteResult(cur, 'lucky');
	session.results[cur.id] = false;
	saveSession();
	$('fx').innerHTML = '';
	showFeedback(cur, 'lucky');
	toast('まちがえた問題に入れました');
	$('next-btn').focus({ preventScroll: true });
}

function burst() {
	if (REDUCED) return;
	const fx = $('fx');
	fx.innerHTML = '';
	for (let i = 0; i < 12; i++) {
		const el = document.createElement('span');
		el.className = 'petal-fx';
		el.style.setProperty('--x', (8 + Math.random() * 84) + '%');
		el.style.setProperty('--dx', (Math.random() * 80 - 40) + 'px');
		el.style.setProperty('--rot', (Math.random() * 360 - 180) + 'deg');
		el.style.setProperty('--d', (i * 45) + 'ms');
		el.innerHTML = flower(BLOOMS[i % BLOOMS.length], 16);
		fx.appendChild(el);
	}
	setTimeout(() => { fx.innerHTML = ''; }, 1800);
}

function next() {
	if (!locked) return;
	if (runComplete(session)) finish(); else renderQuestion();
}

/* ============================== 結果 ============================== */
function finish() {
	const run = session;
	const printId = run.printId;
	const ids = run.ids;
	const isRetry = run.kind === 'retry';
	const correct = ids.filter(id => run.results[id] === true).length;
	const wrong = ids.filter(id => run.results[id] === false);
	const newCount = run.newIds.length;
	justTouched = new Set(run.newIds);
	delete runs[printId]; saveRuns();          // この一巡は、ここで終わり
	session = null;

	const print = DATA.prints.find(p => p.id === printId);
	const { touched, total } = coverage();
	const order = DATA.prints.map(p => p.id);
	const nextPrint = DATA.prints[(order.indexOf(printId) + 1) % order.length];
	const ratio = ids.length ? correct / ids.length : 0;
	const C = 2 * Math.PI * 60;
	const msg = isRetry
		? (wrong.length ? 'あと少し' : 'ぜんぶ解けました')
		: (ratio >= 0.9 ? 'かんぺき' : ratio >= 0.7 ? 'よくできました' : ratio >= 0.5 ? 'あと少し' : 'ここからのびます');
	const KINDS5 = ['sakura', 'ume', 'kiku', 'kikyo', 'tsubaki'];
	const bloomN = Math.round(ratio * 5);   // 正答率に応じて、5輪のうち何輪が咲くか
	const bloomRow = KINDS5.map((k, i) => i < bloomN ? flower(k, 46, 'bloom', `--d:${i * 120}ms`) : flower('bud', 46, 'wait')).join('');
	const WHY = { unknown: 'わからない', lucky: 'たまたま' };
	const wrongHTML = wrong.length ? `<details class="wrong-list" open><summary>まちがえた問題 ${wrong.length}問</summary><ul>${wrong.map(id => {
		const q = DATA.byId.get(id);
		const why = progress[id] && WHY[progress[id].why] ? `<span class="wl-why">${WHY[progress[id].why]}</span>` : '';
		const s = q.sentence ? `<p class="wl-s">${esc(plain(q.sentence))}</p>` : '';
		return `<li><p class="wl-ref">${esc(q.ref || '')}　${esc(q.tag)}${why}</p><p class="wl-q">${esc(q.prompt)}</p>${s}<p class="wl-a">正解は <b>${esc(q.answer)}</b></p></li>`;
	}).join('')}</ul></details>` : '';
	const lines = isRetry
		? `<p>まちがえた問題を、やり直しました</p><p>のこりのまちがい　<b>${wrong.length}</b>問</p>`
		: `<p>はじめて解いた問題　<b>${newCount}</b>問</p><p>ぜんぶで　<b>${touched}</b> / ${total}問に、ふれました</p>`;
	const retryBtn = wrong.length
		? `<button class="btn-sticker" id="retry-btn" type="button"><span class="btn-label">${isRetry ? 'もう一度、まちがえたところから' : 'まちがえたところから'}</span><span class="btn-count">${wrong.length}問</span></button>` : '';
	const nextBtn = wrong.length
		? `<button class="btn-ghost" id="again-btn" type="button">${esc(nextPrint.round)}　${esc(nextPrint.step)}へ</button>`
		: `<button class="btn-sticker" id="again-btn" type="button"><span class="btn-label">${esc(nextPrint.round)}　${esc(nextPrint.step)}へ</span><span class="btn-count">${nextPrint.questions.length}問</span></button>`;

	$('result-box').innerHTML = `
		<div class="result-hero">
			<p class="result-sub">${esc(print ? print.title : '')}　${isRetry ? 'まちがえた問題のやり直し' : 'ぜんぶ一巡しました'}</p>
			<div class="result-flowers" aria-hidden="true">${bloomRow}</div>
			<h2>${msg}</h2>
			<div class="score-ring">
				<svg viewBox="0 0 140 140" aria-hidden="true"><circle class="bg" cx="70" cy="70" r="60" fill="none" stroke-width="14"/><circle class="fg" id="ring-fg" cx="70" cy="70" r="60" fill="none" stroke-width="14" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${C.toFixed(1)}"/></svg>
				<div class="num"><span>${correct} / ${ids.length}</span><small>せいかい</small></div>
			</div>
			<div class="result-lines">${lines}</div>
		</div>
		<div class="result-rank" id="result-rank" aria-live="polite" hidden></div>
		${wrongHTML}
		<div class="result-actions">
			${retryBtn}${nextBtn}
			<button class="btn-ghost" id="home-btn" type="button">ホームにもどる</button>
		</div>`;
	show('result');
	if (wrong.length) $('retry-btn').addEventListener('click', () => startRetry(printId, wrong, (run.round || 0) + 1));
	$('again-btn').addEventListener('click', () => startStep(nextPrint.id));
	$('home-btn').addEventListener('click', goHome);
	requestAnimationFrame(() => requestAnimationFrame(() => {
		const fg = $('ring-fg');
		if (fg) fg.style.strokeDashoffset = (C * (1 - ratio)).toFixed(1);
	}));
	fillResultRank();
}

/* ============================== イベント ============================== */
function bindEvents() {
	$('rounds').addEventListener('click', e => {
		const r = e.target.closest('.step-retry');
		if (r) { startRetry(r.dataset.retry, null, 1); return; }
		const b = e.target.closest('.step-btn');
		if (b) startStep(b.dataset.print);
	});
	$('resume-btn').addEventListener('click', () => { const s = latestRun(); if (s) openRun(s); else renderHome(); });
	$('restart-btn').addEventListener('click', () => {
		const s = latestRun();
		if (!s) { renderHome(); return; }
		if (!window.confirm('この回を、はじめからやり直しますか？ここまでの進み具合は消えます（解いた記録は残ります）。')) return;
		startFresh(s.printId);
	});
	$('next-btn').addEventListener('click', next);
	$('dk-btn').addEventListener('click', giveUp);
	$('feedback').addEventListener('click', e => { if (e.target.closest('#lucky-btn')) markLucky(); });
	$('quit-btn').addEventListener('click', () => {
		const d = $('quit-dialog');
		if (typeof d.showModal === 'function') d.showModal();
		else if (window.confirm('ここでやめますか？ここまでの答えは保存されています。')) goHome();
	});
	$('quit-stay').addEventListener('click', () => $('quit-dialog').close());
	$('quit-go').addEventListener('click', () => { $('quit-dialog').close(); goHome(); });
	$('loading-retry').addEventListener('click', boot);
	$('rank-refresh').addEventListener('click', () => loadRanking(true));
	$('rank-body').addEventListener('click', e => { if (e.target.closest('[data-rank-retry]')) loadRanking(true); });
	$('rank-note').addEventListener('click', e => { if (e.target.closest('#rank-link')) { e.preventDefault(); openPortalCard(); } });

	window.addEventListener('online', () => {
		syncOfflineChip();
		if (view === 'home') loadRanking(true);
		else if (view === 'result') fillResultRank();
	});
	window.addEventListener('offline', syncOfflineChip);
	syncOfflineChip();

	document.addEventListener('keydown', e => {
		if (view !== 'quiz' || e.ctrlKey || e.metaKey || e.altKey) return;
		if (document.querySelector('dialog[open]')) return;
		if (/^[1-9]$/.test(e.key) && !locked) {
			const i = Number(e.key) - 1;
			if (cur && !cur.composite && i < cur.choices.length) { e.preventDefault(); choose(i); }
		} else if (e.key === '0' && !locked) {
			e.preventDefault(); giveUp();
		} else if (e.key === 'Enter' && !locked && cur && cur.composite && !setSel.some(v => v === null) && !(e.target.closest && e.target.closest('button'))) {
			e.preventDefault(); answerSet(false);
		} else if (e.key === 'Enter' && locked && !(e.target.closest && e.target.closest('button'))) {
			e.preventDefault(); next();
		}
	});
}

/* ============================== テンシ ポータル連携 ============================== */
const PORTAL_KEY_HASH = /^#portal-link=([0-9A-Fa-f-]{8,64})$/;

function openPortalCard() {
	if (view === 'quiz' || view === 'result') goHome();
	const card = $('portal-card');
	card.hidden = false;
	setTimeout(() => {
		card.scrollIntoView({ behavior: REDUCED ? 'auto' : 'smooth', block: 'center' });
		const input = document.querySelector('#portal-link input');
		if (input) input.focus({ preventScroll: true });
	}, 250);
}

async function runPortalLinkDialog(key) {
	const dialog = $('portal-confirm');
	const text = $('portal-confirm-text');
	const ok = $('portal-confirm-ok');
	const cancel = $('portal-confirm-cancel');
	const defaultMessage = 'テンシ ポータルと連携しますか？ 送られるのは日ごとの回答数だけで、ポータルのランキングに反映されます。';
	const statusPromise = window.PortalClient.linkStatus().catch(error => {
		console.error('連携の状態を確認できませんでした。', error);
		return null;
	});
	const linkedMessage = status => status && status.linked
		? `この端末はすでに「${status.nickname || ''}」として連携しています。このキーで連携し直しますか？`
		: defaultMessage;
	if (typeof dialog.showModal !== 'function') {
		if (!window.confirm(linkedMessage(await statusPromise))) return;
		try {
			await window.PortalClient.link(key);
			window.PortalClient.syncNow();
			window.alert('連携しました。ポータルに戻って、画面を更新してください。');
		} catch (error) {
			window.alert(`連携できませんでした：${error.message}`);
		}
		return;
	}
	let busy = false;
	text.textContent = defaultMessage;
	ok.hidden = false; ok.disabled = true; ok.textContent = '連携する';
	cancel.disabled = false; cancel.textContent = 'キャンセル';
	statusPromise.then(status => {
		if (busy || !dialog.open) return;
		text.textContent = linkedMessage(status);
		ok.disabled = false;
	});
	await new Promise(resolve => {
		const finishDialog = () => {
			dialog.removeEventListener('close', finishDialog);
			ok.onclick = null; cancel.onclick = null;
			resolve();
		};
		dialog.addEventListener('close', finishDialog);
		cancel.onclick = () => dialog.close();
		ok.onclick = async () => {
			busy = true;
			ok.disabled = true; cancel.disabled = true;
			text.textContent = '連携しています…';
			try {
				const result = await window.PortalClient.link(key);
				window.PortalClient.syncNow();
				text.textContent = `連携しました（${(result && result.nickname) || ''}）。ポータルに戻って、画面を更新してください。`;
				ok.hidden = true;
				cancel.textContent = '閉じる';
			} catch (error) {
				text.textContent = `連携できませんでした：${error.message}`;
				ok.disabled = false; ok.textContent = 'もう一度';
			}
			cancel.disabled = false;
		};
		dialog.showModal();
	});
}

async function handlePortalHash() {
	const match = PORTAL_KEY_HASH.exec(location.hash);
	if (match) {
		const key = match[1];
		history.replaceState(null, '', location.pathname + location.search);   // キーをURLに残さない
		try {
			await runPortalLinkDialog(key);
		} catch (error) {
			console.error('ポータル連携の確認画面でエラーが出ました。', error);
			window.alert(`ポータル連携を始められませんでした：${error.message}`);
		}
		return;
	}
	if (location.hash === '#portal-link') openPortalCard();
}

function initPortal() {
	try {
		if (!window.PortalClient) throw new Error('portal-client.js を読み込めませんでした。');
		window.PortalClient.init({
			url: window.PORTAL_SUPABASE_URL,
			key: window.PORTAL_SUPABASE_PUBLISHABLE_KEY,
			site: 'kobunbunpou',
			syncRpc: 'kobunbunpou_sync_daily',
			rankRpc: 'kobunbunpou_get_ranking',
			getDailyCounts: async () => loadDaily()
		});
		window.PortalClient.mountLinkBox('#portal-link');
		window.addEventListener('hashchange', handlePortalHash);
		handlePortalHash();
	} catch (error) {
		console.error('ポータル連携を開始できませんでした。', error);
		$('portal-card').hidden = true;
		if (location.hash.startsWith('#portal-link')) {
			history.replaceState(null, '', location.pathname + location.search);
			window.alert(`ポータル連携を開始できませんでした：${error.message}`);
		}
	}
}

/* ============================== ランキング ============================== */
// ポータルの kobunbunpou_get_ranking を呼んで表示する。
// ・「あなたの順位」（通算・今日の、順位／人数／ひとつ上との差）は、ポータルと連携していなくても出す（匿名のまま、日ごとの回答数だけで数える）
// ・ランキング表（名前つき）は、ポータルに連携した人だけが載る
// ・返ってくる形が多少ちがっても動くように、ゆるく読み取る。最後に取れた順位は保存して、オフラインでも見せる。
const RANK = { at: 0, busy: false, shown: false };
const RANK_SHOW = 10;
const RANK_NAME_KEYS = ['nickname', 'name', 'display_name', 'user_name', 'username', 'handle'];
const RANK_VALUE_KEYS = [['total', '問'], ['count', '問'], ['answers', '問'], ['answer_count', '問'], ['total_count', '問'], ['total_answers', '問'],
	['n', '問'], ['cnt', '問'], ['sum', '問'], ['score', '問'], ['points', 'pt'], ['streak', '日'], ['days', '日']];

const portalReady = () => !!(window.PortalClient && window.PortalClient.state && window.PortalClient.state.enabled);

function rankNum(v) {
	const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
	return typeof n === 'number' && isFinite(n) ? n : null;
}
function rankRows(raw) {
	if (Array.isArray(raw)) return raw;
	if (raw && typeof raw === 'object') {
		for (const k of ['ranking', 'rows', 'items', 'entries', 'top', 'leaderboard', 'list', 'data', 'results']) {
			if (Array.isArray(raw[k])) return raw[k];
		}
	}
	return [];
}
function rankRow(r, i) {
	if (!r || typeof r !== 'object') return null;
	let name = '';
	for (const k of RANK_NAME_KEYS) { if (typeof r[k] === 'string' && r[k].trim()) { name = r[k].trim(); break; } }
	let value = null, unit = '';
	for (const [k, u] of RANK_VALUE_KEYS) { const n = rankNum(r[k]); if (n !== null) { value = n; unit = u; break; } }
	const rank = rankNum(r.rank !== undefined ? r.rank : r.position !== undefined ? r.position : r.place !== undefined ? r.place : r.rnk);
	const me = [r.is_me, r.me, r.mine, r.is_self, r.self, r.is_you].some(v => v === true);
	return { rank: rank !== null ? rank : i + 1, name: name || 'ななし', value, unit, me };
}
function normalizeRanking(raw, nickname) {
	const rows = rankRows(raw).map(rankRow).filter(Boolean);
	let meRow = rows.find(r => r.me) || null;
	if (!meRow && raw && !Array.isArray(raw) && typeof raw === 'object') {
		const m = rankRow(raw.me || raw.self || raw.mine || raw.you, rows.length);
		if (m && (raw.me || raw.self || raw.mine || raw.you) && typeof (raw.me || raw.self || raw.mine || raw.you) === 'object') { m.me = true; meRow = m; }
	}
	if (!meRow && nickname) {
		meRow = rows.find(r => r.name === nickname) || null;
		if (meRow) meRow.me = true;
	}
	return { rows, meRow };
}

/* ---- あなたの順位（通算・今日） ---- */
function pickBlock(raw, keys) {
	if (!raw || typeof raw !== 'object') return null;
	for (const k of keys) { const b = raw[k]; if (b && typeof b === 'object' && !Array.isArray(b)) return b; }
	return null;
}
function normBlock(b) {
	if (!b) return null;
	const answers = rankNum(b.answers !== undefined ? b.answers : b.total !== undefined ? b.total : b.count);
	const rank = rankNum(b.rank);
	if (answers === null && rank === null) return null;
	const participants = rankNum(b.participants !== undefined ? b.participants : b.total_participants);
	const gap = rankNum(b.gap !== undefined ? b.gap : b.diff);
	const tied = rankNum(b.tied);
	return { answers: answers === null ? 0 : answers, rank, participants, gap, tied: tied === null ? 0 : tied };
}
// 取れた形から「あなたの順位」を読み取る。{ daily, allTime } のほか、名前つきの表に自分の行がある形も読む
function mineFrom(raw, rows, meRow) {
	const mine = {
		hidden: !!(raw && !Array.isArray(raw) && raw.hidden),
		daily: normBlock(pickBlock(raw, ['daily', 'today'])),
		allTime: normBlock(pickBlock(raw, ['allTime', 'all_time', 'alltime', 'overall']))
	};
	if (!mine.allTime && meRow && meRow.value !== null && meRow.unit === '問') {
		const above = rows.filter(r => r.value !== null && r.value > meRow.value && r.rank < meRow.rank)
			.sort((a, b) => a.value - b.value)[0];
		const participants = raw && !Array.isArray(raw) ? rankNum(raw.participants !== undefined ? raw.participants : raw.total_participants) : null;
		mine.allTime = { answers: meRow.value, rank: meRow.rank, participants, gap: above ? above.value - meRow.value : null, tied: 0 };
	}
	return mine;
}
function ago(ms) {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return 'たったいま';
	if (s < 3600) return Math.floor(s / 60) + '分前';
	if (s < 86400) return Math.floor(s / 3600) + '時間前';
	return Math.floor(s / 86400) + '日前';
}
const fmt = n => Number(n).toLocaleString('ja-JP');
function mineColHTML(title, b) {
	if (!b || !(b.answers > 0)) return `<div class="mr-col"><p class="mr-title">${title}</p><p class="mr-empty">まだ解いていません</p></div>`;
	const rank = b.rank !== null
		? `<p class="mr-rank"><b>${fmt(b.rank)}</b>位${b.participants ? `<small>／ ${fmt(b.participants)}人中</small>` : ''}</p>`
		: '<p class="mr-rank"><b>—</b></p>';
	let gap;
	if (b.rank === 1) gap = '<p class="mr-gap top">いま1位です</p>';
	else if (b.gap !== null && b.gap > 0) gap = `<p class="mr-gap"><span>1つ上まで</span> <span class="nw">あと <b>${fmt(b.gap)}</b>問</span></p>`;
	else gap = '<p class="mr-gap">1つ上との差は、まだ出せません</p>';
	const tied = b.tied > 1 ? `<p class="mr-sub">同じ記録の人が ${fmt(b.tied)}人</p>` : '';
	return `<div class="mr-col"><p class="mr-title">${title}</p>${rank}${gap}<p class="mr-sub">解いた問題　${fmt(b.answers)}問</p>${tied}</div>`;
}
function renderMine(el, mine, opt) {
	opt = opt || {};
	if (!mine || (!mine.daily && !mine.allTime)) {
		el.innerHTML = `<p class="mr-msg">${mine && mine.hidden ? 'いまランキングには表示されていません。ポータルで確認してください。' : 'あなたの順位を取得できませんでした。'}</p>`;
		return;
	}
	const stale = opt.stale ? `<p class="mr-stale">オフラインのため、最後に取れた順位を表示しています（${esc(ago(opt.at))}）。</p>` : '';
	el.innerHTML = `<div class="myrank">${mineColHTML('通算', mine.allTime)}${mineColHTML('今日', mine.daily)}</div>${stale}`;
}

/* ---- ランキング表（名前つき） ---- */
function rankRowHTML(r, delay) {
	const top = r.rank >= 1 && r.rank <= 3;
	const val = r.value !== null ? `<span class="rank-val">${esc(r.value.toLocaleString('ja-JP'))}<small>${esc(r.unit)}</small></span>` : '<span></span>';
	return `<li class="rank-row${top ? ' top' : ''}${r.me ? ' me' : ''}" style="--d:${delay}ms">
		<span class="rank-no">${esc(r.rank)}</span>
		<span class="rank-name">${top ? flower(TOP_FLOWERS[r.rank - 1], 24) : ''}<span class="rank-nm">${esc(r.name)}</span>${r.me ? '<span class="rank-me">あなた</span>' : ''}</span>
		${val}
	</li>`;
}
function renderRanking({ rows, meRow }) {
	const body = $('rank-body');
	if (!rows.length) {
		body.innerHTML = `<div class="rank-msg">${flower('bud', 34)}<p>名前つきでランキングに載っている人は、まだいません。</p></div>`;
		return;
	}
	const shown = rows.slice(0, RANK_SHOW);
	let html = shown.map((r, i) => rankRowHTML(r, REDUCED ? 0 : i * 40)).join('');
	if (meRow && !shown.some(r => r.me)) {
		html += `<li class="rank-gap" aria-hidden="true">・・・</li>` + rankRowHTML(meRow, shown.length * 40);
	}
	body.innerHTML = `<ol class="rank-list">${html}</ol>`;
}
function renderRankNote(status) {
	const note = $('rank-note');
	if (status && status.linked && status.banned) {
		note.textContent = 'いま、あなたはランキング表に表示されていません。ポータルで確認してください。';
		note.hidden = false;
	} else if (status && status.linked === false) {
		note.innerHTML = '順位は、ポータルと連携しなくても見られます。<a href="#portal-link" id="rank-link">連携する</a>と、名前つきでランキング表に載ります。';
		note.hidden = false;
	} else {
		note.hidden = true;
	}
}

/* ---- 取得・保存 ---- */
async function fetchRanking() {
	const [raw, status] = await Promise.all([
		window.PortalClient.ranking(),
		window.PortalClient.linkStatus().catch(() => null)
	]);
	console.log('[ranking] raw response', raw);
	const { rows, meRow } = normalizeRanking(raw, status && status.linked ? status.nickname : '');
	const data = {
		at: Date.now(), rows: rows.slice(0, RANK_SHOW), meRow, mine: mineFrom(raw, rows, meRow),
		status: status ? { linked: status.linked, banned: status.banned } : null
	};
	try { writeJSON(KEYS.rank, data); } catch (e) { /* 保存できなくても表示は続ける */ }
	return data;
}
function readRankCache() {
	const c = readJSON(KEYS.rank, null);
	return c && typeof c === 'object' && c.mine && Array.isArray(c.rows) ? c : null;
}
function paintRanking(d, stale) {
	renderMine($('rank-mine'), d.mine, { stale, at: d.at });
	renderRanking({ rows: d.rows || [], meRow: d.meRow || null });
	renderRankNote(stale ? null : d.status);
}
async function loadRanking(force) {
	const card = $('ranking-card');
	if (!portalReady()) { card.hidden = true; return; }
	card.hidden = false;
	if (RANK.busy) return;
	if (!force && RANK.shown && Date.now() - RANK.at < 15000) return;
	const body = $('rank-body');
	const btn = $('rank-refresh');
	const cached = readRankCache();
	if (navigator.onLine === false) {
		if (cached) { paintRanking(cached, true); RANK.shown = true; }
		else {
			$('rank-mine').innerHTML = '';
			body.innerHTML = `<div class="rank-msg">${flower('bud', 34)}<p>オフラインのため、順位は表示できません。オンラインに戻ると表示します。</p></div>`;
		}
		return;
	}
	RANK.busy = true;
	btn.disabled = true;
	if (!RANK.shown) {
		if (cached) paintRanking(cached, false);
		else {
			$('rank-mine').innerHTML = '';
			body.innerHTML = '<div class="rank-skel"></div><div class="rank-skel"></div><div class="rank-skel"></div>';
		}
	}
	try {
		const d = await fetchRanking();
		paintRanking(d, false);
		RANK.shown = true; RANK.at = Date.now();
	} catch (e) {
		const offline = navigator.onLine === false || /オフライン/.test(String(e && e.message));
		(offline ? console.warn : console.error)('ランキングを読み込めませんでした。', e);
		if (cached) { paintRanking(cached, offline); RANK.shown = true; if (!offline) toast('ランキングを更新できませんでした'); }
		else if (!RANK.shown) {
			$('rank-mine').innerHTML = '';
			body.innerHTML = `<div class="rank-msg">${flower('bud', 34)}<p>${offline ? 'オフラインのため、順位は表示できません。オンラインに戻ると表示します。' : 'ランキングを読み込めませんでした。'}</p>${offline ? '' : '<button class="btn-ghost" type="button" data-rank-retry>もう一度ためす</button>'}</div>`;
		} else {
			toast('ランキングを更新できませんでした');
		}
	} finally {
		RANK.busy = false;
		btn.disabled = false;
	}
}
// 結果の画面に、あなたの順位を出す（オフラインなら、最後に取れた順位。オンラインに戻ったら自動で更新）
async function fillResultRank() {
	const el = $('result-rank');
	if (!el) return;
	if (!portalReady()) { el.hidden = true; return; }
	el.hidden = false;
	const cached = readRankCache();
	if (navigator.onLine === false) {
		if (cached) renderMine(el, cached.mine, { stale: true, at: cached.at });
		else el.innerHTML = '<p class="mr-msg">オフラインのため、順位は表示できません。オンラインに戻ると表示します。</p>';
		return;
	}
	if (!cached) el.innerHTML = '<p class="mr-msg">順位を確認しています…</p>';
	else renderMine(el, cached.mine, {});
	try {
		const d = await fetchRanking();
		if (el.isConnected) renderMine(el, d.mine, {});
	} catch (e) {
		if (!el.isConnected) return;
		const offline = navigator.onLine === false || /オフライン/.test(String(e && e.message));
		if (cached) renderMine(el, cached.mine, { stale: offline, at: cached.at });
		else el.innerHTML = `<p class="mr-msg">${offline ? 'オフラインのため、順位は表示できません。オンラインに戻ると表示します。' : '順位を確認できませんでした。'}</p>`;
	}
}
function syncOfflineChip() {
	const c = $('offline-chip');
	if (c) c.hidden = navigator.onLine !== false;
}

/* ============================== 起動 ============================== */
async function boot() {
	show('loading');
	$('loading-retry').hidden = true;
	$('loading-title').textContent = '問題を準備しています';
	$('loading-sub').textContent = 'はじめだけ、すべての問題をダウンロードします。あとは、オフラインでも解けます。';
	$('loading-fill').style.width = '8%';

	const cached = readJSON(KEYS.data, null);
	if (isValidRaw(cached)) {
		DATA = buildIndex(cached);
		migrateParts();
		migrateOldSession();
		renderHome(); show('home');
		checkForUpdate(cached.version);
		return;
	}
	try {
		const raw = await downloadAll((d, t) => { $('loading-fill').style.width = Math.max(8, Math.round(d / t * 100)) + '%'; });
		saveData(raw);
		DATA = buildIndex(raw);
		migrateParts();
		migrateOldSession();
		renderHome(); show('home');
	} catch (e) {
		console.error(e);
		$('loading-title').textContent = '問題をダウンロードできませんでした';
		$('loading-sub').textContent = 'ネットワークにつながっているか、確かめてください。';
		$('loading-retry').hidden = false;
	}
}

$('loading-mascot').innerHTML = flower('sakura', 72);
bindEvents();
initPortal();
boot();
})();
