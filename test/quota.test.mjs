// 口径层单测：quota.mjs（窗口挑选、qwenwork 文字解析、供应商聚合）
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseQwenWorkBalance,
  pickAccountWindow,
  progressColor,
  buildQuotaBoard,
} from "../lib/quota.mjs";

test("parseQwenWorkBalance 解析真实样例", () => {
  const r = parseQwenWorkBalance("399.99 credits (monthly 99.99 · long-term 300)");
  assert.deepEqual(r, { remaining: 399.99, limit: 399.99, monthly: 99.99, longTerm: 300 });
  const r2 = parseQwenWorkBalance("400 credits (monthly 100 · long-term 300)");
  assert.deepEqual(r2, { remaining: 400, limit: 400, monthly: 100, longTerm: 300 });
});

test("parseQwenWorkBalance 非法输入返回 null", () => {
  assert.equal(parseQwenWorkBalance(""), null);
  assert.equal(parseQwenWorkBalance("no numbers here"), null);
  assert.equal(parseQwenWorkBalance("monthly 100 only"), null);
  assert.equal(parseQwenWorkBalance(undefined), null);
});

test("pickAccountWindow：trae-cn 取 Credits 窗口", () => {
  const account = {
    provider: "trae-cn",
    windows: [{ name: "Credits", used: 12.8, amount: 460.79, limit: 3600, unit: "credits" }],
  };
  const w = pickAccountWindow(account);
  assert.equal(w.used, 460.79);
  assert.equal(w.limit, 3600);
});

test("pickAccountWindow：raccoon 忽略 Daily pool", () => {
  const account = {
    provider: "raccoon",
    windows: [
      { name: "Daily pool", amount: 1336, limit: 2100, unit: "credits" },
      { name: "Credits", amount: 436, limit: 7200, unit: "credits" },
    ],
  };
  const w = pickAccountWindow(account);
  assert.equal(w.used, 436);
  assert.equal(w.limit, 7200);
});

test("pickAccountWindow：codearts 取「总积分」窗口", () => {
  const account = {
    provider: "codearts",
    windows: [
      { name: "总积分", amount: 396.35, limit: 4600, unit: "credits" },
      { name: "基础积分包", amount: 0, limit: 500, unit: "credits" },
      { name: "赠送积分包", amount: 396.35, limit: 4100, unit: "credits" },
    ],
  };
  const w = pickAccountWindow(account);
  assert.equal(w.used, 396.35);
  assert.equal(w.limit, 4600);
});

test("pickAccountWindow：qwenwork 从 balance 文字解析", () => {
  const account = { provider: "qwenwork", windows: [], balance: "400 credits (monthly 100 · long-term 300)" };
  const w = pickAccountWindow(account);
  assert.equal(w.used, 0);
  assert.equal(w.limit, 400);
});

test("pickAccountWindow：无匹配窗口返回 null", () => {
  assert.equal(pickAccountWindow({ provider: "unknown-p", windows: [] }), null);
  assert.equal(pickAccountWindow({ provider: "trae-cn", windows: [{ name: "别的", limit: 100 }] }), null);
});

test("progressColor 三档", () => {
  assert.equal(progressColor(50), "ok");
  assert.equal(progressColor(60), "ok");
  assert.equal(progressColor(61), "warn");
  assert.equal(progressColor(90), "warn");
  assert.equal(progressColor(90.5), "danger");
});

test("buildQuotaBoard：lastSeen 按 provider+user 填「最近请求」", () => {
  const lastSeen = new Map([
    ["trae-cn|user-1001", "2026-11-26T10:00:00+08:00"],
    ["trae-cn|账号甲", "2026-11-26T12:30:00+08:00"],
  ]);
  const board = buildQuotaBoard(
    {
      data: [
        {
          provider: "trae-cn",
          name: "Trae CN",
          alias: "账号A",
          user: "user-1001",
          windows: [{ name: "Credits", amount: 100, limit: 2400, unit: "credits" }],
        },
        {
          provider: "trae-cn",
          name: "Trae CN",
          alias: "账号乙",
          user: "账号甲",
          windows: [{ name: "Credits", amount: 200, limit: 3600, unit: "credits" }],
        },
        {
          provider: "qwenwork",
          name: "QwenWork",
          alias: "没人用",
          user: "user-2@example.com",
          windows: [],
          balance: "400 credits (monthly 100 · long-term 300)",
        },
      ],
    },
    lastSeen,
  );
  const trae = board.providers.find((p) => p.provider === "trae-cn");
  // 供应商行取各账号最晚的一次
  assert.equal(trae.lastAt, "2026-11-26T12:30:00+08:00");
  const mother = trae.accounts.find((a) => a.account === "账号A");
  assert.equal(mother.lastAt, "2026-11-26T10:00:00+08:00");
  const qwen = board.providers.find((p) => p.provider === "qwenwork");
  assert.equal(qwen.lastAt, "");
  assert.equal(qwen.accounts[0].lastAt, "");
});

test("buildQuotaBoard：供应商聚合 = 各账号相加，排序稳定", () => {
  const board = buildQuotaBoard({
    data: [
      {
        provider: "trae-cn",
        name: "Trae CN",
        alias: "账号B",
        windows: [{ name: "Credits", amount: 300, limit: 3600, unit: "credits" }],
      },
      {
        provider: "trae-cn",
        name: "Trae CN",
        alias: "账号A",
        windows: [{ name: "Credits", amount: 100, limit: 2400, unit: "credits" }],
      },
      {
        provider: "qwenwork",
        name: "QwenWork",
        alias: "账号C",
        windows: [],
        balance: "400 credits (monthly 100 · long-term 300)",
      },
    ],
  });
  assert.equal(board.providers.length, 2);
  const trae = board.providers.find((p) => p.provider === "trae-cn");
  assert.equal(trae.limit, 6000);
  assert.equal(trae.used, 400);
  assert.equal(trae.remaining, 5600);
  assert.ok(Math.abs(trae.pct - (400 / 6000) * 100) < 1e-9);
  // 账号按名称排序
  assert.equal(trae.accounts[0].account, "账号A");
  assert.equal(trae.accounts[1].account, "账号B");
  const qwen = board.providers.find((p) => p.provider === "qwenwork");
  assert.equal(qwen.limit, 400);
  assert.equal(qwen.used, 0);
});
