// 存储封装：Magpie 的插件页跑在 sandbox="allow-scripts" 的 iframe 里（无 allow-same-origin），
// 文档处于 opaque origin，访问 localStorage 会抛 SecurityError。
// 这里统一兜住：能写就写 localStorage，不能写就退化为内存（功能不受影响，只是刷新后不记忆）。
(function (root) {
  const memory = Object.create(null);
  const store = {
    get(key) {
      try {
        return root.localStorage.getItem(key);
      } catch {
        return key in memory ? memory[key] : null;
      }
    },
    set(key, value) {
      try {
        root.localStorage.setItem(key, value);
      } catch {
        memory[key] = value;
      }
    },
    remove(key) {
      try {
        root.localStorage.removeItem(key);
        return;
      } catch {
        delete memory[key];
      }
    },
    // 便于测试与诊断：当前是否用的是真实持久化
    persistent() {
      try {
        root.localStorage.setItem("__mqb_probe__", "1");
        root.localStorage.removeItem("__mqb_probe__");
        return true;
      } catch {
        return false;
      }
    },
  };
  root.mqbStore = store;
})(globalThis);
