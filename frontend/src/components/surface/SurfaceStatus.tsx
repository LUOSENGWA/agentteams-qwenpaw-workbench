// 运行时配置面的状态区（纯展示）：缺面降级 / 加载骨架 / 读取失败+重试 / 只读提示 / 横幅。
// 由 WorkerRuntimeConfigSurface 调用；不含取数与保存逻辑。
import type * as ReactNS from "react";

import { useT } from "../../i18n";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

export interface SurfaceBanner {
  type: "success" | "error" | "warning" | "info";
  text: string;
}

export default function SurfaceStatus(props: {
  runtimeUnknown: string;
  loading: boolean;
  loadErr: string;
  noWrite: boolean;
  banner: SurfaceBanner | null;
  onRetry: () => void;
  onBannerClose: () => void;
}): JSX.Element {
  const tr = useT();
  const { runtimeUnknown, loading, loadErr, noWrite, banner, onRetry, onBannerClose } = props;

  if (runtimeUnknown) {
    return (
      <antd.Alert
        type="warning"
        showIcon
        message={tr("该运行时暂无配置面（已注册：{supported}）", { supported: runtimeUnknown })}
      />
    );
  }
  if (loading) return <antd.Skeleton active title={false} paragraph={{ rows: 4 }} />;
  return (
    <>
      {loadErr ? (
        <antd.Alert
          type="error"
          showIcon
          message={tr("读取配置失败")}
          description={
            <span>
              {loadErr}
              <antd.Button type="link" size="small" style={{ padding: 0, marginLeft: 8 }} onClick={onRetry}>
                {tr("重试")}
              </antd.Button>
            </span>
          }
        />
      ) : null}
      {noWrite ? (
        <antd.Alert type="info" showIcon style={{ padding: "4px 10px" }} message={tr("只读：团队 Leader 或策略限制")} />
      ) : null}
      {banner ? (
        <antd.Alert type={banner.type} showIcon closable message={banner.text} onClose={onBannerClose} />
      ) : null}
    </>
  );
}
