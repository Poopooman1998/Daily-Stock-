// build-data.js
// 每日收盤後抓取台股資料 → 產生網頁用的 data.json
//
// 用法:  node build-data.js
// 需求:  Node.js 18 以上(內建 fetch,免裝任何套件)
//
// 資料來源皆為「官方、免費、免金鑰」的 OpenAPI:
//   證交所 TWSE  https://openapi.twse.com.tw
//   櫃買中心 TPEx https://www.tpex.org.tw/openapi
//
// ⚠ 這些 API 提供的是「盤後／收盤」資料,約每天 14:00~15:00 後才會更新,
//   正好對應本儀表板「每日彙整」的定位。需要盤中即時報價請改用付費券商 API。

const fs = require('fs');
const path = require('path');

// 小工具 ----------------------------------------------------------
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'twse-daily/1.0' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}
const num = (s) => Number(String(s).replace(/,/g, '')) || 0;
const comma = (n, dp = 2) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pct = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const dirOf = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');

// 主流程 ----------------------------------------------------------
async function main() {
  // 1) 大盤加權指數 + 漲跌 ------------------------------------------------
  //    每日收盤指數(含漲跌點)
  const idx = await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX');
  const taiexRow = idx.find((r) => (r['指數'] || '').includes('發行量加權股價指數'));

  // 2) 全市場個股收盤行情 → 排行榜 -------------------------------------
  //    欄位:證券代號 / 證券名稱 / 收盤價 / 漲跌(+/-) / 漲跌價差 / 成交股數 ...
  const quotes = await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
  const stocks = quotes
    .filter((r) => /^\d{4}$/.test(r['證券代號']) && num(r['收盤價']) > 0)
    .map((r) => {
      const close = num(r['收盤價']);
      const prevClose = close - num(r['漲跌價差']) * (r['漲跌(+/-)'].includes('-') ? -1 : 1);
      const chgPct = prevClose ? ((close - prevClose) / prevClose) * 100 : 0;
      return {
        name: r['證券名稱'],
        code: r['證券代號'],
        close,
        chgPct,
        vol: num(r['成交股數']) / 1000, // 股 → 張
      };
    });

  const byPctDesc = [...stocks].sort((a, b) => b.chgPct - a.chgPct);
  const byVolDesc = [...stocks].sort((a, b) => b.vol - a.vol);

  const gainers = byPctDesc.slice(0, 8).map((s) => ({
    name: s.name, code: s.code, price: comma(s.close), pct: pct(s.chgPct),
  }));
  const losers = byPctDesc.slice(-8).reverse().map((s) => ({
    name: s.name, code: s.code, price: comma(s.close), pct: pct(s.chgPct),
  }));
  const volume = byVolDesc.slice(0, 8).map((s) => ({
    name: s.name, code: s.code,
    vol: Math.round(s.vol).toLocaleString('en-US'),
    pct: pct(s.chgPct), dir: dirOf(s.chgPct),
  }));

  // 3) 三大法人買賣超 ----------------------------------------------------
  const inst = await getJSON('https://openapi.twse.com.tw/v1/fund/BFI82U');
  const pickInst = (kw) => {
    const row = inst.find((r) => (r['單位名稱'] || '').includes(kw));
    return row ? num(row['買賣差額']) / 1e8 : 0; // 元 → 億元
  };
  const foreign = pickInst('外資及陸資');
  const trust = pickInst('投信');
  const dealer = pickInst('自營商');

  // 4) 組裝 data.json ----------------------------------------------------
  //    註:漲跌家數、區間、漲跌停、國際市場、籌碼個股明細、新聞、行事曆
  //    這些需要再串其他 API / RSS;以下先帶入可從上面算出的部分,
  //    其餘維持結構讓你逐步補上(見 README)。
  const taiexClose = taiexRow ? num(taiexRow['收盤指數']) : 0;
  const taiexChg = taiexRow ? num(taiexRow['漲跌點數']) * (taiexRow['漲跌(+/-)'].includes('-') ? -1 : 1) : 0;
  const taiexPrev = taiexClose - taiexChg;
  const taiexPct = taiexPrev ? (taiexChg / taiexPrev) * 100 : 0;

  const now = new Date();
  const tpe = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const wd = ['日', '一', '二', '三', '四', '五', '六'][tpe.getDay()];
  const ymd = `${tpe.getFullYear()} / ${String(tpe.getMonth() + 1).padStart(2, '0')} / ${String(tpe.getDate()).padStart(2, '0')}`;
  const hm = `${String(tpe.getHours()).padStart(2, '0')}:${String(tpe.getMinutes()).padStart(2, '0')}`;

  const data = {
    meta: {
      date: ymd, weekday: `星期${wd}`,
      status: '已收盤 13:30', updated: hm,
      asof: `${tpe.toISOString().slice(0, 10)} ${hm} (GMT+8)`,
    },
    taiex: {
      value: comma(taiexClose), change: comma(Math.abs(taiexChg)),
      pct: pct(taiexPct), dir: dirOf(taiexChg),
      amount: '—', rangeLow: '—', rangeHigh: '—',
      prevClose: comma(taiexPrev), prevCloseNum: taiexPrev,
      intraday: [taiexPrev, taiexClose], // ← 盤中分時需另接即時 API;此處先用兩點
      advancers: 0, unchanged: 0, decliners: 0,
      limitUp: 0, limitDown: 0, volumeShares: '—',
    },
    tickers: [
      { name: '加權指數', value: comma(taiexClose), pct: pct(taiexPct), dir: dirOf(taiexChg) },
      // 其餘 ticker(櫃買、台指期、台積電、匯率、美股…)請依需要補上
    ],
    tiles: [
      { label: '櫃買指數 OTC', value: '—', valueColor: '#9aa3b2', sub: '', subColor: '#626c7e' },
      { label: '三大法人合計', value: pct0(foreign + trust + dealer), valueColor: col(foreign + trust + dealer), sub: '億元', subColor: '#626c7e' },
      { label: '外資買賣超', value: pct0(foreign), valueColor: col(foreign), sub: '億元', subColor: '#626c7e' },
      { label: '融資餘額', value: '—', valueColor: '#e6e9ef', sub: '', subColor: '#626c7e' },
    ],
    gainers, volume, losers,
    institutions: {
      foreign: pct0(foreign), foreignDir: dirOf(foreign),
      trust: pct0(trust), trustDir: dirOf(trust),
      dealer: pct0(dealer), dealerDir: dirOf(dealer),
      buys: [], sells: [], // ← 外資買賣超個股需另接 TWSE「外資及陸資買賣超彙總表」
    },
    sectors: [],  // ← 類股指數漲跌:TWSE MI_INDEX 內含各分類指數,可在此篩選計算
    intl: [],     // ← 國際市場:接 Yahoo Finance / Stooq
    calendar: [], // ← 經濟數據行事曆:手動維護或接財經行事曆來源
    news: [],     // ← 盤後新聞:接各財經媒體 RSS
  };

  const out = path.join(__dirname, '..', 'data.json');
  fs.writeFileSync(out, JSON.stringify(data, null, 2), 'utf8');
  console.log(`✓ 已更新 ${out}`);
  console.log(`  加權指數 ${data.taiex.value} ${data.taiex.pct} · 外資 ${data.institutions.foreign} 億`);
}

// 億元用小工具(帶正負號)
function pct0(n) { return (n >= 0 ? '+' : '') + n.toFixed(1); }
function col(n) { return n > 0 ? '#ff4d4f' : n < 0 ? '#1ec77b' : '#9aa3b2'; }

main().catch((e) => { console.error('✗ 失敗:', e.message); process.exit(1); });
