/**
 * VersionTablePicker.tsx — qwenpaw 版本选择表格（15.27：
 * 「选择版本那里应该有个表格」——自由文本输入 → 可点选版本表）。
 *
 * 数据源 = /agentteams-proxy/upgrade/versions（服务端 PyPI 10min 缓存，
 * 与 /upgrade/latest 同一次网络往返；断网 stale 回退旧缓存）。
 * 形态 = 单选表格（版本/发布时间/大小/标记：最新·预发布·撤回）+ 底部
 * 「自定义版本」高级输入（任意 tag 兜底，如特定 build tag）。
 * 受控：value/onChange——value 恒为纯版本字符串（表格点选与自定义
 * 输入同一 onChange，父组件语义不变）。
 *
 * 纪律：React/antd 取宿主（window.QwenPaw.host）；i18n 全量注册 en 键。
 */
import type * as ReactNS from "react";

import {
  fetchUpgradeVersions,
  httpErrorDetail,
  type UpgradeVersionRow,
} from "../api";
import { useT } from "../i18n";
import { useThemeColors } from "../theme";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

function fmtSize(n: number): string {
  if (!n || n <= 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export default function VersionTablePicker({
  value,
  onChange,
  compact,
}: {
  value: string;
  onChange: (v: string) => void;
  /** 紧凑（行内小字号）——RuntimeUpgradePanel 两模式共用。 */
  compact?: boolean;
}) {
  const t = useThemeColors();
  const tr = useT();
  const [rows, setRows] = React.useState<UpgradeVersionRow[] | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState("");
  const [latest, setLatest] = React.useState("");
  const [open, setOpen] = React.useState(true);
  const [custom, setCustom] = React.useState("");

  const load = React.useCallback(() => {
    setLoading(true);
    setError("");
    fetchUpgradeVersions()
      .then((d) => {
        setRows(d.versions);
        setLatest(d.latest || "");
      })
      .catch((e) => setError(httpErrorDetail(e) || tr("版本列表加载失败")))
      .finally(() => setLoading(false));
  }, [tr]);

  React.useEffect(() => {
    load();
  }, [load]);

  const isKnown = (v: string) => rows?.some((r) => r.version === v) ?? false;

  return (
    <div
      style={{
        border: `1px solid ${t.border}`,
        borderRadius: 8,
        background: t.cardBg,
        padding: compact ? 8 : 10,
        display: "grid",
        gap: 6,
        width: compact ? "100%" : "min(560px, 100%)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{tr("目标版本")}</span>
        {value ? (
          <antd.Tag color="blue" style={{ marginInlineEnd: 0, fontFamily: "monospace" }}>
            {isKnown(value) ? value : `${value}（${tr("自定义")}）`}
          </antd.Tag>
        ) : latest ? (
          <antd.Tag style={{ marginInlineEnd: 0 }} color="default">
            {tr("未选择（建议 {v}）", { v: latest })}
          </antd.Tag>
        ) : null}
        <div style={{ flex: 1 }} />
        {error ? (
          <antd.Tag color="warning">{error}</antd.Tag>
        ) : null}
        <antd.Button
          size="small"
          type="text"
          loading={loading}
          onClick={() => (open ? load() : setOpen(true))}
        >
          {open ? tr("刷新") : tr("版本表")}
        </antd.Button>
      </div>

      {open ? (
        <>
          {rows && rows.length > 0 ? (
            <antd.Table
              size="small"
              rowKey="version"
              dataSource={rows}
              pagination={false}
              scroll={{ y: 236 }}
              rowSelection={{
                type: "radio",
                selectedRowKeys: value ? [value] : [],
                onChange: (keys: Array<string | number>) => {
                  if (keys[0]) onChange(String(keys[0]));
                },
              }}
              onRow={(r: UpgradeVersionRow) => ({
                onClick: () => onChange(r.version),
                style: { cursor: "pointer" },
              })}
              rowClassName={(r: UpgradeVersionRow) =>
                r.version === value ? "ant-table-row-selected" : ""
              }
              columns={[
                {
                  title: tr("版本"),
                  dataIndex: "version",
                  width: 130,
                  render: (v: string, r: UpgradeVersionRow) => (
                    <span style={{ fontFamily: "monospace", fontSize: 12 }}>
                      {v}
                    </span>
                  ),
                },
                {
                  title: tr("发布时间"),
                  dataIndex: "upload_time",
                  width: 104,
                  render: (v: string) => (
                    <span style={{ fontSize: 11, color: t.textSecondary }}>{v || "—"}</span>
                  ),
                },
                {
                  title: tr("大小"),
                  dataIndex: "size",
                  width: 76,
                  render: (v: number) => (
                    <span style={{ fontSize: 11, color: t.textSecondary }}>{fmtSize(v)}</span>
                  ),
                },
                {
                  title: tr("标记"),
                  key: "flags",
                  render: (_: unknown, r: UpgradeVersionRow) => (
                    <span style={{ display: "inline-flex", gap: 4, flexWrap: "wrap" }}>
                      {r.is_latest ? (
                        <antd.Tag color="success" style={{ marginInlineEnd: 0, fontSize: 10 }}>
                          {tr("最新")}
                        </antd.Tag>
                      ) : null}
                      {r.prerelease ? (
                        <antd.Tag color="purple" style={{ marginInlineEnd: 0, fontSize: 10 }}>
                          {tr("预发布")}
                        </antd.Tag>
                      ) : null}
                      {r.yanked ? (
                        <antd.Tag color="error" style={{ marginInlineEnd: 0, fontSize: 10 }}>
                          {tr("已撤回")}
                        </antd.Tag>
                      ) : null}
                    </span>
                  ),
                },
              ]}
            />
          ) : loading ? (
            <antd.Skeleton active title={false} paragraph={{ rows: 3 }} />
          ) : (
            <div style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("暂无版本列表（PyPI 不可达且无缓存）")}
            </div>
          )}
          {/* 自定义版本（高级兜底：任意 tag，如特定 build） */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <span style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("自定义版本（高级）")}
            </span>
            <antd.Input
              size="small"
              style={{ width: 170, fontFamily: "monospace" }}
              placeholder={tr("如 2.3.0（表格未列出的 tag）")}
              value={custom}
              allowClear
              onChange={(e: { target: { value: string } }) =>
                setCustom(String(e.target.value || ""))}
            />
            <antd.Button
              size="small"
              disabled={!custom.trim()}
              onClick={() => {
                onChange(custom.trim());
                setCustom("");
              }}
            >
              {tr("设为目标")}
            </antd.Button>
          </div>
        </>
      ) : null}
    </div>
  );
}
