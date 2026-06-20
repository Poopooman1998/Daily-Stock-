// build-data.js
// 每日收盤後抓取台股資料 → 更新網頁用的 data.json
//
// 用法:  node build-data.js   (需要 Node.js 18+,內建 fetch)
//
// 來源:
//   TWSE FMTQIK         大盤加權指數、漲跌、成交金額(英文欄位 TAIEX/Change/TradeValue)
//   TWSE STOCK_DAY_ALL  全上市個股日成交(英文欄位)→ 排行榜、漲跌家數、台積電
//   TWSE BFI82U         三大法人買賣金額
//   TPEx OpenAPI        櫃買指數(best-effort)
//   Yahoo Finance       國際市場 + 美元台幣(免金鑰)
//
// 原則:只覆蓋抓得到的欄位;某來源失敗就保留 data.json 原值,畫面不會空白。

const fs = require('fs');
const path = require('path');

// ---- 小工具 ----------------------------------------------------
// 證交所看到瀏覽器 UA 會吐 HTML,所以預設用「API 式」UA;Yahoo 則需要瀏覽器 UA。
// 證交所偶爾擋 GitHub IP,加重試(預設試 4 次)。
async function getJSON(url, { ua = 'twse-daily/1.0 (+github-actions)', tries = 4 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'application/json, text/plain, */*' } });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (text.trim().startsWith('<')) throw new Error('回傳 HTML 不是 JSON');
      return JSON.parse(text);
    } catch (e) { last = e; if (i < tries - 1) await new Promise((r) => setTimeout(r, 700 * (i + 1))); }
  }
  throw new Error(`${url} → ${last.message}`);
}
const num = (s) => Number(String(s == null ? '' : s).replace(/[,\s%$]/g, '')) || 0;
const comma = (n, dp = 2) => Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const idxFmt = (n) => comma(n, n >= 1000 ? 0 : 2);
const signed = (n, dp = 2) => (n >= 0 ? '+' : '') + comma(n, dp);
const pct = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const dirOf = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');
const pick = (o, ...keys) => { for (const k of keys) { if (o && o[k] != null && o[k] !== '') return o[k]; } return undefined; };

// Yahoo Finance 單一標的:回傳 {price, pct}
async function yahoo(symbol) {
  const u = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const j = await getJSON(u, { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
  const m = j.chart.result[0].meta;
  const price = m.regularMarketPrice;
  const prev = m.chartPreviousClose != null ? m.chartPreviousClose : m.previousClose;
  return { price, pct: prev ? (price - prev) / prev * 100 : 0 };
}

async function main() {
  const outPath = path.join(__dirname, '..', 'data.json');
  const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  let twChip = { otc: null }; // 暫存櫃買
  let tsmc = null;            // 暫存台積電

  // ---- 1) 大盤指數(FMTQIK)-----------------------------------
  try {
    const fmtqik = await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK');
    if (!Array.isArray(fmtqik) || !fmtqik.length) throw new Error('FMTQIK 非陣列');
    const last = fmtqik[fmtqik.length - 1];
    const close = num(pick(last, 'TAIEX', '發行量加權股價指數', '收盤指數'));
    const chg = num(pick(last, 'Change', '漲跌點數'));
    if (!close) throw new Error('找不到指數欄位,實際鍵:' + Object.keys(last).join(','));
    const prev = close - chg;
    const p = prev ? (chg / prev) * 100 : 0;
    const turnover = num(pick(last, 'TradeValue', '成交金額')) / 1e8;
    Object.assign(data.taiex, {
      value: comma(close), change: comma(Math.abs(chg)), pct: pct(p), dir: dirOf(chg),
      prevClose: comma(prev), prevCloseNum: prev, intraday: [prev, close], amount: comma(turnover, 0),
    });
    console.log(`✓ 加權指數 ${comma(close)} ${pct(p)}`);
  } catch (e) { console.warn('⚠ 大盤指數略過:', e.message); }

  // ---- 2) 個股排行 + 漲跌家數 + 台積電(STOCK_DAY_ALL)--------
  try {
    const quotes = await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
    const stocks = quotes
      .filter((r) => /^\d{4}$/.test(r.Code) && num(r.ClosingPrice) > 0)
      .map((r) => {
        const close = num(r.ClosingPrice);
        const chg = num(r.Change);
        const prev = close - chg;
        return { name: r.Name, code: r.Code, close, chgPct: prev ? (chg / prev) * 100 : 0, vol: num(r.TradeVolume) / 1000 };
      });
    const byPct = [...stocks].sort((a, b) => b.chgPct - a.chgPct);
    const byVol = [...stocks].sort((a, b) => b.vol - a.vol);
    data.gainers = byPct.slice(0, 8).map((s) => ({ name: s.name, code: s.code, price: comma(s.close), pct: pct(s.chgPct) }));
    data.losers = byPct.slice(-8).reverse().map((s) => ({ name: s.name, code: s.code, price: comma(s.close), pct: pct(s.chgPct) }));
    data.volume = byVol.slice(0, 8).map((s) => ({ name: s.name, code: s.code, vol: Math.round(s.vol).toLocaleString('en-US'), pct: pct(s.chgPct), dir: dirOf(s.chgPct) }));
    const up = stocks.filter((s) => s.chgPct > 0).length;
    const dn = stocks.filter((s) => s.chgPct < 0).length;
    Object.assign(data.taiex, {
      advancers: up, decliners: dn, unchanged: stocks.length - up - dn,
      limitUp: stocks.filter((s) => s.chgPct >= 9.9).length,
      limitDown: stocks.filter((s) => s.chgPct <= -9.9).length,
      volumeShares: comma(stocks.reduce((a, s) => a + s.vol * 1000, 0) / 1e8, 2),
    });
    tsmc = stocks.find((s) => s.code === '2330');
    console.log(`✓ 個股 ${stocks.length} 檔 · 漲 ${up} / 跌 ${dn}`);
  } catch (e) { console.warn('⚠ 個股排行略過:', e.message); }

  // ---- 3) 三大法人(BFI82U)-----------------------------------
  try {
    const inst = await getJSON('https://openapi.twse.com.tw/v1/fund/BFI82U');
    if (!Array.isArray(inst) || !inst.length) throw new Error('BFI82U 空陣列/非陣列');
    console.log('  BFI82U 欄位:', Object.keys(inst[0]).join(','));
    const unitOf = (r) => String(pick(r, '單位名稱', 'Name', '名稱') || '');
    const diffOf = (r) => num(pick(r, '買賣差額', 'Difference', '買賣超', '差額'));
    const sumBy = (kw) => inst.filter((r) => unitOf(r).includes(kw)).reduce((a, r) => a + diffOf(r) / 1e8, 0);
    const foreign = sumBy('外資'), trust = sumBy('投信'), dealer = sumBy('自營商');
    const totalI = foreign + trust + dealer;
    Object.assign(data.institutions, {
      foreign: signed(foreign, 1), foreignDir: dirOf(foreign),
      trust: signed(trust, 1), trustDir: dirOf(trust),
      dealer: signed(dealer, 1), dealerDir: dirOf(dealer),
    });
    const col = (n) => (n > 0 ? '#ff4d4f' : n < 0 ? '#1ec77b' : '#9aa3b2');
    const setTile = (label, value, color) => { const t = data.tiles.find((x) => x.label.includes(label)); if (t) { t.value = value; t.valueColor = color; } };
    setTile('三大法人', signed(totalI, 1), col(totalI));
    setTile('外資買賣超', signed(foreign, 1), col(foreign));
    console.log(`✓ 三大法人 外資 ${signed(foreign, 1)} / 投信 ${signed(trust, 1)} / 自營 ${signed(dealer, 1)} 億`);
  } catch (e) { console.warn('⚠ 三大法人略過:', e.message); }

  // ---- 4) 櫃買指數(TPEx,best-effort)------------------------
  try {
    const tp = await getJSON('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_index');
    const row = Array.isArray(tp) ? tp[tp.length - 1] : null;
    const close = num(pick(row || {}, 'ClosingIndex', '收盤指數', 'Index', '櫃買指數'));
    const chg = num(pick(row || {}, 'Change', '漲跌', '漲跌點數'));
    if (close) {
      twChip.otc = { close, pct: (close - chg) ? chg / (close - chg) * 100 : 0, chg };
      const t = data.tiles.find((x) => x.label.includes('櫃買'));
      if (t) { t.value = comma(close, 2); t.valueColor = chg >= 0 ? '#ff4d4f' : '#1ec77b'; t.sub = `${chg >= 0 ? '▲' : '▼'} ${comma(Math.abs(chg), 2)}  ${pct(twChip.otc.pct)}`; t.subColor = chg >= 0 ? '#ff4d4f' : '#1ec77b'; }
      console.log(`✓ 櫃買 ${comma(close, 2)} ${pct(twChip.otc.pct)}`);
    } else throw new Error('找不到櫃買欄位,實際鍵:' + Object.keys(row || {}).join(','));
  } catch (e) { console.warn('⚠ 櫃買略過(保留示意值):', e.message); }

  // ---- 5) 國際市場 + 美元台幣(Yahoo Finance)------------------
  const intlDefs = [
    { name: '道瓊工業', sym: '^DJI' }, { name: '那斯達克', sym: '^IXIC' },
    { name: 'S&P 500', sym: '^GSPC' }, { name: '費城半導體', sym: '^SOX' },
    { name: '日經 225', sym: '^N225' }, { name: '韓國 KOSPI', sym: '^KS11' },
    { name: '上證指數', sym: '000001.SS' }, { name: '恆生指數', sym: '^HSI' },
  ];
  const intlMap = {};
  try {
    const intl = [];
    for (const d of intlDefs) {
      try {
        const q = await yahoo(d.sym);
        intlMap[d.name] = q;
        intl.push({ name: d.name, value: idxFmt(q.price), pct: pct(q.pct), dir: dirOf(q.pct) });
      } catch (err) { console.warn(`  ⚠ ${d.name} (${d.sym}):`, err.message); }
    }
    if (intl.length) { data.intl = intl; console.log(`✓ 國際市場 ${intl.length}/${intlDefs.length} 檔`); }
    else throw new Error('全部失敗(Yahoo 可能擋 IP)');
  } catch (e) { console.warn('⚠ 國際市場略過(保留示意值):', e.message); }

  let twd = null;
  try { twd = await yahoo('TWD=X'); console.log(`✓ USD/TWD ${comma(twd.price, 2)}`); }
  catch (e) { console.warn('⚠ 匯率略過:', e.message); }

  // ---- 6) 重組頂部跑馬燈(只放抓得到的)------------------------
  const tickers = [];
  if (data.taiex && data.taiex.value) tickers.push({ name: '加權指數', value: data.taiex.value, pct: data.taiex.pct, dir: data.taiex.dir });
  if (twChip.otc) tickers.push({ name: '櫃買', value: comma(twChip.otc.close, 2), pct: pct(twChip.otc.pct), dir: dirOf(twChip.otc.chg) });
  if (tsmc) tickers.push({ name: '台積電', value: comma(tsmc.close, 0), pct: pct(tsmc.chgPct), dir: dirOf(tsmc.chgPct) });
  if (twd) tickers.push({ name: 'USD/TWD', value: comma(twd.price, 2), pct: signed(twd.price * twd.pct / 100, 2), dir: dirOf(twd.pct) });
  ['道瓊工業', '那斯達克', '費城半導體'].forEach((n) => {
    const q = intlMap[n]; if (q) tickers.push({ name: n === '道瓊工業' ? '道瓊' : n === '費城半導體' ? '費半' : n, value: idxFmt(q.price), pct: pct(q.pct), dir: dirOf(q.pct) });
  });
  if (tickers.length >= 3) data.tickers = tickers; // 至少抓到幾項才替換,否則保留示意

  // ---- 7) 時間戳 ----------------------------------------------
  const tpe = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const wd = ['日', '一', '二', '三', '四', '五', '六'][tpe.getDay()];
  const hm = `${String(tpe.getHours()).padStart(2, '0')}:${String(tpe.getMinutes()).padStart(2, '0')}`;
  const ymd = `${tpe.getFullYear()}-${String(tpe.getMonth() + 1).padStart(2, '0')}-${String(tpe.getDate()).padStart(2, '0')}`;
  data.meta.date = `${tpe.getFullYear()} / ${String(tpe.getMonth() + 1).padStart(2, '0')} / ${String(tpe.getDate()).padStart(2, '0')}`;
  data.meta.weekday = `星期${wd}`;
  data.meta.updated = hm;
  data.meta.asof = `${ymd} ${hm} (GMT+8)`;

  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`✓ 已更新 ${outPath}`);
}

main().catch((e) => { console.error('✗ 失敗:', e.message); process.exit(1); });
