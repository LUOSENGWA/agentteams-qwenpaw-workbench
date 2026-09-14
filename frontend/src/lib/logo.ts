/**
 * v0.5.0-beta.12.2（用户反馈：去掉占位 emoji，直接用 AgentTeams logo，
 * 与 dashboard 同一文件）——logo 正源 = dashboard public/agentteams-logo.svg
 * （128×128，内嵌 base64 PNG，与 dashboard 侧边栏/favicon 同一文件）。
 *
 * `?inline` 后缀强制 Vite 把 SVG 内联为 data URI 字符串常量——插件 dist 必须
 * 单文件（blob URL 执行，无 base URL，外部资源文件加载不了，见 vite.config.ts
 * no-module-imports-guard 头注）。
 */
import logoUrl from "../assets/agentteams-logo.svg?inline";

export default logoUrl;
