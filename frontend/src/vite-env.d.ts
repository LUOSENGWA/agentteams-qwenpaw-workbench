/// <reference types="vite/client" />

/** 构建期注入的插件版本（vite define，来源 package.json）。
 * 顶部版本号显示用它——永远等于当前 dist 的版本（不受后端进程未重启影响）。 */
declare const __PLUGIN_VERSION__: string;
