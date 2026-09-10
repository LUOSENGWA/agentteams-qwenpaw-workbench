import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig, type Plugin } from "vite";

/**
 * v0.4.87 构建守卫：dist 不得含任何 ES module 导入（裸说明符或相对路径）。
 *
 * 原因：宿主 usePluginLoader 把 dist/index.js 包成同域 Blob URL 后 dynamic
 * import 执行——blob 模块没有 base URL，浏览器解析不了任何 import 说明符
 * （无 import map）。出现裸 `import ... from "react"` 时症状是运行时
 * TypeError "Failed to resolve module specifier 'react'" → "0/1 plugin(s)
 * loaded" → 侧边栏/App 全消失（v0.4.85 事故：单个文件的 value import 把
 * react externalize 污染整个 bundle，真机才炸）。
 *
 * 正确模式：源码一律 `import type * as ReactNS from "react"`（类型，编译
 * 擦除）+ 运行时 `window.QwenPaw.host.React`（宿主实例，hooks 同实例）。
 * 单文件 lib 构建，产物正常形态 = 零 import（v0.4.84 及以前一直如此）。
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
      // 只认语句位置 → 字符串字面量如 r.set("from", n) 不误报（v0.4.84 产物验证过）。
      // 再版 5 重写：旧 value 正则 [^;{}]*? 跨不了命名导入的花括号，minify 后
      // `import{useMemo}from"react"` 直接漏网（re4 把宿主炸掉的正是这条）。
      // 改为逐语法形态精确匹配（minify/带空格双形态全覆盖），14 用例负测通过：
      //   副作用 import"…" | 命名 import{…}from"…" | 命名空间 import*as R from"…"
      //   | 默认+命名 import R,{…}from"…" | 默认 importxfrom"…" | 动态 import("…")
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
 * 只压标识符，注释与换行全保留）→「再版 N」等开发注释随 dist/index.js
 * 分发给每个用户，公开仓库不可接受。esbuild transform(minify) 剥离全部
 * 注释 + 单行化，~3MB → ~1MB。
 * 注册顺序：在 noModuleImportsGuard 之前（post 插件按注册序执行）→
 * 守卫检查的是最终压缩产物（其正则本就覆盖 minify 无空格形态）。
 *
 * 2026-08-30 开源礼仪修复（用户「文档搞好」轮）：legalComments:"none"
 * 会把上游 license 头连同开发注释一起剥掉 → 分发的 bundle 无任何第三方
 * 版权头，违反 MIT/ISC「保留版权与许可声明」条款。修复两件：
 *   ① esbuild legalComments 改 "eof"——three.js 源码带 @license 头，
 *      rollup 已收集，压后保留在 bundle 尾部；
 *   ② transform 后 prepend 统一第三方版权 banner——3d-force-graph /
 *      three-spritetext / fflate 的发行 mjs 头部无 license 注释（构建
 *      时剥离，许可只在各自包内 LICENSE 文件），仅靠 ① 会漏，必须
 *      显式注入。许可全文见 THIRD-PARTY-NOTICES.md（随包分发）。
 */
const THIRD_PARTY_BANNER = `/*!
 * Bundled third-party components (source inlined into this file):
 *   three.js 0.185.1        - Copyright (c) 2010-2026 three.js authors   - MIT
 *   3d-force-graph 1.80.0   - Copyright (c) 2017 Vasco Asturiano         - MIT
 *   three-spritetext 1.10.0 - Copyright (c) 2018 Vasco Asturiano         - MIT
 *   fflate 0.8.3            - Copyright (c) 2026 Arjun Barrett           - MIT
 *   lucide icon path data   - Copyright (c) lucide contributors          - ISC
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
 * beta.11 渲染审计用：/gw-proxy/:path → 内置 fixture（活体响应形状，
 * 含 Higress {code,data} 信封与 Manager 模型值 qwen3.6-plus）。
 * 仅 dev server 生效，不进生产 bundle。
 * v2（11.13）：fixture 键对齐 api.ts 实际请求路径（含 /agentteams-proxy/ 前缀）；
 * 上一版写入曾被外部进程还原（mtime 回退），重加时以本段为准。
 */
const GW_FIXTURES: Record<string, unknown> = {
  "/agentteams-proxy/admin": {
    workers: [
      { name: "sysdev-lead", model: "qwen3.6-27b-fp8", runtime: "qwenpaw", phase: "Running" },
      { name: "sysdev-worker", model: "qwen3.6-27b-fp8", runtime: "qwenpaw", phase: "Running" },
    ],
    teams: [
      { name: "sysdev-team", phase: "Running", leaderName: "sysdev-lead", readyWorkers: 1, totalWorkers: 2, workerNames: ["sysdev-lead", "sysdev-worker"] },
    ],
    humans: [
      { name: "admin", displayName: "管理员", permissionLevel: 1, accessibleTeams: ["sysdev-team", "biz-team"], matrixUserID: "@admin:matrix.local" },
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
        const key = "/" + m[1].split("?")[0];
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

export default defineConfig({
  plugins: [react({ jsxRuntime: "classic" }), fullMinifyGuard(), noModuleImportsGuard(), gwProxyMiddleware()],
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
    },
  },
});
