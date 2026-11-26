// 存储封装单测：模拟 Magpie 沙盒（localStorage 抛 SecurityError）与正常两种环境。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, "..", "ui", "store.js"), "utf8");

// 用真实的 store.js 源码，喂一个假的 globalThis
function loadStore(fakeGlobal) {
  new Function("globalThis", SRC)(fakeGlobal);
  return fakeGlobal.mqbStore;
}

const blockedLocalStorage = {
  getItem() {
    throw new Error("SecurityError: The operation is insecure.");
  },
  setItem() {
    throw new Error("SecurityError: The operation is insecure.");
  },
  removeItem() {
    throw new Error("SecurityError: The operation is insecure.");
  },
};

test("沙盒环境（localStorage 抛错）：读写不抛异常，退化为内存", () => {
  const store = loadStore({ localStorage: blockedLocalStorage });
  assert.equal(store.get("k"), null);
  assert.doesNotThrow(() => store.set("k", "v1"));
  assert.equal(store.get("k"), "v1");
  assert.doesNotThrow(() => store.remove("k"));
  assert.equal(store.get("k"), null);
  assert.equal(store.persistent(), false);
});

test("完全不存在 localStorage 的环境同样可用", () => {
  const store = loadStore({});
  assert.equal(store.get("k"), null);
  assert.doesNotThrow(() => store.set("k", "v2"));
  assert.equal(store.get("k"), "v2");
  assert.equal(store.persistent(), false);
});

test("正常环境：读写走真实 localStorage 且能持久", () => {
  const data = new Map();
  const localStorage = {
    getItem: (k) => (data.has(k) ? data.get(k) : null),
    setItem: (k, v) => data.set(k, String(v)),
    removeItem: (k) => data.delete(k),
  };
  const store = loadStore({ localStorage });
  store.set("k", "v3");
  assert.equal(store.get("k"), "v3");
  assert.equal(data.get("k"), "v3");
  assert.equal(store.persistent(), true);
  // persistent() 探测用的临时键不能残留
  assert.equal(data.has("__mqb_probe__"), false);
});

test("JSON 值（折叠状态）在两种环境下都能正确往返", () => {
  for (const g of [{ localStorage: blockedLocalStorage }, {}]) {
    const store = loadStore(g);
    const value = JSON.stringify({ "trae-cn": true, codearts: false });
    store.set("mqb-expanded", value);
    assert.deepEqual(JSON.parse(store.get("mqb-expanded")), { "trae-cn": true, codearts: false });
  }
});
