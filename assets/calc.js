/* 计算层：流水 -> 持仓聚合、市值/盈亏、分布、定投进度。全局 Calc。 */
const Calc = (() => {
  const ASSETS = ["股票", "基金", "ETF", "可转债", "债券", "黄金", "存款", "理财"];

  // 风险分层：资产类型 -> 默认风险分层（手动标注时的预填值，用户可改）
  //   稳健：低波动固收（债/存款/理财）；进阶：权益类（股/ETF/可转债/多数基金）；对冲：黄金
  const RISK_TIERS = { 债券: "稳健", 存款: "稳健", 理财: "稳健", 股票: "进阶", ETF: "进阶", 可转债: "进阶", 黄金: "对冲", 基金: "进阶" };
  const riskOf = (asset, risk) => risk || RISK_TIERS[asset] || "进阶";

  function uid() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  // 把流水按 (账户+标的) 聚合成持仓，用加权成本法 + 已实现收益
  function aggregate(transactions) {
    const map = new Map();
    const sorted = [...transactions].sort(
      (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    );
    for (const t of sorted) {
      const key = t.account + "::" + t.symbol;
      if (!map.has(key))
        map.set(key, {
          account: t.account,
          symbol: t.symbol,
          name: t.name,
          asset: t.asset,
          risk: t.risk,
          quantity: 0,
          avgCost: 0,
          realized: 0,
        });
      const p = map.get(key);
      p.name = t.name; // 取最近一次名称
      p.asset = t.asset;
      if (t.risk) p.risk = t.risk; // 取最近一次风险分层
      const cost = t.price * t.quantity + (t.fee || 0);
      if (t.type === "buy") {
        const newQty = p.quantity + t.quantity;
        p.avgCost = newQty > 0 ? (p.avgCost * p.quantity + cost) / newQty : 0;
        p.quantity = newQty;
      } else {
        p.realized += (t.price - p.avgCost) * t.quantity - (t.fee || 0);
        p.quantity = Math.max(0, p.quantity - t.quantity);
      }
    }
    return [...map.values()].sort((a, b) =>
      a.asset === b.asset ? a.name.localeCompare(b.name) : ASSETS.indexOf(a.asset) - ASSETS.indexOf(b.asset)
    );
  }

  // 用行情价补全市值/盈亏
  function enrich(positions, prices) {
    return positions.map((p) => {
      const price = prices[p.symbol];
      const hasPrice = typeof price === "number";
      const cost = p.avgCost * p.quantity;
      const marketValue = hasPrice ? price * p.quantity : cost;
      const unrealized = marketValue - cost;
      const totalPnl = unrealized + p.realized;
      return {
        ...p,
        price: hasPrice ? price : p.avgCost,
        priceMissing: !hasPrice,
        cost,
        marketValue,
        unrealized,
        totalPnl,
        pnlPct: cost > 0 ? (unrealized / cost) * 100 : 0,
      };
    });
  }

  function totals(pos) {
    let marketValue = 0, cost = 0, unrealized = 0, realized = 0;
    for (const p of pos) {
      marketValue += p.marketValue;
      cost += p.cost;
      unrealized += p.unrealized;
      realized += p.realized;
    }
    return {
      netAsset: marketValue,
      cost,
      unrealized,
      realized,
      totalPnl: unrealized + realized,
      totalPnlPct: cost > 0 ? (unrealized / cost) * 100 : 0,
    };
  }

  function allocation(pos) {
    const m = new Map();
    for (const p of pos) {
      if (p.quantity <= 0) continue;
      m.set(p.asset, (m.get(p.asset) || 0) + p.marketValue);
    }
    return [...m.entries()]
      .map(([asset, value]) => ({ asset, value }))
      .sort((a, b) => b.value - a.value);
  }

  function topContributors(pos, n = 5) {
    return [...pos]
      .filter((p) => p.quantity > 0)
      .sort((a, b) => b.totalPnl - a.totalPnl)
      .slice(0, n);
  }

  // 定投进度：汇总该计划下所有流水
  function dcaProgress(plan, transactions) {
    const tx = transactions.filter((t) => t.planId === plan.id);
    let invested = 0, qty = 0, realized = 0;
    for (const t of tx) {
      if (t.type === "buy") {
        invested += t.price * t.quantity + (t.fee || 0);
        qty += t.quantity;
      } else {
        realized += (t.price - t.avgCost) * t.quantity; // 近似
        qty -= t.quantity;
      }
    }
    return { invested, execCount: tx.length, qty: Math.max(0, qty), realized };
  }

  // 按风险分层（稳健/进阶/对冲）聚合市值
  function riskSplit(pos) {
    const m = new Map();
    for (const p of pos) {
      if (p.quantity <= 0) continue;
      const r = riskOf(p.asset, p.risk);
      m.set(r, (m.get(r) || 0) + p.marketValue);
    }
    return [...m.entries()].map(([risk, value]) => ({ risk, value })).sort((a, b) => b.value - a.value);
  }

  // 最大单一标的集中度
  function concentration(pos) {
    const open = pos.filter((p) => p.quantity > 0);
    const total = open.reduce((s, p) => s + p.marketValue, 0);
    let top = null;
    for (const p of open) if (!top || p.marketValue > top.marketValue) top = p;
    return { top, total, pct: total > 0 && top ? (top.marketValue / total) * 100 : 0 };
  }

  // 定投日均现金流估算（用于体检提示现金流压力）
  function dcaDaily(plans) {
    let daily = 0;
    const byFreq = {};
    for (const pl of plans) {
      const amt = +pl.amount || 0;
      if (amt <= 0) continue;
      const f = pl.freq;
      const perDay = f === "每日" ? amt : f === "每周" ? amt / 7 : f === "每两周" ? amt / 14 : amt / 30;
      daily += perDay;
      byFreq[f] = (byFreq[f] || 0) + amt;
    }
    return { daily, byFreq };
  }

  // 格式化
  const fmt = (n, d = 2) =>
    "¥" + Number(n).toLocaleString("zh-CN", { minimumFractionDigits: d, maximumFractionDigits: d });
  const pct = (n) => (n >= 0 ? "+" : "") + n.toFixed(2) + "%";
  const sign = (n) => (n >= 0 ? "+" : "-") + fmt(Math.abs(n));

  return {
    ASSETS, RISK_TIERS, riskOf, uid, aggregate, enrich, totals, allocation, topContributors,
    riskSplit, concentration, dcaDaily, dcaProgress, fmt, pct, sign,
  };
})();
