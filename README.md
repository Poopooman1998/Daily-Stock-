# 台股每日彙整 — 串接真實資料

深色終端機風格的台股盤後總覽。畫面(`台股每日彙整.dc.html`)只負責**讀 `data.json` 並渲染**;
資料由 Node 腳本每天收盤後抓取、產生 `data.json`。

```
台股每日彙整.dc.html   ← 網頁(讀 data.json)
data.json             ← 每日資料(腳本產生)
scripts/build-data.js ← Node 抓取腳本
.github/workflows/daily.yml ← 每日自動排程
```

## 運作方式

```
每交易日 15:10 (台北)
  → GitHub Actions 執行 scripts/build-data.js
  → 抓 TWSE / TPEx 官方 OpenAPI(免費、免金鑰)
  → 產生並提交 data.json
  → 網頁重新整理即顯示最新資料
```

瀏覽器直接打證交所 API 會被 CORS 擋,所以一律「**腳本先抓好 → 存成 data.json → 網頁只讀本地 JSON**」。

## 本機先跑一次

需要 Node.js 18 以上(內建 `fetch`,免裝套件):

```bash
node scripts/build-data.js   # 產生 / 更新 data.json
```

## 自動排程

把整個資料夾推到 GitHub repo,Actions 會依 `daily.yml` 每個交易日自動更新 `data.json`
(也可到 repo 的 **Actions** 分頁手動按 **Run workflow**)。

## 資料來源

| 區塊 | 來源 | 狀態 |
|---|---|---|
| 加權指數、漲跌 | TWSE `MI_INDEX` | ✅ 已接 |
| 個股漲跌幅/成交量排行 | TWSE `STOCK_DAY_ALL` | ✅ 已接 |
| 三大法人買賣超 | TWSE `BFI82U` | ✅ 已接 |
| 類股表現 | TWSE `MI_INDEX`(分類指數) | ⬜ 待補(腳本已留位置) |
| 櫃買、上櫃個股 | TPEx OpenAPI | ⬜ 待補 |
| 漲跌家數、區間、漲跌停 | TWSE 大盤統計 | ⬜ 待補 |
| 外資買賣超個股 | TWSE 外資買賣超彙總表 | ⬜ 待補 |
| 盤中分時走勢圖 | 券商即時 API(付費) | ⬜ 選配 |
| 國際市場 | Yahoo Finance / Stooq | ⬜ 待補 |
| 經濟數據行事曆 | 手動維護 / 財經行事曆來源 | ⬜ 待補 |
| 盤後重點新聞 | 各財經媒體 RSS | ⬜ 待補 |

> 目前 `data.json` 內是**完整示意資料**,畫面所有區塊都填滿。
> `build-data.js` 已串好「加權指數、個股排行、三大法人」三項真實來源,
> 其餘區塊在腳本中留了結構與註解,可逐步補上(補一塊、畫面就活一塊)。

## data.json 欄位速查

- `meta` — 日期、星期、收盤狀態、更新時間
- `taiex` — 加權指數、漲跌、成交金額、漲跌家數、分時點陣 `intraday`(走勢圖用)
- `tickers` — 頂部跑馬燈
- `tiles` — 大盤下方四格(櫃買 / 法人合計 / 外資 / 融資)
- `gainers` / `volume` / `losers` — 三張排行榜
- `institutions` — 三大法人 + 外資買賣超個股
- `sectors` — 類股漲跌(`pctNum` 控制長條長度)
- `intl` — 國際市場
- `calendar` — 經濟數據行事曆(`level`: high / today / normal)
- `news` — 盤後新聞(`type`: focus / normal)

漲跌顏色由各區塊的 `dir`(`up` 紅 / `down` 綠 / `flat` 灰)自動決定,符合台股慣例。

---
資料僅供參考,不構成投資建議。
