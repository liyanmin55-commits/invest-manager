// 投资管家 · 行情代理（Cloudflare Worker，ES Module 格式）
// 作用：浏览器跨域拉不到股票/基金行情，由这个零运维的边缘函数转发。
//      它只收到「代码」，看不到你的账户、金额、持仓——隐私留在你本机。
//
// 契约：
//   请求  POST /  body: { "quotes": [ { "symbol": "600519", "asset": "股票" }, ... ] }
//   响应        { "600519": { "price": 1272.83, "name": "" }, ... }
//
// 数据源：
//   - 股票 / ETF / 可转债 / 黄金(上市ETF) / 港股 → 腾讯财经 qt.gtimg.cn（返回已是「元」）
//   - 基金(场外公募) → 东方财富 基金历史净值接口（DWJZ=单位净值）
//
// 部署：见同目录 README.md（wrangler deploy，免费额度足够个人用）

const TENCENT_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; invest-proxy/1.0)",
  "Referer": "https://stockapp.finance.qq.com/",
};
const FUND_HEADERS = {
  "User-Agent": "Mozilla/5.0 (compatible; invest-proxy/1.0)",
  "Referer": "http://fundf10.eastmoney.com/",
};

// 走腾讯财经的资产品类；基金单独处理
const TRADEABLE = ["股票", "ETF", "可转债", "黄金"];
const FUND = "基金";

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Cache-Control": "no-store",
    },
  });
}

// 6 位代码 => 带市场前缀的代码（腾讯财经需要 sh/sz/hk 前缀）
//   港股：5 位代码，hk + 代码
//   沪市：6/9/5/11 开头 → sh ；深市：0/2/3/12/15/16 开头 → sz
function prefixOf(code) {
  const c = String(code);
  if (/^\d{5}$/.test(c)) return "hk" + c;
  if (/^11/.test(c)) return "sh" + c;   // 沪可转债
  if (/^12/.test(c)) return "sz" + c;   // 深可转债
  if (/^5/.test(c)) return "sh" + c;    // 沪 ETF / 基金
  if (/^1[56]/.test(c)) return "sz" + c; // 深 ETF / 基金
  if (/^[69]/.test(c)) return "sh" + c;  // 沪 A / 科创板
  if (/^[023]/.test(c)) return "sz" + c; // 深 A / 创业板
  return "sh" + c; // 兜底
}

// 场外基金名称：东方财富搜索接口返回 NAME 字段
async function fetchFundName(symbol) {
  const u = "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=" + encodeURIComponent(symbol);
  try {
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://fundf10.eastmoney.com/" } });
    const j = await r.json();
    const arr = j && (j.Datas || j.datas || j.data);
    if (Array.isArray(arr) && arr.length) {
      const hit = arr.find((x) => String(x.CODE || x.code || x._id) === symbol) || arr[0];
      const n = hit.NAME || hit.name || hit.SHORTNAME;
      return n ? String(n).trim() : "";
    }
  } catch (_) {}
  return "";
}

// 腾讯财经：一次拉多个，正则提当前价（f[3]，兜底昨收 f[4]）与名称（GBK 解码）。
// 名字字段是 GBK：用 arrayBuffer + TextDecoder("gbk") 解码拿到中文名（避免 .text() 的 UTF-8 乱码）
async function fetchTencent(items) {
  const out = {};
  const url = "https://qt.gtimg.cn/q=" + items.map((i) => i.prefixed).join(",");
  try {
    const r = await fetch(url, { headers: TENCENT_HEADERS });
    const buf = await r.arrayBuffer();
    const txt = new TextDecoder("gbk").decode(buf);
    for (const line of txt.split(";")) {
      const m = line.match(/v_(\w+)="(.+)"/);
      if (!m) continue;
      const f = m[2].split("~");
      let price = parseFloat(f[3]);
      if (!(price > 0)) price = parseFloat(f[4]); // 停牌等情况下用昨收兜底
      if (!(price > 0)) continue;
      const orig = items.find((i) => i.prefixed === m[1]);
      if (orig) out[orig.symbol] = { price, name: (f[1] || "").trim() };
    }
  } catch (_) {
    // 整批失败则本批无行情
  }
  return out;
}

// 东方财富基金净值：DWJZ = 单位净值（日级，收盘后更新，对基金净值场景最合适）
async function fetchFund(symbol) {
  const url =
    "https://api.fund.eastmoney.com/f10/lsjz?fundCode=" +
    encodeURIComponent(symbol) +
    "&pageIndex=1&pageSize=1";
  try {
    const r = await fetch(url, { headers: FUND_HEADERS });
    const j = await r.json();
    const list = j && j.Data && j.Data.LSJZList;
    if (list && list.length) {
      const price = parseFloat(list[0].DWJZ);
      if (!isNaN(price)) return { price, name: await fetchFundName(symbol) };
    }
  } catch (_) {
    // 失败返回 null，由客户端退回手动价
  }
  return null;
}

// 核心：把客户端发来的 quotes 逐个解析成 {symbol:{price,name}}
async function handleQuote(quotes) {
  const result = {};
  const funds = [];
  const tradeables = [];
  for (const q of quotes) {
    const symbol = String(q.symbol || "").trim();
    const asset = String(q.asset || "").trim();
    if (!symbol || symbol.toUpperCase() === "CASH") continue; // 现金/存款无行情
    if (asset === FUND) funds.push({ symbol });
    else if (TRADEABLE.includes(asset) || !asset) tradeables.push({ symbol, prefixed: prefixOf(symbol) });
  }
  // 场外基金逐个拉
  for (const f of funds) {
    const r = await fetchFund(f.symbol);
    if (r) result[f.symbol] = r;
  }
  // 上市标的批量拉腾讯（价+名一次性拿到）
  if (tradeables.length) {
    const got = await fetchTencent(tradeables);
    Object.assign(result, got);
  }
  return result;
}

export { prefixOf, fetchTencent, fetchFund, handleQuote };

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }
    if (request.method !== "POST") {
      return jsonResponse(
        { ok: false, message: "请用 POST 发送 { quotes: [{ symbol, asset }] }" },
        405
      );
    }
    try {
      const body = await request.json();
      const quotes = Array.isArray(body && body.quotes) ? body.quotes : [];
      const result = await handleQuote(quotes);
      return jsonResponse(result);
    } catch (e) {
      return jsonResponse({ ok: false, error: String(e) }, 400);
    }
  },
};
