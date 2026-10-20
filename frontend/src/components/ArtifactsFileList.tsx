/** Artifacts 子模块——自 Artifacts.tsx 纯搬移拆出
 * （行为零变化）。 */
import { ActionBtn } from "./ActionBtn";
import type * as ReactNS from "react";
import {
  downloadViaHost,
  resolveFileTarget,
  resolvePluginUrl,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { formatSize } from "../util";
import { WbTooltip } from "./WbTooltip";
import WbTableFade from "./WbTableFade";
import {
  KIND_META,
  artifactDownloadUrl,
  formatTime,
  truncateFilename,
  type FileEntry,
  type ArtifactKind,
} from "./ArtifactsShared";

const host = window.QwenPaw.host;
const React = host.React;
const antd = host.antd;
const icons = (host.antdIcons || {}) as Record<string, ReactNS.ComponentType>;
const EmptyIcon = (() => null) as unknown as ReactNS.FC<Record<string, unknown>>;
const pick = (name: string): ReactNS.FC<Record<string, unknown>> =>
  (icons[name] as ReactNS.FC<Record<string, unknown>>) || EmptyIcon;
const DownloadIcon = pick("DownloadOutlined");
const EyeIcon = pick("EyeOutlined");

export function FileListBlock({
  visibleFiles,
  selectedKey,
  narrow,
  onOpen,
}: {
  visibleFiles: FileEntry[];
  selectedKey: string;
  narrow: boolean;
  onOpen: (f: FileEntry) => void;
}) {
  const t = useThemeColors();
  const tr = useT();
  return (
    visibleFiles.length === 0 ? (
      <antd.Empty
        description={
          selectedKey === "projects"
            ? tr("暂无项目产物——已登记项目的任务交付物会显示在这里（未登记项目只走下方房间附件扫描）")
            : tr("该分类下还没有文件")
        }
      />
    ) : (
      <WbTableFade>
        <antd.Table
          rowKey="key"
          size="small"
          pagination={false}
          // 竖屏：容器固定屏宽、不横滚（此前 scroll.x:max-content 横滚=每列被横拖）——
          // 窄屏隐藏次要列(来源/发送者/时间)只留 文件/类型/大小/操作 4 列 +
          // tableLayout:fixed 铺满屏宽 + 文件名自动换行。宽屏保持原样(横滚)。
          scroll={narrow ? undefined : { x: "max-content" }}
          tableLayout={narrow ? "fixed" : undefined}
          dataSource={visibleFiles}
          columns={[
            {
              title: tr("文件"),
              dataIndex: "name",
              render: (_: unknown, f: FileEntry) => (
                <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  {/* 窄屏：类型移到图标下方（省横向给文件名换行）；宽屏仅图标。 */}
                  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, flexShrink: 0 }}>
                    {KIND_META[f.kind].icon}
                    {narrow ? (
                      <span style={{ fontSize: 10, color: t.textSecondary, lineHeight: 1 }}>
                        {KIND_META[f.kind].label}
                      </span>
                    ) : null}
                  </div>
                  <WbTooltip title={f.name} tap={false} >
                    <a
                      // 窄屏自动换行（不横滚/不截断），宽屏保持单行 ellipsis。
                      style={{ overflow: narrow ? "visible" : "hidden", textOverflow: narrow ? "clip" : "ellipsis", whiteSpace: narrow ? "normal" : "nowrap", wordBreak: narrow ? "break-word" : undefined, maxWidth: narrow ? "none" : 300 }}
                      onClick={(e) => {
                        e.preventDefault();
                        void onOpen(f);
                      }}
                    >
                      {truncateFilename(f.name)}
                    </a>
                  </WbTooltip>
                </div>
              ),
            },
            // 类型列：窄屏隐藏（已移入文件列图标下方）；宽屏保留。
            ...(narrow
              ? []
              : [
                  {
                    title: tr("类型"),
                    dataIndex: "kind",
                    width: 80,
                    render: (k: ArtifactKind) => (
                      <antd.Tag style={{ margin: 0 }} color={k === "image" ? "orange" : k === "document" ? "blue" : k === "data" ? "green" : k === "code" ? "purple" : undefined}>
                        {KIND_META[k].label}
                      </antd.Tag>
                    ),
                  },
                ]),
            // 窄屏隐藏次要列（省宽度给文件名换行）
            ...(narrow
              ? []
              : [
                  {
                    title: tr("来源"),
                    dataIndex: "source",
                    width: 170,
                    ellipsis: true,
                  },
                ]),
            {
              title: tr("大小"),
              dataIndex: "size",
              width: narrow ? 62 : 90,
              render: (v: number | null) => formatSize(v) || "—",
            },
            // 发送者/时间：窄屏隐藏次要列
            ...(narrow
              ? []
              : [
                  {
                    title: tr("发送者"),
                    dataIndex: "sender",
                    width: 110,
                    render: (v: string) =>
                      (v.split(":")[0] || v || "").replace(/^@/, ""),
                  },
                  {
                    title: tr("时间"),
                    dataIndex: "time",
                    width: 120,
                    render: (v: number) => (v ? formatTime(v) : "—"),
                  },
                ]),
            {
              title: tr("操作"),
              key: "actions",
              width: narrow ? 108 : 176,
              render: (_: unknown, f: FileEntry) => {
                // mxc/正源 → apiPath（host.fetch blob 下载，带鉴权）；
                // http 直链 → 原样导航。裸插件路径落 SPA 兜底（index.html 壳），
                // 解析后 /api 路径裸导航带不了鉴权头会 401——两条都不通。
                const target = f.mxcUrl
                  ? resolveFileTarget(f.mxcUrl)
                  : f.projectId && f.taskId && f.artifactPath
                    ? (() => {
                        const p = artifactDownloadUrl(
                          f.projectId,
                          f.taskId,
                          f.artifactPath,
                        );
                        return { url: resolvePluginUrl(p), apiPath: p };
                      })()
                    : { url: "" };
                const previewable =
                  !!target.url &&
                  (f.kind === "image" ||
                    f.kind === "document" ||
                    f.kind === "data" ||
                    f.kind === "code");
                // 行内动作按钮统一 ActionBtn（图标+文字+可见规格）。
                // 窄屏：查看/下载纵向排列（省横向给文件名换行）。
                return (
                  <div style={{ display: "flex", flexDirection: narrow ? "column" : "row", gap: 4, alignItems: narrow ? "stretch" : "center" }}>
                    {previewable ? (
                      <ActionBtn
                        icon={<EyeIcon />}
                        label={tr("查看")}
                        onClick={() => void onOpen(f)}
                      />
                    ) : null}
                    <ActionBtn
                      icon={<DownloadIcon />}
                      label={tr("下载")}
                      href={target.apiPath ? undefined : target.url || undefined}
                      download={f.name}
                      disabled={!target.url}
                      onClick={
                        target.apiPath
                          ? (e) => {
                              e.preventDefault();
                              void (async () => {
                                const ok = await downloadViaHost(
                                  target.apiPath as string,
                                  f.name,
                                );
                                if (!ok)
                                  antd.message.error("下载失败，请稍后重试");
                              })();
                            }
                          : undefined
                      }
                    />
                  </div>
                );
              },
            },
          ]}
        />
      </WbTableFade>
    )  );
}
