/**
 * metaEntry.ts — 「备注」入口可见性（R13）。
 *
 * 任务 meta 端点 405/404（老控制器路由未部署）→ 父组件 metaSupported=false，
 * 入口静默隐藏（与 16.113 MetaEditorModal 的 onUnsupported 机制同源）。
 */

/** 备注/metadata 入口渲染条件：端点可用 + 有打开回调，两者缺一即隐藏。 */
export function canEditTaskMeta(
  metaSupported: boolean | undefined,
  hasHandler: boolean,
): boolean {
  return metaSupported !== false && hasHandler;
}
