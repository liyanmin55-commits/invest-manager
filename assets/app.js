/* 应用外壳：路由、六大视图、交互。全局 App。 */
const App = (() => {
  const PALETTE = ["#378ADD", "#7F77DD", "#EF9F27", "#888780", "#1D9E75", "#E24B4A", "#534AB7"];
  let state = { prices: {}, route: "dashboard" };
  let charts = [];
  let buyMode = "qty"; // 记账买入方式：qty 按数量 / amt 按金额 / cost 持仓+盈亏（按 CNY 市值反推份额与成本）

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const { fmt, pct, sign } = Calc;

  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (t.hidden = true), 1800);
  }
  function cls(n) { return n >= 0 ? "up" : "down"; }
  function disposeCharts() { charts.forEach((c) => c.dispose()); charts = []; }

  // 定投频率展示文案：每日 / 每周X / 每两周X / 每月X号
  const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  function freqLabel(plan) {
    const d = plan.day | 0;
    if (plan.freq === "每日") return "每日";
    if (plan.freq === "每周") return "每周" + WEEKDAYS[(d + 7) % 7];
    if (plan.freq === "每两周") return "每两周" + WEEKDAYS[(d + 7) % 7];
    return "每月" + d + "号"; // 每月
  }

  async function loadPrices() { state.prices = (await DB.meta("prices")) || {}; }
  async function savePrices() { await DB.meta("prices", state.prices); }
  async function allData() {
    const [tx, plans] = await Promise.all([DB.all("transactions"), DB.all("plans")]);
    const pos = Calc.enrich(Calc.aggregate(tx), state.prices);
    return { tx, plans, pos, tot: Calc.totals(pos), alloc: Calc.allocation(pos) };
  }

  /* ---------- 路由 ---------- */
  async function render() {
    disposeCharts();
    const view = $("#view");
    const d = await allData();
    const builders = { dashboard: dash, holdings: hold, analytics: analy, ledger: ledg, dca: dca, settings: sett };
    view.innerHTML = builders[state.route](d);
    bind[state.route]?.(d);
  }
  function setRoute(r) {
    state.route = r;
    $$(".tab").forEach((b) => b.classList.toggle("active", b.dataset.route === r));
    render();
  }

  /* ---------- 总览 ---------- */
  function dash(d) {
    const { tot, alloc, pos } = d;
    const top = Calc.topContributors(pos, 3);
    const maxPos = pos.filter((p) => p.quantity > 0).sort((a, b) => b.marketValue - a.marketValue)[0];
    const conc = maxPos && tot.netAsset > 0 ? (maxPos.marketValue / tot.netAsset) * 100 : 0;
    const donut = alloc.map((a) => ({ name: a.asset, value: Math.round(a.value) }));
    const legend = alloc.map((a, i) =>
      `<span style="display:flex;align-items:center;gap:6px;"><span style="width:10px;height:10px;border-radius:2px;background:${PALETTE[i % PALETTE.length]}"></span>${a.asset} ${((a.value / tot.netAsset) * 100).toFixed(0)}%</span>`
    ).join("");
    const rows = top.map((p) =>
      `<div class="row"><span>${p.name} <span class="badge gray">${p.asset}</span></span><span>${fmt(p.marketValue)} <span class="${cls(p.totalPnl)}">${sign(p.totalPnl)}</span></span></div>`
    ).join("") || `<p class="muted tiny">暂无持仓</p>`;
    return `
      <div class="card">
        <p class="muted tiny" style="margin:0;">总资产净值</p>
        <p style="font-size:30px;font-weight:600;margin:4px 0 0;">${fmt(tot.netAsset)}</p>
        <div class="row" style="margin-top:6px;">
          <span class="tiny ${cls(tot.totalPnl)}">累计收益 ${sign(tot.totalPnl)}</span>
          <span class="tiny ${cls(tot.unrealized)}">未实现 ${sign(tot.unrealized)}</span>
        </div>
      </div>
      <div class="metric-grid">
        <div class="metric"><p class="label">总资产</p><p class="value">${fmt(tot.netAsset, 0)}</p></div>
        <div class="metric"><p class="label">累计收益</p><p class="value ${cls(tot.totalPnl)}">${sign(tot.totalPnl)}</p></div>
        <div class="metric"><p class="label">已实现</p><p class="value ${cls(tot.realized)}">${sign(tot.realized)}</p></div>
        <div class="metric"><p class="label">未实现</p><p class="value ${cls(tot.unrealized)}">${sign(tot.unrealized)}</p></div>
      </div>
      <div class="card" style="margin-top:12px;">
        <p class="card-title">资产配置</p>
        <div style="display:flex;align-items:center;gap:20px;flex-wrap:wrap;">
          <div id="donut" class="chart" style="height:200px;max-width:240px;"></div>
          <div style="display:flex;flex-direction:column;gap:8px;font-size:12px;color:var(--text-2);">${legend}</div>
        </div>
        <p class="tiny ${conc > 40 ? "down" : "muted"}" style="margin:10px 0 0;">
          最大持仓集中度 ${conc.toFixed(1)}%${conc > 40 ? " · 偏高，注意风险" : ""}
        </p>
      </div>
      <div class="card">
        <p class="card-title">持仓速览</p>
        ${rows}
      </div>`;
  }

  /* ---------- 持仓 ---------- */
  function hold(d) {
    const open = d.pos.filter((p) => p.quantity > 0);
    const opts = Calc.ASSETS.map((a) => `<option value="${a}">${a}</option>`).join("");
    const rows = open.map((p) =>
      `<tr>
        <td>${p.name}<br><span class="muted tiny">${p.symbol} · ${p.account}</span></td>
        <td><span class="badge gray">${p.asset}</span></td>
        <td class="right">${p.quantity}</td>
        <td class="right">${fmt(p.avgCost)}</td>
        <td class="right">${p.priceMissing ? '<span class="muted tiny">无行情</span>' : fmt(p.price)}</td>
        <td class="right">${fmt(p.marketValue, 0)}</td>
        <td class="right ${cls(p.unrealized)}">${sign(p.unrealized)}<br><span class="tiny">${pct(p.pnlPct)}</span></td>
      </tr>`
    ).join("") || `<tr><td colspan="7" class="muted">暂无持仓，去「记账」添加第一笔</td></tr>`;
    return `
      <div class="field"><label>按资产筛选</label>
        <select id="f-asset" class="select"><option value="">全部</option>${opts}</select></div>
      <div class="card" style="padding:0;overflow:hidden;">
        <table class="table"><thead><tr>
          <th>标的</th><th>类型</th><th class="right">数量</th><th class="right">成本</th>
          <th class="right">现价</th><th class="right">市值</th><th class="right">盈亏</th>
        </tr></thead><tbody>${rows}</tbody></table>
      </div>`;
  }

  /* ---------- 分析 ---------- */
  function analy(d) {
    const open = d.pos.filter((p) => p.quantity > 0);
    const totMV = d.tot.netAsset || 0;
    const WARN = 'style="color:#A32D2D"';

    // ---- 配置体检（纯本地数据）----
    const split = Calc.riskSplit(d.pos);
    const riskRows = split.length
      ? split.map((r) => `<div class="row"><span>${r.risk}</span><span>${fmt(r.value)} · ${(totMV > 0 ? (r.value / totMV) * 100 : 0).toFixed(1)}%</span></div>`).join("")
      : '<p class="muted tiny">暂无持仓</p>';
    const c = Calc.concentration(d.pos);
    const concRow = c.top ? `<div class="row"><span>最大单一持仓</span><span ${c.pct > 8 ? WARN : ""}>${c.top.name} ${c.pct.toFixed(1)}%</span></div>` : "";
    const eq = open.filter((p) => ["股票", "ETF", "可转债"].includes(p.asset)).reduce((s, p) => s + p.marketValue, 0);
    const eqPct = totMV > 0 ? (eq / totMV) * 100 : 0;
    const equityRow = `<div class="row"><span>权益类暴露（股/ETF/可转债）</span><span ${eqPct > 70 ? WARN : ""}>${fmt(eq)} · ${eqPct.toFixed(1)}%</span></div>`;
    const cf = Calc.dcaDaily(d.plans);
    const cashflowRow = cf.daily > 0 ? `<div class="row"><span>定投日均现金流</span><span>${fmt(cf.daily)}/天</span></div>` : "";
    const eqCount = open.filter((p) => ["股票", "ETF", "可转债"].includes(p.asset)).length;
    let corrTip = "";
    if (eqCount >= 3) corrTip = `<p class="tiny muted" style="margin-top:8px;">⚠️ 持有 ${eqCount} 只权益类标的，多跟踪 A股、相关性较高，分散效果有限；建议控制单类占比、搭配稳健型（债/短债）底仓。</p>`;
    else if (eqCount === 2) corrTip = `<p class="tiny muted" style="margin-top:8px;">提示：权益类有 ${eqCount} 只，注意是否高度相关（如沪深300 与 中证500 都属 A股宽基，配两只≈一笔 A股仓）。</p>`;
    const checkup = `
      <div class="card">
        <p class="card-title">配置体检</p>
        ${riskRows}
        ${concRow}
        ${equityRow}
        ${cashflowRow}
        ${corrTip}
      </div>`;

    const bar = d.alloc.map((a) => ({ name: a.asset, value: Math.round(a.value) }));
    const top = Calc.topContributors(open, 8);
    const list = top.map((p) =>
      `<div class="row"><span>${p.name} <span class="badge gray">${p.asset}</span></span>
       <span class="${cls(p.totalPnl)}">${sign(p.totalPnl)} <span class="tiny">${pct(p.pnlPct)}</span></span></div>`
    ).join("");
    return `
      ${checkup}
      <div class="card">
        <p class="card-title">各类资产市值</p>
        <div id="bar" class="chart" style="height:240px;"></div>
      </div>
      <div class="card">
        <p class="card-title">盈亏贡献排行（按标的）</p>
        ${list || '<p class="muted tiny">暂无数据</p>'}
      </div>`;
  }

  /* ---------- 记账（流水） ---------- */
  function ledg(d) {
    const assetOpts = Calc.ASSETS.map((a) => `<option value="${a}">${a}</option>`).join("");
    const recent = [...d.tx].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 12);
    const rows = recent.map((t) =>
      `<tr><td>${t.date}<br><span class="muted tiny">${t.name}</span></td>
        <td><span class="badge ${t.type === "buy" ? "" : "gray"}">${t.type === "buy" ? "买入" : "卖出"}</span></td>
        <td class="right">${t.quantity}</td>
        <td class="right">${fmt(t.price)}</td>
        <td class="right"><button class="btn btn-danger tiny" data-del-tx="${t.id}">删</button></td></tr>`
    ).join("") || `<tr><td colspan="5" class="muted">还没有流水</td></tr>`;
    return `
      <div class="card">
        <p class="card-title">记一笔</p>
        <form id="tx-form" class="form-grid">
          <div class="field"><label>账户</label><input class="input" name="account" placeholder="如 华泰/支付宝" required></div>
          <div class="field"><label>代码</label><input class="input" name="symbol" placeholder="如 600519（失焦自动补名）" required></div>
          <div class="field"><label>名称</label><input class="input" name="name" placeholder="自动补全或手填" required><span class="autofill-tip tiny muted" data-name-tip></span></div>
          <div class="field"><label>资产类型</label><select class="select" name="asset">${assetOpts}</select></div>
          <div class="field"><label>风险分层</label><select class="select" name="risk"><option>稳健</option><option>进阶</option><option>对冲</option></select></div>
          <div class="field"><label>方向</label><select class="select" name="type"><option value="buy">买入</option><option value="sell">卖出</option></select></div>

          <div class="field" data-buy-mode style="grid-column:1 / -1;">
            <label>买入方式</label>
            <div class="seg">
              <button type="button" class="seg-btn" data-mode="qty">按数量</button>
              <button type="button" class="seg-btn" data-mode="amt">按金额</button>
              <button type="button" class="seg-btn" data-mode="cost">持仓+盈亏</button>
            </div>
          </div>

          <div class="field"><label>数量</label><input class="input" type="number" step="any" name="quantity" required></div>
          <div class="field" data-f="amt" hidden><label>投入金额(¥)</label><input class="input" type="number" step="any" name="amount"></div>
          <div class="field" data-f="cost" hidden><label>持仓（按当前市值，CNY）</label><input class="input" type="number" step="any" name="holdval" placeholder="如 1000"></div>
          <div class="field" data-f="cost" hidden><label>当前盈亏（CNY，可负）</label><input class="input" type="number" step="any" name="pnl" value="0"></div>
          <div class="field" data-f="cost" hidden><label>最新价格/净值</label><input class="input" type="number" step="any" name="curprice" placeholder="如 2.2692"></div>
          <div class="field" data-f="cost" hidden><label>优惠（CNY）</label><input class="input" type="number" step="any" name="discount" value="0"></div>

          <div class="field"><label>价格</label><input class="input" type="number" step="any" name="price" required></div>
          <div class="field"><label>手续费</label><input class="input" type="number" step="any" name="fee" value="0"></div>
          <div class="field"><label>日期</label><input class="input" type="date" name="date" required></div>
          <div class="field" style="align-self:end;"><button class="btn btn-primary" type="submit" style="width:100%">保存</button></div>
          <div class="field" style="grid-column:1 / -1;"><span class="tiny muted" data-preview></span></div>
        </form>
      </div>
      <div class="card" style="padding:0;overflow:hidden;">
        <p class="card-title" style="padding:16px 16px 0;">最近流水</p>
        <table class="table"><thead><tr><th>日期/标的</th><th>方向</th><th class="right">数量</th><th class="right">价格</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      </div>`;
  }

  /* ---------- 定投 ---------- */
  function dca(d) {
    const assetOpts = Calc.ASSETS.map((a) => `<option value="${a}">${a}</option>`).join("");
    const cards = d.plans.map((p) => {
      const prog = Calc.dcaProgress(p, d.tx);
      return `<div class="card" style="margin-bottom:12px;">
        <div class="row"><span><b>${p.name}</b> <span class="badge gray">${p.asset}</span></span>
          <span class="tiny muted">${freqLabel(p)} · ${fmt(p.amount, 0)}/期</span></div>
        <p class="tiny muted" style="margin:8px 0;">已投 ${fmt(prog.invested, 0)} · 执行 ${prog.execCount} 次${p.lastRun ? " · 上次 " + p.lastRun : ""}</p>
        <form class="form-grid" data-exec="${p.id}" style="margin-top:8px;">
          <input class="input" name="price" type="number" step="any" placeholder="本次价格" required>
          <input class="input" name="quantity" type="number" step="any" placeholder="本次数量" required>
          <input class="input" type="date" name="date" required>
          <button class="btn btn-primary" type="submit">记录执行</button>
        </form>
        <div class="row" style="margin-top:8px;">
          <button class="btn btn-danger tiny" data-del-plan="${p.id}">删除计划</button>
        </div>
      </div>`;
    }).join("") || `<p class="muted tiny">还没有定投计划</p>`;
    return `
      <div class="card">
        <p class="card-title">新建定投计划</p>
        <form id="plan-form" class="form-grid">
          <div class="field"><label>代码</label><input class="input" name="symbol" placeholder="如 510300（失焦自动补名）" required></div>
          <div class="field"><label>名称</label><input class="input" name="name" placeholder="自动补全或手填" required><span class="autofill-tip tiny muted" data-name-tip></span></div>
          <div class="field"><label>类型</label><select class="select" name="asset">${assetOpts}</select></div>
          <div class="field"><label>风险分层</label><select class="select" name="risk"><option>稳健</option><option>进阶</option><option>对冲</option></select></div>
          <div class="field"><label>每期金额</label><input class="input" type="number" step="any" name="amount" required></div>
          <div class="field"><label>频率</label><select class="select" name="freq"><option>每月</option><option>每周</option><option>每两周</option><option>每日</option></select></div>
          <div class="field" data-day-field><label data-day-label>定投日</label><input class="input" type="number" name="day" min="1" max="31" value="1"></div>
          <div class="field" style="align-self:end;"><button class="btn btn-primary" type="submit" style="width:100%">添加</button></div>
        </form>
      </div>
      ${cards}`;
  }

  /* ---------- 设置 ---------- */
  function sett(d) {
    const symbols = [...new Set(d.tx.map((t) => t.symbol))];
    const priceRows = symbols.map((s) =>
      `<div class="row"><span class="tiny">${s}</span>
        <input class="input" type="number" step="any" value="${state.prices[s] ?? ""}" data-price="${s}" style="max-width:140px;"></div>`
    ).join("") || `<p class="muted tiny">暂无标的</p>`;
    return `
      <div class="card">
        <p class="card-title">数据备份（务必定期导出）</p>
        <div class="row">
          <button class="btn btn-primary" id="export">导出 JSON</button>
          <label class="btn">导入 JSON<input id="import" type="file" accept="application/json" hidden></label>
        </div>
        <p class="tiny muted" style="margin:8px 0 0;">数据只存你本机，清缓存或换设备会丢失，请妥善保存导出文件。</p>
      </div>
      <div class="card">
        <p class="card-title">手动行情</p>
        <p class="tiny muted" style="margin:0 0 10px;">没有配置行情代理时，在这里维护每个标的的现价。</p>
        ${priceRows}
        <button class="btn btn-primary" id="save-prices" style="margin-top:10px;">保存行情</button>
      </div>
      <div class="card">
        <p class="card-title">行情代理（高级）</p>
        <p class="tiny muted" style="margin:0 0 10px;">行情代理地址。本地起 server.js 后默认自动用当前访问地址的 /api（电脑 localhost、手机连电脑 IP 均自动适配，一般无需修改）。App 会 POST 当前持仓的 {代码,类型}，它返回 {代码:{现价,名称}}，点顶部「刷新行情」即自动更新。留空则用上面的手动价。</p>
        <input class="input" id="proxy" placeholder="自动（当前地址/api）" value="${(window.__proxy || "")}">
        <button class="btn btn-primary" id="save-proxy" style="margin-top:10px;">保存代理地址</button>
      </div>
      <div class="card">
        <p class="card-title">云端同步（可选 · 多端一致）</p>
        <p class="tiny muted" style="margin:0 0 10px;">填 Supabase 项目 URL 与 anon key 后，持仓流水与定投计划自动多端同步（手机/电脑看同一份数据）。留空则仅本机存储、行为不变。需先在 Supabase 执行 schema.sql 建表。</p>
        <input class="input" id="sb-url" placeholder="https://xxxx.supabase.co" value="${(window.__sb && window.__sb.url) || ""}">
        <input class="input" id="sb-key" placeholder="anon public key" value="${(window.__sb && window.__sb.key) || ""}">
        <input class="input" id="sb-owner" placeholder="云端库标识（建议随机串，用于隔离）" value="${(window.__sb && window.__sb.owner) || ""}">
        <div class="row" style="margin-top:10px;">
          <button class="btn btn-primary" id="save-sync">保存并连接</button>
          <button class="btn" id="test-sync">测试连接</button>
        </div>
        <p class="tiny muted" id="sync-status" style="margin:8px 0 0;"></p>
      </div>
      <div class="card">
        <p class="card-title">危险区</p>
        <button class="btn btn-danger" id="wipe">清空全部数据</button>
        <button class="btn" id="load-sample" style="margin-left:8px;">载入示例数据</button>
        <p class="tiny muted" style="margin:8px 0 0;">「载入示例数据」会写入一份演示持仓（覆盖当前交易/计划），方便先看效果；录真实数据前请先清空。</p>
      </div>`;
  }

  /* ---------- 绑定 ---------- */
  const bind = {
    dashboard: (d) => {
      const el = $("#donut");
      if (el && d.alloc.length) {
        const c = echarts.init(el);
        c.setOption({
          tooltip: { trigger: "item", formatter: "{b}: ¥{c}" },
          series: [{
            type: "pie", radius: ["55%", "80%"], avoidLabelOverlap: false,
            label: { show: false }, labelLine: { show: false },
            data: d.alloc.map((a, i) => ({ name: a.asset, value: Math.round(a.value), itemStyle: { color: PALETTE[i % PALETTE.length] } })),
          }],
        });
        charts.push(c);
      }
    },
    analytics: (d) => {
      const el = $("#bar");
      if (el && d.alloc.length) {
        const c = echarts.init(el);
        c.setOption({
          grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
          tooltip: { trigger: "axis", formatter: (p) => p[0].name + " ¥" + p[0].value.toLocaleString() },
          xAxis: { type: "category", data: d.alloc.map((a) => a.asset), axisLabel: { color: "var(--text-2)" } },
          yAxis: { type: "value", axisLabel: { color: "var(--text-2)" } },
          series: [{ type: "bar", data: d.alloc.map((a) => Math.round(a.value)), itemStyle: { color: "#378ADD", borderRadius: [4, 4, 0, 0] }, barWidth: "46%" }],
        });
        charts.push(c);
      }
    },
    holdings: () => { const s = $("#f-asset"); if (s) s.onchange = () => { const v = s.value; $$("#view tbody tr").forEach((tr) => { const badge = tr.querySelector(".badge.gray"); const show = !v || (badge && badge.textContent === v); tr.style.display = show ? "" : "none"; }); }; },
    ledger: () => {
      const f = $("#tx-form");

      // 买入方式切换：控制哪些字段可见/必填，并刷新预览
      const modeFields = {
        qty:  ["quantity", "price"],
        amt:  ["amount", "price"],
        cost: ["holdval", "curprice", "pnl", "discount"],
      };
      const toggleFields = () => {
        const isBuy = f.type.value === "buy";
        const mode = isBuy ? buyMode : "qty";
        const sel = $("[data-buy-mode]"); if (sel) sel.hidden = !isBuy;
        const visible = isBuy ? (modeFields[mode] || ["quantity", "price"]) : ["quantity", "price"];
        ["quantity", "amount", "holdval", "curprice", "pnl", "discount", "price"].forEach((n) => {
          const el = f.querySelector('[name="' + n + '"]'); if (!el) return;
          const show = visible.includes(n);
          const field = el.closest(".field"); if (field) field.hidden = !show;
          el.required = show;
        });
        updatePreview();
      };
      const updatePreview = () => {
        const prev = $("[data-preview]"); if (!prev) return;
        const isBuy = f.type.value === "buy";
        const mode = isBuy ? buyMode : "qty";
        let msg = "";
        if (isBuy && mode === "amt") {
          const amt = +f.amount.value, p = +f.price.value;
          if (amt > 0 && p > 0) msg = "将买入约 " + (amt / p).toLocaleString(undefined, { maximumFractionDigits: 2 }) + " 份，单价 ¥" + p;
        } else if (isBuy && mode === "cost") {
          const mv = +f.holdval.value, cp = +f.curprice.value, pnl = +f.pnl.value || 0, disc = +f.discount.value || 0;
          if (mv > 0 && cp > 0) {
            const shares = mv / cp;
            const avg = (mv - pnl - disc) / shares;
            msg = "约 " + shares.toLocaleString(undefined, { maximumFractionDigits: 2 }) + " 份，成本均价 ¥" + avg.toFixed(4) + "（市值 ¥" + mv.toLocaleString() + "，盈亏 ¥" + pnl + (disc > 0 ? "，优惠 ¥" + disc : "") + "）";
          }
        }
        prev.textContent = msg;
      };

      // 恢复上次选的买入方式
      f.querySelectorAll(".seg-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === buyMode));
      toggleFields();

      f.onsubmit = async (e) => {
        e.preventDefault();
        const type = f.type.value;
        const isBuy = type === "buy";
        const mode = isBuy ? buyMode : "qty";
        let quantity, price, marketPrice;
        if (!isBuy) {
          quantity = +f.quantity.value; price = +f.price.value; marketPrice = price;
          if (!(quantity > 0) || !(price > 0)) { toast("数量和价格都要大于0"); return; }
        } else if (mode === "amt") {
          const amt = +f.amount.value, p = +f.price.value;
          if (!(amt > 0) || !(p > 0)) { toast("金额和价格都要大于0"); return; }
          quantity = amt / p; price = p; marketPrice = p;
        } else if (mode === "cost") {
          const mv = +f.holdval.value, cp = +f.curprice.value, pnl = +f.pnl.value || 0, disc = +f.discount.value || 0;
          if (!(mv > 0) || !(cp > 0)) { toast("持仓市值和最新价格都要大于0"); return; }
          const shares = mv / cp;
          price = (mv - pnl - disc) / shares;
          if (!(price > 0)) { toast("反推成本价≤0，检查盈亏/持仓市值是否填反"); return; }
          quantity = shares; marketPrice = cp;
        } else {
          quantity = +f.quantity.value; price = +f.price.value; marketPrice = price;
          if (!(quantity > 0) || !(price > 0)) { toast("数量和价格都要大于0"); return; }
        }
        const t = {
          id: Calc.uid(), planId: null,
          account: f.account.value.trim(), symbol: f.symbol.value.trim().toUpperCase(),
          name: f.name.value.trim(), asset: f.asset.value, risk: f.risk.value, type,
          quantity, price, fee: +(f.fee.value || 0),
          discount: mode === "cost" ? (+f.discount.value || 0) : 0,
          date: f.date.value,
        };
        await DB.put("transactions", t);
        if (mode === "cost" || state.prices[t.symbol] === undefined) { state.prices[t.symbol] = marketPrice; await savePrices(); }
        toast("已保存"); render();
      };

      $$("[data-del-tx]").forEach((b) => b.onclick = async () => { if (confirm("删除这笔流水？")) { await DB.del("transactions", b.dataset.delTx); render(); } });

      // 买入方式分段按钮
      f.querySelectorAll(".seg-btn").forEach((b) => b.onclick = () => {
        buyMode = b.dataset.mode;
        f.querySelectorAll(".seg-btn").forEach((x) => x.classList.toggle("active", x === b));
        toggleFields();
      });
      f.type.onchange = toggleFields;
      ["amount", "price", "holdval", "curprice", "pnl", "discount"].forEach((n) => {
        const el = f.querySelector('[name="' + n + '"]');
        if (el) el.addEventListener("input", updatePreview);
      });

      const sym = f.querySelector('[name="symbol"]');
      if (sym) {
        sym.addEventListener("input", () => {
          const name = f.querySelector('[name="name"]');
          const tip = f.querySelector('[data-name-tip]');
          if (name && name.dataset.autofilled === "1") {
            name.value = ""; delete name.dataset.autofilled;
            if (tip) { tip.textContent = ""; tip.dataset.state = ""; }
          }
        });
        sym.addEventListener("blur", () => autoFillName(f, sym));
      }
      // 改了资产类型 → 如果代码已填，重新按新类型去查（避免上次「股票名」残留）；同时预填风险分层
      const assetSel = f.querySelector('[name="asset"]');
      if (assetSel) assetSel.addEventListener("change", () => {
        const symNow = f.querySelector('[name="symbol"]');
        if (symNow && symNow.value.trim()) autoFillName(f, symNow);
        const rsel = f.querySelector('[name="risk"]');
        if (rsel) rsel.value = Calc.riskOf(assetSel.value);
      });
    },
    dca: (d) => {
      $("#plan-form").onsubmit = async (e) => {
        e.preventDefault(); const f = e.target;
        await DB.put("plans", { id: Calc.uid(), symbol: f.symbol.value.trim().toUpperCase(), name: f.name.value.trim(), asset: f.asset.value, risk: f.risk.value, amount: +f.amount.value, freq: f.freq.value, day: +f.day.value, lastRun: null });
        toast("计划已添加"); render();
      };
      // 频率切换：联动定投日字段（每日隐藏、每周/每两周指星期几、每月指几号）
      const pf = $("#plan-form");
      const freqSel = pf.querySelector('[name="freq"]');
      const dayField = pf.querySelector('[data-day-field]');
      const dayLabel = pf.querySelector('[data-day-label]');
      const dayInput = pf.querySelector('[name="day"]');
      const syncDayField = () => {
        const freq = freqSel.value;
        if (freq === "每日") {
          dayField.style.display = "none";
          dayInput.value = "0";
          dayInput.min = 0; dayInput.max = 31;
          // 每日无需定投日：禁用字段，浏览器才会跳过它对 min 的约束校验（否则 value=0<min 会拦截整个表单提交）
          dayInput.disabled = true;
        } else {
          dayInput.disabled = false;
          if (freq === "每周" || freq === "每两周") {
            dayField.style.display = "";
            dayLabel.textContent = "星期几（0周日–6周六）";
            dayInput.min = 0; dayInput.max = 6;
            if (!(+dayInput.value >= 0 && +dayInput.value <= 6)) dayInput.value = "1";
          } else {
            dayField.style.display = "";
            dayLabel.textContent = "每月几号";
            dayInput.min = 1; dayInput.max = 31;
            if (!(+dayInput.value >= 1 && +dayInput.value <= 31)) dayInput.value = "1";
          }
        }
      };
      syncDayField();
      freqSel.addEventListener("change", syncDayField);
      const psym = $("#plan-form [name='symbol']");
      if (psym) {
        psym.addEventListener("input", () => {
          const name = $("#plan-form [name='name']");
          const tip = $("#plan-form [data-name-tip]");
          if (name && name.dataset.autofilled === "1") {
            name.value = "";
            delete name.dataset.autofilled;
            if (tip) { tip.textContent = ""; tip.dataset.state = ""; }
          }
        });
        psym.addEventListener("blur", () => autoFillName($("#plan-form"), psym));
      }
      // 定投表单：改资产类型也重新查（保持名称与类型同步）
      const passetSel = $("#plan-form [name=\"asset\"]");
      if (passetSel) passetSel.addEventListener("change", () => {
        const symNow = $("#plan-form [name='symbol']");
        if (symNow && symNow.value.trim()) autoFillName($("#plan-form"), symNow);
        const rsel = $("#plan-form [name='risk']");
        if (rsel) rsel.value = Calc.riskOf(passetSel.value);
      });
      $$("[data-exec]").forEach((form) => form.onsubmit = async (e) => {
        e.preventDefault(); const f = e.target; const planId = form.dataset.exec;
        const plan = d.plans.find((p) => p.id === planId);
        const t = { id: Calc.uid(), planId, account: "定投", symbol: plan.symbol, name: plan.name, asset: plan.asset, type: "buy", quantity: +f.quantity.value, price: +f.price.value, fee: 0, date: f.date.value };
        await DB.put("transactions", t);
        plan.lastRun = f.date.value; await DB.put("plans", plan);
        if (state.prices[plan.symbol] === undefined) { state.prices[plan.symbol] = t.price; await savePrices(); }
        toast("已记录执行"); render();
      });
      $$("[data-del-plan]").forEach((b) => b.onclick = async () => { if (confirm("删除该计划？（已记录的流水保留）")) { await DB.del("plans", b.dataset.delPlan); render(); } });
    },
    settings: () => {
      $("#export").onclick = async () => {
        const [tx, plans] = await Promise.all([DB.all("transactions"), DB.all("plans")]);
        const blob = new Blob([JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), transactions: tx, plans, prices: state.prices }, null, 2)], { type: "application/json" });
        const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "投资管家备份_" + new Date().toISOString().slice(0, 10) + ".json"; a.click();
        toast("已导出");
      };
      $("#import").onchange = async (e) => {
        const file = e.target.files[0]; if (!file) return;
        const data = JSON.parse(await file.text());
        if (!confirm("导入将覆盖当前所有数据，确定？")) return;
        await DB.clear("transactions"); await DB.clear("plans");
        for (const t of data.transactions || []) await DB.put("transactions", t);
        for (const p of data.plans || []) await DB.put("plans", p);
        if (data.prices) { state.prices = data.prices; await savePrices(); }
        toast("导入完成"); render();
      };
      $("#save-prices").onclick = async () => {
        $$("[data-price]").forEach((i) => { const v = parseFloat(i.value); if (!isNaN(v)) state.prices[i.dataset.price] = v; });
        await savePrices(); toast("行情已保存"); render();
      };
      $("#save-proxy").onclick = async () => { window.__proxy = $("#proxy").value.trim(); await DB.meta("proxy", window.__proxy); toast("代理已保存"); };
      // 云端同步配置
      $("#save-sync").onclick = async () => {
        const url = $("#sb-url").value.trim();
        const key = $("#sb-key").value.trim();
        const owner = $("#sb-owner").value.trim();
        if (!url || !key) { $("#sync-status").textContent = "URL 与 anon key 不能为空"; return; }
        Sync.configure(url, key, owner);
        if (!Sync.isConfigured()) { $("#sync-status").textContent = "连接失败：请检查 URL / key 格式，或确认已引入 supabase.min.js"; return; }
        await DB.meta("supabase_url", url);
        await DB.meta("supabase_key", key);
        await DB.meta("supabase_owner", owner);
        window.__sb = { url, key, owner };
        try {
          const cloud = await Sync.pullAll();
          if (cloud && cloud.transactions.length === 0 && cloud.plans.length === 0) {
            const [lt, lp] = await Promise.all([DB.all("transactions"), DB.all("plans")]);
            await Sync.pushAll(lt, lp);
          }
          $("#sync-status").textContent = "✅ 已连接并同步";
          toast("云端同步已开启");
          render();
        } catch (e) {
          $("#sync-status").textContent = "连接成功但同步出错：" + (e.message || e);
        }
      };
      $("#test-sync").onclick = async () => {
        const url = $("#sb-url").value.trim();
        const key = $("#sb-key").value.trim();
        const owner = $("#sb-owner").value.trim();
        if (!url || !key) { $("#sync-status").textContent = "请先填 URL 与 key"; return; }
        Sync.configure(url, key, owner);
        if (!Sync.isConfigured()) { $("#sync-status").textContent = "初始化失败"; return; }
        try {
          const cloud = await Sync.pullAll();
          $("#sync-status").textContent = cloud ? `✅ 连接成功，云端有 ${cloud.transactions.length} 笔流水 / ${cloud.plans.length} 个计划` : "返回为空";
        } catch (e) { $("#sync-status").textContent = "连接失败：" + (e.message || e); }
      };
      $("#wipe").onclick = async () => { if (confirm("永久清空全部交易、计划与行情，不可恢复！")) { await DB.clear("transactions"); await DB.clear("plans"); state.prices = {}; await savePrices(); toast("已清空"); render(); } };
      $("#load-sample").onclick = () => loadSample();
    },
  };

  /* ---------- 刷新行情（POST 到 serverless 代理） ---------- */
  async function refresh() {
    const proxy = (await DB.meta("proxy")) || window.__proxy || "";
    if (!proxy) { toast("未配置行情代理，使用手动价"); await DB.meta("lastRefresh", Date.now()); return; }
    try {
      toast("正在拉取行情…");
      const d = await allData();
      const quotes = d.pos
        .filter((p) => p.quantity > 0 && !["存款", "理财"].includes(p.asset))
        .map((p) => ({ symbol: p.symbol, asset: p.asset }));
      if (!quotes.length) { toast("没有需要拉取行情的持仓"); return; }
      const res = await fetch(proxy, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotes }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const map = await res.json(); // { symbol: { price, name } }
      let updated = 0;
      for (const q of quotes) {
        const r = map[q.symbol];
        if (r && typeof r.price === "number" && !isNaN(r.price)) {
          state.prices[q.symbol] = r.price;
          updated++;
        }
      }
      await savePrices();
      await DB.meta("lastRefresh", Date.now());
      if (updated) { toast("行情已更新 " + updated + " 个标的"); render(); }
      else { toast("代理未返回有效行情，检查标的或代理地址"); }
    } catch (e) {
      console.error(e);
      toast("代理获取失败，检查地址或网络");
    }
  }

  /* ---------- 输入代码自动补名称 ---------- */
  async function autoFillName(form, symbolInput) {
    const proxy = (await DB.meta("proxy")) || window.__proxy || "";
    const symbol = symbolInput.value.trim().toUpperCase();
    const nameInput = form.querySelector('[name="name"]');
    const tip = form.querySelector('[data-name-tip]');
    if (!symbol || !nameInput) return;
    // 已手动填过名称时不再覆盖（保护用户输入）
    if (nameInput.value.trim() && nameInput.dataset.autofilled !== "1") return;
    if (!proxy) {
      if (tip) { tip.textContent = "未配代理，请手填"; tip.dataset.state = "warn"; }
      return;
    }
    if (tip) { tip.textContent = "查询中…"; tip.dataset.state = "loading"; }
    const asset = (form.querySelector('[name="asset"]') || {}).value || "";
    const log = (...a) => console.log("[autoFill]", symbol, ...a);
    // 拉一次 + 失败自动重试一次（扛住东财接口偶发抖动）
    const tryOnce = async () => {
      const res = await fetch(proxy, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quotes: [{ symbol, asset }] }),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    };
    try {
      log("→", proxy);
      let map, retried = false;
      try {
        map = await tryOnce();
      } catch (e) {
        log("首次失败，稍候重试:", e.message);
        await new Promise((r) => setTimeout(r, 700));
        map = await tryOnce();
        retried = true;
      }
      log(retried ? "重试 OK" : "OK", "map =", JSON.stringify(map));
      const r = map[symbol];
      if (r && r.name) {
        nameInput.value = r.name;
        nameInput.dataset.autofilled = "1";
        if (tip) { tip.textContent = "已自动补全 → " + r.name; tip.dataset.state = "ok"; }
      } else if (r && r.price) {
        if (tip) { tip.textContent = "已取到价 ¥" + r.price + " 但名称为空，请手填"; tip.dataset.state = "warn"; }
      } else if (map && Object.keys(map).length === 0) {
        if (tip) { tip.textContent = "代理返回为空（东财限流？）请手填或稍后再试"; tip.dataset.state = "warn"; }
      } else {
        if (tip) { tip.textContent = "未取到，请手填（无 price）"; tip.dataset.state = "warn"; }
      }
    } catch (e) {
      log("ERR", e.message);
      if (tip) { tip.textContent = "补全失败：" + (e.message || "网络") + "，请手填"; tip.dataset.state = "err"; }
    }
  }

  /* ---------- 主题 ---------- */
  async function initTheme() {
    const t = (await DB.meta("theme")) || "light";
    document.documentElement.dataset.theme = t;
    $("#btn-theme").textContent = t === "dark" ? "亮色" : "暗色";
  }
  async function toggleTheme() {
    const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = t;
    $("#btn-theme").textContent = t === "dark" ? "亮色" : "暗色";
    await DB.meta("theme", t);
    render();
  }

  /* ---------- 示例数据（手动载入，不再自动注入） ---------- */
  async function loadSample() {
    if ((await DB.all("transactions")).length && !confirm("载入示例数据将覆盖当前全部交易与计划（行情价一并重置），确定？")) return;
    const seed = [
      { id: "s1", account: "华泰", symbol: "600519", name: "贵州茅台", asset: "股票", type: "buy", quantity: 100, price: 1480, fee: 0, date: "2026-02-01", planId: null },
      { id: "s2", account: "华泰", symbol: "600519", name: "贵州茅台", asset: "股票", type: "sell", quantity: 50, price: 1560, fee: 0, date: "2026-05-01", planId: null },
      { id: "s3", account: "支付宝", symbol: "005827", name: "易方达蓝筹", asset: "基金", type: "buy", quantity: 5000, price: 2.35, fee: 0, date: "2026-03-05", planId: null },
      { id: "s4", account: "华泰", symbol: "510300", name: "沪深300ETF", asset: "ETF", type: "buy", quantity: 2000, price: 3.85, fee: 0, date: "2026-02-15", planId: null },
      { id: "s5", account: "银行", symbol: "CASH", name: "活期存款", asset: "存款", type: "buy", quantity: 1, price: 20000, fee: 0, date: "2026-01-20", planId: null },
      { id: "s6", account: "华泰", symbol: "300750", name: "宁德时代", asset: "股票", type: "buy", quantity: 200, price: 180, fee: 0, date: "2026-03-10", planId: null },
      { id: "s7", account: "支付宝", symbol: "518880", name: "黄金ETF", asset: "黄金", type: "buy", quantity: 300, price: 5.20, fee: 0, date: "2026-02-20", planId: null },
      { id: "s8", account: "定投", symbol: "510300", name: "沪深300ETF", asset: "ETF", type: "buy", quantity: 253, price: 3.95, fee: 0, date: "2026-03-01", planId: "plan1" },
      { id: "s9", account: "定投", symbol: "510300", name: "沪深300ETF", asset: "ETF", type: "buy", quantity: 250, price: 3.98, fee: 0, date: "2026-04-01", planId: "plan1" },
    ];
    await DB.clear("transactions");
    for (const t of seed) await DB.put("transactions", t);
    await DB.clear("plans");
    await DB.put("plans", { id: "plan1", symbol: "510300", name: "沪深300ETF", asset: "ETF", amount: 1000, freq: "每月", day: 1, lastRun: "2026-04-01" });
    state.prices = { "600519": 1560, "005827": 2.45, "510300": 3.95, "CASH": 20000, "300750": 172, "518880": 5.40 };
    await savePrices();
    toast("已载入示例数据"); render();
  }

  // 本地日期工具
  function parseYMD(s) { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }

  // 打开页面时自动补定投执行：判断是否交易日，非交易日顺延到下一交易日，自动记买入流水（金额=计划设定，不真下单）
  async function autoRunDca(today) {
    const [, plans] = await Promise.all([DB.all("transactions"), DB.all("plans")]);
    if (!plans.length) return { count: 0, skipped: [] };
    const skipped = [];
    const newTx = [];
    const planUpdates = [];
    const MAX_PER_PLAN = 30; // 单次上限，防止异常回溯爆量
    for (const plan of plans) {
      const amount = +plan.amount || 0;
      if (amount <= 0) continue;
      const lastRunDate = plan.lastRun ? parseYMD(plan.lastRun) : null;
      // 起始：有上次执行则从其次日；从未执行则从明天（今天不自动记首笔，避免误记）
      let start = lastRunDate ? addDays(lastRunDate, 1) : addDays(today, 1);
      if (start > today) continue;
      const targetDow = (plan.day | 0) % 7; // 每周/每两周：0周日..6周六
      const monthDay = plan.day | 0;
      const bases = [];
      const freq = plan.freq;
      if (freq === "每日") {
        for (let d = new Date(start); d <= today; d = addDays(d, 1)) bases.push(new Date(d));
      } else if (freq === "每周") {
        let cur = new Date(start);
        while (cur.getDay() !== targetDow && cur <= today) cur = addDays(cur, 1);
        while (cur <= today) { bases.push(new Date(cur)); cur = addDays(cur, 7); }
      } else if (freq === "每两周") {
        let cur = new Date(start);
        while (cur.getDay() !== targetDow && cur <= today) cur = addDays(cur, 1);
        while (cur <= today) { bases.push(new Date(cur)); cur = addDays(cur, 14); }
      } else { // 每月
        let y = start.getFullYear(), m = start.getMonth();
        const endY = today.getFullYear(), endM = today.getMonth();
        while (y < endY || (y === endY && m <= endM)) {
          const dim = new Date(y, m + 1, 0).getDate();
          const d = new Date(y, m, Math.min(monthDay, dim));
          if (d >= start && d <= today) bases.push(d);
          m++; if (m > 11) { m = 0; y++; }
        }
      }
      let count = 0;
      for (const base of bases) {
        if (count >= MAX_PER_PLAN) break;
        const execDay = TradingDays.isTradingDay(base) ? base : TradingDays.nextTradingDay(base, true);
        if (execDay > today) continue;                       // 顺延到未来，未到，不补
        if (lastRunDate && execDay <= lastRunDate) continue; // 防重复
        const price = state.prices[plan.symbol];
        if (typeof price !== "number") { if (!skipped.includes(plan.name)) skipped.push(plan.name); continue; }
        const qty = price > 0 ? amount / price : 0;
        if (!(qty > 0)) { if (!skipped.includes(plan.name)) skipped.push(plan.name); continue; }
        newTx.push({ id: Calc.uid(), planId: plan.id, account: "定投", symbol: plan.symbol, name: plan.name, asset: plan.asset, type: "buy", quantity: +(qty.toFixed(4)), price, fee: 0, date: TradingDays.ymd(execDay) });
        plan.lastRun = TradingDays.ymd(execDay);
        count++;
      }
      if (count) planUpdates.push(plan);
    }
    for (const t of newTx) await DB.put("transactions", t);
    for (const p of planUpdates) await DB.put("plans", p);
    return { count: newTx.length, skipped };
  }

  // —— 云端同步透明接入 ——
  // 包装 DB.put/del：所有 transactions/plans 写操作在成功落本地后自动同步到 Supabase（若已配置）。
  // 未配置时 Sync 内部 no-op，本地行为完全不变。
  (function attachCloudSync() {
    const _put = DB.put.bind(DB);
    DB.put = async (name, val) => {
      const r = await _put(name, val);
      if (name === "transactions") Sync.pushTx(val).catch((e) => console.warn("[Sync] pushTx 失败(已保留本地):", e));
      else if (name === "plans") Sync.pushPlan(val).catch((e) => console.warn("[Sync] pushPlan 失败(已保留本地):", e));
      return r;
    };
    const _del = DB.del.bind(DB);
    DB.del = async (name, id) => {
      const r = await _del(name, id);
      if (name === "transactions") Sync.deleteTx(id).catch((e) => console.warn("[Sync] deleteTx 失败:", e));
      else if (name === "plans") Sync.deletePlan(id).catch((e) => console.warn("[Sync] deletePlan 失败:", e));
      return r;
    };
  })();

  // 打开页面时：读取 Supabase 配置 → 连接 → 拉取云端覆盖本地（首次则上传本地）
  async function initCloudSync() {
    const url = await DB.meta("supabase_url");
    const key = await DB.meta("supabase_key");
    const owner = (await DB.meta("supabase_owner")) || "";
    if (!url || !key) return; // 未配置，纯本地
    Sync.configure(url, key, owner);
    window.__sb = { url, key, owner };
    if (!Sync.isConfigured()) { console.warn("[Sync] 配置无效"); return; }
    try {
      const cloud = await Sync.pullAll();
      if (!cloud) return;
      const localTx = await DB.all("transactions");
      const localPlans = await DB.all("plans");
      if (cloud.transactions.length === 0 && cloud.plans.length === 0 && (localTx.length || localPlans.length)) {
        await Sync.pushAll(localTx, localPlans); // 云端空、本地有 → 首次上传
        console.log("[Sync] 首次上传本地数据到云端");
      } else {
        await DB.clear("transactions"); await DB.clear("plans"); // 以云端为准覆盖本地
        for (const t of cloud.transactions) await DB.put("transactions", t);
        for (const p of cloud.plans) await DB.put("plans", p);
        console.log("[Sync] 已从云端同步", cloud.transactions.length, "笔流水 /", cloud.plans.length, "个计划");
      }
    } catch (e) {
      console.warn("[Sync] 拉取失败，沿用本地数据:", e);
    }
  }

  async function init() {
    await initTheme();
    await loadPrices();
    // —— 云端同步：拉取（若已配置 Supabase）——
    await initCloudSync();
    // 行情代理默认走同源 server.js 的 /api（由 Node 服务端直连东财/腾讯，不受中国大陆直连 *.workers.dev 不可达的影响）
    // 同源的好处：电脑开 http://localhost:8080、手机开 http://电脑IP:8080 时各自自动指向正确的代理，无需改配置
    const DEFAULT_PROXY = location.origin + "/api";
    let savedProxy = (await DB.meta("proxy")) || "";
    // 之前若存过 workers.dev（国内直连连不上），自动切回本地代理
    if (savedProxy.includes("workers.dev")) {
      savedProxy = "";
      await DB.meta("proxy", DEFAULT_PROXY);
    }
    // 存过 localhost 绝对地址、但当前不是从本机打开（手机访问电脑 IP）→ 自动改用同源地址
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(savedProxy) && !["localhost", "127.0.0.1"].includes(location.hostname)) {
      savedProxy = "";
      await DB.meta("proxy", DEFAULT_PROXY);
    }
    window.__proxy = savedProxy || DEFAULT_PROXY;
    // 自动补定投执行：打开页面时检查是否到了交易日，到了就自动记一笔买入流水（不真下单）
    try {
      const res = await autoRunDca(new Date());
      if (res.count) {
        let msg = `已自动补 ${res.count} 笔定投执行`;
        if (res.skipped.length) msg += `（${res.skipped.length} 个计划无行情价已跳过，请先「刷新行情」）`;
        toast(msg);
      }
    } catch (e) { console.warn("[autoRunDca]", e); }
    // 不再自动注入示例数据：真机首次打开即为空库，由用户在设置里手动「载入示例数据」或自行录入真实持仓
    $$(".tab").forEach((b) => (b.onclick = () => setRoute(b.dataset.route)));
    $("#btn-theme").onclick = toggleTheme;
    $("#btn-refresh").onclick = refresh;
    render();
  }

  return { init };
})();
window.addEventListener("DOMContentLoaded", App.init);
