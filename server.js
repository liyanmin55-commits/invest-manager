// 投资管理系统 · 零依赖本地服务（静态托管 + 行情代理 一体）
//
// 为什么合二为一：原本行情代理放在 Cloudflare Worker（*.workers.dev），
// 但该域名在中国大陆直连不可达（必须开 VPN 才通）。本机 Node 起服务时
// 顺手把代理一起跑了，由 Node 服务端（无 CORS 限制、国内直连东财/腾讯没问题）
// 去抓行情，浏览器从同源 http://localhost:8080/api 拿数据，彻底不依赖 Cloudflare。
//
// 用法（CMD / Git Bash / PowerShell 均可，node.exe 不受执行策略影响）：
//   node server.js            # 默认 8080
//   node server.js 9090       # 自定义端口（此时浏览器代理要改成对应端口）
//
// 零依赖：仅 Node 内置 http/fs/path。需 Node ≥ 18（全局 fetch）。

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = parseInt(process.argv[2] || '8080', 10);
const ROOT = __dirname;

// ============ 行情代理逻辑（移植自 proxy/worker.js，零依赖、国内直连）============
const TENCENT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; invest-proxy/1.0)',
  'Referer': 'https://stockapp.finance.qq.com/',
};
const FUND_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (compatible; invest-proxy/1.0)',
  'Referer': 'http://fundf10.eastmoney.com/',
};

// 走腾讯财经的资产品类；基金单独处理
const TRADEABLE = ['股票', 'ETF', '可转债', '债券', '黄金'];
const FUND = '基金';

// 腾讯 qt.gtimg.cn 名字字段是 GBK。Node 22 默认 full-icu 支持 gbk；
// 万一运行在不带 legacy 编码的构建上，降级到 utf-8 不崩（名字可能乱码，但价格仍准）
let gbkDecoder;
try { gbkDecoder = new TextDecoder('gbk'); } catch (e) { gbkDecoder = new TextDecoder('utf-8'); }

// 6 位代码 => 带市场前缀的代码（腾讯财经需要 sh/sz/hk 前缀）
//   港股：5 位代码，hk + 代码
//   债券（须放在通用股票规则之前）：
//     019/018/010/02 → 沪国债/政策债；10 → 深债(企业债/国债)；
//     120/122/124/136 → 沪企业债/公司债；123/127/128 → 深可转债
//   沪市：6/9/5/11 开头 → sh ；深市：0/2/3/15/16 开头 → sz
function prefixOf(code) {
  const c = String(code);
  if (/^\d{5}$/.test(c)) return 'hk' + c;
  if (/^11/.test(c)) return 'sh' + c;   // 沪可转债
  if (/^12[378]/.test(c)) return 'sz' + c; // 深可转债
  if (/^12[024]/.test(c) || /^136/.test(c)) return 'sh' + c; // 沪企业债/公司债
  if (/^10/.test(c)) return 'sz' + c;   // 深市债券(企业债/国债)
  if (/^01[0289]/.test(c) || /^02/.test(c)) return 'sh' + c; // 沪国债/贴现债
  if (/^5/.test(c)) return 'sh' + c;    // 沪 ETF / 基金
  if (/^1[56]/.test(c)) return 'sz' + c; // 深 ETF / 基金
  if (/^[69]/.test(c)) return 'sh' + c;  // 沪 A / 科创板
  if (/^[023]/.test(c)) return 'sz' + c; // 深 A / 创业板
  return 'sh' + c; // 兜底
}

// 场外基金名称：东方财富搜索接口返回 NAME 字段
async function fetchFundName(symbol) {
  const u = 'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=' + encodeURIComponent(symbol);
  try {
    const r = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://fundf10.eastmoney.com/' } });
    const j = await r.json();
    const arr = j && (j.Datas || j.datas || j.data);
    if (Array.isArray(arr) && arr.length) {
      const hit = arr.find((x) => String(x.CODE || x.code || x._id) === symbol) || arr[0];
      const n = hit.NAME || hit.name || hit.SHORTNAME;
      return n ? String(n).trim() : '';
    }
  } catch (_) {}
  return '';
}

// 腾讯财经：一次拉多个，正则提当前价（f[3]，兜底昨收 f[4]）与名称（GBK 解码）
async function fetchTencent(items) {
  const out = {};
  const url = 'https://qt.gtimg.cn/q=' + items.map((i) => i.prefixed).join(',');
  try {
    const r = await fetch(url, { headers: TENCENT_HEADERS });
    const buf = await r.arrayBuffer();
    const txt = gbkDecoder.decode(buf);
    for (const line of txt.split(';')) {
      const m = line.match(/v_(\w+)="(.+)"/);
      if (!m) continue;
      const f = m[2].split('~');
      let price = parseFloat(f[3]);
      if (!(price > 0)) price = parseFloat(f[4]); // 停牌等情况下用昨收兜底
      if (!(price > 0)) continue;
      const orig = items.find((i) => i.prefixed === m[1]);
      if (orig) out[orig.symbol] = { price, name: (f[1] || '').trim() };
    }
  } catch (_) {
    // 整批失败则本批无行情
  }
  return out;
}

// 东方财富基金净值：DWJZ = 单位净值（日级，收盘后更新）
async function fetchFund(symbol) {
  const url =
    'https://api.fund.eastmoney.com/f10/lsjz?fundCode=' +
    encodeURIComponent(symbol) +
    '&pageIndex=1&pageSize=1';
  try {
    const r = await fetch(url, { headers: FUND_HEADERS });
    const j = await r.json();
    const list = j && j.Data && j.Data.LSJZList;
    if (list && list.length) {
      const price = parseFloat(list[0].DWJZ);
      if (!isNaN(price)) return { price, name: await fetchFundName(symbol) };
    }
  } catch (_) {}
  return null;
}

// 核心：把客户端发来的 quotes 逐个解析成 {symbol:{price,name}}
async function handleQuote(quotes) {
  const result = {};
  const funds = [];
  const tradeables = [];
  for (const q of quotes) {
    const symbol = String(q.symbol || '').trim();
    const asset = String(q.asset || '').trim();
    if (!symbol || symbol.toUpperCase() === 'CASH') continue; // 现金/存款无行情
    if (!asset) continue;                                     // 必须指定资产类型，避免乱返股票名误导
    if (asset === FUND) funds.push({ symbol });
    else if (TRADEABLE.includes(asset)) tradeables.push({ symbol, prefixed: prefixOf(symbol) });
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

function json(obj, status = 200) {
  return [
    status,
    {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
    JSON.stringify(obj),
  ];
}

// ============ HTTP 服务 ============
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch (_) {
    urlPath = '/';
  }

  // ---- 行情代理路由 ----
  if (urlPath === '/api') {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      const [s, h, b] = json({ ok: false, message: '请用 POST 发送 { quotes: [{ symbol, asset }] }' }, 405);
      res.writeHead(s, h); res.end(b);
      return;
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const data = body ? JSON.parse(body) : {};
        const quotes = Array.isArray(data.quotes) ? data.quotes : [];
        const result = await handleQuote(quotes);
        const [s, h, b] = json(result);
        res.writeHead(s, h); res.end(b);
      } catch (e) {
        const [s, h, b] = json({ ok: false, error: String(e) }, 400);
        res.writeHead(s, h); res.end(b);
      }
    });
    return;
  }

  // ---- 静态托管 ----
  const rel = urlPath === '/' ? '/index.html' : urlPath;
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403); res.end('forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not Found: ' + rel);
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(data);
  });
});

// 监听 0.0.0.0：同一 WiFi 下的手机也能访问（不是只监听本机 127.0.0.1）
function lanIPs() {
  const out = [];
  const ifs = os.networkInterfaces();
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) out.push(it.address);
    }
  }
  return out;
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`投资管家已起服务: http://localhost:${PORT}`);
  const ips = lanIPs();
  for (const ip of ips) {
    console.log(`手机看(需同一WiFi): http://${ip}:${PORT}`);
  }
  if (!ips.length) {
    console.log('(未检测到局域网 IP，手机暂无法访问；连上 WiFi 后重启本服务即可)');
  }
  console.log(`行情代理: POST http://localhost:${PORT}/api   body: { "quotes": [ { "symbol": "600519", "asset": "股票" } ] }`);
  console.log('不要关闭这个窗口；要停服务按 Ctrl+C');
  console.log('提示: 若手机打不开，检查 Windows 防火墙是否放行了 Node.js(第一次启动会弹窗, 勾选"专用网络"并点允许)');
});
