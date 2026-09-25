import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { readFileSync } from "fs";
import { defineConfig, type Plugin } from "vite";

/**
 * v0.5.0-beta.12 构建守卫：dist 不得含任何 ES module 导入（裸说明符或相对路径）。
 *
 * 原因：宿主 usePluginLoader 把 dist/index.js 包成同域 Blob URL 后 dynamic
 * import 执行——blob 模块没有 base URL，浏览器解析不了任何 import 说明符
 * （无 import map）。出现裸 `import ... from "react"` 时症状是运行时
 * TypeError "Failed to resolve module specifier 'react'" → "0/1 plugin(s)
 * loaded" → 侧边栏/App 全消失（v0.5.0-beta.12 事故：单个文件的 value import 把
 * react externalize 污染整个 bundle，真机才炸）。
 *
 * 正确模式：源码一律 `import type * as ReactNS from "react"`（类型，编译
 * 擦除）+ 运行时 `window.QwenPaw.host.React`（宿主实例，hooks 同实例）。
 * 单文件 lib 构建，产物正常形态 = 零 import（v0.5.0-beta.12 及以前一直如此）。
 */
function noModuleImportsGuard(): Plugin {
  return {
    name: "no-module-imports-guard",
    enforce: "post",
    // 用 generateBundle 而非 writeBundle：Vite 5 lib 构建里 writeBundle 的
    // options.file 是 undefined（曾致守卫静默失效）；generateBundle 直接拿到
    // 即将写出的 chunk 代码。
    generateBundle(_options, bundle) {
      const chunk = bundle["index.js"];
      if (!chunk || typeof chunk.code !== "string") return;
      const src = chunk.code;
      // 语句边界（行首/;/{}/后）的 import 语句 = 违规。双正则覆盖：
      // ① 副作用导入 import"..."  ② 值导入 import X from "..."（含 minify 无空格形态）。
      // 只认语句位置 → 字符串字面量如 r.set("from", n) 不误报（v0.5.0-beta.12 产物验证过）。
      // 重写：旧 value 正则 [^;{}]*? 跨不了命名导入的花括号，minify 后
      // `import{useMemo}from"react"` 直接漏网（早期版本把宿主炸掉的正是这条）。
      // 改为逐语法形态精确匹配（minify/带空格双形态全覆盖），14 用例负测通过：
      // 副作用 import"…" | 命名 import{…}from"…" | 命名空间 import*as R from"…"
      // | 默认+命名 import R,{…}from"…" | 默认 importxfrom"…" | 动态 import("…")
      const modImport = /(^|[;{}])\s*import\s*(?:"|'|\{[^{}]*\}\s*from\s*["']|\*[^;{}]*?from\s*["']|[\w$]+\s*,\s*\{[^{}]*\}\s*from\s*["']|[\w$]+\s*from\s*["']|\(\s*["'])/g;
      const hits = src.match(modImport) || [];
      if (hits.length > 0) {
        throw new Error(
          `[no-module-imports-guard] dist/index.js 含 ${hits.length} 处 module 导入（${hits.slice(0, 3).join(" ")}…）。` +
            "宿主 blob-URL 执行环境无法解析任何 import 说明符——插件会 '0/1 loaded' 消失。" +
            "源码中 React/antd 必须走 window.QwenPaw.host（import type 仅用于类型标注）。",
        );
      }
    },
  };
}

/**
 * 0.5.0-beta.8 构建守卫二：最终 bundle 全量 minify（esbuild API 直压）。
 *
 * 原因：Vite lib 模式对 build.minify 支持不完整（实测 minify:"esbuild"
 * 只压标识符，注释与换行全保留）→ 开发注释随 dist/index.js
 * 分发给每个用户，公开仓库不可接受。esbuild transform(minify) 剥离全部
 * 注释 + 单行化，~3MB → ~1MB。
 * 注册顺序：在 noModuleImportsGuard 之前（post 插件按注册序执行）→
 * 守卫检查的是最终压缩产物（其正则本就覆盖 minify 无空格形态）。
 *
 * 2026-08-30 开源礼仪修复（用户「文档搞好」轮）：legalComments:"none"
 * 会把上游 license 头连同开发注释一起剥掉 → 分发的 bundle 无任何第三方
 * 版权头，违反 MIT/ISC「保留版权与许可声明」条款。修复两件：
 * ① esbuild legalComments 改 "eof"——three.js 源码带 @license 头，
 * rollup 已收集，压后保留在 bundle 尾部；
 * ② transform 后 prepend 统一第三方版权 banner——3d-force-graph /
 * three-spritetext / fflate 的发行 mjs 头部无 license 注释（构建
 * 时剥离，许可只在各自包内 LICENSE 文件），仅靠 ① 会漏，必须
 * 显式注入。许可全文见 THIRD-PARTY-NOTICES.md（随包分发）。
 */
const THIRD_PARTY_BANNER = `/*!
 * Bundled third-party components (source inlined into this file):
 * three.js 0.185.1        - Copyright (c) 2010-2026 three.js authors   - MIT
 * 3d-force-graph 1.80.0   - Copyright (c) 2017 Vasco Asturiano         - MIT
 * three-spritetext 1.10.0 - Copyright (c) 2018 Vasco Asturiano         - MIT
 * fflate 0.8.3            - Copyright (c) 2026 Arjun Barrett           - MIT
 * lucide icon path data   - Copyright (c) lucide contributors          - ISC
 * Full license texts: THIRD-PARTY-NOTICES.md (shipped with this plugin).
 */`;

function fullMinifyGuard(): Plugin {
  return {
    name: "full-minify-guard",
    enforce: "post",
    async generateBundle(_options, bundle) {
      const chunk = bundle["index.js"];
      if (!chunk || typeof chunk.code !== "string") return;
      const { transform } = await import("esbuild");
      const out = await transform(chunk.code, {
        minify: true,
        legalComments: "eof",
        target: "es2020",
      });
      chunk.code = THIRD_PARTY_BANNER + "\n" + out.code;
    },
  };
}

/**
 * v0.5.0-beta.12 渲染审计用：/gw-proxy/:path → 内置 fixture（活体响应形状，
 * 含 Higress {code,data} 信封与 Manager 模型值 qwen3.6-plus）。
 * 仅 dev server 生效，不进生产 bundle。
 * v2（11.13）：fixture 键对齐 api.ts 实际请求路径（含 /agentteams-proxy/ 前缀）；
 * 上一版写入曾被外部进程还原（mtime 回退），重加时以本段为准。
 */
const GW_FIXTURES: Record<string, unknown> = {
  "/agentteams-proxy/admin": {
    workers: [
      { name: "team-a-lead", model: "qwen3.6-27b-fp8", runtime: "qwenpaw", phase: "Running" },
      { name: "team-a-worker", model: "qwen3.6-27b-fp8", runtime: "qwenpaw", phase: "Running" },
    ],
    teams: [
      { name: "team-a", phase: "Running", leaderName: "team-a-lead", readyWorkers: 1, totalWorkers: 2, workerNames: ["team-a-lead", "team-a-worker"] },
    ],
    humans: [
      { name: "admin", displayName: "管理员", permissionLevel: 1, accessibleTeams: ["team-a", "team-b"], matrixUserID: "@admin:matrix.local" },
    ],
    managers: [
      { name: "manager-1", model: "qwen3.6-plus", runtime: "qwenpaw", phase: "Running", mxid: "@manager-1:matrix.local" },
    ],
  },
  "/agentteams-proxy/sglang/models": {
    models: ["qwen3.6-27b-fp8", "qwen3.6-plus-35b-a3b-fp8"],
  },
  "/agentteams-proxy/sglang/loads": { loads: [] },
  "/agentteams-proxy/gateway/ai-routes": {
    available: true,
    data: {
      code: 0,
      data: {
      routes: [
        { name: "default-ai-route", matchType: "EQUAL", modelPredicates: ["deepseek-v4-flash"], provider: "openai-compat" },
        { name: "qwen-local", matchType: "EXACT", modelPredicates: ["qwen3.6-27b-fp8"], provider: "sglang-local" },
        { name: "qwen-plus", matchType: "EXACT", modelPredicates: ["qwen3.6-plus"], provider: "sglang-local" },
        ],
      },
    },
  },
  "/agentteams-proxy/teams/sync": {
    ok: true,
    rooms: [
          { room_id: "!proj-01:matrix.local", name: "项目群-压力测试-01", member_count: 3, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000001, last_body: "最后一条消息 01" },
          { room_id: "!proj-02:matrix.local", name: "项目群-压力测试-02", member_count: 4, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000002, last_body: "最后一条消息 02" },
          { room_id: "!proj-03:matrix.local", name: "项目群-压力测试-03", member_count: 5, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000003, last_body: "最后一条消息 03" },
          { room_id: "!proj-04:matrix.local", name: "项目群-压力测试-04", member_count: 6, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000004, last_body: "最后一条消息 04" },
          { room_id: "!proj-05:matrix.local", name: "项目群-压力测试-05", member_count: 7, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000005, last_body: "最后一条消息 05" },
          { room_id: "!proj-06:matrix.local", name: "项目群-压力测试-06", member_count: 8, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000006, last_body: "最后一条消息 06" },
          { room_id: "!proj-07:matrix.local", name: "项目群-压力测试-07", member_count: 2, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000007, last_body: "最后一条消息 07" },
          { room_id: "!proj-08:matrix.local", name: "项目群-压力测试-08", member_count: 3, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000008, last_body: "最后一条消息 08" },
          { room_id: "!proj-09:matrix.local", name: "项目群-压力测试-09", member_count: 4, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000009, last_body: "最后一条消息 09" },
          { room_id: "!proj-10:matrix.local", name: "项目群-压力测试-10", member_count: 5, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000010, last_body: "最后一条消息 10" },
          { room_id: "!proj-11:matrix.local", name: "项目群-压力测试-11", member_count: 6, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000011, last_body: "最后一条消息 11" },
          { room_id: "!proj-12:matrix.local", name: "项目群-压力测试-12", member_count: 7, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000012, last_body: "最后一条消息 12" },
          { room_id: "!proj-13:matrix.local", name: "项目群-压力测试-13", member_count: 8, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000013, last_body: "最后一条消息 13" },
          { room_id: "!proj-14:matrix.local", name: "项目群-压力测试-14", member_count: 2, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000014, last_body: "最后一条消息 14" },
          { room_id: "!proj-15:matrix.local", name: "项目群-压力测试-15", member_count: 3, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000015, last_body: "最后一条消息 15" },
          { room_id: "!proj-16:matrix.local", name: "项目群-压力测试-16", member_count: 4, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000016, last_body: "最后一条消息 16" },
          { room_id: "!proj-17:matrix.local", name: "项目群-压力测试-17", member_count: 5, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000017, last_body: "最后一条消息 17" },
          { room_id: "!proj-18:matrix.local", name: "项目群-压力测试-18", member_count: 6, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000018, last_body: "最后一条消息 18" },
          { room_id: "!proj-19:matrix.local", name: "项目群-压力测试-19", member_count: 7, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000019, last_body: "最后一条消息 19" },
          { room_id: "!proj-20:matrix.local", name: "项目群-压力测试-20", member_count: 8, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000020, last_body: "最后一条消息 20" },
          { room_id: "!proj-21:matrix.local", name: "项目群-压力测试-21", member_count: 2, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000021, last_body: "最后一条消息 21" },
          { room_id: "!proj-22:matrix.local", name: "项目群-压力测试-22", member_count: 3, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000022, last_body: "最后一条消息 22" },
          { room_id: "!proj-23:matrix.local", name: "项目群-压力测试-23", member_count: 4, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000023, last_body: "最后一条消息 23" },
          { room_id: "!proj-24:matrix.local", name: "项目群-压力测试-24", member_count: 5, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000024, last_body: "最后一条消息 24" },
          { room_id: "!proj-25:matrix.local", name: "项目群-压力测试-25", member_count: 6, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000025, last_body: "最后一条消息 25" },
          { room_id: "!proj-26:matrix.local", name: "项目群-压力测试-26", member_count: 7, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000026, last_body: "最后一条消息 26" },
          { room_id: "!proj-27:matrix.local", name: "项目群-压力测试-27", member_count: 8, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000027, last_body: "最后一条消息 27" },
          { room_id: "!proj-28:matrix.local", name: "项目群-压力测试-28", member_count: 2, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000028, last_body: "最后一条消息 28" },
          { room_id: "!proj-29:matrix.local", name: "项目群-压力测试-29", member_count: 3, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000029, last_body: "最后一条消息 29" },
          { room_id: "!proj-30:matrix.local", name: "项目群-压力测试-30", member_count: 4, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000030, last_body: "最后一条消息 30" },
          { room_id: "!proj-31:matrix.local", name: "项目群-压力测试-31", member_count: 5, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000031, last_body: "最后一条消息 31" },
          { room_id: "!proj-32:matrix.local", name: "项目群-压力测试-32", member_count: 6, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000032, last_body: "最后一条消息 32" },
          { room_id: "!proj-33:matrix.local", name: "项目群-压力测试-33", member_count: 7, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000033, last_body: "最后一条消息 33" },
          { room_id: "!proj-34:matrix.local", name: "项目群-压力测试-34", member_count: 8, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000034, last_body: "最后一条消息 34" },
          { room_id: "!proj-35:matrix.local", name: "项目群-压力测试-35", member_count: 2, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000035, last_body: "最后一条消息 35" },
          { room_id: "!proj-36:matrix.local", name: "项目群-压力测试-36", member_count: 3, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000036, last_body: "最后一条消息 36" },
          { room_id: "!proj-37:matrix.local", name: "项目群-压力测试-37", member_count: 4, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000037, last_body: "最后一条消息 37" },
          { room_id: "!proj-38:matrix.local", name: "项目群-压力测试-38", member_count: 5, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000038, last_body: "最后一条消息 38" },
          { room_id: "!proj-39:matrix.local", name: "项目群-压力测试-39", member_count: 6, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000039, last_body: "最后一条消息 39" },
          { room_id: "!proj-40:matrix.local", name: "项目群-压力测试-40", member_count: 7, members: { "@m:matrix.local": { display_name: "m" } }, last_ts: 1789000000040, last_body: "最后一条消息 40" },
    ],
    invites: [],
    muted_rooms: [],
    user_id: "@admin:matrix.local",
  },
  "/agentteams-proxy/gateway/ai-providers": {
    available: true,
    data: {
      code: 0,
      data: {
      providers: [
        { name: "openai-compat", type: "openai" },
        { name: "sglang-local", type: "openai" },
        ],
      },
    },
  },
};

function gwProxyMiddleware(): Plugin {
  return {
    name: "gw-proxy-middleware",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || "";
        const m = url.match(/^\/gw-proxy\/(.*)/);
        if (!m) return next();
        const key = "/" + m[1].split("?")[0].replace(/^\/+/, "");
        // 12.13 写面冒烟：POST 固定成功信封（真写面由连接器直连 Console）。
        if ((req.method || "GET") === "POST" && key.startsWith("/agentteams-proxy/gateway/")) {
          res.setHeader("content-type", "application/json");
          res.statusCode = 200;
          res.end(JSON.stringify({ available: true, data: { success: true } }));
          return;
        }
        const body = GW_FIXTURES[key];
        res.setHeader("content-type", "application/json");
        if (body === undefined) {
          res.statusCode = 404;
          res.end('{"detail":"not found"}');
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify(body));
      });
    },
  };
}

// v0.5.0-beta.13.17（13.16 装验「顶部版本号显示不对」）：版本注入 =
// 构建期从 package.json 读入打进 bundle（`__PLUGIN_VERSION__`）——顶部
// 显示的版本永远等于「你装进去的那个 dist 的版本」，不再依赖后端
// /health（后端进程未随安装重启时会返回旧 connection 版本 → 显示错）。
// 连接器运行版本仍可经 /health 拿（tooltip 次要信息）。
const PKG_VERSION = (
  JSON.parse(
    readFileSync(resolve(__dirname, "package.json"), "utf8"),
  ) as { version: string }
).version;

export default defineConfig({
  plugins: [react({ jsxRuntime: "classic" }), fullMinifyGuard(), noModuleImportsGuard(), gwProxyMiddleware()],
  define: {
    __PLUGIN_VERSION__: JSON.stringify(PKG_VERSION),
  },
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.tsx"),
      formats: ["es"],
      fileName: () => "index.js",
    },
    outDir: resolve(__dirname, "../dist"),
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      // React/ReactDOM come from window.QwenPaw.host at runtime.
      // 保留 external：源码若误写 value import，守卫让构建显式失败
      // （而不是 rollup 静默内联第二份 React → 双实例 hooks 暗病）。
      external: ["react", "react-dom"],
      // 单文件约束守卫 = noModuleImportsGuard（dist 出现任何 import 语句
      // 即构建失败）。v0.5.0-beta.13.21（A9 mermaid）曾为内联 mermaid 的
      // lazy diagram chunk 加 output.inlineDynamicImports；13.24 随 mermaid
      // 整体退役（装验定案 DAG/Mermaid 合并）一并移除——源码已无运行时
      // 动态导入，守卫仍是单文件契约的兜底。
    },
  },
});
