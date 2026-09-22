/**
 * ArtifactLines.tsx — 任务文件行（spec/结果产物/交付物）的共享渲染。
 *
 * v0.5.0-beta.13.4（9/22 装验反馈：「结果产物查看/下载没有解决」定位）：
 * 数据与后端链路实盘验证完好（controller /tasks/{id}/artifact 200+内容，
 * 插件 catch-all 代理同链 E2E 200），缺口在表面——任务巡检 Drawer 有
 * 查看/下载，但拓扑任务详情行（TopoTaskDetailRow）只有路径文本（原注释
 * 「本行无 runId 上下文」= 没把 ev 传下来）。两处行为必须一致 →
 * 抽共享组件：monospace 路径 + 查看（共享 FilePreview 内联预览
 * md/图片/文本/xlsx）+ 下载（downloadViaHost），Drawer 与拓扑行同用。
 */
import type * as ReactNS from "react";

import {
  downloadViaHost,
  resolvePluginUrl,
} from "../api";
import { useThemeColors } from "../theme";
import { useT } from "../i18n";
import { artifactDownloadUrl } from "./ProjectFiles";
import { FilePreview, type PreviewFile } from "./FilePreview";

// 家规：React/antd 必须取宿主的（window.QwenPaw.host.*）——value import
// react/antd 会让 dist 带裸说明符，宿主 blob-URL loader 无 import map
// 解析不了（beta.12「装了没加载」事故根因）。
const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface ArtifactLineSpec {
  label: string;
  path: string;
}

/** 任务文件行集合：每行 monospace 路径 + 查看（内联预览）+ 下载。
 *  预览 Modal 每个实例一个（多行共用同一预览槽，点谁显谁）。 */
export default function ArtifactLines(props: {
  runId: string;
  taskId: string;
  lines: ArtifactLineSpec[];
  /** 行前缀 label 渲染尺寸（拓扑行紧凑 11 / Drawer 12.5）。 */
  compact?: boolean;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [preview, setPreview] = React.useState<PreviewFile | null>(null);
  const [downloading, setDownloading] = React.useState("");

  const artifactUrl = React.useCallback(
    (path: string) =>
      artifactDownloadUrl(props.runId, props.taskId, path),
    [props.runId, props.taskId],
  );

  const view = React.useCallback(
    (path: string) => {
      const p = artifactUrl(path);
      setPreview({
        name: path.split("/").filter(Boolean).pop() || path,
        url: resolvePluginUrl(p),
        apiPath: p,
        needsFetch: true,
      });
    },
    [artifactUrl],
  );

  const dl = React.useCallback(
    async (path: string) => {
      setDownloading(path);
      const name = path.split("/").filter(Boolean).pop() || path;
      const ok = await downloadViaHost(artifactUrl(path), name);
      setDownloading("");
      if (!ok) antd.message.error(tr("下载失败"));
    },
    [artifactUrl, tr],
  );

  if (props.lines.length === 0) return null;
  const fs = props.compact ? 11 : 11.5;
  return (
    <>
      {props.lines.map((line) => (
        <div
          key={line.path}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            padding: "2px 0",
            flexWrap: "wrap",
          }}
        >
          <span style={{ fontSize: fs, color: t.textSecondary, flexShrink: 0 }}>
            {line.label}
          </span>
          <span
            style={{
              fontFamily: "monospace",
              fontSize: fs,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={line.path}
          >
            {line.path}
          </span>
          <antd.Button size="small" onClick={() => view(line.path)}>
            {tr("查看")}
          </antd.Button>
          <antd.Button
            size="small"
            loading={downloading === line.path}
            onClick={() => void dl(line.path)}
          >
            {tr("下载")}
          </antd.Button>
        </div>
      ))}
      <FilePreview file={preview} onClose={() => setPreview(null)} />
    </>
  );
}
