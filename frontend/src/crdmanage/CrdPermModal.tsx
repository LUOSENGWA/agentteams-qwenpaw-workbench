// CrdManage 拆分（QC-196 方案 §5.2）· 权限管理弹窗（Human CRD spec——
// 上游无 UpdateHuman API，生成「内嵌 apiserver merge-patch」命令）——
// 原主组件 JSX R8 逐字搬移；props = 原闭包变量名（零改写）。

import type * as ReactNS from "react";

import type { HumanInfo } from "../api";
import type { ThemeColors } from "../theme";
import type { PermForm, TrFn } from "./types";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;


interface CrdPermModalProps {
  permHuman: HumanInfo | null;
  permForm: PermForm;
  permCmd: string;
  setPermHuman: ReactNS.Dispatch<ReactNS.SetStateAction<HumanInfo | null>>;
  setPermForm: ReactNS.Dispatch<ReactNS.SetStateAction<PermForm>>;
  generatePermCmd: () => void;
  copyPermCmd: () => void;
  teamNames: string[];
  workerNames: string[];
  tr: TrFn;
  t: ThemeColors;
}

export default function CrdPermModal({
permHuman,
permForm,
permCmd,
setPermHuman,
setPermForm,
generatePermCmd,
copyPermCmd,
teamNames,
workerNames,
tr,
t,
}: CrdPermModalProps) {
  return permHuman ? (
    <antd.Modal
      open
      title={`${tr("权限管理")} · ${permHuman.name}`}
      onCancel={() => setPermHuman(null)}
      footer={
        <antd.Space>
          <antd.Button onClick={() => setPermHuman(null)}>
            {tr("关闭")}
          </antd.Button>
          <antd.Button
            type="primary"
            onClick={() => generatePermCmd()}
          >
            {tr("生成命令")}
          </antd.Button>
        </antd.Space>
      }
    >
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ fontSize: 11, color: t.textSecondary }}>
          {tr(
            "上游 Controller 无 UpdateHuman API（dashboard 的 updateHuman 是死代码）——这里生成「内嵌 apiserver merge-patch」命令，复制到运行 Controller 的宿主机执行。执行完回本页点刷新即可核对生效。上游 Human PUT 端点合并后此处自动升级为一键 PUT。",
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: 12, width: 72 }}>{tr("级别")}</span>
          <antd.Select
            size="small"
            style={{ flex: 1 }}
            value={permForm.permissionLevel}
            onChange={(v: number) =>
              setPermForm({ ...permForm, permissionLevel: v })
            }
            options={[
              {
                value: 2,
                label: tr("2 = 团队成员（Matrix 登录 → L2，可看本团队）"),
              },
              {
                value: 1,
                label: tr(
                  "1 = 管理员（L1；Matrix 登录拿不到 L1，需用管理员 token）",
                ),
              },
              { value: 3, label: tr("3 = Worker") },
            ]}
          />
        </div>
        <div>
          <div style={{ fontSize: 12, marginBottom: 4 }}>
            {tr("可访问团队（决定此人被拉入哪些团队房间）")}
          </div>
          <antd.Select
            size="small"
            mode="multiple"
            allowClear
            style={{ width: "100%" }}
            placeholder={tr("不选任何团队 = 清空列表")}
            value={permForm.accessibleTeams}
            onChange={(v: string[]) =>
              setPermForm({ ...permForm, accessibleTeams: v })
            }
            options={teamNames.map((n) => ({ value: n, label: n }))}
          />
        </div>
        <div>
          <div style={{ fontSize: 12, marginBottom: 4 }}>
            {tr("可访问 Worker（可选）")}
          </div>
          <antd.Select
            size="small"
            mode="multiple"
            allowClear
            style={{ width: "100%" }}
            placeholder={tr("不选任何 Worker = 清空列表")}
            value={permForm.accessibleWorkers}
            onChange={(v: string[]) =>
              setPermForm({ ...permForm, accessibleWorkers: v })
            }
            options={workerNames.map((n) => ({ value: n, label: n }))}
          />
        </div>
        {permCmd ? (
          <>
            <div style={{ fontSize: 11, color: t.textSecondary }}>
              {tr("在运行 Controller 的宿主机执行；空列表 = 清空。merge-patch 不改 status——初始密码不变。")}
            </div>
            <antd.Input.TextArea
              rows={7}
              readOnly
              value={permCmd}
              style={{ fontFamily: "monospace", fontSize: 11 }}
            />
            <antd.Button size="small" onClick={copyPermCmd}>
              {tr("复制命令")}
            </antd.Button>
          </>
        ) : null}
      </div>
    </antd.Modal>
  ) : null;
}
