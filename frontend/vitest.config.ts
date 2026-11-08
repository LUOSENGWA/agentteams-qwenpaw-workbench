// vitest 入口（M2 #1526 模块更新单测引入）：include 只取
// tests 目录下 *.vitest.test.ts（vitest 风格，本批新增）。
// 既有 14 个 tests/*.test.ts 是 node-assert 风格（node
// --experimental-strip-types 直接跑，无 vitest 套件块——若纳入 vitest
// 会报 "No test suite found"），不进 include、行为不变。
// 纯对象导出（不 import vitest/config——npx 缓存环境下该说明符
// 解析不到；对象形态与 defineConfig 等价）。
export default {
  test: {
    include: ["tests/**/*.vitest.test.ts"],
    environment: "node",
  },
};
