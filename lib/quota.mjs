// 额度口径层：把网关 /v1/magpie/quotas 的原始数据映射为两页用的标准结构。
// 纯函数，无 IO，便于单测。
//
// 口径（用户裁决）：
// - trae-cn / raccoon / minimax-code：取名为 Credits 的窗口；raccoon 的 "Daily pool" 忽略。
// - codearts：取名为「总积分」的窗口（已含基础+赠送，不叠加）。
// - qwenwork：无数字窗口，从 balance 文字解析：总量 = monthly + long-term，已用 = 总量 - 剩余。
// - 供应商行 = 各账号相加；未使用 = 总量 - 已使用；进度条色：≤60% 绿、60–90% 橙、>90% 红。

const CREDITS_PROVIDERS = new Set(["trae-cn", "raccoon", "minimax-code"]);

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function text(value) {
  return value == null ? "" : String(value).trim();
}

// ---- qwenwork 余额文字解析 ----
// 样例："400 credits (monthly 100 · long-term 300)"
// 返回 { remaining, limit, monthly, longTerm } 或 null（解析失败时退回纯文字显示）。
export function parseQwenWorkBalance(balance) {
  const s = text(balance);
  if (!s) return null;
  const rem = s.match(/([\d.]+)\s*credits?/i);
  const monthly = s.match(/monthly\s*([\d.]+)/i);
  const longTerm = s.match(/long[- ]term\s*([\d.]+)/i);
  if (!rem || !monthly || !longTerm) return null;
  const remaining = number(rem[1]);
  const limit = number(monthly[1]) + number(longTerm[1]);
  if (limit <= 0) return null;
  return { remaining, limit, monthly: number(monthly[1]), longTerm: number(longTerm[1]) };
}

// ---- 单账号窗口挑选 ----
// 返回 { used, limit }（绝对量），供进度条与三列数值使用；失败返回 null。
export function pickAccountWindow(account) {
  const provider = text(account?.provider);
  const windows = Array.isArray(account?.windows) ? account.windows : [];
  let win = null;
  if (provider === "codearts") {
    win = windows.find((w) => text(w?.name) === "总积分") || null;
  } else if (CREDITS_PROVIDERS.has(provider)) {
    win = windows.find((w) => /^credits$/i.test(text(w?.name))) || null;
  }
  if (win) {
    const limit = number(win.limit);
    if (limit > 0) {
      // used 字段是百分比；绝对已用 = amount（窗口自己的用量计数）。
      // 无 amount 时按 limit*(used/100) 折算。
      const amount = win.amount != null ? number(win.amount) : (limit * number(win.used)) / 100;
      return { used: amount, limit, unit: text(win.unit) || "credits", resetsAt: text(win.resetsAt) };
    }
  }
  // qwenwork：解析 balance 文字
  if (provider === "qwenwork") {
    const parsed = parseQwenWorkBalance(account?.balance);
    if (parsed) {
      return {
        used: Math.max(0, parsed.limit - parsed.remaining),
        limit: parsed.limit,
        unit: "credits",
        resetsAt: "",
        note: text(account?.balance),
      };
    }
  }
  return null;
}

// ---- 进度条颜色 ----
export function progressColor(pct) {
  if (pct > 90) return "danger";
  if (pct > 60) return "warn";
  return "ok";
}

// ---- 账号行 ----
function accountRow(account, lastSeen) {
  const provider = text(account?.provider);
  const user = text(account?.user);
  const win = pickAccountWindow(account);
  const row = {
    provider,
    providerName: text(account?.name) || provider,
    account: text(account?.alias) || user,
    user,
    plan: text(account?.plan),
    limit: null,
    used: null,
    remaining: null,
    pct: null,
    resetsAt: "",
    lastAt: (lastSeen && lastSeen.get(`${provider}|${user}`)) || "",
    note: "",
  };
  if (win) {
    row.limit = win.limit;
    row.used = win.used;
    row.remaining = Math.max(0, win.limit - win.used);
    row.pct = (win.used / win.limit) * 100;
    row.resetsAt = win.resetsAt || "";
    row.note = win.note || "";
  } else {
    // 无可解析窗口：保留文字，前端显示原文且不画进度条
    row.note = text(account?.balance) || "无可解析额度窗口";
  }
  return row;
}

// ---- 主入口：quotas 原始数据 → { providers: [...] } ----
// providers 按名称排序，账号按名称排序；供应商行 = 各账号相加（仅对可解析账号）。
// lastSeen: Map<"provider|user", ISO>，来自 usage.jsonl，用于「最近请求」列。
export function buildQuotaBoard(quotasBody, lastSeen) {
  const data = Array.isArray(quotasBody?.data) ? quotasBody.data : [];
  const byProvider = new Map();
  for (const account of data) {
    const row = accountRow(account, lastSeen);
    if (!byProvider.has(row.provider)) {
      byProvider.set(row.provider, {
        provider: row.provider,
        providerName: row.providerName,
        accounts: [],
        limit: 0,
        used: 0,
        count: 0,
        unresolvable: 0,
      });
    }
    byProvider.get(row.provider).accounts.push(row);
  }
  const providers = [...byProvider.values()].map((p) => {
    p.accounts.sort((a, b) => a.account.localeCompare(b.account, "zh-Hans-CN"));
    for (const a of p.accounts) {
      if (a.limit != null) {
        p.limit += a.limit;
        p.used += a.used;
        p.count += 1;
      } else {
        p.unresolvable += 1;
      }
    }
    if (p.limit > 0) {
      p.remaining = Math.max(0, p.limit - p.used);
      p.pct = (p.used / p.limit) * 100;
    } else {
      p.remaining = null;
      p.pct = null;
    }
    // 供应商的「最近请求」= 其下各账号里最晚的一次
    p.lastAt = p.accounts.reduce((m, a) => (a.lastAt > m ? a.lastAt : m), "");
    return p;
  });
  providers.sort((a, b) => a.providerName.localeCompare(b.providerName, "zh-Hans-CN"));
  return { providers, generatedAt: new Date().toISOString() };
}
