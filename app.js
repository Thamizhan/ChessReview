import { Chess } from './vendor/chess.mjs';

/* ═══════════════ settings ═══════════════ */
const DEFAULTS = {
  username: '', depth: 12,
  provider: 'anthropic', model: 'claude-sonnet-4-6', baseurl: '',
  keys: {}, voiceURI: '',
};
const MODEL_DEFAULTS = {
  anthropic: 'claude-sonnet-4-6', openai: 'gpt-4o-mini',
  gemini: 'gemini-2.0-flash', openrouter: 'anthropic/claude-sonnet-4.5', custom: '',
};
let settings = loadSettings();
function loadSettings() {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem('rr_settings')) || {}) }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings() { localStorage.setItem('rr_settings', JSON.stringify(settings)); }

/* ═══════════════ state ═══════════════ */
function loadLibrary() {
  try { return JSON.parse(localStorage.getItem('rr_library')) || []; }
  catch { return []; }
}
function saveLibrary() {
  try { localStorage.setItem('rr_library', JSON.stringify(games)); }
  catch (e) { console.warn('Could not save game library (storage full?):', e.message); }
}
let games = loadLibrary();   // persisted game library, newest first
let cur = null;            // current review session
const $ = (id) => document.getElementById(id);

/* ═══════════════ PGN parsing ═══════════════ */
function splitPgn(text) {
  return text.replace(/\r/g, '').split(/\n\n(?=\[Event)/).map(s => s.trim()).filter(Boolean);
}
function parseGames(text) {
  const out = [];
  for (const chunk of splitPgn(text)) {
    try {
      const c = new Chess();
      c.loadPgn(chunk);
      const h = c.header();
      const hist = c.history({ verbose: true });
      if (!hist.length) continue;
      out.push({
        pgn: chunk, headers: h, moves: hist,
        hash: djb2(hist.map(m => m.lan).join(' ') + (h.Date || '') + (h.EndTime || '')),
      });
    } catch (e) { console.warn('Skipped one game:', e.message); }
  }
  return out;
}
function djb2(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0; return h.toString(36); }

function youSide(g) {
  const u = (settings.username || '').toLowerCase();
  if (!u) return null;
  if ((g.headers.White || '').toLowerCase() === u) return 'w';
  if ((g.headers.Black || '').toLowerCase() === u) return 'b';
  return null;
}

/* ═══════════════ library UI ═══════════════ */
function renderLibrary() {
  const wrap = $('game-list-wrap'), list = $('game-list');
  if (!games.length) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $('list-meta').textContent = `${games.length} game${games.length > 1 ? 's' : ''}`;
  list.innerHTML = '';
  games.forEach((g, i) => {
    const h = g.headers, side = youSide(g);
    const res = h.Result || '*';
    let chip = 'd', chipTxt = '½';
    if (res === '1-0' || res === '0-1') {
      const whiteWon = res === '1-0';
      if (side) { const won = (side === 'w') === whiteWon; chip = won ? 'w' : 'l'; chipTxt = won ? 'W' : 'L'; }
      else { chip = 'w'; chipTxt = whiteWon ? '1-0' : '0-1'; }
    }
    const opp = side ? (side === 'w' ? h.Black : h.White) : `${h.White} vs ${h.Black}`;
    const oppElo = side ? (side === 'w' ? h.BlackElo : h.WhiteElo) : '';
    const youElo = side ? (side === 'w' ? h.WhiteElo : h.BlackElo) : '';
    const scoreTxt = side ? `You ${youElo || '?'} · ${side === 'w' ? 'White' : 'Black'}  vs  ${oppElo || '?'}` : `${h.WhiteElo || '?'} vs ${h.BlackElo || '?'}`;
    const when = [h.Date, h.EndTime ? h.EndTime.replace(/GMT.*/, '').trim() : ''].filter(Boolean).join(' · ');
    const cached = localStorage.getItem('rr_an_' + g.hash + '_d' + settings.depth) ? '<span class="analyzed">✓ analyzed</span>' : '';
    const li = document.createElement('li');
    li.innerHTML = `<button class="game-row" data-i="${i}">
        <span class="res-chip ${chip}">${chipTxt}</span>
        <span class="g-main"><span class="g-opp">${esc(side ? 'vs ' + opp : opp)}</span>
        <span class="g-detail">${esc(scoreTxt)} · ${esc(res)}</span></span>
        <span class="g-right">${esc(when)}${cached}</span></button>`;
    li.querySelector('button').addEventListener('click', () => openGame(i));
    list.appendChild(li);
  });
}
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function loadPgnText(text) {
  const parsed = parseGames(text);
  if (!parsed.length) { alert('No valid games found in that PGN.'); return; }
  const existingHashes = new Set(games.map(g => g.hash));
  const newGames = parsed.filter(g => !existingHashes.has(g.hash));
  if (newGames.length) { games = [...newGames, ...games]; saveLibrary(); }
  renderLibrary();
  if (parsed.length === 1) {
    openGame(games.findIndex(g => g.hash === parsed[0].hash));
    return;
  }
  $('game-list-wrap').scrollIntoView({ behavior: 'smooth' });
}

/* ═══════════════ engine ═══════════════ */
let engine = null, engineReady = null;
function getEngine() {
  if (engine) return engineReady;
  engine = new Worker('vendor/stockfish.js');
  engineReady = new Promise((res, rej) => {
    const onMsg = (e) => {
      if (String(e.data).includes('uciok')) {
        engine.postMessage('setoption name MultiPV value 2');
        engine.removeEventListener('message', onMsg);
        res();
      }
    };
    engine.addEventListener('message', onMsg);
    engine.addEventListener('error', (e) => {
      const msg = 'Stockfish engine failed to load: ' + (e.message || 'unknown worker error') + '.\nCheck that vendor/stockfish.js and vendor/stockfish.wasm are being served (not opened via file://).';
      console.error('[Review Room] ' + msg, e);
      window.__rrBootError?.(msg);
      rej(new Error(msg));
    });
    engine.postMessage('uci');
  });
  return engineReady;
}

function analysePosition(fen, depth) {
  return new Promise(resolve => {
    const lines = {};
    const onMsg = (e) => {
      const t = String(e.data);
      if (t.startsWith('info') && t.includes(' pv ')) {
        const mpv = /multipv (\d+)/.exec(t)?.[1] || '1';
        const cp = /score cp (-?\d+)/.exec(t);
        const mate = /score mate (-?\d+)/.exec(t);
        const pv = t.split(' pv ')[1].trim().split(' ');
        lines[mpv] = { cp: cp ? +cp[1] : null, mate: mate ? +mate[1] : null, pv };
      } else if (t.startsWith('bestmove')) {
        engine.removeEventListener('message', onMsg);
        resolve(lines);
      }
    };
    engine.addEventListener('message', onMsg);
    engine.postMessage('position fen ' + fen);
    engine.postMessage(`go depth ${depth}`);
  });
}

/* score → white-POV centipawns (+huge for mate) */
function toWhiteCp(line, stmIsWhite) {
  if (!line) return { cp: 0, mate: null };
  let cp, mate = null;
  if (line.mate !== null) { mate = line.mate; cp = Math.sign(line.mate) * (10000 - Math.abs(line.mate)); }
  else cp = line.cp;
  if (!stmIsWhite) { cp = -cp; if (mate !== null) mate = -mate; }
  return { cp, mate };
}
const winPct = (cp) => 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * Math.max(-4000, Math.min(4000, cp)))) - 1);

/* ═══════════════ analysis pipeline ═══════════════ */
let cancelAnalysis = false;
async function analyseGame(g) {
  const key = 'rr_an_' + g.hash + '_d' + settings.depth;
  const cached = localStorage.getItem(key);
  if (cached) { try { return JSON.parse(cached); } catch { } }

  $('analyze-overlay').hidden = false;
  cancelAnalysis = false;
  try {
    await getEngine();
  } catch (err) {
    $('analyze-overlay').hidden = true;
    return null;
  }

  const c = new Chess();
  const fens = [c.fen()];
  for (const m of g.moves) { c.move(m.san); fens.push(c.fen()); }

  const pos = [];
  for (let i = 0; i < fens.length; i++) {
    if (cancelAnalysis) { $('analyze-overlay').hidden = true; return null; }
    const stmWhite = fens[i].split(' ')[1] === 'w';
    const raw = await analysePosition(fens[i], settings.depth);
    const l1 = raw['1'], l2 = raw['2'];
    const s1 = toWhiteCp(l1, stmWhite), s2 = l2 ? toWhiteCp(l2, stmWhite) : null;
    pos.push({
      fen: fens[i],
      cp: s1.cp, mate: s1.mate, best: l1?.pv?.[0] || null, pv: (l1?.pv || []).slice(0, 8),
      cp2: s2 ? s2.cp : null, best2: l2?.pv?.[0] || null,
    });
    $('progress-fill').style.width = Math.round((i + 1) / fens.length * 100) + '%';
    $('an-sub').textContent = `Position ${i + 1} of ${fens.length}`;
  }
  $('analyze-overlay').hidden = true;
  const result = { depth: settings.depth, pos };
  try { localStorage.setItem(key, JSON.stringify(result)); } catch { pruneCache(); try { localStorage.setItem(key, JSON.stringify(result)); } catch { } }
  return result;
}
function pruneCache() {
  const ks = Object.keys(localStorage).filter(k => k.startsWith('rr_an_'));
  ks.slice(0, Math.ceil(ks.length / 2)).forEach(k => localStorage.removeItem(k));
}

/* ═══════════════ verdicts & coaching ═══════════════ */
const VERDICTS = {
  brilliant: { label: 'Brilliant', glyph: '!!', color: 'var(--brilliant)' },
  great: { label: 'Great move', glyph: '!', color: 'var(--great)' },
  best: { label: 'Best move', glyph: '★', color: 'var(--best)' },
  excellent: { label: 'Excellent', glyph: '✓', color: 'var(--excellent)' },
  good: { label: 'Good', glyph: '✓', color: 'var(--good)' },
  inaccuracy: { label: 'Inaccuracy', glyph: '?!', color: 'var(--inaccuracy)' },
  mistake: { label: 'Mistake', glyph: '?', color: 'var(--mistake)' },
  miss: { label: 'Missed win', glyph: '✗', color: 'var(--miss)' },
  blunder: { label: 'Blunder', glyph: '??', color: 'var(--blunder)' },
};

function classifyAll(g, an) {
  const out = [];
  for (let i = 0; i < g.moves.length; i++) {
    const mv = g.moves[i], before = an.pos[i], after = an.pos[i + 1];
    const mover = mv.color;
    const povB = mover === 'w' ? before.cp : -before.cp;
    const povA = mover === 'w' ? after.cp : -after.cp;
    const wB = winPct(povB), wA = winPct(povA);
    const diff = Math.max(0, wB - wA);
    const isBest = before.best && mv.lan.startsWith(before.best.slice(0, 4)) && (before.best.length <= 4 || mv.lan === before.best);

    const mateForBefore = before.mate !== null && (mover === 'w' ? before.mate > 0 : before.mate < 0);
    const mateForAfter = after.mate !== null && (mover === 'w' ? after.mate > 0 : after.mate < 0);
    const mateAgainstAfter = after.mate !== null && (mover === 'w' ? after.mate < 0 : after.mate > 0);

    let v;
    if (isBest) {
      v = 'best';
      if (before.cp2 !== null) {
        const gap = winPct(mover === 'w' ? before.cp : -before.cp) - winPct(mover === 'w' ? before.cp2 : -before.cp2);
        if (gap >= 18 && wA >= 45) v = 'great';
      }
      if (isSacrifice(before.fen, mv) && wA >= 45) v = 'brilliant';
    }
    else if (mateForBefore && !mateForAfter && povB >= 500) v = 'miss';
    else if (diff < 2) v = 'excellent';
    else if (diff < 5) v = 'good';
    else if (diff < 10) v = 'inaccuracy';
    else if (diff < 20) v = 'mistake';
    else v = 'blunder';
    if (mateAgainstAfter && !['best', 'great', 'brilliant'].includes(v) && povB > -800) v = 'blunder';

    out.push({ verdict: v, diff, wB, wA, povB, povA, mateAgainstAfter, mateForBefore });
  }
  return out;
}

function isSacrifice(fen, mv) {
  const val = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
  const gave = val[mv.piece], got = mv.captured ? val[mv.captured] : 0;
  if (gave < 3 || got >= gave) return false;
  const c = new Chess(fen); c.move(mv.san);
  return c.moves({ verbose: true }).some(r => r.to === mv.to && val[r.piece] <= gave);
}

function pvToSan(fen, pvUci, max = 5) {
  const c = new Chess(fen); const out = [];
  for (const u of pvUci.slice(0, max)) {
    try {
      const m = c.move({ from: u.slice(0, 2), to: u.slice(2, 4), promotion: u[4] });
      out.push(m.san);
    } catch { break; }
  }
  return out;
}
function uciSan(fen, uci) { return pvToSan(fen, [uci], 1)[0] || uci; }

function evalText(p) {
  if (p.mate !== null) return (p.mate > 0 ? '+M' : '-M') + Math.abs(p.mate);
  return (p.cp >= 0 ? '+' : '') + (p.cp / 100).toFixed(1);
}

function pieceName(sym) { return { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }[sym] || sym; }

/* Coach commentary — templated, in plain words */
function coachFor(g, an, cls, i) {
  const mv = g.moves[i], before = an.pos[i], after = an.pos[i + 1], c = cls[i];
  const you = youSide(g) === mv.color;
  const who = you ? 'You' : 'Your opponent';
  const bestSan = before.best ? uciSan(before.fen, before.best) : null;
  const line = before.pv?.length ? pvToSan(before.fen, before.pv, 6).join(' ') : '';
  const V = c.verdict;

  if (['brilliant', 'great', 'best'].includes(V)) {
    const praise = V === 'brilliant' ? `${who} found a brilliant idea — giving up material for a bigger gain that pays off. The strongest move on the board.`
      : V === 'great' ? `${who} found the only strong move here; everything else loses ground.`
        : `${bestSan || mv.san} was the strongest move here. ${you ? 'Well spotted.' : ''}`;
    return { text: praise, line };
  }
  if (V === 'excellent' || V === 'good') {
    return { text: `${mv.san} is a solid, healthy move. ${bestSan && bestSan !== mv.san ? `${bestSan} was a touch stronger, but it's a close call.` : ''}`, line };
  }

  // What went wrong
  const bits = [];
  if (c.mateAgainstAfter) bits.push(`after ${mv.san}, the opponent has a forced checkmate in ${Math.abs(after.mate)}`);
  if (c.verdict === 'miss') bits.push(`${you ? 'you' : 'your opponent'} had a forced checkmate available and let it slip`);

  // does the engine's reply win material?
  const reply = after.best;
  if (reply) {
    const cAfter = new Chess(after.fen);
    const rm = cAfter.moves({ verbose: true }).find(m => m.lan.startsWith(reply.slice(0, 4)));
    if (rm && rm.captured) {
      if (rm.to === mv.to) bits.push(`the ${pieceName(mv.piece)} you just moved to ${mv.to} can simply be taken by ${rm.san}`);
      else bits.push(`it leaves the ${pieceName(rm.captured)} on ${rm.to} hanging — ${rm.san} wins it`);
    }
  }
  // was best move a capture / mate?
  if (bestSan) {
    const cb = new Chess(before.fen);
    const bm = cb.moves({ verbose: true }).find(m => m.lan.startsWith(before.best.slice(0, 4)));
    if (c.mateForBefore && before.mate !== null) bits.push(`${bestSan} led to forced mate in ${Math.abs(before.mate)}`);
    else if (bm && bm.captured) bits.push(`${bestSan} was available, winning the ${pieceName(bm.captured)} on ${bm.to}`);
  }

  const sev = V === 'blunder' ? 'This one really hurts.' : V === 'mistake' ? 'A real slip.' : 'A small step in the wrong direction.';
  const why = bits.length ? capitalize(bits.join('; ')) + '.' : "It wasn't the strongest continuation here — it let some of the advantage slip away.";
  const instead = bestSan ? ` Instead, ${bestSan} keeps ${you ? 'you' : 'your opponent'} on track.` : '';
  const habit = you && (V === 'blunder' || V === 'mistake')
    ? ' Before every move, ask: what is the opponent\'s best check, capture, or threat in reply?' : '';
  return { text: `${sev} ${why}${instead}${habit}`, line };
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ═══════════════ review session ═══════════════ */
async function openGame(i) {
  if (!settings.username.trim()) {
    openSettings();
    const hint = $('username-hint');
    hint.textContent = 'Set your username first — this tells the coach which side is you.';
    hint.classList.add('hint-warn');
    $('set-username').focus();
    return;
  }
  const g = games[i];
  showScreen('review');
  const h = g.headers;
  $('rev-players').textContent = `${h.White} (${h.WhiteElo || '?'}) vs ${h.Black} (${h.BlackElo || '?'})`;
  $('rev-sub').textContent = [h.Date, h.Result, h.Termination].filter(Boolean).join(' · ');

  const an = await analyseGame(g);
  if (!an) { showScreen('library'); return; }
  const cls = classifyAll(g, an);

  const c = new Chess();
  const fens = [c.fen()];
  for (const m of g.moves) { c.move(m.san); fens.push(c.fen()); }

  cur = {
    g, an, cls, fens, ply: 0,
    orient: youSide(g) === 'b' ? 'b' : 'w',
    retry: false, retryArmed: false, sel: null,
  };
  renderMoveList(); renderPlayers(); renderSummary(); goTo(0);
  renderLibrary(); // refresh "analyzed" badges
}

function renderPlayers() {
  const { g, cls } = cur, h = g.headers;
  const acc = { w: [], b: [] };
  cur.g.moves.forEach((m, i) => {
    const a = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * cls[i].diff) - 3.1669));
    acc[m.color].push(a);
  });
  const mean = (a) => a.length ? (a.reduce((x, y) => x + y) / a.length).toFixed(1) : '—';
  const top = cur.orient === 'w' ? 'b' : 'w', bottom = cur.orient;
  const name = (s) => `${s === 'w' ? h.White : h.Black} (${(s === 'w' ? h.WhiteElo : h.BlackElo) || '?'})`;
  $('name-top').textContent = name(top);
  $('name-bottom').textContent = name(bottom);
  $('acc-top').textContent = `accuracy ${mean(acc[top])}`;
  $('acc-bottom').textContent = `accuracy ${mean(acc[bottom])}`;
}

function renderSummary() {
  const { g, cls } = cur, h = g.headers;
  const order = ['brilliant', 'great', 'best', 'excellent', 'good', 'inaccuracy', 'mistake', 'miss', 'blunder'];
  const count = { w: {}, b: {} };
  g.moves.forEach((m, i) => { count[m.color][cls[i].verdict] = (count[m.color][cls[i].verdict] || 0) + 1; });
  let rows = `<div class="sum-grid"><span class="lbl"></span><span class="n">${esc(h.White)}</span><span class="n">${esc(h.Black)}</span>`;
  for (const v of order) {
    if (!(count.w[v] || count.b[v])) continue;
    rows += `<span class="lbl" style="color:${VERDICTS[v].color}">${VERDICTS[v].glyph} ${VERDICTS[v].label}</span><span class="n">${count.w[v] || 0}</span><span class="n">${count.b[v] || 0}</span>`;
  }
  rows += '</div>';
  $('summary-body').innerHTML = rows;
  $('summary-card').hidden = false;
}

function renderMoveList() {
  const { g, cls } = cur, el = $('move-list');
  el.innerHTML = '';
  for (let i = 0; i < g.moves.length; i += 2) {
    const num = document.createElement('span');
    num.className = 'mv-num'; num.textContent = (i / 2 + 1) + '.';
    el.appendChild(num);
    for (const j of [i, i + 1]) {
      const b = document.createElement('button');
      if (j < g.moves.length) {
        const v = cls[j].verdict;
        b.className = 'mv'; b.dataset.ply = j + 1;
        b.innerHTML = `<span class="tag" style="background:${VERDICTS[v].color}">${VERDICTS[v].glyph}</span>${esc(g.moves[j].san)}`;
        b.addEventListener('click', () => goTo(j + 1));
      } else b.className = 'mv empty';
      el.appendChild(b);
    }
  }
}

/* ═══════════════ board ═══════════════ */
const FILES = 'abcdefgh';
function sqName(r, f) { return FILES[f] + (8 - r); } // r,f in white-orientation grid
function renderBoard() {
  const { fens, ply, orient, g } = cur;
  const chess = new Chess(fens[ply]);
  const grid = chess.board(); // [rank8..rank1][a..h]
  const el = $('board');
  el.innerHTML = '';
  const last = ply > 0 ? g.moves[ply - 1] : null;
  const verdict = ply > 0 ? cur.cls[ply - 1].verdict : null;

  for (let vr = 0; vr < 8; vr++) {
    for (let vf = 0; vf < 8; vf++) {
      const r = orient === 'w' ? vr : 7 - vr;
      const f = orient === 'w' ? vf : 7 - vf;
      const name = sqName(r, f);
      const piece = grid[r][f];
      const d = document.createElement('div');
      d.className = 'sq ' + ((r + f) % 2 === 0 ? 'light' : 'dark');
      d.dataset.sq = name;
      if (last && (name === last.from || name === last.to)) d.classList.add('hl');
      if (piece) d.innerHTML = `<img src="pieces/${piece.color}${piece.type.toUpperCase()}.svg" alt="">`;
      if (vf === 7) d.insertAdjacentHTML('beforeend', `<span class="coord rank">${8 - r}</span>`);
      if (vr === 7) d.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[f]}</span>`);
      if (last && verdict && name === last.to) {
        d.insertAdjacentHTML('beforeend', `<span class="badge" style="background:${VERDICTS[verdict].color}">${VERDICTS[verdict].glyph}</span>`);
      }
      d.addEventListener('click', () => onSquareTap(name));
      el.appendChild(d);
    }
  }
  renderArrow();
  renderEval();
}

function sqCenter(name) {
  const f = FILES.indexOf(name[0]), r = 8 - +name[1];
  const vf = cur.orient === 'w' ? f : 7 - f;
  const vr = cur.orient === 'w' ? r : 7 - r;
  return [vf * 100 + 50, vr * 100 + 50];
}
function renderArrow() {
  const svg = $('arrow-layer');
  svg.innerHTML = '';
  if (!$('chk-arrow').checked) return;
  if (cur.retryArmed) return; // don't spoil the guess
  // Retrospective: show the suggestion for the move that was just played (ply-1),
  // not the forward-looking suggestion for whoever moves next — those are opposite sides.
  const p = cur.an.pos[Math.max(0, cur.ply - 1)];
  if (!p || !p.best) return;
  const [x1, y1] = sqCenter(p.best.slice(0, 2));
  const [x2, y2] = sqCenter(p.best.slice(2, 4));
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const x2s = x2 - 26 * Math.cos(ang), y2s = y2 - 26 * Math.sin(ang);
  svg.innerHTML = `<defs><marker id="ah" markerWidth="5" markerHeight="5" refX="2.2" refY="2.5" orient="auto"><path d="M0,0 L5,2.5 L0,5 Z" fill="rgba(29,158,117,.85)"/></marker></defs>
    <line x1="${x1}" y1="${y1}" x2="${x2s}" y2="${y2s}" stroke="rgba(29,158,117,.85)" stroke-width="16" stroke-linecap="round" marker-end="url(#ah)"/>`;
}
function renderEval() {
  const p = cur.an.pos[cur.ply];
  const wp = winPct(p.cp);
  $('eval-white').style.height = wp + '%';
  const bar = $('eval-bar');
  bar.classList.toggle('black-adv', p.cp < 0);
  $('eval-num').textContent = p.mate !== null ? 'M' + Math.abs(p.mate) : Math.abs(p.cp / 100).toFixed(1);
}

/* ═══════════════ voice coaching ═══════════════ */
function speak(text) {
  if (!('speechSynthesis' in window) || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (settings.voiceURI) {
    const v = speechSynthesis.getVoices().find(v => v.voiceURI === settings.voiceURI);
    if (v) u.voice = v;
  }
  const btn = $('btn-speak');
  u.onstart = () => btn?.classList.add('speaking');
  u.onend = u.onerror = () => btn?.classList.remove('speaking');
  speechSynthesis.speak(u);
}
function populateVoiceOptions() {
  if (!('speechSynthesis' in window)) return;
  const sel = $('set-voice');
  const voices = speechSynthesis.getVoices().filter(v => v.lang?.toLowerCase().startsWith('en'));
  if (!voices.length) return;
  const current = sel.value || settings.voiceURI;
  sel.innerHTML = '<option value="">Browser default</option>' + voices
    .map(v => `<option value="${esc(v.voiceURI)}">${esc(v.name)} (${esc(v.lang)})</option>`)
    .join('');
  sel.value = voices.some(v => v.voiceURI === current) ? current : '';
}
if ('speechSynthesis' in window) speechSynthesis.addEventListener('voiceschanged', populateVoiceOptions);

/* ═══════════════ coach panel ═══════════════ */
function renderCoach() {
  const { ply, g, an, cls } = cur;
  const chip = $('verdict-chip'), txt = $('coach-text'), mvEl = $('coach-move'), lineEl = $('coach-line');
  $('ai-answer').hidden = true; $('ai-answer').textContent = '';
  if (cur.retryArmed) {
    chip.textContent = 'Your turn'; chip.style.background = 'var(--amber)';
    mvEl.textContent = '';
    txt.textContent = 'In the game, a weaker move was played here. Move a piece on the board — can you find the coach\'s choice?';
    lineEl.hidden = true; $('btn-ai-explain').hidden = true;
    speak(txt.textContent);
    return;
  }
  if (ply === 0) {
    chip.textContent = 'Start'; chip.style.background = 'var(--surface-2)'; chip.style.color = 'var(--ink-2)';
    mvEl.textContent = '';
    const side = youSide(g);
    txt.textContent = side ? `You played ${side === 'w' ? 'White' : 'Black'}. Step through with ▶ or the arrow keys — I'll comment on every move, both sides.` : 'Step through with ▶ or the arrow keys.';
    lineEl.hidden = true; $('btn-ai-explain').hidden = true;
    speak(txt.textContent);
    return;
  }
  const i = ply - 1, v = cls[i].verdict, mv = g.moves[i];
  const you = youSide(g) === mv.color;
  const whoName = you ? 'You' : 'Opponent';
  chip.textContent = VERDICTS[v].label;
  chip.style.background = VERDICTS[v].color; chip.style.color = '#10151b';
  mvEl.innerHTML = `<span class="whose ${you ? 'you' : 'opp'}">${esc(whoName)}</span> · ${Math.floor(i / 2) + 1}${mv.color === 'w' ? '.' : '…'} ${esc(mv.san)}  ·  ${evalText(an.pos[i + 1])}`;
  const coach = coachFor(g, an, cls, i);
  txt.textContent = coach.text;
  if (coach.line && ['inaccuracy', 'mistake', 'blunder', 'miss'].includes(v)) {
    lineEl.hidden = false;
    lineEl.textContent = 'Better line: ' + coach.line;
  } else lineEl.hidden = true;
  $('btn-ai-explain').hidden = !['inaccuracy', 'mistake', 'blunder', 'miss', 'brilliant', 'great'].includes(v);
  speak((you ? 'Your move. ' : 'Opponent\'s move. ') + txt.textContent);
}

/* ═══════════════ navigation & retry ═══════════════ */
function goTo(ply) {
  cur.ply = Math.max(0, Math.min(cur.fens.length - 1, ply));
  cur.retryArmed = false; cur.sel = null;
  $('retry-banner').hidden = true;
  renderBoard(); renderCoach(); highlightMoveList();
}
function highlightMoveList() {
  document.querySelectorAll('.mv.current').forEach(e => e.classList.remove('current'));
  const el = document.querySelector(`.mv[data-ply="${cur.ply}"]`);
  if (el) { el.classList.add('current'); el.scrollIntoView({ block: 'nearest' }); }
}
function next() {
  if (cur.ply >= cur.fens.length - 1) return;
  const i = cur.ply; // move about to be played
  const mv = cur.g.moves[i];
  const bad = ['inaccuracy', 'mistake', 'blunder', 'miss'].includes(cur.cls[i].verdict);
  const yours = youSide(cur.g) === mv.color;
  if (cur.retry && yours && bad && !cur.retryArmed && !cur._retryDone?.has(i)) {
    cur.retryArmed = true;
    $('retry-banner').hidden = false;
    renderBoard(); renderCoach();
    return;
  }
  cur.retryArmed = false; $('retry-banner').hidden = true;
  goTo(cur.ply + 1);
}
function onSquareTap(name) {
  if (!cur || !cur.retryArmed) return;
  const chess = new Chess(cur.fens[cur.ply]);
  const piece = chess.get(name);
  if (cur.sel === null) {
    if (piece && piece.color === chess.turn()) selectSquare(name, chess);
    return;
  }
  if (name === cur.sel) { clearSelection(); return; }
  if (piece && piece.color === chess.turn()) { selectSquare(name, chess); return; }
  const legal = chess.moves({ square: cur.sel, verbose: true }).find(m => m.to === name);
  if (!legal) return;
  evaluateGuess(legal);
}
function selectSquare(name, chess) {
  cur.sel = name;
  renderBoard();
  const el = document.querySelector(`.sq[data-sq="${name}"]`);
  el?.classList.add('sel');
  for (const m of chess.moves({ square: name, verbose: true })) {
    const t = document.querySelector(`.sq[data-sq="${m.to}"]`);
    if (t) t.insertAdjacentHTML('beforeend', m.captured ? '<span class="ring"></span>' : '<span class="dot"></span>');
  }
}
function clearSelection() { cur.sel = null; renderBoard(); }
function evaluateGuess(legal) {
  const i = cur.ply, before = cur.an.pos[i], played = cur.g.moves[i];
  const bestUci = before.best;
  const guessUci = legal.from + legal.to + (legal.promotion || '');
  cur._retryDone = cur._retryDone || new Set(); cur._retryDone.add(i);
  cur.retryArmed = false; cur.sel = null;
  $('retry-banner').hidden = true;
  const chip = $('verdict-chip'), txt = $('coach-text');
  renderBoard();
  const bestSan = uciSan(before.fen, bestUci);
  if (bestUci && guessUci.startsWith(bestUci.slice(0, 4))) {
    chip.textContent = 'You found it'; chip.style.background = 'var(--best)'; chip.style.color = '#10151b';
    txt.textContent = `${legal.san} — exactly right. In the game ${played.san} was played instead. Press ▶ to see how the game actually continued.`;
  } else if (legal.san === played.san) {
    chip.textContent = 'Same as the game'; chip.style.background = 'var(--inaccuracy)'; chip.style.color = '#10151b';
    txt.textContent = `${legal.san} is what was played in the game — and it's the move the coach flagged. The stronger idea was ${bestSan}. Press ▶ to continue.`;
  } else {
    chip.textContent = 'Not quite'; chip.style.background = 'var(--mistake)'; chip.style.color = '#10151b';
    txt.textContent = `${legal.san} isn't it either. The coach's choice was ${bestSan}. Press ▶ to see the game move.`;
  }
  $('coach-line').hidden = true; $('btn-ai-explain').hidden = true;
  speak(txt.textContent);
}

/* ═══════════════ AI explain ═══════════════ */
async function aiExplain() {
  const i = cur.ply - 1;
  if (i < 0) return;
  const key = settings.keys[settings.provider];
  if (!key && settings.provider !== 'custom') { openSettings(); return; }
  const g = cur.g, mv = g.moves[i], before = cur.an.pos[i], after = cur.an.pos[i + 1], c = cur.cls[i];
  const bestSan = before.best ? uciSan(before.fen, before.best) : '—';
  const line = pvToSan(before.fen, before.pv, 6).join(' ');
  const you = youSide(g) === mv.color;
  const prompt =
    `You are a friendly chess coach for a ~450-rated beginner. Explain this single moment in 3-5 short sentences, plain language, no engine jargon.
Position (FEN before the move): ${before.fen}
Move played: ${mv.san} by ${you ? 'the student' : 'the opponent'} (${mv.color === 'w' ? 'White' : 'Black'})
Engine verdict: ${VERDICTS[c.verdict].label}. Eval went from ${evalText(before)} to ${evalText(after)} (White's view).
Engine's preferred move: ${bestSan}. Best line: ${line}
Explain: 1) the idea behind what was played, 2) concretely why it ${['best', 'great', 'brilliant'].includes(c.verdict) ? 'works so well' : 'fails and what it loses'}, 3) the thinking habit that finds ${bestSan} — phrase it as advice the student can reuse.`;

  const box = $('ai-answer');
  box.hidden = false; box.classList.add('loading'); box.textContent = 'Coach is thinking…';
  try {
    const text = await callAI(prompt);
    box.classList.remove('loading');
    box.textContent = text.trim();
  } catch (e) {
    box.classList.remove('loading');
    box.textContent = 'AI request failed: ' + e.message + '\nCheck your provider, model, and API key in Settings. Some providers also block browser calls (CORS) — OpenRouter and Anthropic work well from the browser.';
  }
}
async function callAI(prompt) {
  const p = settings.provider, model = settings.model, key = settings.keys[p] || '';
  if (p === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
    });
    if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 140));
    const d = await r.json();
    return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
  }
  if (p === 'gemini') {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 140));
    const d = await r.json();
    return (d.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
  }
  // OpenAI-compatible: openai / openrouter / custom
  const base = p === 'openai' ? 'https://api.openai.com/v1'
    : p === 'openrouter' ? 'https://openrouter.ai/api/v1'
      : (settings.baseurl || '').replace(/\/$/, '');
  if (!base) throw new Error('Set a base URL in Settings for the custom provider.');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
    body: JSON.stringify({ model, max_tokens: 500, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!r.ok) throw new Error(r.status + ' ' + (await r.text()).slice(0, 140));
  const d = await r.json();
  return d.choices?.[0]?.message?.content || '';
}

/* ═══════════════ screens, settings, wiring ═══════════════ */
function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $('screen-' + name).classList.add('active');
}
function openSettings() {
  $('set-username').value = settings.username;
  const hint = $('username-hint');
  hint.textContent = 'Used to mark your side, flip the board, and tag wins and losses.';
  hint.classList.remove('hint-warn');
  $('set-depth').value = String(settings.depth);
  populateVoiceOptions();
  $('set-voice').value = settings.voiceURI || '';
  $('set-provider').value = settings.provider;
  $('set-model').value = settings.model;
  $('set-baseurl').value = settings.baseurl;
  $('set-apikey').value = settings.keys[settings.provider] || '';
  $('field-baseurl').hidden = settings.provider !== 'custom';
  $('settings-modal').hidden = false;
}

function wire() {
  $('btn-browse').addEventListener('click', () => $('pgn-file').click());
  $('pgn-file').addEventListener('change', async (e) => {
    let text = '';
    for (const f of e.target.files) text += await f.text() + '\n\n';
    loadPgnText(text);
    e.target.value = '';
  });
  const dz = $('drop-zone');
  dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
  dz.addEventListener('drop', async (e) => {
    e.preventDefault(); dz.classList.remove('drag');
    let text = '';
    for (const f of e.dataTransfer.files) text += await f.text() + '\n\n';
    if (text.trim()) loadPgnText(text);
  });
  $('btn-paste').addEventListener('click', () => { $('paste-box').hidden = false; $('pgn-text').focus(); });
  $('btn-paste-cancel').addEventListener('click', () => { $('paste-box').hidden = true; });
  $('btn-paste-load').addEventListener('click', () => {
    loadPgnText($('pgn-text').value); $('paste-box').hidden = true;
  });

  $('btn-back').addEventListener('click', () => { if ('speechSynthesis' in window) speechSynthesis.cancel(); showScreen('library'); });
  $('btn-flip').addEventListener('click', () => { if (cur) { cur.orient = cur.orient === 'w' ? 'b' : 'w'; renderBoard(); renderPlayers(); } });
  $('nav-start').addEventListener('click', () => goTo(0));
  $('nav-prev').addEventListener('click', () => goTo(cur.ply - 1));
  $('nav-next').addEventListener('click', next);
  $('nav-end').addEventListener('click', () => goTo(cur.fens.length - 1));
  $('chk-retry').addEventListener('change', (e) => { if (cur) cur.retry = e.target.checked; });
  $('chk-arrow').addEventListener('change', () => cur && renderArrow());
  $('btn-speak').addEventListener('click', () => {
    if ('speechSynthesis' in window && speechSynthesis.speaking) { speechSynthesis.cancel(); return; }
    speak($('coach-text').textContent);
  });
  $('btn-ai-explain').addEventListener('click', aiExplain);
  $('btn-cancel-analysis').addEventListener('click', () => { cancelAnalysis = true; });

  $('btn-settings').addEventListener('click', openSettings);
  $('btn-settings-close').addEventListener('click', () => { $('settings-modal').hidden = true; });
  $('set-voice').addEventListener('change', (e) => {
    const prevVoiceURI = settings.voiceURI;
    settings.voiceURI = e.target.value;
    speak('This is how I\'ll sound when I read out your hints.');
    settings.voiceURI = prevVoiceURI; // only persisted on Save
  });
  $('set-provider').addEventListener('change', (e) => {
    $('set-model').value = MODEL_DEFAULTS[e.target.value] || '';
    $('set-apikey').value = settings.keys[e.target.value] || '';
    $('field-baseurl').hidden = e.target.value !== 'custom';
  });
  $('btn-settings-save').addEventListener('click', () => {
    settings.username = $('set-username').value.trim();
    settings.depth = +$('set-depth').value;
    settings.voiceURI = $('set-voice').value;
    settings.provider = $('set-provider').value;
    settings.model = $('set-model').value.trim();
    settings.baseurl = $('set-baseurl').value.trim();
    settings.keys[settings.provider] = $('set-apikey').value.trim();
    saveSettings();
    $('settings-modal').hidden = true;
    renderLibrary();
  });

  document.addEventListener('keydown', (e) => {
    if (!cur || !$('screen-review').classList.contains('active')) return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) return;
    if (e.key === 'ArrowRight') { e.preventDefault(); next(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(cur.ply - 1); }
    else if (e.key === 'Home') goTo(0);
    else if (e.key === 'End') goTo(cur.fens.length - 1);
    else if (e.key.toLowerCase() === 'f') $('btn-flip').click();
    else if (e.key.toLowerCase() === 'g') { $('chk-retry').checked = !$('chk-retry').checked; cur.retry = $('chk-retry').checked; }
  });
}
try {
  wire();
  renderLibrary();
  checkSharedPgn();
} catch (err) {
  const msg = 'Review Room failed to start: ' + err.message + '.\nOpen the browser console for details.';
  console.error('[Review Room] ' + msg, err);
  window.__rrBootError?.(msg);
}

/* ═══════════════ share target (PWA) ═══════════════ */
async function checkSharedPgn() {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('review-room-share-inbox');
    const res = await cache.match('./__shared-pgn__');
    if (!res) return;
    await cache.delete('./__shared-pgn__');
    const text = await res.text();
    if (text.trim()) loadPgnText(text);
  } catch (e) { console.warn('No shared PGN to import:', e.message); }
}
