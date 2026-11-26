// magpie-usage-quota-board 的宿主部分：magpie 的 Bun 宿主加载它并询问页面服务。
// 服务跑在宿主进程里，magpie 停止插件时它随之停止。架构参照 @magpie-community/page-usage-tree。
import { startServer } from "./lib/server.mjs";

let started = null;

export default {
  id: "magpie-usage-quota-board",
  server: async (_input, options) => {
    if (!started) {
      started = startServer({ port: Number(options?.port) || 3499 }).catch((error) => {
        started = null;
        throw error;
      });
    }
    await started;
    return {};
  },
};
