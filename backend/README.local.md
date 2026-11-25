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

- 访客入口为 `/app/#browse`，员工入口为 `/app/#login`。只有 available 且未归档的车辆可以公开查看和接收新询价。单门店自动识别，多门店数据库需用 `DEALER_PUBLIC_ORG_ID` 指定本站门店。
- 产品入口：<http://localhost:3000/app/>
- 首次启动且业务表为空时，会自动写入一组 sample data：3 台车辆、3 位客户、3 条线索和 3 个会话，便于部署后直接体验。已有任一车辆/客户/线索时不会写入，避免覆盖已有数据；设置 `DEALER_SEED_SAMPLE_DATA=0` 可关闭。
- `DEALER_ADMIN_*` 仅在数据库首次初始化时使用，之后启动可省略。

启动前可设置 `PORT`、`DEALER_DB_PATH`、`DEALER_ADMIN_EMAIL`、`DEALER_ADMIN_PASSWORD`、`DEALER_JWT_SECRET`、`APP_ORIGIN`。账号及密码仅在数据库首次初始化时生效；JWT 密钥不设置时每次启动重新生成，旧登录将失效。数据文件路径会打印在启动日志。

服务默认监听 `0.0.0.0`，并通过 `APP_ORIGIN`（默认 `http://localhost:3000`）校验请求的 Host 和 Origin。如果通过其他主机名或端口访问，必须把 `APP_ORIGIN` 设为实际访问的 origin，否则会返回 403。Host/Origin 校验不是身份认证；不要把服务直接暴露到不可信网络，生产环境需要防火墙、HTTPS 和反向代理。

AI 草稿真实模型的配置写在 **`backend/.env`**（该文件已被 gitignore；可参考 `backend/.env.example`）。服务启动时自动读取该文件，也可以显式使用 `node --env-file=backend/.env backend/server.mjs`，或直接在 shell 中 export 同名变量。

```sh
# backend/.env
AI_MODEL='你的模型名'
AI_API_KEY='你的 API key'
AI_PROVIDER=openai
# 如果服务不是 OpenAI 官方地址，再填写：
# AI_BASE_URL=https://your-provider.example.com/v1
# AI_API_STYLE=chat   # 只支持 Chat Completions 的兼容服务用这个
```

Anthropic Messages API 或 DeepSeek 的 Anthropic 兼容接口示例：

```sh
AI_MODEL='deepseek-flash'
AI_API_KEY='你的 API key'
AI_PROVIDER=deepseek
AI_BASE_URL=https://api.deepseek.com/anthropic
AI_API_STYLE=anthropic
```

`AI_MODEL` 和 `AI_API_KEY` 都存在时才会调用真实模型；否则使用本地确定性草稿。支持 `responses`、`chat`、`anthropic` 三种请求格式；设置 `AI_PROVIDER=local` 可强制使用本地草稿。旧的 `OPENAI_API_KEY` / `OPENAI_BASE_URL` 仍可作为兼容别名。API key 只在服务端使用，不会返回浏览器。

配置真实模型后，由模型结合同一会话的近期消息补答问题。报价和已识别的政策条款由后端提供；模型生成失败或草稿未通过核查时，员工会看到本地草稿及原因。

`DEALER_AI_TEST_MODE=1` 仅用于测试环境：允许 AI 使用车辆的 test-only current mileage，并在 staff notes 中标注 test-only。生产环境不得设置；默认关闭时 test-only 字段不会进入 AI facts，也不会进入草稿。

Linux/WSL 下默认数据库为 `backend/data/dealer.sqlite`。**推荐在 WSL 的项目目录运行 Linux Node**，保持数据库和代码在同一文件系统。Windows Node 从 `\\wsl$` 网络路径启动时，SQLite 文件锁不能可靠工作，因此默认数据库置于 Windows 临时目录下按项目路径区分的 `dealer-ai-web/<项目标识>/dealer.sqlite`；能跨进程重启保留，但可能被临时文件清理。需要长期保留时，将 `DEALER_DB_PATH` 设为本机持久目录，或在 WSL 内运行。切换路径不会自动迁移数据库，迁移前停止服务并复制完整数据库。

## 已实现

| 模块 | 功能 |
| --- | --- |
| 库存 | 新建、查看、编辑、归档（写操作仅 Owner/Manager）；Make 下拉、Transmission 下拉（Automatic / Manual / CVT / eCVT / Other / Unknown）；CARFAX 里程来源/日期、事故/title/服务历史、检查状态和 test-only 字段；草稿；VIN/库存号唯一检查；车型、品牌、状态、价格、关键词筛选；分页；真实统计；JPEG/PNG 照片上传、预览、删除（10 张，每张 10 MB）；价格、里程和年份校验 |
| 客户 | 档案、联系方式、首选联系方式、意向车辆、负责人、状态、语言、禁止联系标记；联系方式标准化；同邮箱/电话的重复候选提示（保留独立客户，不自动合并）；备注、置顶备注、操作历史、关联线索；Sales/BDC 仅访问分配范围内的记录 |
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

线索阶段：`new → working / lost`，`working → qualified / lost`，`qualified → working / lost`。只有经理可把 `lost` 重开到 `working`；`won` 不可直接重开。新建只能从 `new` 开始。

## 会话与 AI 草稿

- 会话关联客户，建议关联车辆；车辆是 AI 回复的事实来源。员工可以在库存车辆详情点 **Start conversation**，或在 Conversations 页面新建会话并选好客户和渠道后即可开始跟进。公开询价表单提交的问题会自动进入对应会话。
- `POST /api/v1/conversations/{id}/ai-suggestion` 将**当前车辆公开事实 + 当前会话此前最多 8 条消息（每条最多 1200 字符）+ 最新客户问题**交给模型，返回客户可读草稿和仅员工可见的核查提示。草稿不会自动发送，员工必须审阅、编辑后再发送。
- 报价、折扣和试驾等已识别的政策答复由后端生成，模型可以补充其他问题。模型改变受保护内容、另加金额或出现预约确认措辞时，界面改用本地草稿并提示员工核查。
- AI 输入包含车辆公开事实、CARFAX 历史摘要、里程来源/日期/冲突、title/事故/服务记录、混动电池/smog/AC 检查状态，以及门店地址/营业时间/保修/现金折扣/金融规则。命中落地价问题时，本次适用的 OTD 估算放在 `verifiedReply` 中。**采购成本、最低价、内部备注、报告 URL 和 test-only 字段不会进入生产环境 AI 输入。**
- 如果车辆描述中包含导入的 CARFAX 报告摘要，AI 可以引用为 “the CARFAX report summary on file says …”，但不得声称独立验证或 accident-free；没有摘要时仍回答历史未验证。
- 员工可以核对草稿来源、回退原因和待确认事项，编辑后再发送。
- 客户标记 `do not contact` 时，AI 草稿和出站消息都会被拒绝。出站消息要求 `Idempotency-Key`：相同 key + 相同内容返回原消息，不同内容返回 409。
- 消息目前记录在 CRM 本地，`delivery_status` 为 `recorded`（出站）或 `received`（入站），不投递到短信/邮件；`channel` 只是上下文标签。
- 未实现：自动回复、翻译、真实短信/邮件/WhatsApp 投递、消费者登录和站内双向聊天门户。会话的暂停（snooze）也暂未启用。

## 消费者公开询价（FR 15）

- 消费者不需要账号、不会被邀请，也不是内部用户。员工在车辆 Details 里可以 **Copy customer inquiry link** 或 **Preview customer inquiry**，把 `/app/#inquiry?vehicle_id=...` 发给消费者。
- 公开页面只显示车辆公开字段：年款、品牌、车型、配置、里程、标价、状态、燃料、变速箱、位置和描述。成本、最低价、内部备注、test-only 字段和报告 URL 不会出现在公开页面或公开接口。
- 消费者填写姓名、邮箱/电话、首选联系方式、问题和同意声明；提交后显示 **reference**（submission_id），不提供 consumer login。
- 每个新的公开询价建独立的客户、Website 线索、web 会话和首条入站消息，并保存同意联系的时间与提交编号。共用邮箱或电话的客户显示为待核对候选，既有档案的联系方式和首选渠道保留原值。命中禁止联系的号码或邮箱时，新档案也标记为禁止联系。
- 同一提交编号和相同内容返回原 reference。本版新建的询价复用编号但更改内容会返回 409。公开接口沿用每个 IP 每 10 分钟 20 次的限制。
- 访客从首页浏览在售车辆并提交询价后会收到确认，不做 customer login、full storefront 或站内双向聊天。员工通过已批准的外部渠道跟进；如果要做消费者在站内回复，需要另行定义公开会话 token/channel 合同。

## 库存表单与 CARFAX 历史

- Make 使用下拉列表；Transmission 固定为 `Automatic / Manual / CVT / eCVT / Other / Unknown`，CVT 与 eCVT 分开。
- 车辆保存结构化历史：`mileage_source`、`mileage_reported_at`、`mileage_conflict`、`title_status`、`accident_count`、`accident_summary`、`service_record_count`、`last_service_date`、`history_summary`、`history_report_date`、`history_report_url`、`hybrid_battery_status`、`smog_status`、`ac_status`、`inspection_notes`、`inspection_conflict`。
- CARFAX 报告的最后里程写入 `mileage`，报告日期写入 `mileage_reported_at`，来源写入 `CARFAX`。它是历史读数，不是实时里程。
- `test_current_mileage` / `test_mileage_note` 是 manager-only 的测试字段；只有 `DEALER_AI_TEST_MODE=1` 时 AI 才会使用，并在 staff notes 中明确标注 test-only。生产环境默认不读取。
- `history_report_url`、`mileage_conflict`、`inspection_conflict` 和 test-only 字段只对 Owner/Manager 返回；Sales/BDC 看不到。

## AI 回复策略

后端先结合近期对话识别受保护主题。命中报价、折扣、试驾等规则后，policy 生成核定片段，通过 `verifiedReply` 传给模型。模型在成稿中保留单独一行 `[[verified_reply]]` 并补答其他问题；核查通过后，后端把标记替换为原文。

- 车辆事实：年份/品牌/车型/配置、VIN、里程及来源/日期/冲突、标价、可售状态、车身/颜色/变速箱/驱动/燃料/车况、位置、描述、CARFAX 摘要、事故/title/服务记录、混动电池/smog/AC 检查状态。
- 门店事实：地址、营业时间、保修说明、$200 现金折扣、支持估算的邮编 91731、金融门槛与指导话术、trade-in 和 smog 说明。
- 约束：只能使用提供的事实；不得承诺库存、贷款审批、APR/月供、保修覆盖、事故-free 或试驾已预约；缺失/冲突字段要求人工确认；OTD 必须引用后端提供的明细，不得重算；test-only 里程只在测试环境使用并标注。

`GET /api/v1/vehicles/{id}/price-estimate?zip=91731[&cash=1]` 仍由后端公式计算 itemized test estimate：车价 + 10% 税 + $50 title + $200 registration；$10,000 车价 → $11,250。现金折扣 $200，OTD 用折扣后车价重算。

模型输出格式错误时，后端会加强 JSON 格式提示后重试一次；提供方明确报告输出达到 token 上限时，提高输出预算后重试一次。其他非正常结束直接回退。诊断日志记录接口格式、尝试次数、错误类别和结束原因，省略原始消息和草稿。缺少可用模型或核查失败时，使用本地政策或车辆事实生成草稿；员工界面显示实际来源。

归档保留记录及历史，但从活动列表隐藏。有未关闭线索的车辆/客户不能归档，需先处理线索。已成交车辆不可通过普通编辑重新设为可售。普通编辑不能把线索标为 won。该状态由销售完成流程写入，现阶段保留历史 won 记录。

## 接口

采用 `docs/DealerAI_API_Specification.docx` 的 `/api/v1` 路径、UUID、UTC 时间、成功/错误 envelope。`GET` 列表返回 `{data: [...], meta: {request_id, page, page_size, total, total_pages}}`；失败返回 `{error: {code, message, field_errors, request_id}}`。

除登录外，所有接口需要 `Authorization: Bearer <access_token>`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/v1/auth/login` | `{email, password}`，返回 8 小时 access token |
| GET | `/api/v1/public/vehicles` | 当前门店的在售车辆，支持 page 和 page_size 分页 |
| GET | `/api/v1/public/vehicles/{id}` | 免登录公开车辆摘要；不含成本、最低价、内部备注、测试字段或报告 URL |
| POST | `/api/v1/public/inquiries` | 免登录消费者询价；创建/关联客户、一条 Website 线索、一个 web 会话和 inbound 消息；返回 reference |
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
| PATCH | `/api/v1/vehicles/{id}/media` | 用 If-Match 车辆版本提交完整 media_ids 顺序。首张为主图，上传、删除、排序会更新车辆版本 |
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

默认测试直接执行 HTTP 请求处理器、JSON/multipart 序列化和 SQLite 操作。另有收件箱交互回归，模拟切换会话、乱序响应和延迟返回的 AI 草稿。

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

## 已实现模块与需求的核对

| 需求 | 当前行为 | 后续验收缺口 |
| --- | --- | --- |
| FR 01、14 门店与用户 | 员工登录、邀请、禁用、角色控制和令牌失效已接入。分配人员下拉只列出活跃员工，支持多页名单。 | 当前邮箱全局唯一。跨门店同邮箱登录、会话刷新和门店设置仍待实现。 |
| FR 03、04 库存 | 在售车辆必须提供实际里程。草稿可留空，公开页面仅展示已发布状态的车辆；界面可按品牌、型号、年份等筛选。已上传照片可设置主图和排序，列表展示主图。 | AI 描述草稿和历史销售联动仍待实现。旧记录中的零里程需根据原始资料核实。 |
| FR 05、15 客户与公开询价 | 员工新建客户遇到可见的相同邮箱或电话时，API 返回 409 和候选人。可以查看原档案，或提交 `duplicate_review`（已核对的候选 ID 列表）建立独立档案并留痕。公开询价保留独立档案，客户详情显示当前有权查看的候选人。 | 通用门店询价入口和历史重复档案的合并未实现。公开询价入口仍绑定车辆。 |
| FR 06 线索 | 新线索从 new 开始，经 working 再到 qualified。失单与重新打开需要原因。列表、搜索和详情按员工的可见范围展开关联档案。 | 成交后原子更新指定线索和车辆依赖销售模块。 |
| FR 07、08、09 会话与 AI | 收件箱可按渠道、负责人、状态和未读筛选。新会话可不选车。手工草稿按会话保存到退出登录，AI 结果仅应用于发起请求的会话。完整的 STOP、UNSUBSCRIBE 等退订指令会记录到客户档案。没有目标邮箱或号码时，对应渠道的回复会被拦截。只有来源标记为 CARFAX 的里程才按 CARFAX 引述。 | 消息目前仅在 CRM 留档。外部投递、翻译、会话暂停和投递状态回调仍待接入。 |

FR 02 仪表盘、FR 10 预约、FR 11–12 销售与收款、FR 13 报表仍缺少完整的产品流程。FR 16 外部渠道监控、FR 17 数据保留和处置也尚未达到完整 MVP 的验收范围。
