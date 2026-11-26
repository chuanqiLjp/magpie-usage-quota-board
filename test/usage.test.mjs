// 用量口径层单测：usage.mjs（四维汇总、自定义区间、Token/命中率口径）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  summarizeGateway,
  summarizeRows,
  totalOf,
  readUsageRows,
  usageJsonlPath,
} from "../lib/usage.mjs";

function gwItem(over = {}) {
  return {
    calls: 10,
    errors: 1,
    input: 1000,
    output: 200,
    cache_read: 3000,
    cache_write: 0,
    cost: 0.5,
    last_at: "2026-11-26T10:00:00+08:00",
    ...over,
  };
}

test("summarizeGateway model 维度：Token=输入+输出+缓存，命中率=缓存读/(输入+缓存读)", () => {
  const rows = summarizeGateway({ models: [gwItem({ name: "glm-5.3" })] }, "model");
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.name, "glm-5.3");
  assert.equal(r.calls, 10);
  assert.equal(r.tokens, 1000 + 200 + 3000 + 0);
  assert.ok(Math.abs(r.cacheHit - (3000 / 4000) * 100) < 1e-9);
});

test("summarizeGateway model 维度：同一模型跨账号的多行要合并成一行", () => {
  // 网关的 models 数组按「模型 × 账号」拆分，实测同一个 glm-5.3 会出现 4 行
  const body = {
    models: [
      { provider: "codearts", model: "glm-5.3", name: "glm-5.3", ...gwItem({ calls: 125, input: 1000, cache_read: 0 }) },
      { provider: "codearts", model: "glm-5.3", name: "glm-5.3", ...gwItem({ calls: 39, input: 100, cache_read: 0 }) },
      { provider: "raccoon", model: "glm-5.3", name: "glm-5.3", ...gwItem({ calls: 10, input: 10, cache_read: 0 }) },
    ],
  };
  const rows = summarizeGateway(body, "model");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].calls, 174);
  assert.equal(rows[0].input, 1110);
});

test("summarizeGateway provider 维度：账号行聚合成供应商行", () => {
  const body = {
    accounts: [
      { provider: "codearts", name: "账号A", ...gwItem({ calls: 2, input: 100 }) },
      { provider: "codearts", name: "账号B", ...gwItem({ calls: 3, input: 200, cache_read: 0 }) },
      { provider: "trae-cn", name: "账号C", ...gwItem({ calls: 5 }) },
    ],
  };
  const rows = summarizeGateway(body, "provider");
  assert.equal(rows.length, 2);
  const codearts = rows.find((r) => r.name === "CodeArts");
  assert.equal(codearts.calls, 5);
  assert.equal(codearts.input, 300);
  const trae = rows.find((r) => r.name === "Trae CN");
  assert.equal(trae.calls, 5);
});

test("summarizeGateway account 维度：名称=供应商 · 账号，排序先供应商再账号名", () => {
  const body = {
    accounts: [
      { provider: "trae-cn", name: "账号A", ...gwItem() },
      { provider: "codearts", name: "账号A", ...gwItem() },
      { provider: "codearts", name: "阿花", ...gwItem() },
    ],
  };
  const rows = summarizeGateway(body, "account");
  assert.deepEqual(
    rows.map((r) => r.name),
    ["CodeArts · 阿花", "CodeArts · 账号A", "Trae CN · 账号A"],
  );
});

test("summarizeGateway harness 维度：取 agents 数组", () => {
  const rows = summarizeGateway(
    { agents: [{ id: "dsh", name: "DeepSeek Harness", ...gwItem() }] },
    "harness",
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "DeepSeek Harness");
});

test("summarizeRows：流水账四维（account 维 API Key 单独成组）", () => {
  const rows = [
    { t: "2026-11-25T10:30:00+08:00", agent: "dsh", agentName: "DeepSeek Harness", provider: "codearts", providerName: "CodeArts", providerAccount: "user:hw1", model: "glm-5.3", in: 100, out: 20, cache_read: 80, cache_write: 0, cost: 0.1, status: 200 },
    { t: "2026-11-25T11:00:00+08:00", agent: "dsh", provider: "deepseek", providerName: "DeepSeek", providerAccount: "", model: "deepseek-chat", in: 50, out: 10, cache_read: 0, cache_write: 0, cost: 0.02, status: 500 },
  ];
  const acc = summarizeRows(rows, "account");
  assert.deepEqual(
    acc.map((r) => r.name),
    ["CodeArts · user:hw1", "DeepSeek · API Key"],
  );
  assert.equal(acc[1].errors, 1);
  const model = summarizeRows(rows, "model");
  assert.equal(model.length, 2);
  const harness = summarizeRows(rows, "harness");
  assert.equal(harness.length, 1);
  assert.equal(harness[0].name, "DeepSeek Harness");
  assert.equal(harness[0].lastAt, "2026-11-25T11:00:00+08:00");
});

test("readUsageRows：区间过滤（from 含、to 不含）", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mqb-"));
  const file = path.join(dir, "usage.jsonl");
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ t: "2026-11-25T09:59:00+08:00", in: 1 }),
      JSON.stringify({ t: "2026-11-25T10:00:00+08:00", in: 2 }),
      JSON.stringify({ t: "2026-11-25T10:30:00+08:00", in: 3 }),
      "残行",
      JSON.stringify({ t: "2026-11-25T12:00:00+08:00", in: 4 }),
      "",
    ].join("\n"),
    "utf8",
  );
  const rows = readUsageRows("2026-11-25T10:00", "2026-11-25T11:00", file);
  assert.deepEqual(rows.map((r) => r.in), [2, 3]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("totalOf：合计", () => {
  const rows = summarizeRows(
    [
      { t: "2026-11-25T10:00:00+08:00", agent: "a", provider: "p", model: "m", in: 100, out: 50, cache_read: 50, cache_write: 10, cost: 0.1, status: 200 },
      { t: "2026-11-25T10:05:00+08:00", agent: "a", provider: "p", model: "m", in: 100, out: 50, cache_read: 50, cache_write: 10, cost: 0.1, status: 200 },
    ],
    "model",
  );
  const t = totalOf(rows);
  assert.equal(t.calls, 2);
  assert.equal(t.tokens, 420);
  // 命中率口径：缓存读 100 / (输入 200 + 缓存读 100)
  assert.ok(Math.abs(t.cacheHit - (100 / 300) * 100) < 1e-9);
});

test("费用不可得：流水账无 cost 时 cost 为 null（不显示 0 美元）", () => {
  const rows = summarizeRows(
    [{ t: "2026-11-25T10:00:00+08:00", agent: "a", provider: "p", model: "m", in: 10, out: 5, cache_read: 0, cache_write: 0, status: 200 }],
    "model",
  );
  assert.equal(rows[0].cost, null);
  assert.equal(totalOf(rows).cost, null);

  // 有 cost 时正常累加
  const rows2 = summarizeRows(
    [{ t: "2026-11-25T10:00:00+08:00", agent: "a", provider: "p", model: "m", in: 10, out: 5, cache_read: 0, cache_write: 0, cost: 0.25, status: 200 }],
    "model",
  );
  assert.equal(rows2[0].cost, 0.25);
  assert.equal(totalOf(rows2).cost, 0.25);
});

test("usageJsonlPath：默认在 ~/.config/magpie 下", () => {
  assert.ok(usageJsonlPath().includes(path.join(".config", "magpie", "usage.jsonl")));
});
