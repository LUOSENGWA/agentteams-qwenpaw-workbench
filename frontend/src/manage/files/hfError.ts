/**
 * hfError.ts — 文件区统一错误 → i18n 文案（原 FilesSection.hfErrorText，
 * 16.137 迁出：QuotaEditDialog 被文件区与人员管理共用，若从 FilesSection
 * 取文案会形成 FilesSection → FileOpsDialogs → QuotaEditDialog → FilesSection
 * 回环；FilesSection 保留同名 re-export，外部调用面不变）。
 *
 * 语义（逐字保留原实现）：按 status/code 分支；413 区分 size vs quota；
 * 403 =「无权限」（前端不预判角色，服务端终裁）。
 */
import { HumanFilesError } from "../../api";
import { fmtBytes } from "./format";

export type Tr = (s: string, v?: Record<string, string | number>) => string;

/** 统一错误 → i18n 文案（按 status/code 分支；413 区分 size vs quota）。 */
export function hfErrorText(e: unknown, tr: Tr): string {
  if (e instanceof HumanFilesError) {
    // #1519 前端拦截：file.size > presign maxBytes（status=0，message=上限字节）。
    if (e.code === "max_bytes") {
      return tr("文件超过预签名上传上限（最大 {a}）", { a: fmtBytes(Number(e.message) || 0) });
    }
    switch (e.status) {
      case 400:
        return tr("路径非法");
      case 403:
        // #1669 角色无关：权限由服务端裁决，前端不预判角色（原「仅管理员」
        // 为角色门文案，删除流需要的是通用错误语义）。
        return tr("无权限");
      case 404:
        // #1519 commit：对象已被服务端删 → 「需重新上传」。
        if (e.code === "object_missing") return tr("上传失败（对象不存在）——请重新上传");
        return tr("无权限或不存在");
      case 409:
        // #1519 commit：checksum 不匹配（对象已被服务端删）→ 「需重新上传」；
        // 其余 409 = restore 目标路径已存在（旧语义不变）。
        if (e.code === "checksum_mismatch")
          return tr("上传校验失败（checksum 不匹配）——请重新上传");
        return tr("目标路径已存在");
      case 412:
        return tr("内容冲突（etag 不匹配）——刷新后重试");
      case 413:
        if (e.code === "size_exceeded") return tr("大小超限（单文件 ≤ 64MiB）");
        if (e.code === "quota_exceeded") return tr("配额已满");
        return tr("上传失败（大小超限或配额已满）");
      default:
        return e.message || `HTTP ${e.status}`;
    }
  }
  return e instanceof Error ? e.message : String(e);
}
