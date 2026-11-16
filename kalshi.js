// Kalshi, read-only, signed on this device. The private key never leaves the device: each request is signed here
// (Ed25519 via WebCrypto) and sent through a relay only because Kalshi's API refuses requests from web pages.
// Shared by the poly-accounts phone page and the Chrome extension's accounts page (keep the two copies identical).
// An account: { id, nick, keyId, pem, subNames: { n: name }, hiddenSubs: [n] }. summary(account) -> [{ n, nick, accountId, cash, positions, orders, fills, settlements }]
var KalshiClient = (() => {
  const RELAY = 'https://kalshi-accounts.robu-ora.workers.dev/k';
  const keys = new Map();

  const pemToDer = pem => {
    const b64 = String(pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    return Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  };
  function signingKey(acct) {
    if (!keys.has(acct.pem)) keys.set(acct.pem, crypto.subtle.importKey('pkcs8', pemToDer(acct.pem), { name: 'Ed25519' }, false, ['sign']));
    return keys.get(acct.pem);
  }
  async function get(acct, path, query = '') {
    const headers = {};
    if (acct && path.includes('/portfolio/')) {
      const ts = String(Date.now());
      const sig = await crypto.subtle.sign({ name: 'Ed25519' }, await signingKey(acct), new TextEncoder().encode(ts + 'GET' + path));
      headers['KALSHI-ACCESS-KEY'] = acct.keyId;
      headers['KALSHI-ACCESS-TIMESTAMP'] = ts;
      headers['KALSHI-ACCESS-SIGNATURE'] = btoa(String.fromCharCode(...new Uint8Array(sig)));
    }
    const r = await fetch(RELAY + path + query, { headers, cache: 'no-store' });
    if (r.status === 401) throw Object.assign(new Error('Kalshi did not accept this API key'), { auth: true });
    if (!r.ok) throw new Error(`Kalshi ${r.status}`);
    return r.json();
  }
  async function pages(acct, path, field, params, max = 5) {
    const out = [];
    let cursor = '';
    for (let i = 0; i < max; i++) {
      const j = await get(acct, path, `?${params ? params + '&' : ''}limit=200${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`);
      out.push(...(j[field] || []));
      cursor = j.cursor || '';
      if (!cursor) break;
    }
    return out;
  }
  // Kalshi timestamps can carry 4-6 fractional digits (e.g. 04:30:44.55987Z); Safari can't parse those, Chrome can.
  // Trim to milliseconds first so dates (and charts) work everywhere. Returns seconds.
  const parseTime = t => Date.parse(String(t || '').replace(/\.(\d+)/, (m, f) => '.' + (f + '00').slice(0, 3))) / 1000;
  // Kalshi returns legacy cents fields and newer *_dollars / *_fp strings; read whichever is present.
  const num = (o, keys, cents = []) => {
    for (const k of keys) if (o[k] != null && o[k] !== '') return Number(o[k]);
    for (const k of cents) if (o[k] != null && o[k] !== '') return Number(o[k]) / 100;
    return 0;
  };
  const marketCache = new Map();
  const market = ticker => {
    if (!marketCache.has(ticker)) {
      marketCache.set(ticker, get(null, `/trade-api/v2/markets/${encodeURIComponent(ticker)}`).then(j => j.market || {}).catch(() => ({})));
      setTimeout(() => marketCache.delete(ticker), 60000);
    }
    return marketCache.get(ticker);
  };
  const yesPrice = m => {
    const bid = num(m, ['yes_bid_dollars'], ['yes_bid']), ask = num(m, ['yes_ask_dollars'], ['yes_ask']), last = num(m, ['last_price_dollars'], ['last_price']);
    return bid > 0 && ask > 0 ? (bid + ask) / 2 : last;
  };

  async function subaccount(acct, n, cash) {
    const q = `subaccount=${n}`;
    const [posRaw, fillsRaw, setRaw, ordersRaw] = await Promise.all([
      pages(acct, '/trade-api/v2/portfolio/positions', 'market_positions', q),
      get(acct, '/trade-api/v2/portfolio/fills', `?${q}&limit=50`).then(j => j.fills || []),
      pages(acct, '/trade-api/v2/portfolio/settlements', 'settlements', q),
      pages(acct, '/trade-api/v2/portfolio/orders', 'orders', q + '&status=resting', 2),
    ]);
    const positions = (await Promise.all(posRaw.map(async p => {
      const count = num(p, ['position_fp', 'position']);
      if (!count) return null;
      const m = await market(p.ticker);
      const side = count > 0 ? 'Yes' : 'No', shares = Math.abs(count);
      const yp = yesPrice(m), price = side === 'Yes' ? yp : 1 - yp;
      const cost = num(p, ['market_exposure_dollars'], ['market_exposure']), value = shares * price;
      return { ticker: p.ticker, title: m.title || p.ticker, subtitle: side === 'Yes' ? (m.yes_sub_title || '') : (m.no_sub_title || ''),
        side, shares, avg: shares ? cost / shares : null, price, value, cost, pnl: value - cost, pct: cost ? ((value - cost) / cost) * 100 : null };
    }))).filter(Boolean).sort((a, b) => b.value - a.value);
    const titles = {};
    await Promise.all([...new Set([...fillsRaw, ...setRaw, ...ordersRaw].map(x => x.ticker))].slice(0, 60).map(async t => { titles[t] = (await market(t)).title || t; }));
    // Kalshi's "sell Yes" while holding no Yes is really "buy No" (outcome_side says which contracts you end up with).
    // Show orders by that outcome at its own price; only orders that open a position tie up cash.
    const orders = ordersRaw.map(o => {
      const side = (o.side || 'yes').toLowerCase() === 'no' ? 'No' : 'Yes';
      const outcome = (o.outcome_side || o.side || 'yes').toLowerCase() === 'no' ? 'No' : 'Yes';
      const sell = (o.action || 'buy').toLowerCase() === 'sell';
      const opens = !sell || outcome !== side;
      const price = outcome === 'Yes' ? num(o, ['yes_price_dollars'], ['yes_price']) : num(o, ['no_price_dollars'], ['no_price']);
      const remaining = num(o, ['remaining_count_fp', 'remaining_count']);
      return { ticker: o.ticker, title: titles[o.ticker] || o.ticker, side: opens ? outcome : side, action: opens ? 'Buy' : 'Sell',
        price: opens ? price : (side === 'Yes' ? num(o, ['yes_price_dollars'], ['yes_price']) : num(o, ['no_price_dollars'], ['no_price'])),
        remaining, cash: opens ? remaining * price : 0, ts: parseTime(o.created_time) };
    }).sort((a, b) => b.ts - a.ts);
    const fills = fillsRaw.map(f => {
      const side = (f.side || 'yes').toLowerCase() === 'no' ? 'No' : 'Yes';
      const outcome = (f.outcome_side || f.side || 'yes').toLowerCase() === 'no' ? 'No' : 'Yes';
      const sell = (f.action || 'buy').toLowerCase() === 'sell', opens = !sell || outcome !== side;   // same reading as orders
      const shown = opens ? outcome : side;
      const price = shown === 'Yes' ? num(f, ['yes_price_dollars'], ['yes_price']) : num(f, ['no_price_dollars'], ['no_price']);
      const count = num(f, ['count_fp', 'count']);
      return { type: opens ? 'Bought' : 'Sold', ticker: f.ticker, title: titles[f.ticker] || f.ticker,
        side: shown, count, price, usd: count * price, ts: parseTime(f.created_time) };
    });
    // P&L per settled market = what the contracts were worth at settlement − cost − fees.
    // Not Kalshi's "revenue": when the bot held both Yes and No, the pairs are paid out by netting
    // (each pair is worth $1 regardless of the result), so revenue can show $0 for a position that paid $300.
    const settlements = setRaw.map(s => {
      const cost = num(s, ['yes_total_cost_dollars'], ['yes_total_cost']) + num(s, ['no_total_cost_dollars'], ['no_total_cost']);
      const fees = num(s, ['fee_cost_dollars', 'fee_cost']);
      const yesN = num(s, ['yes_count_fp', 'yes_count']), noN = num(s, ['no_count_fp', 'no_count']);
      const result = String(s.market_result || '').toLowerCase();
      const v = result === 'yes' ? 1 : result === 'no' ? 0 : num(s, ['value_dollars'], ['value']);   // value of one Yes at settlement
      const revenue = result === 'yes' || result === 'no' || s.value != null ? yesN * v + noN * (1 - v) : num(s, ['revenue_dollars'], ['revenue']);
      return { ticker: s.ticker, title: titles[s.ticker] || s.ticker, result: s.market_result, revenue, cost, pnl: revenue - cost - fees,
        ts: parseTime(s.settled_time) };
    });
    return { n, nick: acct.nick, accountId: acct.id, cash, positions, orders: ordersRaw.length, orderList: orders, fills, settlements };
  }

  // Liquidity incentive rewards: Kalshi pays them to the account (they land in Sub 0), naming the event.
  // Credit each to the subaccount whose orders were in that event (most orders wins; Sub 0 if none).
  // Matches are remembered on the device, so later refreshes only look at new rewards.
  const ATTR_KEY = 'kalshiRewardAttr';
  const loadAttr = () => { try { return JSON.parse(localStorage.getItem(ATTR_KEY) || '{}'); } catch { return {}; } };
  const saveAttr = a => { try { localStorage.setItem(ATTR_KEY, JSON.stringify(a)); } catch {} };
  async function rewards(acct, subNums) {
    const credits = (await pages(acct, '/trade-api/v2/portfolio/credit_history', 'credits', '', 10))
      .filter(c => c.type === 'incentive' && c.status === 'applied')
      .map(c => ({ id: c.credit_id, amount: Number(c.amount_dollars) || 0, ts: parseTime(c.created_time), event: (String(c.reason || '').match(/event\s+([A-Za-z0-9._-]+)/) || [])[1] || '' }));
    const attr = loadAttr(), pre = acct.keyId + ':';
    const todo = credits.filter(c => attr[pre + c.id] == null);
    if (todo.length) {
      const tickers = {};
      if (subNums.length > 1) {
        const since = Math.floor(Math.min(...todo.map(c => c.ts)) - 4 * 86400);   // rewards pay for recent quoting
        await Promise.all(subNums.map(async n => {
          tickers[n] = (await pages(acct, '/trade-api/v2/portfolio/orders', 'orders', `subaccount=${n}&min_ts=${since}`, 10).catch(() => [])).map(o => o.ticker || '');
        }));
      }
      for (const c of todo) {
        let best = 0, most = 0;
        for (const n of subNums) {
          const k = (tickers[n] || []).filter(t => c.event && (t === c.event || t.startsWith(c.event + '-'))).length;
          if (k > most) { best = n; most = k; }
        }
        attr[pre + c.id] = best;
      }
      saveAttr(attr);
    }
    const bySub = {};
    for (const c of credits) (bySub[attr[pre + c.id]] ||= []).push([c.ts, c.amount, c.event]);
    return bySub;
  }

  // every subaccount of one Kalshi account, each reported separately
  async function summary(acct) {
    const bal = await get(acct, '/trade-api/v2/portfolio/subaccounts/balances');
    const cash = new Map();
    for (const b of bal.subaccount_balances || []) cash.set(b.subaccount_number, (cash.get(b.subaccount_number) || 0) + Number(b.balance || 0));
    if (!cash.size) cash.set(0, num(await get(acct, '/trade-api/v2/portfolio/balance'), ['balance_dollars'], ['balance']));
    const nums = [...cash.keys()].sort((a, b) => a - b);
    const [subs, rw] = await Promise.all([Promise.all(nums.map(n => subaccount(acct, n, cash.get(n)))), rewards(acct, nums).catch(() => ({}))]);
    for (const s of subs) s.rewards = (rw[s.n] || []).sort((a, b) => a[0] - b[0]);   // [ts, amount, event]
    return subs;
  }

  // validate a pasted key before saving it: must parse and be accepted by Kalshi
  async function check(acct) {
    if (!/^[0-9a-f-]{20,}$/i.test(acct.keyId || '')) throw new Error('That API key ID looks wrong.');
    try { await signingKey(acct); } catch { keys.delete(acct.pem); throw new Error("That private key couldn't be read. Paste the whole key, including the BEGIN/END lines."); }
    const subs = await summary(acct);
    return subs.length;
  }

  // links: [{ n: nick, k: keyId, p: private key body }] as base64url JSON
  const b64url = s => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = s => decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/'))));
  const toLink = accts => b64url(JSON.stringify(accts.map(a => ({ n: a.nick, k: a.keyId, p: String(a.pem).replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''),
    ...(a.subNames && Object.keys(a.subNames).length ? { s: a.subNames } : {}), ...(a.hiddenSubs?.length ? { h: a.hiddenSubs } : {}) }))));
  const fromLink = s => JSON.parse(unb64url(s)).filter(a => a.k && a.p).map(a => ({
    id: 'k' + Math.random().toString(36).slice(2, 9), nick: a.n || '', keyId: a.k, pem: `-----BEGIN PRIVATE KEY-----\n${a.p}\n-----END PRIVATE KEY-----`,
    subNames: a.s || {}, hiddenSubs: a.h || [],
  }));
  // card label for a subaccount: its own name if renamed, else "Nick · Sub n"
  const subLabel = (acct, n) => acct?.subNames?.[n] || `${acct?.nick || 'Kalshi'} · Sub ${n}${n === 0 ? ' (primary)' : ''}`;
  // "Kalshi · Main · sub 1", or "Kalshi · sub 1" when the account has no nickname
  const subCaption = (acct, n) => `Kalshi${acct?.nick ? ' · ' + acct.nick : ''} · sub ${n}${n === 0 ? ' (primary)' : ''}`;
  const isHidden = (acct, n) => !!acct?.hiddenSubs?.includes(n);
  const newId = () => 'k' + Math.random().toString(36).slice(2, 9);

  return { summary, check, toLink, fromLink, newId, subLabel, subCaption, isHidden };
})();
