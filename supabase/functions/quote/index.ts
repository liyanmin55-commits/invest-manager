// Supabase Edge Function · 行情代理（云端版）
// 调用：POST https://<ref>.functions.supabase.co/quote
// body: { quotes: [{ symbol, asset }] }
// => { "600519": { price: 1304.66, name: "贵州茅台" }, ... }
//
// 数据源：东方财富(push2，UTF-8 干净 JSON) 为主，腾讯(qt.gtimg) 兜底；基金走净值接口。

const FUND = "基金";
const TRADEABLE = ["股票", "ETF", "可转债", "债券", "黄金"];

function prefixOf(code: string): string {
  const c = String(code);
  if (/^\d{5}$/.test(c)) return "hk" + c;
  if (/^11/.test(c)) return "sh" + c;
  if (/^12[378]/.test(c)) return "sz" + c;
  if (/^12[024]/.test(c) || /^136/.test(c)) return "sh" + c;
  if (/^10/.test(c)) return "sz" + c;
  if (/^01[0289]/.test(c) || /^02/.test(c)) return "sh" + c;
  if (/^5/.test(c)) return "sh" + c;
  if (/^1[56]/.test(c)) return "sz" + c;
  if (/^[69]/.test(c)) return "sh" + c;
  if (/^[023]/.test(c)) return "sz" + c;
  return "sh" + c;
}

// 东方财富 secid = <市场>.<代码>：上海=1，深圳=0，港股=116
function secidOf(prefixed: string): string {
  if (prefixed.startsWith("hk")) return "116." + prefixed.slice(2);
  if (prefixed.startsWith("sz")) return "0." + prefixed.slice(2);
  return "1." + prefixed.slice(2);
}

async function fetchFundName(symbol: string): Promise<string> {
  const u =
    "https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=" +
    encodeURIComponent(symbol);
  try {
    const r = await fetch(u, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://fundf10.eastmoney.com/" },
    });
    const j = await r.json();
    const arr = j && (j.Datas || j.datas || j.data);
    if (Array.isArray(arr) && arr.length) {
      const hit =
        arr.find((x: any) => String(x.CODE || x.code || x._id) === symbol) || arr[0];
      const n = hit.NAME || hit.name || hit.SHORTNAME;
      return n ? String(n).trim() : "";
    }
  } catch (_) {}
  return "";
}

// 东方财富（UTF-8 JSON，名字正确；f43 单位为分，需 /100）
async function fetchEM(items: { symbol: string; secid: string }[]) {
  const out: Record<string, { price: number; name: string }> = {};
  for (const it of items) {
    const url = "https://push2.eastmoney.com/api/qt/stock/get?secid=" + it.secid + "&fields=f43,f58";
    try {
      const r = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://quote.eastmoney.com/" },
      });
      const j = await r.json();
      const d = j && j.data;
      if (d && typeof d.f43 === "number" && d.f43 > 0) {
        out[it.symbol] = { price: d.f43 / 100, name: String(d.f58 || "").trim() };
      }
    } catch (_) {}
  }
  return out;
}

// 腾讯兜底（GBK，价格直接；名字可能乱码但价格仍准）
let gbk: TextDecoder;
try { gbk = new TextDecoder("gbk"); } catch { gbk = new TextDecoder("utf-8"); }

async function fetchTencent(items: { symbol: string; prefixed: string }[]) {
  const out: Record<string, { price: number; name: string }> = {};
  const url = "https://qt.gtimg.cn/q=" + items.map((i) => i.prefixed).join(",");
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://stockapp.finance.qq.com/" },
    });
    const buf = await r.arrayBuffer();
    const txt = gbk.decode(buf);
    for (const line of txt.split(";")) {
      const m = line.match(/v_(\w+)="(.+)"/);
      if (!m) continue;
      const f = m[2].split("~");
      let price = parseFloat(f[3]);
      if (!(price > 0)) price = parseFloat(f[4]);
      if (!(price > 0)) continue;
      const orig = items.find((i) => i.prefixed === m[1]);
      if (orig) out[orig.symbol] = { price, name: (f[1] || "").trim() };
    }
  } catch (_) {}
  return out;
}

async function fetchFund(symbol: string) {
  const url =
    "https://api.fund.eastmoney.com/f10/lsjz?fundCode=" +
    encodeURIComponent(symbol) +
    "&pageIndex=1&pageSize=1";
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Referer": "http://fundf10.eastmoney.com/" },
    });
    const j = await r.json();
    const list = j && j.Data && j.Data.LSJZList;
    if (list && list.length) {
      const price = parseFloat(list[0].DWJZ);
      if (!isNaN(price)) return { price, name: await fetchFundName(symbol) };
    }
  } catch (_) {}
  return null;
}

async function handleQuote(quotes: { symbol: string; asset: string }[]) {
  const result: Record<string, { price: number; name: string }> = {};
  const funds: string[] = [];
  const tradeables: { symbol: string; prefixed: string; secid: string }[] = [];
  for (const q of quotes) {
    const symbol = String(q.symbol || "").trim();
    const asset = String(q.asset || "").trim();
    if (!symbol || symbol.toUpperCase() === "CASH") continue;
    if (!asset) continue; // 必须指定类型，避免误返股票名
    if (asset === FUND) funds.push(symbol);
    else if (TRADEABLE.includes(asset)) {
      const prefixed = prefixOf(symbol);
      tradeables.push({ symbol, prefixed, secid: secidOf(prefixed) });
    }
  }
  for (const s of funds) {
    const r = await fetchFund(s);
    if (r) result[s] = r;
  }
  if (tradeables.length) {
    const em = await fetchEM(tradeables.map((t) => ({ symbol: t.symbol, secid: t.secid })));
    const missing = tradeables.filter((t) => !em[t.symbol]);
    Object.assign(result, em);
    if (missing.length) {
      const tx = await fetchTencent(missing.map((t) => ({ symbol: t.symbol, prefixed: t.prefixed })));
      Object.assign(result, tx);
    }
  }
  return result;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST")
    return new Response(JSON.stringify({ ok: false }), { status: 405, headers: cors });
  try {
    const data = await req.json();
    const quotes = Array.isArray(data.quotes) ? data.quotes : [];
    const result = await handleQuote(quotes);
    return new Response(JSON.stringify(result), {
      headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: String(e) }), {
      status: 400,
      headers: cors,
    });
  }
});
