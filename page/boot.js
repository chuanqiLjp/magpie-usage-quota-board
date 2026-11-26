// 启动逻辑：等待 bridge 就绪 → 读插件自己的选项（port）→ 导航到本地服务。
// token 由服务在 URL 上带一次，之后页面改用 localStorage 保存。
(async () => {
  const defaultPort = 3499;
  let port = defaultPort;
  try {
    await magpie.ready;
    const opts = await magpie.options.get();
    port = Number(opts?.port) || defaultPort;
  } catch {
    // bridge 不可用时按默认端口走
  }
  const base = `http://127.0.0.1:${port}`;
  // 先试无 token 打开（服务会把我们引到带 token 的入口）；
  // 由于沙盒里无法 fetch，直接导航到 /enter，由服务 302 到带 token 的页面。
  location.replace(`${base}/enter`);
})();
