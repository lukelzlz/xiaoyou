# 小悠系统配置说明

## 1. 环境变量配置

### 1.1 应用基础配置

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `NODE_ENV` | 否 | `development` | 运行环境：`development` / `production` / `test` |
| `PORT` | 否 | `3000` | HTTP 服务端口 |
| `LOG_LEVEL` | 否 | `info` | 日志级别：`debug` / `info` / `warn` / `error` |
| `TIMEZONE` | 否 | `Asia/Shanghai` | 系统默认时区 |

### 1.2 Discord 配置

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `DISCORD_TOKEN` | 是 | Discord Bot Token |
| `DISCORD_CLIENT_ID` | 是 | Discord Application Client ID |
| `DISCORD_GUILD_ID` | 否 | 指定服务器 ID（开发模式下限定服务器） |
| `DISCORD_COMMAND_PREFIX` | 否 | 命令前缀，默认 `/` |

### 1.3 Telegram 配置

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `TELEGRAM_TOKEN` | 是 | Telegram Bot Token |
| `TELEGRAM_WEBHOOK_URL` | 否 | Webhook URL（生产环境推荐） |
| `TELEGRAM_ALLOWED_CHATS` | 否 | 允许的聊天 ID 列表，逗号分隔 |

### 1.4 GLM-4.5-Air 配置

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `GLM_API_KEY` | 是 | - | GLM API 密钥 |
| `GLM_API_URL` | 是 | - | GLM API 地址 |
| `MODEL_ID` | 否 | `glm-4.5-air` | 聊天模型 ID（优先级高于 `GLM_MODEL`） |
| `EMBEDDING_MODEL_ID` | 否 | `text-embedding-3-small` | 向量嵌入模型 ID（优先级高于 `GLM_EMBEDDING_MODEL`） |
| `VISION_MODEL_ID` | 否 | `glm-4.5-vision` | 多模态视觉模型 ID（优先级高于 `GLM_VISION_MODEL`，未配置时回退到 `MODEL_ID`） |
| `GLM_MODEL` | 否 | `glm-4.5-air` | （兼容旧配置）聊天模型名称 |
| `GLM_EMBEDDING_MODEL` | 否 | `text-embedding-3-small` | （兼容旧配置）向量嵌入模型名称 |
| `GLM_VISION_MODEL` | 否 | `glm-4.5-vision` | （兼容旧配置）多模态视觉模型名称 |
| `GLM_MAX_TOKENS` | 否 | `4096` | 最大生成 token 数 |
| `GLM_TEMPERATURE` | 否 | `0.7` | 生成温度 |
| `GLM_TIMEOUT` | 否 | `30000` | 请求超时（毫秒） |

> **模型配置说明**：
> - `MODEL_ID`：用于日常聊天、意图识别等文本生成任务
> - `EMBEDDING_MODEL_ID`：用于将文本转换为向量，支持语义检索和长期记忆
> - `VISION_MODEL_ID`：用于图片、文档、视频等多模态内容的理解与摘要
> - 三个模型可独立配置，适配不同场景的性能与成本需求

### 1.5 Nemotron 配置

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `NEMOTRON_API_KEY` | 是 | - | Nemotron API 密钥 |
| `NEMOTRON_API_URL` | 是 | - | Nemotron API 地址 |
| `NEMOTRON_MODEL` | 否 | `nemotron-3-super` | 模型名称 |
| `NEMOTRON_MAX_TOKENS` | 否 | `8192` | 最大生成 token 数 |
| `NEMOTRON_TIMEOUT` | 否 | `60000` | 请求超时（毫秒） |

### 1.6 OpenClaw 配置

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `OPENCLAW_API_URL` | 是 | - | OpenClaw API 地址 |
| `OPENCLAW_API_KEY` | 是 | - | OpenClaw API 密钥 |
| `OPENCLAW_MAX_CONCURRENT` | 否 | `10` | 最大并发任务数 |
| `OPENCLAW_TASK_TIMEOUT` | 否 | `300000` | 任务超时（毫秒，默认5分钟） |
| `OPENCLAW_CALLBACK_URL` | 否 | `http://localhost:3000/api/callback` | 任务回调地址 |

### 1.7 Redis 配置

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `REDIS_URL` | 是 | - | Redis 连接 URL |
| `REDIS_PASSWORD` | 否 | - | Redis 密码 |
| `REDIS_DB` | 否 | `0` | Redis 数据库编号 |
| `REDIS_KEY_PREFIX` | 否 | `xiaoyou:` | Key 前缀 |

### 1.8 Qdrant 配置

| 变量名 | 必填 | 默认值 | 说明 |
|--------|------|--------|------|
| `QDRANT_URL` | 是 | - | Qdrant 服务地址 |
| `QDRANT_API_KEY` | 否 | - | Qdrant API 密钥 |
| `QDRANT_COLLECTION` | 否 | `xiaoyou_memories` | 集合名称 |

### 1.9 数据库配置

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `DATABASE_URL` | 是 | PostgreSQL 连接 URL |

## 2. 运行时配置

### 2.1 记忆系统配置

```typescript
// config/memory.ts
export const memoryConfig = {
  hot: {
    // 热记忆 TTL（秒）
    ttl: 3600,
    // 最大对话历史条数
    maxConversationHistory: 50,
    // 最大活动任务数
    maxActiveTasks: 20,
  },
  vector: {
    // 向量维度
    dimension: 1536,
    // 默认检索数量
    defaultTopK: 10,
    // 默认相似度阈值
    defaultThreshold: 0.7,
    // 距离度量方式
    distanceMetric: 'cosine' as const,
  },
  flush: {
    // 自动归档间隔（秒）
    autoFlushInterval: 1800,
    // 最小重要性阈值（低于此值不归档）
    minImportanceThreshold: 0.3,
    // 批量归档大小
    batchSize: 100,
  },
};
```

### 2.2 意图识别配置

```typescript
// config/intent.ts
export const intentConfig = {
  // 最低置信度阈值
  minConfidence: 0.6,
  // 低于此阈值时回退到聊天
  fallbackThreshold: 0.4,
  // 意图缓存 TTL（秒）
  cacheTTL: 300,
  // 上下文窗口大小（用于意图识别的历史消息数）
  contextWindowSize: 5,
};
```

### 2.3 任务执行配置

```typescript
// config/task.ts
export const taskConfig = {
  // 最大并发任务数
  maxConcurrentTasks: 10,
  // 单任务最大并发步骤
  maxConcurrentSteps: 5,
  // 默认任务超时（毫秒）
  defaultTimeout: 300000,
  // 默认重试策略
  defaultRetryPolicy: {
    maxRetries: 3,
    retryInterval: 1000,
    backoffMultiplier: 2,
    maxInterval: 30000,
    retryableErrors: ['TIMEOUT', 'RATE_LIMIT', 'TEMPORARY_FAILURE'],
  },
  // 任务结果保留时间（秒）
  resultRetention: 86400,
};
```

### 2.4 定时任务配置

```typescript
// config/schedule.ts
export const scheduleConfig = {
  // 最大定时任务数（每用户）
  maxSchedulesPerUser: 50,
  // 最小执行间隔（秒）
  minInterval: 60,
  // 默认时区
  defaultTimezone: 'Asia/Shanghai',
  // 任务执行超时（毫秒）
  executionTimeout: 600000,
  // 失败重试次数
  failureRetries: 2,
  // 历史记录保留天数
  historyRetentionDays: 30,
};
```

### 2.5 速率限制配置

```typescript
// config/ratelimit.ts
export const rateLimitConfig = {
  // 每用户每分钟请求数
  perUserPerMinute: 60,
  // 每用户每小时请求数
  perUserPerHour: 500,
  // 全局每分钟请求数
  globalPerMinute: 1000,
  // 任务创建限制（每用户每小时）
  taskCreationPerHour: 20,
  // 定时任务创建限制（每用户每天）
  scheduleCreationPerDay: 10,
};
```

### 2.6 降级配置

```typescript
// config/fallback.ts
export const fallbackConfig = {
  // Nemotron 超时后的降级策略
  nemotronFallback: {
    // 超时时间（毫秒）
    timeout: 10000,
    // 重试次数
    retries: 2,
    // 降级消息
    message: '系统繁忙，稍后为您处理',
    // 是否排队等待
    queueEnabled: true,
    // 队列最大长度
    maxQueueSize: 100,
  },
  // GLM 超时后的降级策略
  glmFallback: {
    timeout: 15000,
    retries: 3,
    message: '抱歉，我暂时无法回复，请稍后再试',
  },
  // OpenClaw 超时后的降级策略
  openclawFallback: {
    timeout: 30000,
    retries: 2,
    message: '任务执行服务暂时不可用',
  },
};
```

## 3. Prompt 模板配置

### 3.1 系统 Prompt

```typescript
// config/prompts.ts
export const systemPrompts = {
  // GLM 系统 Prompt
  glmSystem: `
你是小悠，一个友好、智能的 AI 助手。你的特点是：
- 温暖亲切，像朋友一样交流
- 善于理解用户意图，准确分流请求
- 对复杂任务能给出清晰的处理方案
- 记住用户的偏好和历史对话

当前时间：{{currentTime}}
用户信息：{{userProfile}}
会话上下文：{{sessionContext}}
`,

  // 意图识别 Prompt
  intentRecognition: `
你是一个意图识别系统。请分析用户消息并返回 JSON 格式的意图分类结果。

可用意图类型：
{{intentTypes}}

用户消息：{{userMessage}}
上下文：{{context}}

请返回：
{
  "intent": "意图类型",
  "confidence": 0.0-1.0,
  "entities": [{"type": "类型", "value": "值"}]
}
`,

  // 任务规划 Prompt
  taskPlanning: `
你是一个任务规划专家。请将任务分解为可执行的步骤。

任务：{{taskDescription}}
可用工具：{{availableTools}}
约束条件：{{constraints}}

请返回结构化的执行计划。
`,
};
```

### 3.2 Prompt 变量替换

```typescript
// 使用方式
function renderPrompt(
  template: string,
  variables: Record<string, string>
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key) => variables[key] || ''
  );
}
```

## 4. 环境配置文件示例

### 4.1 开发环境

```bash
# .env.development
NODE_ENV=development
PORT=3000
LOG_LEVEL=debug
TIMEZONE=Asia/Shanghai

# Discord（开发 Bot）
DISCORD_TOKEN=dev_bot_token
DISCORD_CLIENT_ID=dev_client_id
DISCORD_GUILD_ID=dev_guild_id

# Telegram（开发 Bot）
TELEGRAM_TOKEN=dev_telegram_token

# GLM
GLM_API_KEY=dev_glm_key
GLM_API_URL=https://api.glm.ai/v1
GLM_TEMPERATURE=0.8
MODEL_ID=glm-4.5-air
EMBEDDING_MODEL_ID=text-embedding-3-small
VISION_MODEL_ID=glm-4.5-vision

# Nemotron
NEMOTRON_API_KEY=dev_nemotron_key
NEMOTRON_API_URL=https://api.nvidia.com/v1

# OpenClaw
OPENCLAW_API_URL=http://localhost:8080
OPENCLAW_API_KEY=dev_openclaw_key

# Redis（本地）
REDIS_URL=redis://localhost:6379

# Qdrant（本地）
QDRANT_URL=http://localhost:6333

# 数据库（本地）
DATABASE_URL=postgresql://dev:dev@localhost:5432/xiaoyou_dev
```

### 4.2 生产环境

```bash
# .env.production
NODE_ENV=production
PORT=3000
LOG_LEVEL=warn
TIMEZONE=Asia/Shanghai

# Discord
DISCORD_TOKEN=prod_bot_token
DISCORD_CLIENT_ID=prod_client_id

# Telegram
TELEGRAM_TOKEN=prod_telegram_token
TELEGRAM_WEBHOOK_URL=https://api.xiaoyou.com/webhook/telegram

# GLM
GLM_API_KEY=prod_glm_key
GLM_API_URL=https://api.glm.ai/v1
GLM_TEMPERATURE=0.7
MODEL_ID=glm-4.5-air
EMBEDDING_MODEL_ID=text-embedding-3-small
VISION_MODEL_ID=glm-4.5-vision

# Nemotron
NEMOTRON_API_KEY=prod_nemotron_key
NEMOTRON_API_URL=https://api.nvidia.com/v1

# OpenClaw
OPENCLAW_API_URL=https://openclaw.internal:8080
OPENCLAW_API_KEY=prod_openclaw_key
OPENCLAW_MAX_CONCURRENT=20

# Redis
REDIS_URL=redis://redis-cluster.internal:6379
REDIS_PASSWORD=prod_redis_password

# Qdrant
QDRANT_URL=http://qdrant.internal:6333
QDRANT_API_KEY=prod_qdrant_key

# 数据库
DATABASE_URL=postgresql://prod:password@postgres.internal:5432/xiaoyou
```

## 5. Docker 配置

### 5.1 docker-compose.yml

```yaml
version: '3.8'

services:
  xiaoyou:
    build: .
    ports:
      - "${PORT:-3000}:3000"
    env_file:
      - .env
    depends_on:
      redis:
        condition: service_healthy
      qdrant:
        condition: service_started
      postgres:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3

  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 3

  qdrant:
    image: qdrant/qdrant:latest
    volumes:
      - qdrant_data:/qdrant/storage
    ports:
      - "6333:6333"

  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: ${DB_USER:-xiaoyou}
      POSTGRES_PASSWORD: ${DB_PASSWORD:-xiaoyou}
      POSTGRES_DB: ${DB_NAME:-xiaoyou}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-xiaoyou}"]
      interval: 10s
      timeout: 5s
      retries: 3

volumes:
  redis_data:
  qdrant_data:
  postgres_data:
```

## 6. 数据库 Schema

```prisma
// prisma/schema.prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id          String   @id @default(uuid())
  platformId  String
  platform    String
  preferences Json     @default("{}")
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  tasks     Task[]
  schedules Schedule[]
  feedback  Feedback[]

  @@unique([platformId, platform])
  @@index([platform])
}

model Task {
  id          String   @id @default(uuid())
  userId      String
  type        String
  description String
  status      String   @default("pending")
  plan        Json?
  result      Json?
  error       String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  user User @relation(fields: [userId], references: [id])

  @@index([userId, status])
  @@index([createdAt])
}

model Schedule {
  id             String   @id @default(uuid())
  userId         String
  name           String
  description    String?
  cronExpression String
  timezone       String   @default("Asia/Shanghai")
  taskTemplate   Json
  status         String   @default("active")
  notifyComplete Boolean  @default(true)
  notifyFailure  Boolean  @default(true)
  maxExecutions  Int?
  executionCount Int      @default(0)
  lastExecution  DateTime?
  nextExecution  DateTime?
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt

  user       User                @relation(fields: [userId], references: [id])
  executions ScheduleExecution[]

  @@index([userId, status])
  @@index([nextExecution])
}

model ScheduleExecution {
  id         String   @id @default(uuid())
  scheduleId String
  status     String
  result     Json?
  error      String?
  startedAt  DateTime @default(now())
  completedAt DateTime?
  duration   Int?

  schedule Schedule @relation(fields: [scheduleId], references: [id])

  @@index([scheduleId, startedAt])
}

model Feedback {
  id        String   @id @default(uuid())
  userId    String
  messageId String
  type      String
  content   String?
  createdAt DateTime @default(now())

  user User @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([messageId])
}
```
