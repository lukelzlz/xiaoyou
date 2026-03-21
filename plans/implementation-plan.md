# 小悠系统实现计划

## 概述

本文档记录了小悠系统的实现进展，包括已完成的功能和待实现的功能。

---

## 已完成功能

### 核心功能（Phase 1）

| 模块 | 文件 | 状态 | 说明 |
|------|------|------|------|
| 意图识别 | `src/controller/intent.ts` | ✅ | 支持聊天、工具、任务、定时、反馈等意图类型 |
| 场景路由 | `src/controller/router.ts` | ✅ | 基于意图的优先级路由 |
| 上下文管理 | `src/controller/context.ts` | ✅ | 会话上下文和变量管理 |
| 热记忆存储 | `src/memory/hot.ts` | ✅ | Redis 热记忆 |
| 向量记忆存储 | `src/memory/vector.ts` | ✅ | Qdrant 向量检索，支持 similarity/keyword/hybrid |
| 记忆归档 | `src/memory/flush.ts` | ✅ | 热记忆到长期记忆的归档 |
| 工具注册与调用 | `src/tools/index.ts` | ✅ | 可注册、可发现、可鉴权的 Tool Registry |
| 搜索工具 | `src/tools/brave-search.ts` | ✅ | Brave 搜索集成 |
| 记忆工具 | `src/tools/memory.ts` | ✅ | 记忆搜索和存储 |
| Discord 适配器 | `src/adapters/discord/index.ts` | ✅ | Discord 机器人 |
| Telegram 适配器 | `src/adapters/telegram/index.ts` | ✅ | Telegram 机器人 |
| 多模态处理 | `src/gateway/multimodal.ts` | ✅ | 视觉大语言模型多模态提取 |
| 速率限制 | `src/gateway/ratelimit.ts` | ✅ | 用户级速率限制 |
| 消息解析 | `src/gateway/parser.ts` | ✅ | 消息格式解析 |
| 插件系统 | `src/plugins/index.ts` | ✅ | 扩展点机制 |
| 监控指标 | `src/monitoring/metrics.ts` | ✅ | Prometheus 指标 |
| OpenClaw Agent | `src/executor/openclaw-agent.ts` | ✅ | WebSocket RPC 任务执行 |
| OpenClaw CRON | `src/executor/openclaw-cron.ts` | ✅ | 定时任务管理 |
| OpenClaw RPC | `src/executor/openclaw-rpc.ts` | ✅ | WebSocket RPC 客户端 |

### 新增功能（Phase 2）

| 模块 | 文件 | 状态 | 说明 |
|------|------|------|------|
| REST API 接口层 | `src/api/index.ts` | ✅ | 完整的 REST API 实现 |
| 安全服务 | `src/security/index.ts` | ✅ | 认证、授权、加密、审计 |
| 数据库持久化层 | `prisma/schema.prisma` | ✅ | Prisma Schema 定义 |
| 数据库服务 | `src/database/index.ts` | ✅ | 用户、任务、定时任务、反馈等服务 |
| WebSocket 推送服务 | `src/websocket/index.ts` | ✅ | 任务进度和系统通知推送 |
| 用户反馈处理 | `src/feedback/index.ts` | ✅ | 反馈分析和用户画像更新 |
| 降级机制 | `src/fallback/index.ts` | ✅ | 熔断器和服务降级策略 |

---

## REST API 接口清单

### 消息处理 API
- `POST /api/messages/incoming` - 接收消息
- `POST /api/messages/outgoing` - 发送消息
- `GET /api/messages/:messageId/status` - 查询消息状态

### 意图识别 API
- `POST /api/intent/analyze` - 意图分析

### 任务管理 API
- `POST /api/tasks` - 创建任务
- `GET /api/tasks/:taskId` - 查询任务状态
- `POST /api/tasks/:taskId/control` - 控制任务（暂停/恢复/取消/重试）
- `GET /api/tasks` - 查询任务列表

### 定时任务 API
- `POST /api/schedules` - 创建定时任务
- `GET /api/schedules/:scheduleId` - 查询定时任务
- `PUT /api/schedules/:scheduleId` - 更新定时任务
- `DELETE /api/schedules/:scheduleId` - 删除定时任务
- `GET /api/schedules` - 查询定时任务列表

### 记忆系统 API
- `GET /api/memory/hot/:sessionId` - 读取热记忆
- `PATCH /api/memory/hot/:sessionId` - 更新热记忆
- `POST /api/memory/vector/search` - 向量记忆检索
- `POST /api/memory/flush` - 记忆归档

### 工具调用 API
- `POST /api/tools/search` - 搜索工具
- `POST /api/tools/extract` - 内容提取工具
- `POST /api/tools/query` - 查询工具
- `GET /api/tools` - 获取可用工具列表

### 用户反馈 API
- `POST /api/feedback` - 提交反馈
- `GET /api/users/:userId/profile` - 查询用户画像

### 系统管理 API
- `GET /api/health` - 健康检查
- `GET /api/metrics` - 系统指标

---

## 数据库模型

### 用户相关
- `User` - 用户表
- `UserProfile` - 用户画像
- `Session` - 会话

### 任务相关
- `Task` - 任务
- `TaskStep` - 任务步骤

### 定时任务相关
- `Schedule` - 定时任务
- `ScheduleHistory` - 执行历史

### 反馈相关
- `Feedback` - 用户反馈

### 系统相关
- `AuditLog` - 审计日志
- `SystemConfig` - 系统配置
- `WebhookEvent` - Webhook 事件

---

## WebSocket 事件

### 任务进度推送
- `task.progress` - 任务进度更新
- `task.completed` - 任务完成
- `task.failed` - 任务失败
- `task.need_confirm` - 需要用户确认

### 系统通知推送
- `notification` - 系统通知

---

## 安全功能

### 认证服务
- JWT Token 生成和验证
- Token 刷新机制
- Token 撤销

### 授权服务
- 基于角色的权限控制（RBAC）
- 资源级权限检查
- 敏感操作确认

### 数据安全
- AES-256-GCM 数据加密
- 数据脱敏（邮箱、手机、身份证、银行卡）
- 访问审计日志

---

## 降级机制

### 熔断器
- 三态模型：closed → open → half-open → closed
- 可配置的失败阈值和恢复阈值
- 冷却期自动恢复

### 降级策略
- LLM 降级：返回友好提示或简化响应
- 规划服务降级：记录任务稍后处理
- 执行器降级：暂停任务并通知用户
- 记忆服务降级：静默降级，无上下文运行
- 工具服务降级：返回不可用提示

---

## 部署说明

### 环境要求
- Node.js 20+
- PostgreSQL 15+
- Redis 7+
- Qdrant 1.7+

### 环境变量
参见 `.env.example` 和 `docs/configuration.md`

### 启动命令
```bash
# 安装依赖
npm install

# 生成 Prisma 客户端
npx prisma generate

# 运行数据库迁移
npx prisma migrate dev

# 启动开发服务
npm run dev
```

---

## 测试覆盖

### 单元测试
- `tests/unit/controller.test.ts` - 控制器测试
- `tests/unit/router.test.ts` - 路由测试
- `tests/unit/context.test.ts` - 上下文测试
- `tests/unit/memory.test.ts` - 记忆系统测试
- `tests/unit/vector.test.ts` - 向量检索测试
- `tests/unit/tools.test.ts` - 工具测试
- `tests/unit/plugins.test.ts` - 插件系统测试
- `tests/unit/metrics.test.ts` - 监控指标测试
- `tests/unit/multimodal.test.ts` - 多模态测试
- `tests/unit/ratelimit.test.ts` - 速率限制测试
- `tests/unit/executor.test.ts` - 执行器测试
- `tests/unit/openclaw-cron.test.ts` - CRON 测试

---

## 下一步计划

### 待优化
1. 添加更多单元测试覆盖新模块
2. 实现集成测试
3. 添加 API 文档（OpenAPI/Swagger）
4. 实现配置热更新
5. 添加分布式锁支持

### 待实现
1. 用户管理后台
2. 任务监控仪表板
3. 日志聚合和分析
4. 性能优化和缓存策略
