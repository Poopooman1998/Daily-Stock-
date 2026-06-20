// build-data.js
// 每日收盤後抓取台股資料 → 更新網頁用的 data.json
//
// 用法:  node build-data.js
// 需求:  Node.js 18 以上(內建 fetch,免裝任何套件)
//
// 資料來源皆為證交所「官方、免費、免金鑰」OpenAPI(https://openapi.twse.com.tw):
//   FMTQIK         大盤每日成交量值 + 發行量加權股價指數、漲跌點數
//   STOCK_DAY_ALL  全上市個股日成交資訊(英文欄位)
//   BFI82U         三大法人買賣金額統計
//
// 設計原則:只覆蓋「抓得到真實資料」的欄位;尚未接的區塊(類股/國際/新聞/
//          行事曆…)保留 data.json 原本內容,所以畫面不會出現空白區塊。

const fs = require('fs');
const path = require('path');

// ---- 小工具 ----------------------------------------------------
async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'twse-daily/1.0', Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  if (text.trim().startsWith('<')) throw new Error(`${url} → 回傳的是 HTML 不是 JSON(網址可能失效)`);
  return JSON.parse(text);
}
const num = (s) => Number(String(s == null ? '' : s).replace(/[,\s%]/g, '')) || 0;
const comma = (n, dp = 2) =>
  Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const signed = (n, dp = 2) => (n >= 0 ? '+' : '') + comma(n, dp);
const pct = (n) => (n >= 0 ? '+' : '') + n.toFixed(2) + '%';
const dirOf = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : 'flat');

async function main() {
  // 讀現有 data.json 當底稿(保留尚未接上的區塊)
  const outPath = path.join(__dirname, '..', 'data.json');
  const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));

  // ---- 1) 大盤指數 + 漲跌 + 成交金額(FMTQIK)-------------------
  try {
    const fmtqik = await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/FMTQIK');
    const last = fmtqik[fmtqik.length - 1]; // 最後一筆 = 最近交易日
    const close = num(last['發行量加權股價指數']);
    const chg = num(last['漲跌點數']);       // 已含正負號
    const prev = close - chg;
    const p = prev ? (chg / prev) * 100 : 0;
    const turnover = num(last['成交金額']) / 1e8; // 元 → 億元

    Object.assign(data.taiex, {
      value: comma(close),
      change: comma(Math.abs(chg)),
      pct: pct(p),
      dir: dirOf(chg),
      prevClose: comma(prev),
      prevCloseNum: prev,
      intraday: [prev, close], // 盤中分時需另接即時 API,此處先用昨收→今收兩點
      amount: comma(turnover, 0),
    });
    data.tickers[0] = { name: '加權指數', value: comma(close), pct: pct(p), dir: dirOf(chg) };
    console.log(`✓ 加權指數 ${comma(close)} ${pct(p)} · 成交 ${comma(turnover, 0)} 億`);
  } catch (e) { console.warn('⚠ 大盤指數略過:', e.message); }

  // ---- 2) 個股排行 + 漲跌家數(STOCK_DAY_ALL,英文欄位)--------
  try {
    const quotes = await getJSON('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
    const stocks = quotes
      .filter((r) => /^\d{4}$/.test(r.Code) && num(r.ClosingPrice) > 0)
      .map((r) => {
        const close = num(r.ClosingPrice);
        const chg = num(r.Change);          // 已含正負號(價差)
        const prev = close - chg;
        const chgPct = prev ? (chg / prev) * 100 : 0;
        return { name: r.Name, code: r.Code, close, chgPct, vol: num(r.TradeVolume) / 1000 };
      });

    const byPct = [...stocks].sort((a, b) => b.chgPct - a.chgPct);
    const byVol = [...stocks].sort((a, b) => b.vol - a.vol);

    data.gainers = byPct.slice(0, 8).map((s) => ({ name: s.name, code: s.code, price: comma(s.close), pct: pct(s.chgPct) }));
    data.losers = byPct.slice(-8).reverse().map((s) => ({ name: s.name, code: s.code, price: comma(s.close), pct: pct(s.chgPct) }));
    data.volume = byVol.slice(0, 8).map((s) => ({
      name: s.name, code: s.code,
      vol: Math.round(s.vol).toLocaleString('en-US'),
      pct: pct(s.chgPct), dir: dirOf(s.chgPct),
    }));

    const up = stocks.filter((s) => s.chgPct > 0).length;
    const dn = stocks.filter((s) => s.chgPct < 0).length;
    const fl = stocks.length - up - dn;
    const totalShares = stocks.reduce((a, s) => a + s.vol * 1000, 0);
    Object.assign(data.taiex, {
      advancers: up, decliners: dn, unchanged: fl,
      limitUp: stocks.filter((s) => s.chgPct >= 9.9).length,
      limitDown: stocks.filter((s) => s.chgPct <= -9.9).length,
      volumeShares: comma(totalShares / 1e8, 2),
    });
    console.log(`✓ 個股 ${stocks.length} 檔 · 漲 ${up} / 跌 ${dn} / 平 ${fl}`);
  } catch (e) { console.warn('⚠ 個股排行略過:', e.message); }

  // ---- 3) 三大法人買賣超(BFI82U)------------------------------
  try {
    const inst = await getJSON('https://openapi.twse.com.tw/v1/fund/BFI82U');
    const sumBy = (kw) => inst
      .filter((r) => (r['單位名稱'] || '').includes(kw))
      .reduce((a, r) => a + num(r['買賣差額']) / 1e8, 0); // 元 → 億
    const foreign = sumBy('外資');
    const trust = sumBy('投信');
    const dealer = sumBy('自營商');
    const totalI = foreign + trust + dealer;

    Object.assign(data.institutions, {
      foreign: signed(foreign, 1), foreignDir: dirOf(foreign),
      trust: signed(trust, 1), trustDir: dirOf(trust),
      dealer: signed(dealer, 1), dealerDir: dirOf(dealer),
    });
    const setTile = (label, value, color) => {
      const tile = data.tiles.find((t) => t.label.includes(label));
      if (tile) { tile.value = value; tile.valueColor = color; }
    };
    const col = (n) => (n > 0 ? '#ff4d4f' : n < 0 ? '#1ec77b' : '#9aa3b2');
    setTile('三大法人', signed(totalI, 1), col(totalI));
    setTile('外資買賣超', signed(foreign, 1), col(foreign));
    console.log(`✓ 三大法人 外資 ${signed(foreign, 1)} / 投信 ${signed(trust, 1)} / 自營 ${signed(dealer, 1)} 億`);
  } catch (e) { console.warn('⚠ 三大法人略過:', e.message); }

  // ---- 4) 更新時間戳 -------------------------------------------
  const tpe = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const wd = ['日', '一', '二', '三', '四', '五', '六'][tpe.getDay()];
  const hm = `${String(tpe.getHours()).padStart(2, '0')}:${String(tpe.getMinutes()).padStart(2, '0')}`;
  data.meta.date = `${tpe.getFullYear()} / ${String(tpe.getMonth() + 1).padStart(2, '0')} / ${String(tpe.getDate()).padStart(2, '0')}`;
  data.meta.weekday = `星期${wd}`;
  data.meta.updated = hm;
  data.meta.asof = `${tpe.getFullYear()}-${String(tpe.getMonth() + 1).padStart(2, '0')}-${String(tpe.getDate()).padStart(2, '0')} ${hm} (GMT+8)`;

  fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
  console.log(`✓ 已更新 ${outPath}`);
}

main().catch((e) => { console.error('✗ 失敗:', e.message); process.exit(1); });
