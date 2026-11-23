# DealerAI：Inventory / Customers / Leads / Users / Conversations

第三个模块按 **Leads（销售线索）** 命名：API 和数据文档均使用这个名称。一个客户可以有多条购车线索，每条线索可以关联一辆库存车。Users（用户/账号管理）按 PRD 的 Settings and users（FR 14）与 API 文档的 `/users` 接口实现。Conversation Center 提供车辆关联的会话、消息记录、未读状态和 AI 助审草稿（PRD FR 07–09 的 assist mode 范围）。

根目录原有 HTML、`css/`、`js/` 保持不变；产品页面与接口统一由 `backend/` 提供，入口为 `/app/`。

## 启动

需要 **Node.js 24.14+**；无第三方运行依赖，无需 `npm install`。

首次启动必须提供 Owner 账号和密码，用于创建初始管理员；密码至少 10 位：

```sh
cd /root/projects/dealer-ai-web
DEALER_ADMIN_EMAIL='owner@your-dealership.com' \
DEALER_ADMIN_PASSWORD='replace-with-a-strong-password' \
node backend/server.mjs
```

- 产品入口：<http://localhost:3000/app/>
- 首次启动只创建 Owner 账号，不生成车辆、客户或线索数据。
- `DEALER_ADMIN_*` 仅在数据库首次初始化时使用，之后启动可省略。

启动前可设置 `PORT`、`DEALER_DB_PATH`、`DEALER_ADMIN_EMAIL`、`DEALER_ADMIN_PASSWORD`、`DEALER_JWT_SECRET`、`APP_ORIGIN`。账号及密码仅在数据库首次初始化时生效；JWT 密钥不设置时每次启动重新生成，旧登录将失效。数据文件路径会打印在启动日志。

服务默认监听 `0.0.0.0`，并通过 `APP_ORIGIN`（默认 `http://localhost:3000`）校验请求的 Host 和 Origin。如果通过其他主机名或端口访问，必须把 `APP_ORIGIN` 设为实际访问的 origin，否则会返回 403。Host/Origin 校验不是身份认证；不要把服务直接暴露到不可信网络，生产环境需要防火墙、HTTPS 和反向代理。

AI 草稿可选配置 `OPENAI_API_KEY` 和 `AI_MODEL`；两者都存在时调用 OpenAI Responses API，否则使用本地确定性草稿。设置 `AI_PROVIDER=local` 可强制使用本地草稿。API key 只在服务端使用，不会返回浏览器。

`DEALER_AI_TEST_MODE=1` 仅用于测试环境：允许 AI 使用车辆的 test-only current mileage，并在 staff notes 中标注 test-only。生产环境不得设置；默认关闭时 test-only 字段不会进入 AI facts，也不会进入草稿。

Linux/WSL 下默认数据库为 `backend/data/dealer.sqlite`。**推荐在 WSL 的项目目录运行 Linux Node**，保持数据库和代码在同一文件系统。Windows Node 从 `\\wsl$` 网络路径启动时，SQLite 文件锁不能可靠工作，因此默认数据库置于 Windows 临时目录下按项目路径区分的 `dealer-ai-web/<项目标识>/dealer.sqlite`；能跨进程重启保留，但可能被临时文件清理。需要长期保留时，将 `DEALER_DB_PATH` 设为本机持久目录，或在 WSL 内运行。切换路径不会自动迁移数据库，迁移前停止服务并复制完整数据库。

## 已实现

| 模块 | 功能 |
| --- | --- |
| 库存 | 新建、查看、编辑、归档（写操作仅 Owner/Manager）；Make 下拉、Transmission 下拉（Automatic / Manual / CVT / eCVT / Other / Unknown）；CARFAX 里程来源/日期、事故/title/服务历史、检查状态和 test-only 字段；草稿；VIN/库存号唯一检查；车型、品牌、状态、价格、关键词筛选；分页；真实统计；JPEG/PNG 照片上传、预览、删除（10 张，每张 10 MB）；价格、里程和年份校验 |
| 客户 | 档案、联系方式、意向车辆、负责人、状态、语言、禁止联系标记；联系方式标准化；同邮箱/电话的重复候选提示（保留独立客户，不自动合并）；备注、置顶备注、操作历史、关联线索；Sales/BDC 仅访问分配范围内的记录 |
| 线索 | 新建、查看、编辑、归档；关联客户及车辆；来源、负责人、优先级、客户留言；阶段管理（`lost` 必填原因，重开必填原因）；外部来源编号去重；搜索筛选分页；阶段变化历史；Sales/BDC 仅访问分配范围内的记录 |
| 用户 | 员工列表、邀请、接受邀请、角色调整、启用/禁用、撤销邀请；最后一个活动 Owner 保护；角色或状态变化立即使旧令牌失效 |
| 会话 | 客户 + 车辆关联的会话；消息时间线；按员工未读/已读；分配、关闭、重开；记录客户具体问题；基于车辆公开事实的 AI 草稿；幂等发送；禁止联系拦截 |
| 通用 | 登录；JWT；按门店隔离；角色限制；成本等字段限制；版本冲突检查；数据库持久化；加载、空列表、错误提示；筛选条件保留在 URL |

用户角色：`owner`、`manager`、`sales`、`bdc`。Owner/Manager 可管理用户；经理不能授予高于自身的角色，也不能修改 Owner。任何角色变更、启用或禁用都会递增账号的授权版本，已签发的 JWT 立即失效；最后一个活动 Owner 不能被降级或禁用。邀请令牌只保存 SHA-256 摘要，7 天过期、一次性使用；邀请对话框会生成 `/app/#accept?token=...` 链接，被邀请人设置姓名和至少 10 位密码后自动登录。

角色数据范围按 PRD 默认矩阵执行：

- **Owner / Manager**：库存、客户、线索、会话全门店读写，可归档，可分配负责人。
- **Sales Rep**：库存只读（不含采购成本、最低价、内部备注）；客户、线索和会话仅限分配给自己的记录；新建时自动分配给自己；不能把记录改派给他人；不能归档；不能管理用户。
- **BDC**：库存只读；客户、线索和会话可访问分配给自己的或未分配的团队队列；可把未分配记录认领给自己，不能改派给他人；不能归档；不能管理用户。
- 列表、详情、备注、操作历史和 `/summary` 统计全部按同一范围在 API 层过滤；前端隐藏按钮只是辅助，不是权限边界。
- 当前未实现库存的“显式授权”模型和独立的团队队列实体：Sales/BDC 的库存写权限默认关闭，BDC 的团队队列按“未分配记录”处理。

以上是文档中的默认范围（PRD 标注为 proposed，需 D05 确认）；本版本按该默认矩阵实现。

线索阶段：`new → working / qualified / lost`，`working → qualified / lost`，`qualified → working / won / lost`。只有经理可把 `lost` 重开到 `working`；`won` 不可直接重开。新建只能从 `new` 开始。

## 会话与 AI 草稿

- 会话关联客户，建议关联车辆；车辆是 AI 回复的事实来源。员工可以在库存车辆详情点 **Start conversation**，或在 Conversations 页面新建会话并记录客户的具体问题。
- `POST /api/v1/conversations/{id}/ai-suggestion` 将**当前车辆公开事实 + 最新客户问题**交给模型，返回客户可读草稿和仅员工可见的核查提示。草稿不会自动发送，员工必须审阅、编辑后再发送。
- 车辆公开事实仅包含年份、品牌、车型、配置、里程、标价、可售状态、车身/颜色/变速箱/驱动/燃料/车况、位置和描述。**采购成本、最低价、内部备注不会进入 AI 输入，也不会进入草稿。**
- 如果车辆描述中包含导入的 CARFAX 报告摘要，AI 可以引用为 “the CARFAX report summary on file says …”，但不得声称独立验证或 accident-free；没有摘要时仍回答历史未验证。
- 配置 `OPENAI_API_KEY` 和 `AI_MODEL` 时调用 OpenAI；未配置或提供方失败时使用本地确定性草稿，并在 UI 中明确标注。AI 不可承诺库存、保修、金融审批或议价结果；缺失事实会写入核查提示。
- 客户标记 `do not contact` 时，AI 草稿和出站消息都会被拒绝。出站消息要求 `Idempotency-Key`：相同 key + 相同内容返回原消息，不同内容返回 409。
- 消息目前记录在 CRM 本地，`delivery_status` 为 `recorded`（出站）或 `received`（入站），不投递到短信/邮件；`channel` 只是上下文标签。
- 未实现：自动回复、翻译、真实短信/邮件/WhatsApp 投递、公开网站询价入口。会话的暂停（snooze）也暂未启用。

## 库存表单与 CARFAX 历史

- Make 使用下拉列表；Transmission 固定为 `Automatic / Manual / CVT / eCVT / Other / Unknown`，CVT 与 eCVT 分开。
- 车辆保存结构化历史：`mileage_source`、`mileage_reported_at`、`mileage_conflict`、`title_status`、`accident_count`、`accident_summary`、`service_record_count`、`last_service_date`、`history_summary`、`history_report_date`、`history_report_url`、`hybrid_battery_status`、`smog_status`、`ac_status`、`inspection_notes`、`inspection_conflict`。
- CARFAX 报告的最后里程写入 `mileage`，报告日期写入 `mileage_reported_at`，来源写入 `CARFAX`。它是历史读数，不是实时里程。
- `test_current_mileage` / `test_mileage_note` 是 manager-only 的测试字段；只有 `DEALER_AI_TEST_MODE=1` 时 AI 才会使用，并在 staff notes 中明确标注 test-only。生产环境默认不读取。
- `history_report_url`、`mileage_conflict`、`inspection_conflict` 和 test-only 字段只对 Owner/Manager 返回；Sales/BDC 看不到。

## AI 回复策略

高风险问题由后端 policy 层生成，模型不能自由更改数字或承诺：

- 可用性：使用最新 inventory status；不清楚时回答 “I’ll check availability for you before you make the trip.”
- VIN/里程：VIN + “The last mileage reported on CARFAX was [miles] miles as of [date]” + 主动确认当前读数；缺失/冲突时转人工检查 odometer。
- CARFAX/事故/title：有报告才提供报告；只有报告支持时才说 “no accidents reported”；title 单独说明；未验证的内容转人工。
- Out-the-door：`GET /api/v1/vehicles/{id}/price-estimate?zip=91731[&cash=1]` 返回后端 itemized test estimate：车价 + 10% 税 + $50 title + $200 registration；$10,000 车价 → $11,250。现金折扣 $200，OTD 会用折扣后车价重算。真实报价必须转 sales。
- 自有 registration、金融（<$8,000 / ≥$8,000 两套固定话术）、trade-in、混动电池、smog/AC、warranty、地址/营业时间/试驾、best price/$200 cash offer：都使用固定 policy 话术；没有记录的检查项要求人工确认。
- `OPENAI_API_KEY` + `AI_MODEL` 只用于未命中 policy 的普通问题；policy 命中时返回 `provider: policy`，仍然只是 staff-reviewed draft。

归档保留记录及历史，但从活动列表隐藏。有未关闭线索的车辆/客户不能归档，需先处理线索。已成交车辆不可通过普通编辑重新设为可售。**线索 won 是本模块的手工跟进结论，不会自动把车辆标记 sold，也不会创建销售订单。**

## 接口

采用 `docs/DealerAI_API_Specification.docx` 的 `/api/v1` 路径、UUID、UTC 时间、成功/错误 envelope。`GET` 列表返回 `{data: [...], meta: {request_id, page, page_size, total, total_pages}}`；失败返回 `{error: {code, message, field_errors, request_id}}`。

除登录外，所有接口需要 `Authorization: Bearer <access_token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/auth/login` | `{email, password}`，返回 8 小时 access token |
| GET | `/api/v1/me` | 当前账号 |
| GET | `/api/v1/users` | Owner/Manager 用户列表，可用 `status`、`role`、`q` 筛选并获取管理字段 |
| GET / PATCH | `/api/v1/users/{id}` | 用户详情 / 更新 `name`、`role`、`status`（Owner/Manager） |
| GET / POST | `/api/v1/users/invitations` | 待接受邀请列表 / 创建邀请（Owner/Manager） |
| DELETE | `/api/v1/users/invitations/{id}` | 撤销邀请并禁用对应账号 |
| POST | `/api/v1/auth/accept-invitation` | 公开接口；用一次性令牌设置姓名与密码 |
| GET | `/api/v1/summary` | 三模块实时状态统计 |
| GET / POST | `/api/v1/vehicles` | 库存列表（全员公开字段）/ 创建（Owner/Manager） |
| GET / PATCH / DELETE | `/api/v1/vehicles/{id}` | 详情（全员公开字段）/ 编辑 / 归档（后两者 Owner/Manager） |
| GET | `/api/v1/vehicles/{id}/price-estimate` | ZIP 91731 的 itemized test OTD estimate；`cash=1` 使用 $200 现金折扣并重算 |
| GET / POST | `/api/v1/vehicles/{id}/media` | 照片列表 / multipart 上传（上传 Owner/Manager），字段名 `file` |
| GET / DELETE | `/api/v1/vehicles/{id}/media/{mediaId}` | 读取（全员）/ 删除照片（Owner/Manager） |
| GET / POST | `/api/v1/customers` | 客户列表（按角色范围）/ 创建（自动分配给 Sales/BDC 创建人） |
| GET / PATCH / DELETE | `/api/v1/customers/{id}` | 详情（含备注）/ 编辑 / 归档 |
| GET / POST | `/api/v1/customers/{id}/notes` | 备注列表 / 新增 `{note_text, is_pinned}` |
| GET / POST | `/api/v1/leads` | 线索列表 / 创建 |
| GET / PATCH / DELETE | `/api/v1/leads/{id}` | 详情 / 编辑 / 归档 |
| GET / POST | `/api/v1/conversations` | 会话列表（按角色范围）/ 创建会话（客户 + 可选车辆 + 初始客户问题） |
| GET / PATCH | `/api/v1/conversations/{id}` | 详情（消息、客户、车辆、线索）/ 关闭、重开、分配（PATCH 需 If-Match） |
| POST | `/api/v1/conversations/{id}/messages` | 记录客户问题（inbound）或发送回复（outbound）；outbound 需 `Idempotency-Key` |
| POST | `/api/v1/conversations/{id}/ai-suggestion` | 基于车辆公开事实和最新客户问题生成审核用 AI 草稿，不自动发送 |
| GET | `/api/v1/{vehicles,customers,leads}/{id}/activity` | 操作历史 |

PATCH 和记录 DELETE 必须带 `If-Match: <version>`，version 来自最近一次 GET 返回值；缺失返回 428，版本冲突返回 409。编辑时只提交可写字段，不要把整个 GET 响应回传。

列表通用参数：`q`、`status`、`page`、`page_size`（1–100）、`date_from`、`date_to`、`assigned_user_id`（适用客户及线索）。库存还支持 `make`、`model`、`year`、`body_type`、`fuel_type`、`price_min`、`price_max`。客户支持 `source`、`interested_vehicle_id`；线索支持 `source`、`priority`、`assignee`、`customer_id`、`vehicle_id`。会话支持 `status`、`channel`、`unread_only`、`assigned_user_id`。价格范围为包含端点的数值范围。

库存保留 `reserved` 和 `in_transit` 状态，作为本版本的显式扩展。客户状态采用数据文档的 `new/contacted/qualified/appointment/won/lost`，不与线索阶段混用。

## 测试

在项目根目录：

```sh
node --test backend/test/*.test.mjs
```

默认直接执行实际 HTTP 请求处理器、JSON/multipart 序列化和真实 SQLite 数据操作，不依赖网络端口。测试套件包含 **29 项**：22 项 API/持久化测试 + 7 项 AI policy/OTD/里程规则测试。覆盖身份验证、CRUD、分页、字段校验、唯一约束、并发版本、客户备注、关联关系、线索流转与原因校验、用户邀请/接受/撤销、角色与账号状态、令牌失效、最后一个 Owner 保护、租户隔离、角色和字段权限、Sales/BDC 分配范围、库存写权限、统计范围、会话/未读、AI 车辆事实与隐私边界、OTD 计算、里程/测试模式、幂等发送、禁止联系拦截、照片限制和磁盘重启持久化。

也可运行相同测试的真实 TCP/HTTP 模式：

```sh
# Linux / WSL
DEALER_HTTP_TEST=1 node --test backend/test/*.test.mjs
```

```powershell
# PowerShell
$env:DEALER_HTTP_TEST = '1'
node --test backend/test/*.test.mjs
```

## 本地版本边界

这是可运行的本地核心功能版本，服务默认监听 `0.0.0.0` 并由 `APP_ORIGIN` 限制 Host/Origin，不是文档中完整的生产部署。技术上使用 Node 原生 HTTP + SQLite（JSON 字段存储、唯一索引及事务）；尚未采用文档规划的 NestJS、PostgreSQL、Next.js、S3。当前列表在门店数据范围内执行内存筛选，适用于本地小规模验证。

AI 已接入**助审草稿**；test-only current mileage 只在 `DEALER_AI_TEST_MODE=1` 的测试环境使用，生产环境必须关闭。OTD 是按当前测试费率计算的 **test estimate**，不是正式报价；税费和费用必须由 sales 确认。未接入翻译、自动回复、短信/邮件/WhatsApp 真实投递、外部平台抓取、预约、交易结算，也未提供 refresh token、密码重置或完整的生产身份系统（如 MFA、邀请邮件发送）。经销商资料、时区、货币与 AI 策略设置（`/settings`）不在本次三个模块范围内。用户邀请在本版本中返回一次性令牌，需要管理员自行安全地转交。销售权限和门店隔离在接口层生效，但生产身份系统与账号生命周期管理仍需后续集成。备注/媒体的访问均需登录。照片目前仅验证 MIME、文件头和大小，不含生产要求的病毒扫描、解码重编码、EXIF 清理或主图排序。

首次启动必须提供 `DEALER_ADMIN_*`。发布前需要生产身份与会话管理、数据库迁移、备份、HTTPS 和媒体处理。根目录旧页面不再作为产品入口。
