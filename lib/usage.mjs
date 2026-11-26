// 用量口径层：网关 /v1/magpie/usage 的四维汇总 + 自定义区间（读 usage.jsonl 流水账）。
// 汇总规则（用户裁决）：
// - Token = 输入 + 输出 + 缓存读写合计，展示为 M（百万）单位。
// - 缓存命中率 = 缓存读 ÷（输入 + 缓存读），仅「按模型」维度显示；无缓存读的行不显示。
// - 按账号维度：名称 =「供应商 · 账号」，排序先按供应商、再按账号名称；API Key 单独成组。
// - 自定义区间（精确到时分）：读 usage.jsonl 自行汇总（网关接口只认 today/7d/30d/all）。

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function text(v) {
  return v == null ? "" : String(v).trim();
}
function number(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---- usage.jsonl 路径（只读） ----
export function usageJsonlPath() {
  if (process.env.MAGPIE_USAGE_JSONL) return process.env.MAGPIE_USAGE_JSONL;
  return path.join(os.homedir(), ".config", "magpie", "usage.jsonl");
}

// 逐行读取 [from, to] 区间内的行（本地时间 ISO 字符串可直接字典序比较，同格式时安全）。
// from/to 均为 "YYYY-MM-DDTHH:mm" 本地时间表示；返回原始行对象数组。
export function readUsageRows(from, to, filePath = usageJsonlPath()) {
  const rows = [];
  const raw = fs.readFileSync(filePath, "utf8");
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let row;
    try {
      row = JSON.parse(s);
    } catch {
      continue; // 残行跳过
    }
    const t = text(row?.t);
    if (!t) continue;
    if (from && t < from) continue;
    if (to && t >= to) continue;
    rows.push(row);
  }
  return rows;
}

// ---- 最近请求时间索引 ----
// 额度接口不带请求时间，而 usage.jsonl 的 providerAccount 与额度接口的 user 是同一个值，
// 所以按 (provider, providerAccount) 取最后一次请求时间，供额度页显示「最近请求」。
// 只读文件尾部（默认 4 MB），避免长年累积后整文件解析。
export function readLastSeen(maxBytes = 4 * 1024 * 1024, filePath = usageJsonlPath()) {
  const map = new Map();
  let raw;
  try {
    const size = fs.statSync(filePath).size;
    const start = Math.max(0, size - maxBytes);
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      raw = buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
    // 从中间截断时首行可能不完整，丢掉
    if (start > 0) raw = raw.slice(raw.indexOf("\n") + 1);
  } catch {
    return map; // 文件不存在或无权限：额度页照常显示，只是最近请求为「—」
  }
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let row;
    try {
      row = JSON.parse(s);
    } catch {
      continue;
    }
    const provider = text(row?.provider);
    const account = text(row?.providerAccount);
    const t = text(row?.t);
    if (!provider || !account || !t) continue;
    const k = `${provider}|${account}`;
    if (t > (map.get(k) || "")) map.set(k, t);
  }
  return map;
}

// ---- 统计累加器 ----
// costRows 记录「带单价的行数」：usage.jsonl 不写价格，自定义区间里费用无法还原，
// 此时 cost 置为 null（前端显示「—」），而不是假装成 0 美元。
function blank() {
  return {
    calls: 0,
    errors: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    costRows: 0,
    lastAt: "",
  };
}
function addStats(st, row) {
  st.calls += 1;
  if (number(row?.status) >= 400 || number(row?.status) === 0) st.errors += 1;
  st.input += number(row?.in);
  st.output += number(row?.out);
  st.cacheRead += number(row?.cache_read);
  st.cacheWrite += number(row?.cache_write);
  if (row?.cost != null) {
    st.cost += number(row?.cost);
    st.costRows += 1;
  }
  const t = text(row?.t);
  if (t > st.lastAt) st.lastAt = t;
}
function finish(st) {
  st.tokens = st.input + st.output + st.cacheRead + st.cacheWrite;
  st.tokensM = st.tokens / 1e6;
  st.cacheHit =
    st.input + st.cacheRead > 0
      ? (st.cacheRead / (st.input + st.cacheRead)) * 100
      : null; // null = 不显示
  if (st.costRows === 0) st.cost = null; // 无价格数据：不显示 0
  return st;
}

// ---- 网关聚合行（usage 接口各数组元素）→ 统计 ----
function fromGatewayItem(item) {
  const st = blank();
  st.calls = number(item?.calls);
  st.errors = number(item?.errors);
  st.input = number(item?.input);
  st.output = number(item?.output);
  st.cacheRead = number(item?.cache_read);
  st.cacheWrite = number(item?.cache_write);
  st.cost = number(item?.cost);
  st.costRows = item?.cost == null ? 0 : 1; // 网关会算价
  st.lastAt = text(item?.last_at || item?.lastAt || item?.last);
  return finish(st);
}

const PROVIDER_NAMES = {
  codex: "Codex",
  openai: "OpenAI",
  anthropic: "Anthropic",
  workbuddy: "WorkBuddy",
  "workbuddy-ai": "WorkBuddy AI",
  raccoon: "商汤小浣熊",
  "minimax-code": "MiniMax Code",
  "minimax-code-global": "MiniMax Code (Global)",
  "trae-cn": "Trae CN",
  "trae-global": "Trae",
  qwenwork: "QwenWork",
  codearts: "CodeArts",
};

export function providerName(id) {
  return PROVIDER_NAMES[text(id)] || text(id) || "unknown";
}

// ---- 四维汇总：网关模式 ----
// dim: model | provider | account | harness
// 注意：网关的 models 数组是按「模型 × 账号」拆分的，同一个模型会出现多行；
// provider 数组则按账号给行。两者都要按目标键再合并，否则会看到重复行。
export function summarizeGateway(usageBody, dim) {
  const key = { model: "models", provider: "accounts", account: "accounts", harness: "agents" }[dim];
  const items = Array.isArray(usageBody?.[key]) ? usageBody[key] : [];

  // 需要合并的维度：model 按模型名，provider 按供应商 id
  if (dim === "model" || dim === "provider") {
    const merged = new Map();
    for (const item of items) {
      const st = fromGatewayItem(item);
      const k = dim === "model" ? text(item?.model) || text(item?.name) || "unknown" : text(item?.provider) || "unknown";
      if (!merged.has(k)) {
        merged.set(k, { name: dim === "model" ? text(item?.name) || k : providerName(k), ...blank() });
      }
      const m = merged.get(k);
      m.calls += st.calls; m.errors += st.errors;
      m.input += st.input; m.output += st.output;
      m.cacheRead += st.cacheRead; m.cacheWrite += st.cacheWrite;
      if (st.cost != null) { m.cost += st.cost; m.costRows += 1; }
      if (st.lastAt > m.lastAt) m.lastAt = st.lastAt;
    }
    return [...merged.values()]
      .map(finish)
      .sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name, "zh-Hans-CN"));
  }

  const rows = [];
  for (const item of items) {
    const st = fromGatewayItem(item);
    if (dim === "account") {
      // 名称列 =「供应商 · 账号」；排序先供应商再账号名（用户裁决）
      const pname = providerName(item?.provider);
      rows.push({ name: `${pname} · ${text(item?.name) || "（未命名）"}`, ...st });
    } else {
      rows.push({ name: text(item?.name) || text(item?.id) || "unknown", ...st });
    }
  }
  if (dim === "account") return rows.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return rows.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

// ---- 四维汇总：流水账模式（自定义区间） ----
// 流水行字段：agent/agentName/provider/providerName/providerAccount/model/in/out/cache_read/cache_write/cost/status/t
// aliases: Map<"provider|providerAccount", 别名>，来自额度接口（usage.jsonl 不记别名）。
// 有别名用别名，否则回退 providerAccount 原始值——与额度页 accountRow() 的语义一致。
export function summarizeRows(rows, dim, aliases) {
  const groups = new Map();
  const bucketOf = (row) => {
    if (dim === "model") return `model::${text(row?.model) || "unknown"}`;
    if (dim === "provider") return `provider::${text(row?.provider)}`;
    if (dim === "account") {
      const acc = text(row?.providerAccount);
      if (acc) return `account::${text(row?.provider)}::${acc}`;
      return `account::${text(row?.provider)}::(API Key)`;
    }
    return `agent::${text(row?.agent)}`;
  };
  // 分组键仍用原始账号：别名只影响显示名，不影响合并与排序依据
  const labelOf = (row, acc) => {
    const alias = aliases?.get?.(`${text(row?.provider)}|${acc}`);
    return text(alias) || acc;
  };
  for (const row of rows) {
    const k = bucketOf(row);
    if (!groups.has(k)) {
      let name;
      if (dim === "model") name = text(row?.model) || "unknown";
      else if (dim === "provider") name = text(row?.providerName) || providerName(row?.provider);
      else if (dim === "account") {
        const p = text(row?.providerName) || providerName(row?.provider);
        const acc = text(row?.providerAccount);
        name = acc ? `${p} · ${labelOf(row, acc)}` : `${p} · API Key`;
      } else name = text(row?.agentName) || text(row?.agent) || "unknown";
      groups.set(k, { name, ...blank() });
    }
    addStats(groups.get(k), row);
  }
  const out = [...groups.values()].map(finish);
  if (dim === "account") return out.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
  return out.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name, "zh-Hans-CN"));
}

// ---- 合计 ----
export function totalOf(rows) {
  const t = blank();
  for (const r of rows) {
    t.calls += r.calls; t.errors += r.errors; t.input += r.input; t.output += r.output;
    t.cacheRead += r.cacheRead; t.cacheWrite += r.cacheWrite;
    if (r.cost != null) {
      t.cost += r.cost;
      t.costRows += 1;
    }
    if (r.lastAt > t.lastAt) t.lastAt = r.lastAt;
  }
  return finish(t);
}
