// 页面主逻辑：token 处理、双标签切换、用量四维查询、额度两级看板、自动刷新。
//
// 重要：本页在 Magpie 窗口里跑在 sandbox="allow-scripts" 的 iframe 中（没有 allow-same-origin），
// 文档处于 opaque origin，访问 window.localStorage 会抛 SecurityError。
// 所以任何存储访问都必须容错，否则 IIFE 初始化中断 → 页面只有骨架、所有交互失效。
(() => {
  const $ = (id) => document.getElementById(id);

  // ---- 启动异常可见化：任何阶段出错都显示出来，而不是留一个死页面 ----
  function showFatal(error) {
    try {
      const box = document.createElement("div");
      box.style.cssText =
        "margin:8px 16px;padding:10px 14px;border-radius:6px;background:#fdecea;color:#c0392b;font:12px/1.6 sans-serif;white-space:pre-wrap";
      box.textContent = `页面脚本出错：${error && error.message ? error.message : error}\n${(error && error.stack) || ""}`;
      document.body.insertBefore(box, document.body.firstChild);
    } catch {}
  }
  window.addEventListener("error", (e) => showFatal(e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => showFatal(e.reason));

  // ---- 存储：沙盒里 localStorage 不可用时退化为内存，保证功能可用 ----
  // 实现在 store.js（可单测）；缺失时用最小内联兜底。
  const store = window.mqbStore || (() => {
    const memory = Object.create(null);
    return {
      get: (k) => {
        try {
          return window.localStorage.getItem(k);
        } catch {
          return k in memory ? memory[k] : null;
        }
      },
      set: (k, v) => {
        try {
          window.localStorage.setItem(k, v);
        } catch {
          memory[k] = v;
        }
      },
    };
  })();

  function readExpanded() {
    try {
      return JSON.parse(store.get("mqb-expanded") || "null") || {};
    } catch {
      return {};
    }
  }

  const state = {
    tab: "usage",
    period: "today",
    dim: "model",
    from: "",
    to: "",
    token: new URLSearchParams(location.search).get("token") || store.get("mqb-token") || "",
    expanded: readExpanded(), // { providerId: bool }
    timer: null,
    interval: 30,
  };
  if (state.token) store.set("mqb-token", state.token);

  // 存储不可用时如实告知（Magpie 页面在沙盒 iframe 里没有 localStorage）
  try {
    if (store.persistent && !store.persistent()) $("store-hint").classList.remove("hidden");
  } catch {}
  // token 随 Magpie 每次启动而变：401 时自动回到 /enter 领一次新 token，而不是卡在报错。
  let authRetried = false;
  function relogin() {
    if (authRetried) return;
    authRetried = true;
    location.replace("/enter");
  }

  const api = (path, body) =>
    fetch(path, {
      method: body ? "POST" : "GET",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${state.token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => {
      if (!r.ok) {
        const detail = (await r.json().catch(() => ({}))).error || `HTTP ${r.status}`;
        const error = new Error(detail);
        error.status = r.status;
        throw error;
      }
      return r.json();
    });

  // ---- 工具 ----
  const fmtInt = (n) => (n == null ? "—" : Number(n).toLocaleString("zh-CN"));
  const fmtNum = (n, d = 1) => (n == null ? "—" : Number(n).toLocaleString("zh-CN", { maximumFractionDigits: d, minimumFractionDigits: 0 }));
  const fmtM = (n) => (n == null ? "—" : (n / 1e6).toFixed(2));
  const fmtCost = (n) => (n == null ? "—" : `$${Number(n).toFixed(2)}`);
  const fmtPct = (n) => (n == null ? "—" : `${n.toFixed(1)}%`);
  const fmtTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    if (sameDay) return `今天 ${hm}`;
    const yesterday = new Date(now);
    yesterday.setDate(now.getDate() - 1);
    if (d.toDateString() === yesterday.toDateString()) return `昨天 ${hm}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  };

  // ---- 标签切换 ----
  const setTab = (tab) => {
    state.tab = tab;
    $("tab-usage").classList.toggle("active", tab === "usage");
    $("tab-quota").classList.toggle("active", tab === "quota");
    $("view-usage").classList.toggle("hidden", tab !== "usage");
    $("view-quota").classList.toggle("hidden", tab !== "quota");
    load();
  };
  $("tab-usage").onclick = () => setTab("usage");
  $("tab-quota").onclick = () => setTab("quota");

  // ---- 用量页 ----
  const PERIOD_LABEL = { today: "今天", "7d": "7 天", "30d": "30 天", all: "全部", custom: "自定义" };
  const DIM_LABEL = { model: "模型名称", provider: "供应商名称", account: "供应商 · 账号", harness: "Harness 名称" };

  document.querySelectorAll("#period-pills .pill").forEach((b) => {
    b.onclick = () => {
      state.period = b.dataset.period;
      document.querySelectorAll("#period-pills .pill").forEach((x) => x.classList.toggle("active", x === b));
      const isCustom = state.period === "custom";
      $("custom-range").classList.toggle("hidden", !isCustom);
      if (isCustom) {
        // 没选时间就先不查，避免无谓报错
        if (!$("range-from").value) $("range-from").value = defaultFrom();
        if (!$("range-to").value) $("range-to").value = defaultTo();
        state.from = $("range-from").value;
        state.to = $("range-to").value;
      }
      load();
    };
  });
  document.querySelectorAll("#dim-pills .pill").forEach((b) => {
    b.onclick = () => {
      state.dim = b.dataset.dim;
      document.querySelectorAll("#dim-pills .pill").forEach((x) => x.classList.toggle("active", x === b));
      $("th-name").textContent = DIM_LABEL[state.dim];
      $("th-hit").classList.toggle("hidden", state.dim !== "model");
      load();
    };
  });
  $("range-apply").onclick = () => {
    state.from = $("range-from").value;
    state.to = $("range-to").value;
    load();
  };

  // ---- 时间默认值：datetime-local 需要的 "YYYY-MM-DDTHH:mm"（本地时间） ----
  const pad = (n) => String(n).padStart(2, "0");
  const toLocalInput = (d) =>
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const defaultTo = () => toLocalInput(new Date());
  const defaultFrom = () => {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return toLocalInput(d);
  };

  async function loadUsage() {
    const body = { dim: state.dim, period: state.period };
    if (state.period === "custom") {
      body.from = $("range-from").value || state.from;
      body.to = $("range-to").value || state.to;
      if (!body.from || !body.to) {
        $("usage-error").textContent = "请先选择开始和结束时间（精确到时分）";
        $("usage-error").classList.remove("hidden");
        return;
      }
    }
    try {
      const data = await api("/api/usage", body);
      $("usage-error").classList.add("hidden");
      renderUsage(data);
    } catch (error) {
      if (error.status === 401) return relogin();
      $("usage-error").textContent = `读取失败：${error.message}`;
      $("usage-error").classList.remove("hidden");
    }
  }

  function renderUsage(data) {
    const tb = $("usage-body");
    tb.innerHTML = "";
    const showHit = state.dim === "model";
    for (const r of data.rows) {
      const tr = document.createElement("tr");
      const hit = showHit
        ? `<td class="${r.cacheHit == null ? "no-hit" : ""}">${r.cacheHit == null ? "—" : fmtPct(r.cacheHit)}</td>`
        : "";
      tr.innerHTML = `
        <td class="name"></td>
        <td>${fmtInt(r.calls)}</td>
        <td>${fmtM(r.tokens)}</td>
        ${hit}
        <td class="${r.errors ? "err1" : "err0"}">${fmtInt(r.errors)}</td>
        <td>${fmtCost(r.cost)}</td>`;
      tr.querySelector(".name").textContent = r.name;
      tb.appendChild(tr);
    }
    const t = data.total;
    const hit = showHit ? `<td>${t.cacheHit == null ? "—" : fmtPct(t.cacheHit)}</td>` : "";
    $("usage-total").innerHTML = `<tr>
      <td class="name">合计（${data.rows.length} 项）</td>
      <td>${fmtInt(t.calls)}</td>
      <td>${fmtM(t.tokens)}</td>
      ${hit}
      <td class="${t.errors ? "err1" : "err0"}">${fmtInt(t.errors)}</td>
      <td>${fmtCost(t.cost)}</td></tr>`;
    const src = data.source === "usage.jsonl" ? "本地流水账" : "网关用量接口";
    const costNote =
      data.total.cost == null
        ? "；费用为「—」是因为本地流水账只记 token 与耗时、不记单价（要准确费用请用今天/7天/30天）"
        : "";
    $("usage-note").textContent =
      `※ Token 用量 = 输入 + 输出 + 缓存读写合计（M = 百万）；缓存命中率 = 缓存读 ÷（输入 + 缓存读），仅「按模型」维度显示。` +
      `当前：${PERIOD_LABEL[data.period]}${data.from ? ` ${data.from} 至 ${data.to}` : ""} · 数据源：${src}${costNote}。`;
  }

  // ---- 额度页 ----
  $("expand-all").onclick = () => setAllExpanded(true);
  $("collapse-all").onclick = () => setAllExpanded(false);
  function setAllExpanded(open) {
    for (const p of state.boardCache?.providers || []) state.expanded[p.provider] = open;
    store.set("mqb-expanded", JSON.stringify(state.expanded));
    renderBoard(state.boardCache);
  }

  async function loadQuota() {
    try {
      const board = await api("/api/board");
      $("quota-error").classList.add("hidden");
      state.boardCache = board;
      for (const p of board.providers) {
        if (!(p.provider in state.expanded)) state.expanded[p.provider] = false;
      }
      renderBoard(board);
    } catch (error) {
      if (error.status === 401) return relogin();
      $("quota-error").textContent = `读取失败：${error.message}`;
      $("quota-error").classList.remove("hidden");
    }
  }

  function barHTML(pct) {
    if (pct == null) return `<div class="bar"><i style="width:0"></i></div>`;
    const cls = pct > 90 ? "danger" : pct > 60 ? "warn" : "ok";
    return `<div class="bar ${cls}"><i style="width:${Math.min(100, pct).toFixed(1)}%"></i></div>`;
  }
  function rowHTML(cells) {
    return cells.join("");
  }
  function renderBoard(board) {
    const root = $("quota-board");
    root.innerHTML = "";
    for (const p of board.providers) {
      const card = document.createElement("div");
      card.className = "provider-card" + (state.expanded[p.provider] ? "" : " collapsed");
      const open = state.expanded[p.provider];
      const head = document.createElement("div");
      head.className = "provider-head";
      head.innerHTML = rowHTML([
        // 箭头与名称必须包在同一个网格单元里，否则 7 列会被撑成 8 项导致整行错位
        `<span class="plead"><span class="arrow">${open ? "▾" : "▸"}</span><span class="pname"></span></span>`,
        `<span class="num">${fmtNum(p.limit)}</span>`,
        `<span class="num">${fmtNum(p.used)}</span>`,
        `<span class="num">${fmtNum(p.remaining)}</span>`,
        `<span class="pct">${p.pct == null ? "—" : fmtPct(p.pct)}</span>`,
        barHTML(p.pct),
        `<span class="last"></span>`,
      ]);
      head.querySelector(".pname").textContent = p.providerName;
      head.querySelector(".last").textContent = p.lastAt ? fmtTime(p.lastAt) : "—";
      head.title = `最近一次请求：${p.lastAt ? fmtTime(p.lastAt) : "无记录"}`;
      head.querySelector(".arrow").onclick = () => {
        state.expanded[p.provider] = !state.expanded[p.provider];
        store.set("mqb-expanded", JSON.stringify(state.expanded));
        renderBoard(board);
      };
      card.appendChild(head);
      const kids = document.createElement("div");
      kids.className = "provider-children";
      for (const a of p.accounts) {
        const row = document.createElement("div");
        row.className = "account-row";
        row.innerHTML = rowHTML([
          `<span class="aname"></span>`,
          `<span class="num">${a.limit == null ? "—" : fmtNum(a.limit)}</span>`,
          `<span class="num">${a.used == null ? "—" : fmtNum(a.used)}</span>`,
          `<span class="num">${a.remaining == null ? "—" : fmtNum(a.remaining)}</span>`,
          `<span class="pct">${a.pct == null ? "—" : fmtPct(a.pct)}</span>`,
          a.pct == null ? `<div class="bar"><i style="width:0"></i></div>` : barHTML(a.pct),
          `<span class="last">${a.lastAt ? fmtTime(a.lastAt) : "—"}</span>`,
          a.note ? `<span class="note"></span>` : "",
        ]);
        row.querySelector(".aname").textContent = a.account;
        // 重置时间放进悬停提示，不占列
        row.title = [
          a.plan ? `套餐：${a.plan}` : "",
          a.resetsAt ? `额度重置：${fmtTime(a.resetsAt)}` : "",
          a.lastAt ? `最近请求：${fmtTime(a.lastAt)}` : "",
        ]
          .filter(Boolean)
          .join(" · ");
        if (a.note) row.querySelector(".note").textContent = a.note;
        if (a.note) row.querySelector(".note").textContent = a.note;
        kids.appendChild(row);
      }
      card.appendChild(kids);
      root.appendChild(card);
    }
  }

  // ---- 刷新 ----
  function load() {
    if (state.tab === "usage") loadUsage();
    else loadQuota();
  }
  $("refresh-btn").onclick = load;
  $("refresh-interval").onchange = (e) => {
    state.interval = Number(e.target.value);
    restartTimer();
  };
  function restartTimer() {
    if (state.timer) clearInterval(state.timer);
    if (state.interval > 0) state.timer = setInterval(load, state.interval * 1000);
  }
  restartTimer();
  load();
})();
