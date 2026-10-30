// CrdManage 拆分（QC-196 方案 §5.2）· 员工入职卡（Human CRD 创建表单）——
// 原主组件 JSX R4a 逐字搬移；props = 原闭包变量名（零改写）。

import type * as ReactNS from "react";

import type { HumanForm, TrFn } from "./types";
import LevelHelp from "./LevelHelp";

const host = window.QwenPaw.host;
const React: typeof ReactNS = host.React;
const antd = host.antd;

interface CrdHumanFormProps {
  hForm: HumanForm;
  setHForm: ReactNS.Dispatch<ReactNS.SetStateAction<HumanForm>>;
  hBusy: boolean;
  doCreateHuman: () => void | Promise<void>;
  teamNames: string[];
  workerNames: string[];
  tr: TrFn;
}

export default function CrdHumanForm({
  hForm,
  setHForm,
  hBusy,
  doCreateHuman,
  teamNames,
  workerNames,
  tr,
}: CrdHumanFormProps) {
  return (
      <antd.Card
        size="small"
        title={tr("员工入职（Human CRD）")}
        styles={{ body: { padding: 10 } }}
      >
        <div style={{ display: "grid", gap: 8 }}>
          <antd.Input
            size="small"
            placeholder={tr("账号名（Matrix localpart，如 alice）")}
            value={hForm.name}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setHForm({ ...hForm, name: e.target.value })
            }
          />
          <antd.Input
            size="small"
            placeholder={tr("显示名（如 张三）")}
            value={hForm.displayName}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setHForm({ ...hForm, displayName: e.target.value })
            }
          />
          <antd.Input
            size="small"
            placeholder={tr("邮箱（可选）")}
            value={hForm.email}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) =>
              setHForm({ ...hForm, email: e.target.value })
            }
          />
          {/* 15.36 D：label 精简为 L1/L2/L3 短档名，完整说明进 LevelHelp ? tooltip */}
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <antd.Select
              size="small"
              style={{ flex: 1, minWidth: 0 }}
              value={hForm.permissionLevel}
              onChange={(v: number) =>
                setHForm({ ...hForm, permissionLevel: v })
              }
              options={[
                { value: 1, label: tr("L1 · 管理员") },
                { value: 2, label: tr("L2 · 团队成员") },
                { value: 3, label: tr("L3 · Worker") },
              ]}
            />
            <LevelHelp level={hForm.permissionLevel} tr={tr} />
          </div>
          <antd.Select
            size="small"
            mode="multiple"
            allowClear
            style={{ width: "100%" }}
            placeholder={tr("可访问团队（可选）")}
            value={hForm.accessibleTeams}
            onChange={(v: string[]) =>
              setHForm({ ...hForm, accessibleTeams: v })
            }
            options={teamNames.map((n) => ({ value: n, label: n }))}
          />
          <antd.Select
            size="small"
            mode="multiple"
            allowClear
            style={{ width: "100%" }}
            placeholder={tr("可访问 Worker（可选）")}
            value={hForm.accessibleWorkers}
            onChange={(v: string[]) =>
              setHForm({ ...hForm, accessibleWorkers: v })
            }
            options={workerNames.map((n) => ({ value: n, label: n }))}
          />
          <antd.Input
            size="small"
            placeholder={tr("备注（可选）")}
            value={hForm.note}
            onChange={(e: ReactNS.ChangeEvent<HTMLInputElement>) => setHForm({ ...hForm, note: e.target.value })}
          />
          <antd.Button
            size="small"
            type="primary"
            loading={hBusy}
            onClick={() => void doCreateHuman()}
          >
            {tr("确认入职")}
          </antd.Button>
        </div>
      </antd.Card>
  );
}
