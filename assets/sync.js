/* 云端同步模块（Supabase）
 * 设计原则：可选增强。未配置时所有方法 no-op，本地用法完全不受影响。
 * 依赖：window.supabase（本地 vendor/supabase.min.js 注入）。
 * 逻辑隔离：每条记录带 owner 字段，pull/push 均按 owner 过滤。
 */
const Sync = (() => {
  let client = null;
  let owner = "";
  let configured = false;

  function configure(url, anonKey, ownerId) {
    if (!url || !anonKey || typeof window.supabase === "undefined") {
      client = null;
      configured = false;
      return false;
    }
    try {
      client = window.supabase.createClient(url.trim(), anonKey.trim(), {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      owner = (ownerId || "").trim();
      configured = true;
      return true;
    } catch (e) {
      console.warn("[Sync] 初始化失败:", e);
      client = null;
      configured = false;
      return false;
    }
  }

  const isConfigured = () => configured && !!client;

  // 字段映射：业务层用 camelCase（planId / lastRun），PostgREST 列名用 snake_case（plan_id / last_run）。
  // 双向翻译在 push/pull 边界做，sync.js 内部任何 SQL 列都吃 snake、对 JS 暴露 camel。
  const snakeTx = (tx) => {
    if (!tx) return tx;
    const { planId, ...rest } = tx;
    return { ...rest, plan_id: planId ?? null };
  };
  const camelTx = (tx) => {
    if (!tx) return tx;
    const { plan_id, ...rest } = tx;
    return { ...rest, planId: plan_id ?? null };
  };
  const snakePlan = (p) => {
    if (!p) return p;
    const { lastRun, feeRate, ...rest } = p;
    return { ...rest, last_run: lastRun ?? null, fee_rate: feeRate ?? 0 };
  };
  const camelPlan = (p) => {
    if (!p) return p;
    const { last_run, fee_rate, ...rest } = p;
    return { ...rest, lastRun: last_run ?? null, feeRate: fee_rate ?? 0 };
  };

  // 去掉云端内部字段，返回纯业务对象（存本地时用）
  const strip = (rows) =>
    (rows || []).map(({ owner, created_at, ...rest }) => rest);

  async function pullAll() {
    if (!isConfigured()) return null;
    const [txr, pr] = await Promise.all([
      client.from("transactions").select("*").eq("owner", owner),
      client.from("plans").select("*").eq("owner", owner),
    ]);
    if (txr.error) throw txr.error;
    if (pr.error) throw pr.error;
    return { transactions: strip(txr.data).map(camelTx), plans: strip(pr.data).map(camelPlan) };
  }

  async function pushTx(tx) {
    if (!isConfigured()) return;
    const { error } = await client
      .from("transactions")
      .upsert({ ...snakeTx(tx), owner }, { onConflict: "id" });
    if (error) throw error;
  }

  async function pushPlan(plan) {
    if (!isConfigured()) return;
    const { error } = await client
      .from("plans")
      .upsert({ ...snakePlan(plan), owner }, { onConflict: "id" });
    if (error) throw error;
  }

  async function deleteTx(id) {
    if (!isConfigured()) return;
    const { error } = await client
      .from("transactions")
      .delete()
      .eq("id", id)
      .eq("owner", owner);
    if (error) throw error;
  }

  async function deletePlan(id) {
    if (!isConfigured()) return;
    const { error } = await client
      .from("plans")
      .delete()
      .eq("id", id)
      .eq("owner", owner);
    if (error) throw error;
  }

  // 首次连接：把本地已有数据上传到云端
  async function pushAll(localTx, localPlans) {
    if (!isConfigured()) return;
    for (const t of localTx) await pushTx(t);
    for (const p of localPlans) await pushPlan(p);
  }

  return {
    configure,
    isConfigured,
    pullAll,
    pushTx,
    pushPlan,
    deleteTx,
    deletePlan,
    pushAll,
  };
})();

if (typeof window !== "undefined") window.Sync = Sync;
if (typeof module !== "undefined" && module.exports) module.exports = Sync;
