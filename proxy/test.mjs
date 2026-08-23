// 本地验证脚本：直接调用 worker.js 里的数据源函数，确认契约没问题。
// 用法（在你真机，需联网）： node test.mjs
import { prefixOf, fetchFund, handleQuote } from "./worker.js";

const samples = [
  { symbol: "600519", asset: "股票", label: "贵州茅台(A股)" },
  { symbol: "300750", asset: "股票", label: "宁德时代(创业板)" },
  { symbol: "510300", asset: "ETF", label: "沪深300ETF" },
  { symbol: "518880", asset: "黄金", label: "黄金ETF" },
  { symbol: "113050", asset: "可转债", label: "南银转债(可转债)" },
  { symbol: "00700", asset: "股票", label: "腾讯控股(港股)" },
  { symbol: "005827", asset: "基金", label: "易方达蓝筹(场外基金)" },
];

console.log("== 市场前缀检查 ==");
for (const s of samples) {
  if (s.asset === "基金") continue;
  console.log(s.symbol.padEnd(7), "->", prefixOf(s.symbol), "  ", s.label);
}

console.log("\n== 走 handleQuote（与线上一致） ==");
const out = await handleQuote(samples.map((s) => ({ symbol: s.symbol, asset: s.asset })));
for (const s of samples) {
  const r = out[s.symbol];
  console.log(s.label.padEnd(20), r ? `¥${r.price}  ${r.name || "(无名)"}` : "未取到");
}
console.log("\n原始返回：");
console.log(JSON.stringify(out, null, 2));
