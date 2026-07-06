/* ================================================================
   Pitch IQ · World Cup 2026 companion
   Single-file app. In-memory state is the source of truth; an async
   key-value store (window.storage if present, else an IndexedDB
   shim with the same API) persists the data blob + follows.
   ================================================================ */
'use strict';

/* ---------------- storage (never localStorage/sessionStorage) ---------------- */
const storageAPI = (() => {
  if (window.storage && typeof window.storage.get === 'function') return window.storage;
  let dbp = null;
  const mem = new Map(); // last-resort fallback
  try {
    dbp = new Promise((res, rej) => {
      const r = indexedDB.open('pitchiq-kv', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  } catch (e) { dbp = null; }
  return {
    async get(key) {
      if (!dbp) { if (!mem.has(key)) throw new Error('missing'); return { value: mem.get(key) }; }
      const db = await dbp;
      const v = await new Promise((res, rej) => {
        const q = db.transaction('kv').objectStore('kv').get(key);
        q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
      });
      if (v === undefined) throw new Error('missing key: ' + key);
      return { value: v };
    },
    async set(key, value) {
      if (!dbp) { mem.set(key, value); return; }
      const db = await dbp;
      return new Promise((res, rej) => {
        const t = db.transaction('kv', 'readwrite');
        t.objectStore('kv').put(value, key);
        t.oncomplete = () => res(); t.onerror = () => rej(t.error);
      });
    },
  };
})();

/* ---------------- state ---------------- */
const S = {
  data: DATA,
  follows: new Set(),
  pins: {},            // matchId -> teamId (what-if forced winners)
  view: 'home',
  modal: null,         // playerId
  mapMode: 'all',      // 'all' | playerId
  cam: null,           // journey-map camera {k,x,y}; null => reframe on next render
  mapDirty: true,      // reframe against the true visible region on next bind
  mapVV: null,         // measured visible viewBox rect
  filters: { team: '', pos: '', tier: '', status: '', q: '' },
  sort: 'default',     // default | goals | assists | saves
  busy: {},            // refresh spinners
  digest: null,        // {points:[...], ai:boolean}
  strengths: null,     // calibrated
  learned: {},         // playerId -> [{q, a, fact, at}]   (grows with curiosity, persisted)
  qa: {},              // playerId -> {busy, answer, error}  (transient Q&A UI state)
  apiKey: null,        // user's Anthropic key (browser-only, never in code)
  sheetOverlay: null,  // 'settings' | 'add-player'
  addPlayer: { busy: false, error: null },
};

/* ---------------- tiny helpers ---------------- */
const $ = (sel, el) => (el || document).querySelector(sel);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nn = v => (v == null ? '—' : v); // null -> em dash glyph (data honesty)
const team = id => S.data.teams.find(t => t.id === id);
const player = id => S.data.players.find(p => p.id === id);
const alive = t => t && t.status === 'alive';
const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function headlineStat(p) {
  const st = p.stats || {};
  if (p.position === 'GK') return { v: nn(st.saves), l: 'saves' };
  if (p.position === 'DEF') return st.goals ? { v: st.goals, l: 'goals' } : { v: nn(st.cleanSheets), l: 'clean sheets' };
  return { v: nn(st.goals), l: 'goals' };
}
function initials(name) {
  const parts = name.replace(/[().]/g, '').split(/\s+/).filter(Boolean);
  return (parts.length >= 2 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)).toUpperCase();
}
function toast(msg, isErr) {
  const slot = $('#toast-slot');
  slot.innerHTML = `<div class="toast${isErr ? ' err' : ''}">${esc(msg)}</div>`;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { slot.innerHTML = ''; }, 4200);
}
function daysToFinal() {
  const final = new Date('2026-07-19T20:00:00-04:00');
  return Math.max(0, Math.ceil((final - new Date()) / 86400000));
}

/* ================================================================
   SIMULATOR
   Team strength: we derive S_t = p_t ^ (1 / winsNeeded_t), where p_t is
   the odds-implied (normalized) title probability and winsNeeded_t is how
   many knockout wins that team still needs to lift the trophy. Rationale:
   winning the title requires winsNeeded roughly-even contests, so the
   per-match "win propensity" is on the order of the winsNeeded-th root of
   the title probability. Pairwise P(A beats B) = S_A / (S_A + S_B).
   We then run a short fixed-point calibration so that the model's exactly
   propagated title probabilities reproduce the researched market odds at
   baseline; what-if pins therefore start from the market numbers.
   Title probabilities are computed by EXACT propagation over the bracket
   tree (participant distributions per match), no Monte Carlo.
   ================================================================ */
const SIM = {
  rounds() { return S.data.bracket.rounds; },
  winsNeeded(tid) {
    const rs = this.rounds();
    for (let r = 0; r < rs.length; r++) {
      for (const m of rs[r].matches) {
        if (!m.played && (m.teamA === tid || m.teamB === tid)) return rs.length - r;
      }
    }
    return 1; // shouldn't happen for alive teams
  },
  bracketTeamIds() {
    const s = new Set();
    for (const r of this.rounds()) for (const m of r.matches) { if (m.teamA) s.add(m.teamA); if (m.teamB) s.add(m.teamB); }
    return s;
  },
  contenders() { const bt = this.bracketTeamIds(); return S.data.teams.filter(t => alive(t) && bt.has(t.id)); },
  baseStrengths() {
    const aliveTeams = this.contenders();
    const floor = 0.15;
    const probs = {};
    let sum = 0;
    for (const t of aliveTeams) { const p = t.titleProbability == null ? floor : Math.max(t.titleProbability, floor); probs[t.id] = p; sum += p; }
    const s = {};
    for (const t of aliveTeams) {
      const p = probs[t.id] / sum; // normalize to 1
      s[t.id] = Math.pow(p, 1 / this.winsNeeded(t.id));
    }
    // calibrate so exact propagation reproduces market probs at baseline
    for (let k = 0; k < 60; k++) {
      const model = this.titleProbs({}, s);
      let maxErr = 0;
      for (const t of aliveTeams) {
        const target = probs[t.id] / sum;
        const got = model[t.id] || 1e-9;
        const adj = Math.pow(target / got, 0.5);
        s[t.id] *= Math.min(3, Math.max(0.33, adj));
        maxErr = Math.max(maxErr, Math.abs(got - target));
      }
      if (maxErr < 0.0005) break;
    }
    return s;
  },
  strengths() { if (!S.strengths) S.strengths = this.baseStrengths(); return S.strengths; },
  // distribution of the WINNER of match (r, i) as {teamId: prob}
  winnerDist(r, i, pins, str, memo) {
    const key = r + ':' + i;
    if (memo[key]) return memo[key];
    const m = this.rounds()[r].matches[i];
    let out = {};
    if (m.played && m.winner) { out[m.winner] = 1; }
    else {
      const dA = m.teamA ? { [m.teamA]: 1 } : (r > 0 ? this.winnerDist(r - 1, i * 2, pins, str, memo) : {});
      const dB = m.teamB ? { [m.teamB]: 1 } : (r > 0 ? this.winnerDist(r - 1, i * 2 + 1, pins, str, memo) : {});
      const pinned = pins[m.id];
      for (const a in dA) for (const b in dB) {
        const pab = dA[a] * dB[b];
        if (pab <= 0) continue;
        if (pinned && (pinned === a || pinned === b)) {
          out[pinned] = (out[pinned] || 0) + pab;
        } else {
          const sa = str[a] || 0.01, sb = str[b] || 0.01;
          out[a] = (out[a] || 0) + pab * (sa / (sa + sb));
          out[b] = (out[b] || 0) + pab * (sb / (sa + sb));
        }
      }
    }
    memo[key] = out;
    return out;
  },
  titleProbs(pins, strOverride) {
    const str = strOverride || this.strengths();
    const rs = this.rounds();
    const finalR = rs.length - 1;
    const memo = {};
    // final round may hold [final] or [3rd place, final]; find the final by name
    let fi = rs[finalR].matches.length - 1;
    for (let j = 0; j < rs[finalR].matches.length; j++) {
      if (!/third|3rd/i.test(rs[finalR].matches[j].id)) fi = j;
    }
    return this.winnerDist(finalR, fi, pins, str, memo);
  },
};

/* ---------------- nav ---------------- */
const NAV = [
  { id: 'home', label: 'Home', ic: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5.5 9.5V20h13V9.5"/>' },
  { id: 'players', label: 'Players', ic: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c1.2-3.6 4-5.4 7.5-5.4s6.3 1.8 7.5 5.4"/>' },
  { id: 'bracket', label: 'Bracket', ic: '<path d="M4 5h5v5H4zM4 14h5v5H4z"/><path d="M9 7.5h3.5v9H9M12.5 12H16"/><circle cx="18.5" cy="12" r="2.2"/>' },
  { id: 'map', label: 'Map', ic: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c-5 5-5 12 0 17 5-5 5-12 0-17z"/>' },
  { id: 'digest', label: 'Catch up', ic: '<path d="M13 3 5 13.5h5L10.5 21 19 10.5h-5.5z"/>' },
];

/* ================================================================ RENDER */
function render() {
  const views = { home: vHome, players: vPlayers, bracket: vBracket, map: vMap, digest: vDigest };
  $('#app').innerHTML = `
    <nav class="tabbar" aria-label="Sections">
      <span class="brand">PITCH <b>IQ</b></span>
      ${NAV.map(n => `<button data-act="view" data-v="${n.id}" class="${S.view === n.id ? 'on' : ''}" aria-current="${S.view === n.id}">
        <svg viewBox="0 0 24 24" aria-hidden="true">${n.ic}</svg>${n.label}</button>`).join('')}
      <button class="tab-gear${S.apiKey ? ' keyed' : ''}" data-act="settings" aria-label="Settings and API key" title="Settings">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M21.5 12h-3M5.5 12h-3M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1M18.4 18.4l-2.1-2.1M7.7 7.7 5.6 5.6"/></svg></button>
    </nav>
    <main>${views[S.view]()}</main>
    ${S.modal ? vPlayerSheet(S.modal) : ''}
    ${S.sheetOverlay === 'settings' ? vSettings() : ''}
    ${S.sheetOverlay === 'add-player' ? vAddPlayer() : ''}`;
  afterRender();
}
function asofHtml() {
  return `<span class="asof"><span class="dot"></span>data as of ${esc(S.data.meta.asOf)}</span>`;
}

/* ---------------- HOME ---------------- */
function vHome() {
  const m = S.data.meta;
  const stories = (S.data.stories || []).slice(0, 3);
  const probs = SIM.titleProbs(S.pins);
  const fav = Object.entries(probs).sort((a, b) => b[1] - a[1])[0];
  const favT = fav && team(fav[0]);
  const L = S.data.leaders;
  const gk1 = (L.gkLeaders || [])[0], sc1 = (L.topScorers || [])[0], as1 = (L.topAssists || [])[0];
  const leadCard = (row, statKey, lbl) => {
    if (!row) return '';
    const p = S.data.players.find(x => x.name === row.name || x.id === row.playerId);
    const t = p && team(p.teamId);
    return `<button class="lead" data-act="${p ? 'open' : ''}" data-p="${p ? p.id : ''}">
      <span class="lbl">${lbl}</span>
      <span class="big">${nn(row[statKey])}</span>
      <span class="who">${t ? t.flagEmoji + ' ' : ''}${esc(row.name)}</span>
      <span class="team">${esc(row.team || '')}</span></button>`;
  };
  return `
  <header class="hero">
    <svg class="pitchlines" viewBox="0 0 400 200" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g fill="none" stroke="rgba(163,193,173,.09)" stroke-width="1.2">
        <circle cx="200" cy="100" r="58"/><line x1="200" y1="-10" x2="200" y2="210"/>
        <rect x="-40" y="40" width="90" height="120"/><rect x="350" y="40" width="90" height="120"/>
      </g></svg>
    <span class="lbl gold">FIFA World Cup 2026 · USA · Mexico · Canada</span>
    <div class="stage disp">${esc(m.stage)}</div>
    <p class="sub">${esc(m.stageNote || '')}</p>
    <div class="meta-row">
      <span class="count num">${daysToFinal()}<small>days to the final · Jul 19 · MetLife</small></span>
      ${favT ? `<span class="count num" style="color:${favT.accentColor}">${Math.round(fav[1] * 100)}%<small>${esc(favT.name)} title odds</small></span>` : ''}
    </div>
    <div style="margin-top:12px">${asofHtml()}</div>
  </header>

  <h2 class="sec">Story of the tournament</h2>
  <div class="strip">
    ${stories.map(s => `<div class="card story">
      <span class="headline">${esc(s.headline)}</span>
      <span class="detail">${esc(s.detail)}</span></div>`).join('')}
  </div>

  <h2 class="sec">Leaders <span class="lbl">tap for profile</span></h2>
  <div class="leaders">
    ${leadCard(sc1, 'goals', 'Top scorer · goals')}
    ${leadCard(as1, 'assists', 'Top assists')}
    ${leadCard(gk1, 'saves', 'Top GK · saves')}
  </div>

  <h2 class="sec">Next matches</h2>
  <div class="card flat">
    ${(m.nextMatches || []).map(x => `<div class="mrow">
      <span class="when">${esc(x.date)}</span>
      <span class="fixture">${esc(x.teams)}</span>
      <span class="round">${esc(x.round)}</span></div>`).join('') || '<p class="footnote">No scheduled matches in the data.</p>'}
  </div>

  ${(S.data.fallenStars || []).length ? `
  <h2 class="sec">Fallen stars <span class="lbl">out, not forgotten</span></h2>
  <div class="card flat fallen">
    ${S.data.fallenStars.map(f => {
      const t = S.data.teams.find(t2 => t2.name === f.team || t2.id === f.team);
      return `<div class="fs"><span class="fl">${t ? t.flagEmoji : '·'}</span><div><b>${esc(f.name)}</b> <span>${esc(f.oneLineLegacy)}</span></div></div>`;
    }).join('')}
  </div>` : ''}
  <p class="footnote">Pitch IQ is a hand-researched snapshot, not a live feed. Probabilities are normalized from market title odds at the time shown above.</p>`;
}

/* ---------------- PLAYERS ---------------- */
function passFilters(p) {
  const f = S.filters, t = team(p.teamId);
  if (f.team && p.teamId !== f.team) return false;
  if (f.pos && p.position !== f.pos) return false;
  if (f.tier && String(p.tier) !== f.tier) return false;
  if (f.status === 'alive' && !(t && t.status === 'alive')) return false;
  if (f.status === 'out' && !(t && t.status === 'eliminated')) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    if (!(p.name.toLowerCase().includes(q) || (t && t.name.toLowerCase().includes(q)) || (p.club || '').toLowerCase().includes(q))) return false;
  }
  return true;
}
function pcard(p, rank) {
  const t = team(p.teamId) || {};
  const sortKey = SORTS[S.sort];
  const hs = sortKey ? { v: nn(p.stats && p.stats[sortKey]), l: sortKey === 'saves' ? 'saves' : sortKey } : headlineStat(p);
  const fol = S.follows.has(p.id);
  const dead = t.status === 'eliminated';
  return `<div class="pcard${dead ? ' dead' : ''}" style="--ac:${t.accentColor || 'var(--gold)'}">
    ${rank ? `<span class="rankbadge num">${rank}</span>` : ''}
    <button class="star${fol ? ' on' : ''}" data-act="follow" data-p="${p.id}" aria-label="${fol ? 'Unfollow' : 'Follow'} ${esc(p.name)}" aria-pressed="${fol}">
      <svg viewBox="0 0 24 24"><path d="M12 3.6 14.6 9l5.9.6-4.4 4 1.3 5.8L12 16.4l-5.4 3 1.3-5.8-4.4-4L9.4 9z"/></svg></button>
    <button class="top" data-act="open" data-p="${p.id}" style="all:unset;cursor:pointer;display:flex;align-items:center;gap:9px">
      <span class="avatar lg">${p.photo ? `<img src="${p.photo}" alt="">` : `<span class="ini">${initials(p.name)}</span>`}</span>
      <span style="min-width:0">
        <span class="nm" style="display:block">${t.flagEmoji || ''} ${esc(p.name)}</span>
        <span class="cl">${esc(p.club || '')}</span>
      </span></button>
    <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
      <span class="posb">${p.position}</span>
      ${p.number != null ? `<span class="jersey num">${p.number}</span>` : ''}
      ${p.tier === 1 ? '<span class="tierchip">TIER 1</span>' : p.custom ? '<span class="tierchip" style="color:var(--gold)">TRACKED</span>' : ''}
      ${dead ? '<span class="pill out">out</span>' : ''}
      ${(S.learned[p.id] || []).length ? `<span class="learnchip">✦ ${S.learned[p.id].length}</span>` : ''}
    </div>
    <button class="statline" data-act="open" data-p="${p.id}"><b class="num">${hs.v}</b><span>${hs.l}</span></button>
  </div>`;
}
const SORTS = { goals: 'goals', assists: 'assists', saves: 'saves' };
function playersList() {
  const list = S.data.players.filter(passFilters);
  const key = SORTS[S.sort];
  if (key) {
    // pure stat leaderboard: highest first, players without that stat sink to the bottom
    const val = p => (p.stats && p.stats[key] != null) ? p.stats[key] : -1;
    list.sort((a, b) => {
      const d = val(b) - val(a);
      if (d) return d;
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.name.localeCompare(b.name);
    });
  } else {
    list.sort((a, b) => {
      const fa = S.follows.has(a.id) ? 0 : 1, fb = S.follows.has(b.id) ? 0 : 1;
      if (fa !== fb) return fa - fb;
      if (a.tier !== b.tier) return a.tier - b.tier;
      const la = (team(a.teamId) || {}).status === 'alive' ? 0 : 1;
      const lb = (team(b.teamId) || {}).status === 'alive' ? 0 : 1;
      if (la !== lb) return la - lb;
      const sa = (a.stats && (a.stats.goals ?? a.stats.saves)) || 0;
      const sb = (b.stats && (b.stats.goals ?? b.stats.saves)) || 0;
      return sb - sa;
    });
  }
  return list.map((p, i) => pcard(p, key ? i + 1 : 0)).join('') || '<p class="footnote">No players match those filters.</p>';
}
function vPlayers() {
  const f = S.filters;
  const teamOpts = S.data.teams.filter(t => S.data.players.some(p => p.teamId === t.id))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(t => `<option value="${t.id}" ${f.team === t.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const sortOpt = (v, lbl) => `<option value="${v}" ${S.sort === v ? 'selected' : ''}>${lbl}</option>`;
  const custom = S.data.players.filter(p => p.custom).length;
  return `
  <div class="players-head">
    <h2 class="sec" style="margin:20px 0 0">Players <span class="lbl">${S.data.players.length} tracked${custom ? ' · ' + custom + ' by you' : ''}</span></h2>
    <button class="btn addbtn" data-act="add-player">+ Track a player</button>
  </div>
  <div class="filters">
    <input class="search" id="psearch" type="search" placeholder="Search name, team, club" value="${esc(f.q)}" aria-label="Search players">
    <select data-flt="team" aria-label="Team"><option value="">All teams</option>${teamOpts}</select>
    <select data-flt="pos" aria-label="Position"><option value="">All pos</option>${['GK', 'DEF', 'MID', 'FWD'].map(x => `<option ${f.pos === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
    <select data-flt="tier" aria-label="Tier"><option value="">Tiers</option><option value="1" ${f.tier === '1' ? 'selected' : ''}>Tier 1</option><option value="2" ${f.tier === '2' ? 'selected' : ''}>Tier 2</option></select>
    <select data-flt="status" aria-label="Status"><option value="">All</option><option value="alive" ${f.status === 'alive' ? 'selected' : ''}>Alive</option><option value="out" ${f.status === 'out' ? 'selected' : ''}>Eliminated</option></select>
  </div>
  <div class="sortrow">
    <span class="lbl">Sort</span>
    <select id="psort" aria-label="Sort by">
      ${sortOpt('default', 'Follows first')}${sortOpt('goals', 'Goals ⬇')}${sortOpt('assists', 'Assists ⬇')}${sortOpt('saves', 'Saves ⬇')}
    </select>
    ${SORTS[S.sort] ? '<span class="lbl gold">leaderboard · top of the tournament first</span>' : '<span class="lbl">★ starred players float to the top</span>'}
  </div>
  <div class="pgrid" id="pgrid">${playersList()}</div>`;
}

/* ---------------- PLAYER SHEET ---------------- */
function statBlocks(p) {
  const st = p.stats || {};
  const order = p.position === 'GK'
    ? [['saves', 'Saves'], ['cleanSheets', 'Clean sheets'], ['goalsConceded', 'Conceded'], ['matchesPlayed', 'Matches']]
    : p.position === 'DEF'
      ? [['matchesPlayed', 'Matches'], ['goals', 'Goals'], ['assists', 'Assists'], ['cleanSheets', 'Clean sheets']]
      : [['goals', 'Goals'], ['assists', 'Assists'], ['shots', 'Shots'], ['matchesPlayed', 'Matches']];
  return order.map(([k, l]) => `<div class="st"><b class="num">${nn(st[k])}</b><span>${l}</span></div>`).join('');
}
function qaBlock(p) {
  const st = S.qa[p.id] || {};
  const facts = S.learned[p.id] || [];
  const keyed = !!S.apiKey;
  return `
    <div class="qa" style="--ac:${(team(p.teamId) || {}).accentColor || 'var(--gold)'}">
      <div class="qa-head"><span class="lbl gold">Ask about ${esc(p.name.split(' ')[0])}</span>
        <span class="lbl">answers get saved below</span></div>
      <div class="qa-input">
        <input id="qa-input" type="text" placeholder="${keyed ? 'Ask anything — why the transfer? best goal? injury?' : 'Add your Anthropic key to ask questions'}"
          ${keyed ? '' : 'disabled'} value="" aria-label="Ask a question about ${esc(p.name)}">
        <button class="btn qa-ask" data-act="qa-ask" data-p="${p.id}" ${keyed && !st.busy ? '' : 'disabled'}>${st.busy ? '<span class="spin"></span>' : 'Ask'}</button>
      </div>
      ${!keyed ? `<button class="qa-keyhint" data-act="settings">You need a free Anthropic API key for the ask feature. Add one →</button>` : ''}
      ${st.error ? `<p class="qa-err">${esc(st.error)}</p>` : ''}
      ${st.answer ? `<div class="qa-answer"><span class="lbl">Answer</span><p>${esc(st.answer)}</p>${st.savedFact ? `<div class="qa-saved">✦ Saved to profile: <b>${esc(st.savedFact)}</b></div>` : ''}</div>` : ''}
      ${facts.length ? `
        <div class="learned">
          <div class="qa-head"><span class="lbl">What you've learned <span style="color:var(--gold)">(${facts.length})</span></span>
            ${facts.length ? `<button class="learn-clear" data-act="learn-clear" data-p="${p.id}">clear</button>` : ''}</div>
          ${facts.map((f, i) => `<div class="lfact"><span class="lfact-q" title="${esc(f.q)}">${esc(f.q)}</span><span class="lfact-a">${esc(f.fact)}</span></div>`).join('')}
        </div>` : ''}
    </div>`;
}
function vPlayerSheet(pid) {
  const p = player(pid); if (!p) return '';
  const t = team(p.teamId) || {};
  const ac = t.accentColor || '#D9B45C';
  const heroInner = p.photo
    ? `<img class="hero-photo" src="${p.photo}" alt="${esc(p.name)}">`
    : `<div class="hero-ini" style="background:linear-gradient(135deg, color-mix(in srgb, ${ac} 40%, #101a13), #0b120e)"><span>${initials(p.name)}</span></div>`;
  return `<div class="overlay" data-act="close-ov" role="dialog" aria-modal="true" aria-label="${esc(p.name)}">
  <article class="sheet has-hero" style="--ac:${ac}">
    <button class="x hero-x" data-act="close" aria-label="Close">✕</button>
    <div class="phero">
      ${heroInner}
      <div class="phero-shade"></div>
      <div class="phero-status">${t.status === 'eliminated' ? '<span class="pill out">eliminated</span>' : '<span class="pill alive">still alive</span>'}${p.custom ? ' <span class="pill" style="background:rgba(217,180,92,.16);color:var(--gold)">tracked by you</span>' : ''}</div>
      ${p.number != null ? `<span class="phero-num num">${p.number}</span>` : ''}
      <div class="phero-id">
        <h3>${esc(p.name)}</h3>
        <div class="phero-sub">${t.flagEmoji || ''} ${esc(t.name || '')} · ${p.position}${p.age != null ? ' · age ' + p.age : ''}${p.club ? ' · ' + esc(p.club) : ''}</div>
      </div>
    </div>
    <div class="sheet-body">
    <div class="callout"><b>${esc(p.knownFor || '')}</b>${p.watchBecause ? `<div style="margin-top:6px;color:var(--muted);font-size:13px">Why now: ${esc(p.watchBecause)}</div>` : ''}</div>
    ${(p.storylines || []).length ? `<span class="lbl">The storylines</span>${p.storylines.map(s => `<div class="sl">${esc(s)}</div>`).join('')}` : ''}
    <span class="lbl" style="display:block;margin-top:16px">This tournament</span>
    <div class="statgrid">${statBlocks(p)}</div>
    ${qaBlock(p)}
    ${p.birthplace && p.birthplace.latLng && p.clubLatLng ? `
    <button class="journeyline" data-act="journey" data-p="${p.id}">
      <span class="leg"><em>Born</em><b>${esc(p.birthplace.city)}, ${esc(p.birthplace.country)}</b></span>
      <span class="arrow">→</span>
      <span class="leg"><em>Club</em><b>${esc(p.clubCity || p.club)}</b></span>
      <span class="arrow">→</span>
      <span class="leg"><em>Plays for</em><b>${t.flagEmoji || ''} ${esc(t.name || '')}</b></span>
    </button>
    <p class="footnote" style="margin-top:4px">Tap the journey to see it on the world map.</p>` : ''}
    <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
      <button class="btn ghost" data-act="follow" data-p="${p.id}">${S.follows.has(p.id) ? '★ Following' : '☆ Follow'}</button>
      ${p.custom ? `<button class="btn ghost danger" data-act="remove-player" data-p="${p.id}">Remove</button>` : ''}
    </div>
    </div>
  </article></div>`;
}

/* ---------------- BRACKET ---------------- */
function vBracket() {
  const rs = SIM.rounds();
  const probs = SIM.titleProbs(S.pins);
  const ranked = SIM.contenders()
    .map(t => ({ t, p: probs[t.id] || 0 }))
    .sort((a, b) => b.p - a.p);
  const maxp = ranked.length ? ranked[0].p : 1;
  const hasPins = Object.keys(S.pins).length > 0;
  const trow = (m, tid, other) => {
    const t = tid && team(tid);
    const winner = m.played && m.winner === tid;
    const loser = m.played && m.winner && m.winner !== tid;
    const canPick = !m.played && tid && other; // both known, not played
    const pinned = S.pins[m.id] === tid;
    const scores = m.teamA === tid ? m.scoreA : m.scoreB;
    return `<${canPick ? 'button' : 'div'} class="trow${winner ? ' win' : ''}${loser ? ' lose' : ''}${canPick ? ' pick' : ''}${pinned ? ' pinned' : ''}"
      ${canPick ? `data-act="pin" data-m="${esc(m.id)}" data-t="${tid}"` : ''} style="--ac:${t ? t.accentColor : 'var(--gold)'}">
      <span class="fl">${t ? t.flagEmoji : '·'}</span>
      <span class="tn">${t ? esc(t.name) : esc(tid || 'TBD')}</span>
      <span class="sc num">${m.played ? nn(scores) : ''}</span>
    </${canPick ? 'button' : 'div'}>`;
  };
  return `
  <h2 class="sec" style="margin-top:20px">Bracket
    ${hasPins ? `<button class="resetpins" data-act="reset-pins">✕ clear ${Object.keys(S.pins).length} pin${Object.keys(S.pins).length > 1 ? 's' : ''}</button>` : '<span class="lbl">tap a team in an upcoming match to pin a what-if</span>'}
  </h2>
  <div class="bwrap"><div class="bcols">
    ${rs.map(r => `<div class="bcol"><h4>${esc(r.name)}</h4>
      ${r.matches.map(m => `<div class="bm">
        <div class="bdate">${esc(m.date || '')}${m.played ? ' · FT' : ''}</div>
        ${trow(m, m.teamA, m.teamB)}${trow(m, m.teamB, m.teamA)}
        ${m.penalties ? `<div class="pens">${esc((team(m.winner) || {}).name || '')} win ${esc(m.penalties)} on penalties</div>` : ''}
      </div>`).join('')}
    </div>`).join('')}
  </div></div>

  <h2 class="sec">Title probability ${hasPins ? '<span class="lbl gold">what-if applied</span>' : `<span class="lbl">from market odds · ${esc(S.data.meta.oddsSource || '')}</span>`}</h2>
  <div class="card flat">
    ${ranked.map(({ t, p }) => `<div class="prow" style="--ac:${t.accentColor}">
      <span class="fl">${t.flagEmoji}</span>
      <div class="pl"><div class="nm">${esc(t.name)} <small>${t.group ? 'Group ' + esc(t.group) : ''}</small></div>
        <div class="bar"><i style="width:${Math.max(1.2, p / maxp * 100)}%"></i></div></div>
      <span class="pct num">${(p * 100) < 1 ? (p * 100).toFixed(1) : Math.round(p * 100)}%</span>
    </div>`).join('')}
  </div>
  <p class="footnote">Model: pairwise P(A beats B) = S_A/(S_A+S_B); strengths are the winsNeeded-th root of odds-implied title probability, calibrated so the exact bracket propagation reproduces the market numbers before you pin anything. Pin a winner and every downstream number recomputes exactly.</p>`;
}

/* ---------------- MAP ---------------- */
const MAP_W = 1000, MAP_H = 500, MAP_VB = { x: 0, y: 14, w: 1000, h: 392 };
const prj = (lat, lng) => [(lng + 180) / 360 * MAP_W, (90 - lat) / 180 * MAP_H];
// tiny football islands invisible at 110m scale (so pins sit on land)
const MICRO_ISLANDS = [[14.93, -23.51], [15.12, -23.62], [16.09, -22.8]]; // Cabo Verde
function arcPath(a, b) {
  const [x1, y1] = a, [x2, y2] = b;
  const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy) || 1;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const lift = Math.min(60, d * 0.28);
  // perpendicular, biased upward so arcs read like flight paths
  let px = -dy / d, py = dx / d;
  if (py > 0) { px = -px; py = -py; }
  return `M${x1.toFixed(1)} ${y1.toFixed(1)} Q${(mx + px * lift).toFixed(1)} ${(my + py * lift).toFixed(1)} ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}
function journeyPlayers() {
  return S.data.players.filter(p => p.birthplace && p.birthplace.latLng && p.clubLatLng);
}
// ---- camera (Google-Maps-style zoom + pan over the equirectangular projection) ----
const VIEW_W = 1000, VIEW_H = 460, K_MIN = 1, K_MAX = 14;
function mapList() { const solo = S.mapMode !== 'all' && player(S.mapMode); return solo ? [solo] : journeyPlayers(); }
// the viewBox rectangle actually visible in the SVG element (accounts for preserveAspectRatio)
function curVV() { return S.mapVV || { x0: 0, y0: 0, x1: VIEW_W, y1: VIEW_H }; }
function computeVV(svg) {
  try {
    const inv = svg.getScreenCTM().inverse(), r = svg.getBoundingClientRect();
    const tl = new DOMPoint(r.left, r.top).matrixTransform(inv);
    const br = new DOMPoint(r.right, r.bottom).matrixTransform(inv);
    return { x0: tl.x, y0: tl.y, x1: br.x, y1: br.y };
  } catch (_) { return null; }
}
function frameCam(list) {
  const vv = curVV(), VW = vv.x1 - vv.x0, VH = vv.y1 - vv.y0;
  const pts = list.flatMap(p => [prj(...p.birthplace.latLng), prj(...p.clubLatLng)]);
  if (!pts.length) return { k: 1, x: 0, y: 0 };
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  // padding as a fraction of the span so tight (single-player) pairs still zoom in close
  const single = list.length === 1;
  const spanX = Math.max(...xs) - Math.min(...xs), spanY = Math.max(...ys) - Math.min(...ys);
  const padX = single ? Math.max(28, spanX * 1.4) : 55, padY = single ? Math.max(24, spanY * 1.4) : 44;
  const x0 = Math.min(...xs) - padX, x1 = Math.max(...xs) + padX, y0 = Math.min(...ys) - padY, y1 = Math.max(...ys) + padY;
  const bw = Math.max(50, x1 - x0), bh = Math.max(50, y1 - y0);
  const k = Math.max(K_MIN, Math.min(K_MAX, Math.min(VW / bw, VH / bh)));
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const vcx = (vv.x0 + vv.x1) / 2, vcy = (vv.y0 + vv.y1) / 2;
  const cam = { k, x: vcx - k * cx, y: vcy - k * cy };
  clampPan(cam); return cam;
}
function clampPan(c) {
  c.k = Math.max(K_MIN, Math.min(K_MAX, c.k));
  const vv = curVV(), VW = vv.x1 - vv.x0, VH = vv.y1 - vv.y0;
  const coverW = MAP_W * c.k, coverH = MAP_H * c.k;
  // if the map is narrower than the view, center it; otherwise clamp to its edges
  c.x = coverW <= VW ? vv.x0 + (VW - coverW) / 2 : Math.min(vv.x0, Math.max(vv.x1 - coverW, c.x));
  c.y = coverH <= VH ? vv.y0 + (VH - coverH) / 2 : Math.min(vv.y0, Math.max(vv.y1 - coverH, c.y));
}
function applyCam(wrap) {
  const svg = wrap && wrap.querySelector('svg'); if (!svg) return;
  const c = S.cam;
  svg.querySelector('.cam').setAttribute('transform', `translate(${c.x.toFixed(2)} ${c.y.toFixed(2)}) scale(${c.k.toFixed(4)})`);
  svg.querySelectorAll('.mk').forEach(mk => {
    const bx = +mk.dataset.bx, by = +mk.dataset.by;
    mk.setAttribute('transform', `translate(${(c.k * bx + c.x).toFixed(2)} ${(c.k * by + c.y).toFixed(2)})`);
  });
}
function zoomAt(vx, vy, f) {
  const c = S.cam, k2 = Math.max(K_MIN, Math.min(K_MAX, c.k * f));
  const bx = (vx - c.x) / c.k, by = (vy - c.y) / c.k;
  c.x = vx - k2 * bx; c.y = vy - k2 * by; c.k = k2;
  clampPan(c); applyCam($('#jmapwrap'));
}
function bindMap(wrap) {
  if (!wrap || wrap.__bound) return; wrap.__bound = true;
  const svg = wrap.querySelector('svg');
  const toVB = (cx, cy) => { const pt = svg.createSVGPoint(); pt.x = cx; pt.y = cy; return pt.matrixTransform(svg.getScreenCTM().inverse()); };
  // now that the element is laid out, measure the true visible region and (re)frame
  const measure = (reframe) => {
    const vv = computeVV(svg); if (vv) S.mapVV = vv;
    if (reframe || !S.cam) { S.cam = frameCam(mapList()); S.mapDirty = false; } else { clampPan(S.cam); }
    applyCam(wrap);
  };
  measure(S.mapDirty || !S.cam);
  const onResize = () => { if (document.body.contains(wrap)) measure(false); else window.removeEventListener('resize', onResize); };
  window.addEventListener('resize', onResize);
  const pointers = new Map(); let last = null, pinch = 0, moved = 0;
  wrap.addEventListener('pointerdown', e => {
    if (e.target.closest('.mapzoom')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { wrap.setPointerCapture(e.pointerId); } catch (_) {}
    moved = 0; S.__mapDragged = false;
    if (pointers.size === 1) { last = toVB(e.clientX, e.clientY); wrap.classList.add('grabbing'); }
    else if (pointers.size === 2) { const p = [...pointers.values()]; pinch = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y); }
  });
  wrap.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    moved += Math.abs(e.clientX - prev.x) + Math.abs(e.clientY - prev.y);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (moved > 6) S.__mapDragged = true;
    if (pointers.size >= 2) {
      const p = [...pointers.values()], dist = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      if (pinch > 0) { const vb = toVB((p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2); zoomAt(vb.x, vb.y, dist / pinch); }
      pinch = dist;
    } else if (pointers.size === 1 && last) {
      const cur = toVB(e.clientX, e.clientY);
      S.cam.x += cur.x - last.x; S.cam.y += cur.y - last.y; clampPan(S.cam); applyCam(wrap);
      last = toVB(e.clientX, e.clientY);
    }
  });
  const up = e => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    if (pointers.size === 1) { const p = [...pointers.values()][0]; last = toVB(p.x, p.y); }
    if (pointers.size === 0) { last = null; wrap.classList.remove('grabbing'); }
  };
  wrap.addEventListener('pointerup', up); wrap.addEventListener('pointercancel', up);
  wrap.addEventListener('wheel', e => { e.preventDefault(); const vb = toVB(e.clientX, e.clientY); zoomAt(vb.x, vb.y, Math.exp(-e.deltaY * 0.0016)); }, { passive: false });
  wrap.addEventListener('dblclick', e => { e.preventDefault(); const vb = toVB(e.clientX, e.clientY); zoomAt(vb.x, vb.y, 1.8); });
  wrap.addEventListener('click', e => { if (S.__mapDragged) { e.stopPropagation(); e.preventDefault(); } }, true);
}
function vMap() {
  const solo = S.mapMode !== 'all' && player(S.mapMode);
  const list = mapList();
  if (!S.cam) S.cam = frameCam(list);
  const c = S.cam;
  const tf = (bx, by) => `translate(${(c.k * bx + c.x).toFixed(2)} ${(c.k * by + c.y).toFixed(2)})`;
  const G = list.map(p => {
    const t = team(p.teamId) || {}, color = t.accentColor || '#D9B45C';
    const A = prj(...p.birthplace.latLng), B = prj(...p.clubLatLng);
    const dx = B[0] - A[0], dy = B[1] - A[1], d = Math.hypot(dx, dy) || 1;
    const mx = (A[0] + B[0]) / 2, my = (A[1] + B[1]) / 2, lift = Math.min(75, d * 0.28);
    let px = -dy / d, py = dx / d; if (py > 0) { px = -px; py = -py; }
    const C = [mx + px * lift, my + py * lift];
    const path = `M${A[0].toFixed(1)} ${A[1].toFixed(1)} Q${C[0].toFixed(1)} ${C[1].toFixed(1)} ${B[0].toFixed(1)} ${B[1].toFixed(1)}`;
    const ang = Math.atan2(B[1] - C[1], B[0] - C[0]) * 180 / Math.PI;
    return { p, t, A, B, path, ang, color };
  });
  const arcs = G.map(g => `<path class="arcbase" d="${g.path}" style="stroke:${g.color}" vector-effect="non-scaling-stroke"/>` +
    `<path class="arcflow" d="${g.path}" style="stroke:${g.color}" vector-effect="non-scaling-stroke"/>` +
    `<path class="archit" d="${g.path}" data-act="open" data-p="${g.p.id}" vector-effect="non-scaling-stroke"></path>`).join('');
  const markers = G.map(g => {
    const face = g.p.photo
      ? `<circle r="15.5" fill="#0b120e"/><image href="${g.p.photo}" x="-15" y="-15" width="30" height="30" clip-path="url(#faceclip)" preserveAspectRatio="xMidYMid slice"/>`
      : `<circle r="15.5" fill="#101a13"/><text class="ini2">${initials(g.p.name)}</text>`;
    const club = `<g class="mk club" data-bx="${g.B[0].toFixed(1)}" data-by="${g.B[1].toFixed(1)}" transform="${tf(g.B[0], g.B[1])}"><g transform="rotate(${g.ang.toFixed(1)})"><path class="arrowhead" d="M-6 0 L-15 -3.2 L-15 3.2 Z" style="fill:${g.color}"/></g><rect class="club-dia" x="-4.5" y="-4.5" width="9" height="9" transform="rotate(45)"/></g>`;
    const faceMk = `<g class="mk face" data-act="open" data-p="${g.p.id}" data-bx="${g.A[0].toFixed(1)}" data-by="${g.A[1].toFixed(1)}" transform="${tf(g.A[0], g.A[1])}"><circle class="face-ring" r="16.5" style="stroke:${g.color}"/>${face}<title>${esc(g.p.name)} · born ${esc(g.p.birthplace.city)} · plays ${esc(g.p.clubCity || g.p.club || '')}</title></g>`;
    return club + faceMk;
  }).join('');
  return `
  <h2 class="sec" style="margin-top:20px">Journey map <span class="lbl">${solo ? esc(solo.name) : 'born vs plays · drag, zoom, tap a face'}</span></h2>
  <div class="map-toggle">
    <button class="chip ${!solo ? 'on' : ''}" data-act="map-all">${solo ? '← All players' : 'All journeys'}</button>
    ${solo ? `<span class="chip on">${esc(solo.name)}</span>` : ''}
  </div>
  <div class="mapwrap" id="jmapwrap">
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Zoomable map of player journeys">
      <defs><clipPath id="faceclip"><circle r="15"/></clipPath></defs>
      <g class="cam" transform="translate(${c.x.toFixed(2)} ${c.y.toFixed(2)}) scale(${c.k.toFixed(4)})">
        <rect x="-400" y="-400" width="1800" height="1300" fill="#0A120C"/>
        <path d="${LAND}" fill="#16241b" stroke="#2C4234" stroke-width="0.7" vector-effect="non-scaling-stroke" fill-rule="evenodd"/>
        ${MICRO_ISLANDS.map(([la, ln]) => { const [x, y] = prj(la, ln); return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.4" fill="#16241b" stroke="#2C4234" stroke-width="0.5" vector-effect="non-scaling-stroke"/>`; }).join('')}
        <g class="arclayer">${arcs}</g>
      </g>
      <g class="markers">${markers}</g>
    </svg>
    <div class="mapzoom">
      <button data-act="map-zin" aria-label="Zoom in">+</button>
      <button data-act="map-zout" aria-label="Zoom out">−</button>
      <button data-act="map-reset" aria-label="Reset view">⤢</button>
    </div>
    <div class="maphint">drag to move · scroll or pinch to zoom · tap a face</div>
  </div>
  <div class="maplegend">
    <span><i class="lg-face"></i>birthplace (player face)</span>
    <span><i style="background:#EAF1EB;border-radius:2px;transform:rotate(45deg)"></i>club city</span>
    <span><i class="lg-arrow"></i>arrow points to where they play</span>
  </div>
  ${solo ? `<div class="card flat" style="margin-top:10px">
      <b>${(team(solo.teamId) || {}).flagEmoji || ''} ${esc(solo.name)}</b>
      <p style="color:var(--muted);font-size:13.5px;margin-top:4px">Born in ${esc(solo.birthplace.city)}, ${esc(solo.birthplace.country)}. Club football at ${esc(solo.club || '?')}${solo.clubCity && solo.clubCity !== solo.club ? ' in ' + esc(solo.clubCity) : ''}. Wears the shirt of ${esc((team(solo.teamId) || {}).name || '')} this summer.</p>
      <button class="btn ghost" style="margin-top:10px" data-act="open" data-p="${solo.id}">Open profile</button>
    </div>` : ''}`;
}

/* ---------------- DIGEST + REFRESH ---------------- */
function leverage() {
  // find the upcoming decided-participant match whose result swings title probs the most
  const base = SIM.titleProbs(S.pins);
  let best = null;
  for (const r of SIM.rounds()) {
    for (const m of r.matches) {
      if (m.played || !m.teamA || !m.teamB || S.pins[m.id]) continue;
      for (const tid of [m.teamA, m.teamB]) {
        const probs = SIM.titleProbs({ ...S.pins, [m.id]: tid });
        let swing = 0;
        for (const k in probs) swing += Math.abs((probs[k] || 0) - (base[k] || 0));
        for (const k in base) if (!(k in probs)) swing += base[k];
        if (!best || swing > best.swing) best = { m, tid, swing, probs, base, round: r.name };
      }
    }
  }
  return best;
}
function buildDigest() {
  const pts = [];
  const s0 = (S.data.stories || [])[0];
  if (s0) pts.push(`<b>${esc(s0.headline)}.</b> ${esc(s0.detail)}`);
  const sc = (S.data.leaders.topScorers || [])[0];
  if (sc) {
    const p = S.data.players.find(x => x.name === sc.name);
    const extra = p && p.watchBecause ? ' ' + esc(p.watchBecause) : '';
    pts.push(`<b>The hottest player is ${esc(sc.name)}</b> (${esc(sc.team)}): ${nn(sc.goals)} goals${sc.assists ? ' and ' + sc.assists + (sc.assists === 1 ? ' assist' : ' assists') : ''} so far.${extra}`);
  }
  const lev = leverage();
  if (lev) {
    const t = team(lev.tid), tOther = team(lev.m.teamA === lev.tid ? lev.m.teamB : lev.m.teamA);
    const before = Math.round((lev.base[lev.tid] || 0) * 100), after = Math.round((lev.probs[lev.tid] || 0) * 100);
    pts.push(`<b>Sharpest what-if: ${esc(t.name)} vs ${esc(tOther.name)}</b> (${esc(lev.round)}). If ${esc(t.name)} win, their title chances move from ${before}% to ${after}%, the single biggest swing left on the board. Try pinning it in the bracket.`);
  }
  return pts;
}
async function aiDigest() {
  const facts = { stage: S.data.meta.stage, asOf: S.data.meta.asOf, stories: (S.data.stories || []).slice(0, 3), topScorers: (S.data.leaders.topScorers || []).slice(0, 3), gk: (S.data.leaders.gkLeaders || []).slice(0, 2) };
  const prompt = `You are writing a 60-second World Cup 2026 briefing for a smart adult who is new to soccer. From ONLY these verified facts, write exactly 3 punchy talking points, 1-2 sentences each, conversational, no hedging, no markdown. Respond with ONLY valid JSON: {"points":["...","...","..."]}. No prose, no markdown fences. FACTS: ${JSON.stringify(facts)}`;
  const out = await callClaude(prompt);
  const j = JSON.parse(stripFences(out));
  if (!j.points || j.points.length < 3) throw new Error('bad shape');
  S.digest = { points: j.points.map(x => `<b>${esc(x.split('.')[0])}.</b> ${esc(x.split('.').slice(1).join('.').trim())}`), ai: true };
}
function vDigest() {
  const pts = S.digest ? S.digest.points : buildDigest();
  const busy = k => S.busy[k] ? '<span class="spin"></span>' : '';
  return `
  <h2 class="sec" style="margin-top:20px">Catch me up <span class="lbl">60 seconds, then go talk football</span></h2>
  <div class="card digest">
    ${pts.map((p, i) => `<div class="pt"><span class="ic num">${i + 1}</span><p>${p}</p></div>`).join('')}
    <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
      <button class="btn ghost" data-act="digest-rebuild">↻ Rebuild from data</button>
      <button class="btn" data-act="digest-ai" ${S.busy.ai ? 'disabled' : ''}>${busy('ai')}✨ AI version</button>
    </div>
    ${S.digest && S.digest.ai ? '<p class="footnote">AI phrasing of the same verified facts.</p>' : ''}
  </div>

  <h2 class="sec">Refresh data <span class="lbl">chunked, graceful</span></h2>
  <div class="card flat">
    <div class="refresh-row"><div class="t"><b>Results &amp; bracket</b><span>Latest scores, eliminations, updated title odds</span></div>
      <button class="btn ghost" data-act="rf-results" ${S.busy.results ? 'disabled' : ''}>${busy('results')}Refresh</button></div>
    <div class="refresh-row"><div class="t"><b>Leaders</b><span>Scorer, assist and goalkeeper tables</span></div>
      <button class="btn ghost" data-act="rf-leaders" ${S.busy.leaders ? 'disabled' : ''}>${busy('leaders')}Refresh</button></div>
    <div class="refresh-row"><div class="t"><b>Storylines</b><span>Fresh angles for your ${S.follows.size} followed player${S.follows.size === 1 ? '' : 's'}</span></div>
      <button class="btn ghost" data-act="rf-stories" ${S.busy.stories ? 'disabled' : ''}>${busy('stories')}Refresh</button></div>
    <p class="footnote">${asofHtml()} · Live refresh calls Claude with web search${S.apiKey ? '' : ' — <button class="linklike" data-act="settings">add your API key</button> to enable it'}. If a call fails you keep the data you have, always.</p>
  </div>`;
}

/* ---------------- Anthropic API plumbing ----------------
   Two call paths:
   (a) claude.ai artifact runtime: key handled by the environment, no header needed.
   (b) self-hosted (GitHub Pages etc.): user supplies their own key, sent with the
       anthropic-dangerous-direct-browser-access header so the browser call is allowed.
   The key lives only in this browser's IndexedDB, never in the code. */
function stripFences(s) { return s.replace(/```json\s*|```/g, '').trim(); }
async function callClaude(prompt, opts) {
  opts = opts || {};
  const body = {
    model: opts.model || 'claude-sonnet-4-6',
    max_tokens: opts.maxTokens || 1000,
    messages: [{ role: 'user', content: prompt }],
  };
  if (opts.system) body.system = opts.system;
  if (opts.useSearch) body.tools = [{ type: 'web_search_20250305', name: 'web_search' }];
  const headers = { 'Content-Type': 'application/json' };
  if (S.apiKey) {
    headers['x-api-key'] = S.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error('Could not reach the AI service from this page. On a self-hosted site, add your Anthropic API key in Settings.');
  }
  if (res.status === 401 || res.status === 403) throw new Error('Your API key was rejected. Check it in Settings.');
  if (res.status === 429) throw new Error('Rate limited by the API. Wait a moment and try again.');
  if (!res.ok) throw new Error('AI service error (' + res.status + ').');
  const data = await res.json();
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
}
async function persistBlob() {
  try { await storageAPI.set('wc26-data', JSON.stringify(S.data)); } catch (e) { /* keep in memory */ }
}
function nowStamp() {
  const d = new Date();
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) + ', ~' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}
const REFRESHERS = {
  async results() {
    const fixtures = SIM.rounds().flatMap(r => r.matches.filter(m => !m.played && m.teamA && m.teamB).map(m => ({ id: m.id, teams: (team(m.teamA) || {}).name + ' vs ' + (team(m.teamB) || {}).name })));
    const prompt = `Web-search the CURRENT state of the 2026 FIFA World Cup knockout stage. These fixtures were upcoming as of ${S.data.meta.asOf}: ${JSON.stringify(fixtures)}. Respond with ONLY valid JSON matching this schema, no prose, no markdown fences: {"stage":"...","results":[{"id":"<same id>","scoreA":0,"scoreB":0,"penalties":null,"winnerName":"..."}],"titleOddsPct":[{"team":"...","impliedPct":0}]} . Only include fixtures that have actually been played. titleOddsPct = current implied win probability for every team still alive.`;
    const j = JSON.parse(stripFences(await callClaude(prompt, { useSearch: true })));
    for (const r of j.results || []) {
      for (const rd of SIM.rounds()) for (const m of rd.matches) if (m.id === r.id) {
        const wt = S.data.teams.find(t => t.name === r.winnerName);
        if (!wt) continue;
        m.scoreA = r.scoreA; m.scoreB = r.scoreB; m.penalties = r.penalties || null; m.winner = wt.id; m.played = true;
        const lt = m.teamA === wt.id ? team(m.teamB) : team(m.teamA);
        if (lt) { lt.status = 'eliminated'; lt.eliminatedBy = wt.name; }
        // advance winner into next round slot
        const ri = SIM.rounds().indexOf(rd), mi = rd.matches.indexOf(m);
        const nxt = SIM.rounds()[ri + 1]; if (nxt) { const nm = nxt.matches[Math.floor(mi / 2)]; if (nm) { if (mi % 2 === 0) nm.teamA = wt.id; else nm.teamB = wt.id; } }
      }
    }
    for (const o of j.titleOddsPct || []) { const t = S.data.teams.find(t2 => t2.name === o.team); if (t && alive(t)) t.titleProbability = o.impliedPct; }
    if (j.stage) S.data.meta.stage = j.stage;
    S.strengths = null; S.pins = {};
  },
  async leaders() {
    const prompt = `Web-search the 2026 FIFA World Cup tournament stats leaders RIGHT NOW. Respond with ONLY valid JSON, no prose, no markdown fences: {"topScorers":[{"name":"","team":"","goals":0,"assists":0}],"topAssists":[{"name":"","team":"","assists":0,"goals":0}],"gkLeaders":[{"name":"","team":"","saves":0,"cleanSheets":0,"goalsConceded":0}]} . Top 6 of each, tournament stats only, null for anything unverified.`;
    const j = JSON.parse(stripFences(await callClaude(prompt, { useSearch: true })));
    if (j.topScorers) S.data.leaders.topScorers = j.topScorers;
    if (j.topAssists) S.data.leaders.topAssists = j.topAssists;
    if (j.gkLeaders) S.data.leaders.gkLeaders = j.gkLeaders;
  },
  async stories() {
    const fols = [...S.follows].map(id => player(id)).filter(Boolean).slice(0, 6);
    if (!fols.length) throw new Error('Follow a player first, then refresh their storylines.');
    const names = fols.map(p => p.name + ' (' + ((team(p.teamId) || {}).name || '') + ')');
    const prompt = `Web-search what is being said RIGHT NOW at the 2026 World Cup about: ${names.join('; ')}. Respond with ONLY valid JSON, no prose, no markdown fences: {"players":[{"name":"","watchBecause":"one line","storylines":["...","..."]}]} . Conversational, specific, 2 storylines each, no em-dashes.`;
    const j = JSON.parse(stripFences(await callClaude(prompt, { useSearch: true })));
    for (const u of j.players || []) {
      const p = S.data.players.find(x => x.name === u.name || x.name.includes(u.name));
      if (p) { if (u.watchBecause) p.watchBecause = u.watchBecause; if (u.storylines && u.storylines.length) p.storylines = u.storylines; }
    }
  },
};
async function runRefresh(key) {
  S.busy[key] = true; render();
  try {
    await REFRESHERS[key]();
    S.data.meta.asOf = nowStamp();
    await persistBlob();
    S.busy[key] = false; S.digest = null;
    render();
    toast('Updated. Data as of ' + S.data.meta.asOf);
  } catch (e) {
    S.busy[key] = false; render();
    toast('Refresh failed, showing data as of ' + S.data.meta.asOf, true);
  }
}

/* ================================================================
   Q&A NOTEBOOK, ADD-PLAYER, SETTINGS  (all AI-powered, key-gated)
   ================================================================ */
function slugify(name) {
  return (name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function saveFollows() { storageAPI.set('wc26-follows', JSON.stringify([...S.follows])).catch(() => {}); }
function saveLearned() { storageAPI.set('wc26-learned', JSON.stringify(S.learned)).catch(() => {}); }
function saveCustom() {
  const customs = S.data.players.filter(p => p.custom);
  storageAPI.set('wc26-custom', JSON.stringify(customs)).catch(() => {});
  const customTeams = S.data.teams.filter(t => t.custom);
  storageAPI.set('wc26-custom-teams', JSON.stringify(customTeams)).catch(() => {});
}

/* --- Ask about a player; the succinct fact grows the profile over time --- */
async function askAboutPlayer(pid, question) {
  const p = player(pid);
  question = (question || '').trim();
  if (!p || !question) return;
  S.qa[pid] = { busy: true }; render();
  try {
    const t = team(p.teamId) || {};
    const ctx = {
      name: p.name, team: t.name, position: p.position, club: p.club,
      knownFor: p.knownFor, thisWorldCup: p.stats, storylines: p.storylines,
      alreadyKnow: (S.learned[pid] || []).map(f => f.fact),
    };
    const prompt = `Here is context on a 2026 World Cup player as of ${S.data.meta.asOf}: ${JSON.stringify(ctx)}.\n\nThe user asks: "${question}"\n\nUse web search for anything current (injuries, latest match, transfers). Respond with ONLY valid JSON, no markdown fences: {"answer":"2 to 4 conversational sentences that actually answer the question, specific, no em-dashes","fact":"one standalone sentence under 16 words capturing the single key takeaway to save to their profile"}.`;
    const out = await callClaude(prompt, { useSearch: true, maxTokens: 1500, system: 'You are a sharp, friendly football expert catching up a smart newcomer. Be concrete, current, and never use em-dashes.' });
    let j; try { j = JSON.parse(stripFences(out)); } catch (_) { j = { answer: stripFences(out), fact: '' }; }
    const answer = (j.answer || '').trim() || 'No answer came back. Try rephrasing.';
    const fact = (j.fact || '').trim();
    S.qa[pid] = { answer, savedFact: fact || null };
    if (fact) {
      (S.learned[pid] = S.learned[pid] || []);
      S.learned[pid].unshift({ q: question, a: answer, fact, at: Date.now() });
      saveLearned();
    }
  } catch (e) {
    S.qa[pid] = { error: e.message || 'Something went wrong.' };
  }
  render();
}

/* --- Add a brand-new player to track, researched on demand --- */
function buildCustomPlayer(j) {
  let t = S.data.teams.find(x => x.name.toLowerCase() === (j.nationalTeam || '').toLowerCase());
  if (!t) {
    t = {
      id: 'X-' + (slugify(j.nationalTeam || 'unknown').toUpperCase().replace(/-/g, '').slice(0, 8) || 'CUSTOM'),
      name: j.nationalTeam || 'Unknown', flagEmoji: '🏳️', group: null,
      status: j.teamStatus === 'eliminated' ? 'eliminated' : (j.teamStatus === 'not in tournament' ? 'eliminated' : 'alive'),
      eliminatedBy: null, titleProbability: null, strength: 0, accentColor: '#D9B45C', custom: true, notInBracket: true,
    };
    S.data.teams.push(t);
  }
  const pos = ['GK', 'DEF', 'MID', 'FWD'].includes(j.position) ? j.position : 'MID';
  const s = j.stats || {};
  const stats = pos === 'GK'
    ? { saves: s.saves ?? null, cleanSheets: s.cleanSheets ?? null, goalsConceded: s.goalsConceded ?? null, matchesPlayed: s.matchesPlayed ?? null }
    : pos === 'DEF'
      ? { matchesPlayed: s.matchesPlayed ?? null, goals: s.goals ?? null, assists: s.assists ?? null, cleanSheets: s.cleanSheets ?? null }
      : { goals: s.goals ?? null, assists: s.assists ?? null, shots: s.shots ?? null, matchesPlayed: s.matchesPlayed ?? null };
  return {
    id: slugify(j.name), name: j.name, teamId: t.id, tier: 2, custom: true, position: pos,
    age: j.age ?? null, number: j.number ?? null, club: j.club || null, league: j.league || null,
    clubCity: j.clubCity || null, clubCountry: j.clubCountry || null,
    clubLatLng: Array.isArray(j.clubLatLng) && j.clubLatLng.length === 2 ? j.clubLatLng : null,
    birthplace: (j.birthCity && Array.isArray(j.birthLatLng) && j.birthLatLng.length === 2)
      ? { city: j.birthCity, country: j.birthCountry, latLng: j.birthLatLng } : null,
    knownFor: j.knownFor || '', watchBecause: j.watchBecause || '',
    storylines: Array.isArray(j.storylines) ? j.storylines.slice(0, 3) : [], stats, photo: null,
  };
}
async function submitAddPlayer(name, teamHint) {
  name = (name || '').trim();
  if (!name) return;
  S.addPlayer = { busy: true, error: null }; render();
  try {
    const existing = S.data.players.find(p => p.id === slugify(name));
    if (existing) { S.addPlayer = { busy: false, error: null }; S.sheetOverlay = null; S.modal = existing.id; render(); toast('Already tracking ' + existing.name + '.'); return; }
    const prompt = `Research the footballer "${name}"${teamHint ? ' (team hint: ' + teamHint + ')' : ''} for a 2026 FIFA World Cup companion app. Use web search. Today is ${S.data.meta.asOf}. Respond with ONLY valid JSON, no markdown fences: {"name":"","nationalTeam":"","teamStatus":"alive|eliminated|not in tournament","position":"GK|DEF|MID|FWD","number":null,"age":null,"club":"","league":"","clubCity":"","clubCountry":"","clubLatLng":[lat,lng],"birthCity":"","birthCountry":"","birthLatLng":[lat,lng],"knownFor":"one crisp line","watchBecause":"one line on why to watch him now","storylines":["1 to 2 sentences","1 to 2 sentences"],"stats":{"matchesPlayed":null,"goals":null,"assists":null,"saves":null,"cleanSheets":null,"goalsConceded":null,"shots":null}}. clubLatLng and birthLatLng are approximate city coordinates. Stats are THIS 2026 World Cup only; use null for anything you cannot verify. No em-dashes.`;
    const j = JSON.parse(stripFences(await callClaude(prompt, { useSearch: true, maxTokens: 1500 })));
    if (!j.name) throw new Error('Could not find that player. Try a fuller name or add a team hint.');
    const p = buildCustomPlayer(j);
    S.data.players.push(p);
    S.follows.add(p.id); saveFollows();
    saveCustom(); persistBlob();
    S.addPlayer = { busy: false, error: null }; S.sheetOverlay = null; S.view = 'players'; S.modal = p.id;
    render();
    toast('Added ' + p.name + ' — now following.');
    fetchWikiPhoto(p.name).then(uri => { if (uri) { p.photo = uri; saveCustom(); persistBlob(); if (S.modal === p.id) render(); } });
  } catch (e) {
    S.addPlayer = { busy: false, error: e.message || 'Research failed.' }; render();
  }
}
function removeCustomPlayer(pid) {
  const p = player(pid); if (!p || !p.custom) return;
  S.data.players = S.data.players.filter(x => x.id !== pid);
  S.follows.delete(pid); delete S.learned[pid]; delete S.qa[pid];
  saveFollows(); saveLearned(); saveCustom(); persistBlob();
  S.modal = null; render();
  toast('Removed ' + p.name + '.');
}
async function fetchWikiPhoto(name) {
  const loadImg = src => new Promise((res, rej) => {
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => res(img); img.onerror = rej; img.src = src;
  });
  for (const t of [name, name + ' (footballer)']) {
    try {
      const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(t.replace(/ /g, '_')));
      if (!r.ok) continue;
      const j = await r.json();
      if (j.type === 'disambiguation') continue;
      const src = (j.thumbnail || {}).source; if (!src) continue;
      const img = await loadImg(src);
      const cv = document.createElement('canvas'); cv.width = 120; cv.height = 120;
      const s = Math.min(img.width, img.height);
      cv.getContext('2d').drawImage(img, (img.width - s) / 2, 0, s, s, 0, 0, 120, 120);
      return cv.toDataURL('image/jpeg', 0.7);
    } catch (_) { /* try next title */ }
  }
  return null;
}

/* --- Settings (API key) --- */
async function saveKey(k) {
  k = (k || '').trim();
  S.apiKey = k || null;
  try { if (k) await storageAPI.set('wc26-apikey', k); else await storageAPI.set('wc26-apikey', ''); } catch (_) {}
}
function vSettings() {
  const keyed = !!S.apiKey;
  const masked = keyed ? S.apiKey.slice(0, 7) + '…' + S.apiKey.slice(-4) : '';
  return `<div class="overlay" data-act="close-ov2" role="dialog" aria-modal="true" aria-label="Settings">
    <article class="sheet" style="--ac:var(--gold)">
      <div class="grab"><span class="lbl gold">Settings</span><button class="x" data-act="close-ov2" aria-label="Close">✕</button></div>
      <div class="sheet-body">
      <h3 style="font-family:var(--disp);font-weight:400;font-size:22px;letter-spacing:.02em;text-transform:uppercase">AI features</h3>
      <p style="color:var(--muted);font-size:13.5px;margin:8px 0 14px">The <b>Ask about a player</b>, <b>Track a new player</b>, <b>AI digest</b>, and <b>Refresh</b> features call Claude live. On your own website they use your personal Anthropic API key, stored only in this browser and never in the code or shared.</p>
      <div class="keyfield">
        <input id="apikey-input" type="password" placeholder="sk-ant-..." value="" aria-label="Anthropic API key" autocomplete="off">
        <button class="btn" data-act="save-key">Save</button>
      </div>
      <p class="footnote">${keyed ? `<span style="color:var(--live)">✓ Key saved (${esc(masked)}).</span> <button class="linklike" data-act="clear-key">Remove key</button>` : 'No key set. AI features are off; everything else works fully.'}</p>
      <div class="hairline"></div>
      <p style="color:var(--muted);font-size:13px;line-height:1.6">Get a key at <b>console.anthropic.com</b> → API Keys. A question costs well under a cent. The key stays on your device; requests go straight from your browser to Anthropic.</p>
      <div class="hairline"></div>
      <span class="lbl">Your data</span>
      <p style="color:var(--muted);font-size:13px;margin-top:6px">Follows, saved answers and players you have added live in this browser. <button class="linklike" data-act="wipe">Reset everything on this device</button></p>
      </div>
    </article></div>`;
}
function vAddPlayer() {
  const st = S.addPlayer;
  return `<div class="overlay" data-act="close-ov2" role="dialog" aria-modal="true" aria-label="Track a new player">
    <article class="sheet" style="--ac:var(--gold)">
      <div class="grab"><span class="lbl gold">Track a new player</span><button class="x" data-act="close-ov2" aria-label="Close">✕</button></div>
      <div class="sheet-body">
      <p style="color:var(--muted);font-size:13.5px;margin-bottom:14px">Name anyone at the World Cup and Pitch IQ will research a full profile, add them to your grid, and start following them.</p>
      ${!S.apiKey ? `<button class="qa-keyhint" data-act="settings" style="margin-bottom:12px">This needs your Anthropic API key. Add one →</button>` : ''}
      <div class="addform">
        <input id="ap-name" type="text" placeholder="Player name (e.g. Nico Williams)" ${S.apiKey && !st.busy ? '' : 'disabled'} aria-label="Player name">
        <input id="ap-team" type="text" placeholder="Team (optional, helps disambiguate)" ${S.apiKey && !st.busy ? '' : 'disabled'} aria-label="Team hint">
        <button class="btn" data-act="do-add" ${S.apiKey && !st.busy ? '' : 'disabled'}>${st.busy ? '<span class="spin"></span> Researching…' : 'Research & add'}</button>
      </div>
      ${st.error ? `<p class="qa-err">${esc(st.error)}</p>` : ''}
      ${st.busy ? '<p class="footnote">Searching the web and building the profile. This takes a few seconds.</p>' : ''}
      </div>
    </article></div>`;
}

/* ---------------- events ---------------- */
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  if (act === 'view') { S.view = el.dataset.v; S.modal = null; render(); window.scrollTo(0, 0); }
  else if (act === 'open') { if (el.dataset.p) { S.modal = el.dataset.p; render(); } }
  else if (act === 'close') { S.modal = null; render(); }
  else if (act === 'close-ov') { if (e.target === el) { S.modal = null; render(); } }
  else if (act === 'follow') {
    const id = el.dataset.p;
    S.follows.has(id) ? S.follows.delete(id) : S.follows.add(id);
    storageAPI.set('wc26-follows', JSON.stringify([...S.follows])).catch(() => {});
    render();
  }
  else if (act === 'journey') { S.mapMode = el.dataset.p; S.cam = null; S.mapDirty = true; S.modal = null; S.view = 'map'; render(); window.scrollTo(0, 0); }
  else if (act === 'map-all') { S.mapMode = 'all'; S.cam = null; S.mapDirty = true; render(); }
  else if (act === 'map-zin') { const v = curVV(); zoomAt((v.x0 + v.x1) / 2, (v.y0 + v.y1) / 2, 1.7); }
  else if (act === 'map-zout') { const v = curVV(); zoomAt((v.x0 + v.x1) / 2, (v.y0 + v.y1) / 2, 1 / 1.7); }
  else if (act === 'map-reset') { S.cam = frameCam(mapList()); applyCam($('#jmapwrap')); }
  else if (act === 'pin') {
    const mid = el.dataset.m, tid = el.dataset.t;
    if (S.pins[mid] === tid) delete S.pins[mid]; else S.pins[mid] = tid;
    render();
  }
  else if (act === 'reset-pins') { S.pins = {}; render(); }
  else if (act === 'digest-rebuild') { S.digest = null; render(); }
  else if (act === 'digest-ai') {
    S.busy.ai = true; render();
    aiDigest().then(() => { S.busy.ai = false; render(); })
      .catch(err => { S.busy.ai = false; render(); toast(err && err.message ? err.message : 'AI phrasing unavailable, showing the data-built digest.', true); });
  }
  else if (act === 'rf-results') runRefresh('results');
  else if (act === 'rf-leaders') runRefresh('leaders');
  else if (act === 'rf-stories') runRefresh('stories');
  // --- new: settings / add-player / Q&A ---
  else if (act === 'settings') { S.sheetOverlay = 'settings'; render(); }
  else if (act === 'add-player') { S.addPlayer = { busy: false, error: null }; S.sheetOverlay = 'add-player'; render(); }
  else if (act === 'close-ov2') { if (e.target === el || el.classList.contains('x')) { S.sheetOverlay = null; render(); } }
  else if (act === 'save-key') { const v = ($('#apikey-input') || {}).value || ''; saveKey(v).then(() => { render(); toast(v.trim() ? 'API key saved on this device.' : 'Key cleared.'); }); }
  else if (act === 'clear-key') { saveKey('').then(() => { render(); toast('Key removed.'); }); }
  else if (act === 'wipe') {
    ['wc26-data', 'wc26-follows', 'wc26-learned', 'wc26-custom', 'wc26-custom-teams', 'wc26-apikey'].forEach(k => storageAPI.set(k, '').catch(() => {}));
    toast('Reset. Reloading…'); setTimeout(() => window.location.reload(), 700);
  }
  else if (act === 'do-add') { submitAddPlayer(($('#ap-name') || {}).value, ($('#ap-team') || {}).value); }
  else if (act === 'qa-ask') { askAboutPlayer(el.dataset.p, ($('#qa-input') || {}).value); }
  else if (act === 'learn-clear') { const id = el.dataset.p; delete S.learned[id]; if (S.qa[id]) delete S.qa[id].savedFact; saveLearned(); render(); }
  else if (act === 'remove-player') { removeCustomPlayer(el.dataset.p); }
});
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { if (S.sheetOverlay) { S.sheetOverlay = null; render(); } else if (S.modal) { S.modal = null; render(); } }
  if (e.key === 'Enter') {
    if (e.target.id === 'qa-input') { askAboutPlayer(e.target.dataset.p || S.modal, e.target.value); }
    else if (e.target.id === 'ap-name' || e.target.id === 'ap-team') { submitAddPlayer(($('#ap-name') || {}).value, ($('#ap-team') || {}).value); }
    else if (e.target.id === 'apikey-input') { saveKey(e.target.value).then(() => { render(); toast('API key saved.'); }); }
  }
});
document.addEventListener('input', e => {
  if (e.target.id === 'psearch') {
    S.filters.q = e.target.value;
    const g = $('#pgrid'); if (g) g.innerHTML = playersList();
  }
});
document.addEventListener('change', e => {
  const f = e.target.closest('[data-flt]');
  if (f) { S.filters[f.dataset.flt] = f.value; const g = $('#pgrid'); if (g) g.innerHTML = playersList(); }
  else if (e.target.id === 'psort') { S.sort = e.target.value; const g = $('#pgrid'); if (g) g.innerHTML = playersList(); }
});
function afterRender() {
  // keep the Q&A input addressable by Enter-to-ask
  const qi = $('#qa-input'); if (qi && S.modal) qi.dataset.p = S.modal;
  if (S.view === 'map') { const wrap = $('#jmapwrap'); if (wrap) bindMap(wrap); }
}

/* ---------------- boot ---------------- */
async function load(key) { try { const r = await storageAPI.get(key); return r.value ? JSON.parse(r.value) : null; } catch (e) { return null; } }
(async function boot() {
  // stored data blob wins only if it is the same data revision (a code update bumps meta.rev)
  const saved = await load('wc26-data');
  if (saved && saved.meta && saved.meta.asOf && saved.meta.rev === DATA.meta.rev) S.data = saved;

  const follows = await load('wc26-follows'); if (Array.isArray(follows)) S.follows = new Set(follows);
  const learned = await load('wc26-learned'); if (learned && typeof learned === 'object') S.learned = learned;
  try { const k = await storageAPI.get('wc26-apikey'); if (k.value) S.apiKey = k.value; } catch (e) { /* none */ }

  // re-attach the player-added-by-you and their teams (survive data-rev bumps)
  const customTeams = await load('wc26-custom-teams');
  if (Array.isArray(customTeams)) for (const t of customTeams) if (!S.data.teams.some(x => x.id === t.id)) S.data.teams.push(t);
  const customs = await load('wc26-custom');
  if (Array.isArray(customs)) for (const p of customs) if (!S.data.players.some(x => x.id === p.id)) S.data.players.push(p);

  render();
})();
