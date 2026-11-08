// 上传 / 新建文件夹的目标目录（纯函数，可 vitest 直测）。
//
// B1 实测 bug：树视图选中目录后点「新建文件夹」仍建在根目录——旧实现只
// 用 dirPath，忽略了树视图的 uploadDirRef。统一口径 = 树选中目录优先，
// 空 = 当前目录；**新建与上传共用同一解析**，避免两处漂移。
//
// 尾斜杠：树目录 rowPath 对新形态条目带 "/"（"docs/"）。存储路径按段拼，
// 保留会拼出 "docs//a.txt"（API encPath 虽会折叠，但展示/队列文案难看），
// 故在此归一为无尾斜杠。

/** 目标目录（相对存储根；"" = 根目录 / 当前目录本身）。 */
export function resolveTargetDir(
  uploadDir: string | null | undefined,
  dirPath: string,
): string {
  return (uploadDir || dirPath || "").replace(/\/+$/, "");
}

/** 目标目录展示标签：根 = 「我的文件」，其余带尾斜杠（"docs/sub/"）。 */
export function targetDirLabel(target: string, rootLabel: string): string {
  const clean = (target || "").replace(/\/+$/, "");
  return clean === "" ? rootLabel : `${clean}/`;
}
