// Token Radar v3 page: renders the board from data.js, filters it, sorts it and
// opens a detail view per protocol. No network, no framework: plain DOM code.
// The screenshot states are addressable: #detail=<slug>, #cat=<category>,
// #chain=<chain>, #watch=1, #q=<text> preset the same controls a reader uses.

(function () {
  const data = window.TOKEN_RADAR;
  const meta = data.meta;
  const rows = data.rows;
  const maxImplied = Math.max(...rows.map((r) => r.implied_value_usd));

  const $ = (id) => document.getElementById(id);
  const els = {
    topmeta: $('topmeta'),
    lede: $('lede'),
    stats: $('stats'),
    method: $('method'),
    q: $('q'),
    cat: $('cat'),
    chain: $('chain'),
    tvl: $('tvl'),
    watch: $('watch'),
    count: $('count'),
    rows: $('rows'),
    empty: $('empty'),
    foot: $('foot'),
    drawer: $('drawer'),
    drawerRank: $('drawer-rank'),
    drawerBody: $('drawer-body'),
    drawerClose: $('drawer-close'),
  };

  function fmtUsd(v) {
    if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
    if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
    return `$${v.toFixed(0)}`;
  }
  function fmtPct(g) {
    if (g === null || g === undefined) return '—';
    const sign = g > 0 ? '+' : '';
    return `${sign}${g.toFixed(2)}%`;
  }
  function fmtAge(days) {
    if (days === null || days === undefined) return '—';
    if (days >= 365) return `${(days / 365).toFixed(1)}y`;
    return `${days}d`;
  }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Header, stats and methodology: all numbers come from the same data as the table.
  els.topmeta.innerHTML =
    `<span>Snapshot ${esc(meta.as_of)}</span><span>DefiLlama protocol index</span>` +
    `<span>${esc(meta.model)} model</span>`;
  els.lede.textContent =
    'The watchlist is the floor: every protocol with at least $50M of TVL and no token ' +
    'on record. The radar ranks all 198 rankable pre-token protocols — the 40 on the ' +
    'watchlist plus 158 more the list leaves out. Implied value is fitted from traded peers, not a promise.';
  const statPairs = [
    ['Watchlist covered', `${meta.watchlist_size} / ${meta.watchlist_size}`],
    ['Pre-token rows ranked', String(meta.rows)],
    ['Out-of-sample error', `x${meta.oos_median_factor.toFixed(2)}`],
    ['Traded peers fitted', String(meta.peers_used)],
    ['Families', String(meta.families.length)],
  ];
  els.stats.innerHTML = statPairs
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`)
    .join('');
  els.method.textContent =
    `Model ${meta.model}: implied value = TVL x a multiple from a size curve fitted on ` +
    `${meta.peers_used} traded peers, shifted by the protocol's family. Out-of-sample error ` +
    `x${meta.oos_median_factor.toFixed(2)} (5-fold). The 7-day TVL change and the protocol age ` +
    `were tested as predictors and do not move the value.`;
  els.foot.innerHTML =
    `<p>${esc(meta.methodology)}</p>` +
    `<p>Implied values are estimates from one snapshot, not prices and not a promise of a ` +
    `token. A protocol is ranked only when the snapshot records no token for it; the record ` +
    `is not proof it has none.</p>`;

  // Controls: categories and chains come from the board itself, in first-seen order.
  const categories = [];
  const chains = [];
  for (const r of rows) {
    if (r.category && !categories.includes(r.category)) categories.push(r.category);
    for (const c of r.chains) if (!chains.includes(c)) chains.push(c);
  }
  for (const c of categories) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    els.cat.appendChild(opt);
  }
  for (const c of chains) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    els.chain.appendChild(opt);
  }

  const state = { sortKey: 'rank', sortDir: 1 };

  function visibleRows() {
    const q = els.q.value.trim().toLowerCase();
    const cat = els.cat.value;
    const chain = els.chain.value;
    const tvl = els.tvl.value;
    const watchOnly = els.watch.checked;
    let out = rows.filter((r) => {
      if (watchOnly && !r.watchlist) return false;
      if (cat && r.category !== cat) return false;
      if (chain && !r.chains.includes(chain)) return false;
      if (tvl === 'big' && r.tvl_usd < 500_000_000) return false;
      if (tvl === 'mid' && (r.tvl_usd < 50_000_000 || r.tvl_usd >= 500_000_000)) return false;
      if (tvl === 'small' && r.tvl_usd >= 50_000_000) return false;
      if (q) {
        const hay = `${r.name} ${r.slug} ${r.category ?? ''} ${r.chains.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const key = state.sortKey;
    const dir = state.sortDir;
    const num = (r) => {
      const v = r[key];
      return v === null || v === undefined ? (dir === 1 ? Infinity : -Infinity) : v;
    };
    out = [...out].sort((a, b) => {
      if (key === 'name') return dir * String(a.name).localeCompare(String(b.name));
      return dir * (num(a) - num(b));
    });
    return out;
  }

  function render() {
    const list = visibleRows();
    els.count.textContent = `${list.length} of ${rows.length} rows shown`;
    els.empty.hidden = list.length !== 0;
    els.rows.innerHTML = list
      .map((r) => {
        const pct = fmtPct(r.change_7d);
        const pctClass = r.change_7d === null ? '' : r.change_7d >= 0 ? 'up' : 'down';
        const width = Math.max(2, Math.round((r.implied_value_usd / maxImplied) * 100));
        const sub = `${esc(r.category ?? 'Uncategorised')} on ${esc(r.chains.slice(0, 2).join(', '))}`;
        return `<tr data-slug="${esc(r.slug)}">` +
          `<td class="rank">${r.rank}</td>` +
          `<td class="name"><b>${esc(r.name)}</b><span>${sub}</span></td>` +
          `<td class="num">${fmtUsd(r.tvl_usd)}</td>` +
          `<td class="num ${pctClass}">${pct}</td>` +
          `<td class="num">${fmtAge(r.age_days)}</td>` +
          `<td class="num"><span class="bar"><i style="width:${width}%"></i></span>${fmtUsd(r.implied_value_usd)}</td>` +
          `<td><span class="badge ${r.watchlist ? 'watch' : 'early'}">${r.watchlist ? 'Watchlist' : 'Early'}</span></td>` +
          `</tr>`;
      })
      .join('');
  }

  function openDetail(slug) {
    const r = rows.find((x) => x.slug === slug);
    if (!r) return;
    els.drawerRank.textContent = `Rank ${r.rank} of ${rows.length}`;
    const fam = meta.families.find((f) => f.name === r.family);
    const growthNote =
      r.change_7d === null
        ? 'No 7-day change reported for this protocol.'
        : `7-day TVL change ${fmtPct(r.change_7d)} — tested as a predictor of the traded multiple (correlation ${meta.growth_correlation.toFixed(2)}), it does not move the value.`;
    const ageNote =
      r.age_days === null
        ? 'No listing date recorded for this protocol.'
        : `Listed ${fmtAge(r.age_days)} ago — age was tested the same way (correlation ${meta.age_correlation.toFixed(2)}) and does not move the value.`;
    els.drawerBody.innerHTML =
      `<h2>${esc(r.name)}</h2>` +
      `<p class="sub">${esc(r.category ?? 'Uncategorised')} on ${esc(r.chains.join(', '))}` +
      `${r.watchlist ? ' — on the house watchlist' : ''}</p>` +
      `<h3>Implied value</h3>` +
      `<dl class="kv">` +
      `<dt>TVL</dt><dd>${fmtUsd(r.tvl_usd)}</dd>` +
      `<dt>Size-curve multiple</dt><dd>x${r.base_multiple.toFixed(4)}<small>fitted: log(multiple) = ${meta.curve_intercept.toFixed(3)} ${meta.curve_slope.toFixed(3)} x log(TVL)</small></dd>` +
      `<dt>Family adjustment</dt><dd>x${Math.exp(r.family_adjustment).toFixed(2)}<small>${esc(r.family)} — ${r.family_peers} traded peers${fam ? `, median residual ${fam.adjustment.toFixed(3)}` : ''}</small></dd>` +
      `<dt>Final multiple</dt><dd>x${r.size_multiple.toFixed(4)}<small>size curve x family adjustment, clamped to [0.005, 2.00]</small></dd>` +
      `<dt>Implied value</dt><dd>${fmtUsd(r.implied_value_usd)}</dd>` +
      `</dl>` +
      `<p class="note">${esc(growthNote)} ${esc(ageNote)} ` +
      `The page recomputes this row as ${fmtUsd(r.implied_value_usd)}, the same number board.json carries. This is an estimate, not a price.</p>` +
      `<h3>Farm plan</h3>` +
      `<ol class="plan">${r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>`;
    els.drawer.hidden = false;
    document.querySelectorAll('#rows tr.selected').forEach((tr) => tr.classList.remove('selected'));
    const tr = document.querySelector(`#rows tr[data-slug="${CSS.escape(slug)}"]`);
    if (tr) tr.classList.add('selected');
  }

  function closeDetail() {
    els.drawer.hidden = true;
    document.querySelectorAll('#rows tr.selected').forEach((tr) => tr.classList.remove('selected'));
  }

  els.rows.addEventListener('click', (event) => {
    const tr = event.target.closest('tr[data-slug]');
    if (tr) openDetail(tr.dataset.slug);
  });
  els.drawerClose.addEventListener('click', closeDetail);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDetail();
  });
  for (const el of [els.q, els.cat, els.chain, els.tvl, els.watch]) {
    el.addEventListener('input', render);
  }
  document.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.sortKey === key) {
        state.sortDir = -state.sortDir;
      } else {
        state.sortKey = key;
        state.sortDir = key === 'name' ? 1 : -1;
      }
      render();
    });
  });

  // Screenshot states from the URL hash: #detail=<slug>, #cat=<category>,
  // #chain=<chain>, #watch=1, #q=<text>. Applied on load and on every hash
  // change, so a plain hash navigation re-renders the page.
  function applyHash() {
    const hash = new URLSearchParams(window.location.hash.slice(1));
    els.cat.value = hash.get('cat') ?? '';
    els.chain.value = hash.get('chain') ?? '';
    els.watch.checked = hash.get('watch') === '1';
    els.q.value = hash.get('q') ?? '';
    render();
    const detail = hash.get('detail');
    if (detail) openDetail(detail);
    else closeDetail();
  }
  window.addEventListener('hashchange', applyHash);
  applyHash();
})();
