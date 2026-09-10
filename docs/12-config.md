# 配置参考

配置页三组输入：**Matrix 地址**（必填）+ **认证模式**（必选其一）+ **Controller 地址**（可选）。保存后持久化在本机（浏览器 + 插件后端），重启/升级不丢。

## Matrix 地址（必填至少一个）

- 内网 + 外网两个入口（`http://内网IP:6867` / `https://域名:6867`），可只填一个
- 内外网是同一服务器的两条访问路径，**无需手动切换**：插件自动定期重测全部地址（测延迟，失败重试一次），自动切到最快可达的一条，内/外网切换自动识别
- 页面上的「当前」徽章 = 此刻生效的地址

## 认证模式

三档：**L2 Matrix 登录**（默认）/ **L1 管理员**（两种凭据二选一，beta.12 起）。

| | Matrix 登录（L2，默认） | L1 管理员 |
|---|---|---|
| 输入 | 自己的 **Matrix 账号 + 密码**（入职时交付） | 两种凭据二选一（见下） |
| 持久性 | 登录会话（切账号=数据源切换，本地缓存同步清空重取） | 验证通过后持久化，**永久记住** |
| 能力 | 本账号可访问的团队 + 项目操作（启动/暂停/产物）+ 聊天/审批/通知/知识库 | L2 全部 + CRD 管理（入职/建队/改配/删除）+ 全量 Worker/Team 状态 + 集群负载 |

登录后显示「当前身份」（你的 Matrix mxid）。

### L1 管理员：两种凭据二选一（beta.12 起）

| | ① Controller 管理员 token | ② admin 账号+密码 |
|---|---|---|
| 输入 | **粘贴 token 内容**（UI 提供获取命令，一键复制粘贴；部署期已注入 env `AGENTTEAMS_CONTROLLER_TOKEN` 时留空即可） | admin 账号 + admin 密码（+Higress 地址，必填） |
| 解锁能力 | **Controller 管理 API 全量**：CRD 管理、全量 Worker/Team 状态视图、集群负载、跨团队项目/产物 | **Higress 面**：持有 Higress Console 会话 → 模型下拉的 Higress alias 候选（AI routes + providers） |
| 验证 | 「验证」按钮（GET /api/v1/teams，无尾斜杠——Gin 对 /teams/ 返 404）通过才持久化 | 「验证」按钮（POST /session/login）通过才持久化；密码留空=保持已存值，不回填明文 |
| 前置 | 无接口可获取（上游安全设计），token 由部署管理员线下提供；**token 存 tmpfs，controller 容器每次重启签发新 token**（app.go 注释实锤「free token rotation on every container start」）——粘贴值属快照，controller 重启/轮换后需按「token 获取命令」节重新获取再粘贴 | Higress 地址=**必填**（beta.12 定案：Console 与 Controller 同容器不同端口，但宿主端口是安装时用户自选 `AGENTTEAMS_PORT_CONSOLE`，默认 18001、人人不同 → 8001/6868 盲探已移除，留空=可操作错误） |

> **端口全景（8/14 实测）**：宿主 6866=Controller API（容器 8090）/ **6868=Higress Console（容器 8001）** / 6867=Higress 数据面（容器 8080）/ 6869=Element+console（容器 8088）。插件 Controller 地址填 `http://<内网IP>:6866`，Higress 地址填 `http://<内网IP>:6868`。**这套端口映射是部署时自选的（安装脚本 prompt，默认 18001）——换部署就是别的端口，插件不做任何端口猜测（beta.12 起）。**

> **两种凭据不互相替代**：② 换不来 Controller 管理 API 凭据（controller 无 token 签发端点）——密码模式验证后 CRD 管理等 L1 能力仍锁着，只是模型下拉多了网关 alias。UI 明示「密码模式不替代 token」。

### token 获取命令与 env 注入（beta.12 定案：文件路径路已删，留命令）

token 无接口可获取（上游安全设计），由部署管理员线下提供。供给连接器的两条路（UI 设置页已内置获取命令提示，一键复制；解析优先级连接器侧每次请求现算）：

1. **粘贴**（docker 部署，`tokenSource=config`）——在 **Controller 宿主机**执行：

   ```
   docker exec agentteams-controller cat /var/run/agentteams/cli-token
   ```

   复制输出粘贴到设置页「粘贴 token 内容」。粘贴值属快照——controller 容器重启/轮换（tmpfs 重新签发）后需重新执行命令再粘贴。
2. **env 注入**（非 docker / 部署期一次注入，`tokenSource=env`）——给 QwenPaw 宿主进程设环境变量 `AGENTTEAMS_CONTROLLER_TOKEN`，粘贴框留空即可。

行为规则：

- 粘贴的 token 混入不可见字符/全角字符 → 明确报「token 含非 ASCII 字符（定位到字符）」，不裸抛 UnicodeEncodeError
- env 值**不落盘**（config 保持空）；粘贴值存插件后端本机配置（仅本机，见上）——token 轮换（controller 重签）后粘贴值需按获取命令重新获取再粘贴
- **token 值永不离开 QwenPaw 进程**：浏览器/前端只看到 `controllerTokenSource: "config"|"env"|"invalid"|""` 来源标记（beta.12 起 `file`/`file_unreadable` 不复存在）

> **安全定案（为什么不用密码换 token）**：Controller 无任何 token 签发端点（上游安全设计，非缺陷）——浏览器侧密码→token 兑换在架构上不存在；能做的安全等价物只有「部署期注入」（dashboard F1g 定案 B 同款）。密码仍只解锁网关面（Higress Console），token（无论 config 还是 env）解锁 Controller 管理 API，两者并存。

> **level 2 注意**：Controller 的 Matrix 认证只接受**权限等级 2 的 Human 账号**——level 1 的 admin 账号会 401。L2 模式 401 时：改用 L1 token 模式，或让部署管理员把该 Human 改为 level 2（自检页「权限自检」可见当前账号等级）。

## Controller 地址（实际部署必填）

**L1 与几乎所有管理能力都依赖它**：L1 token 验证、CRD 管理（建队/建 Worker/改配/删）、模型网关地址推导、全量团队视图（跨团队项目/产物总览、集群负载）。不填只有 L2 房间侧功能（聊天/审批/附件扫描）可用——实际部署两个地址都填（9/10 装验确认）。

- 可填多个地址（主备 / 内外网多入口）
- 保存时**逐个测延迟**（失败重试一次），识别外网/内网，**自动切到最快**
- 后台**自适应重测**：稳定时低频；单地址不探测（没得比）
- 测的是「未保存的地址」——保存后才按延迟切换生效
- 不填：聊天/审批/附件扫描等房间侧功能照常，跨团队总览不可用

## L1 / L2 权限矩阵（完整）

| 能力 | L2 | L1 |
|------|:---:|:---:|
| 团队/Worker 列表（可访问范围） | ✅ | ✅（全量） |
| 聊天 / 审批 / 通知 / 知识库 | ✅ | ✅ |
| 项目操作（启动/暂停/恢复） | ✅ 可访问项目 | ✅ |
| 项目产物（含不在其房间内的项目） | ❌ | ✅ |
| CRD 管理（建队/入职/改配/删除） | ❌ | ✅ |
| Worker 模型内联编辑 | 限本团队 | ✅ |
| 频道配置写 | 限本团队 | ✅ |
| 技能矩阵 / MCP 矩阵写 | 限本团队 | ✅ |
| 集群负载（SGLang/GPU） | ❌ | ✅ |
| 模型下拉网关 alias（网关面） | ❌ | ✅（需 ② 密码模式验证） |

## token 安全

- 只在**本机**存储（浏览器 localStorage + 插件后端本机配置）——浏览器零凭据原则：页面 JS 永远不直接持有 Matrix/Controller 凭据直连外部，一切经宿主进程内代理
- token 无接口可获取（上游安全设计），由部署管理员线下提供；两条供给路：UI 获取命令 + 粘贴（存插件后端本机配置），或宿主 env `AGENTTEAMS_CONTROLLER_TOKEN`（见「token 获取命令」节）。token **值永不进浏览器**——前端只可见来源标记（`tokenSource=config`/`env`）
- admin 密码 / Console 会话同样只存本机；导出配置一律脱敏为 `***`（导入不覆盖已存凭据）
