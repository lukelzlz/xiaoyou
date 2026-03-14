# 小悠系统 API 接口文档

## 1. 概述

本文档定义了小悠系统各组件之间的内部 API 接口，以及与外部平台交互的接口规范。

### 1.1 通用约定

- 所有内部接口使用 TypeScript 类型定义
- 异步操作统一返回 `Promise`
- 错误通过 `XiaoyouError` 统一封装
- 时间戳统一使用 ISO 8601 格式

### 1.2 通用类型定义

```typescript
// 通用响应结构
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
  timestamp: string;
}

interface ApiError {
  code: string;
  message: string;
  details?: Record<string, any>;
}

// 分页参数
interface PaginationParams {
  page: number;
  pageSize: number;
}

// 分页响应
interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}
```

## 2. 消息处理 API

### 2.1 消息接收

```typescript
// POST /api/messages/incoming
interface IncomingMessageRequest {
  platform: 'discord' | 'telegram';
  channelId: string;
  userId: string;
  content: string;
  attachments?: Attachment[];
  replyTo?: string;
  metadata?: Record<string, any>;
}

interface Attachment {
  type: 'image' | 'document' | 'audio' | 'video';
  url: string;
  name: string;
  size?: number;
  mimeType?: string;
}

interface IncomingMessageResponse {
  messageId: string;
  status: 'accepted' | 'rejected';
  reason?: string;
}
```

### 2.2 消息发送

```typescript
// POST /api/messages/outgoing
interface OutgoingMessageRequest {
  platform: 'discord' | 'telegram';
  channelId: string;
  content: MessageContent;
  replyTo?: string;
}

type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'embed'; title: string; description: string; fields?: EmbedField[] }
  | { type: 'file'; url: string; name: string }
  | { type: 'image'; url: string; caption?: string };

interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface OutgoingMessageResponse {
  messageId: string;
  status: 'sent' | 'failed';
  error?: string;
}
```

### 2.3 消息状态查询

```typescript
// GET /api/messages/:messageId/status
interface MessageStatusResponse {
  messageId: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  intent?: IntentType;
  scene?: SceneType;
  taskId?: string;
  createdAt: string;
  updatedAt: string;
}
```

## 3. 意图识别 API

### 3.1 意图分析

```typescript
// POST /api/intent/analyze
interface IntentAnalyzeRequest {
  text: string;
  context?: ConversationContext;
  userId?: string;
}

interface IntentAnalyzeResponse {
  intent: IntentType;
  confidence: number;
  entities: Entity[];
  suggestedScene: SceneType;
}

interface Entity {
  type: string;
  value: string;
  start: number;
  end: number;
  confidence: number;
}

interface ConversationContext {
  recentMessages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }>;
  activeTask?: string;
  userPreferences?: Record<string, any>;
}
```

### 3.2 意图类型枚举

```typescript
enum IntentType {
  CHAT_CASUAL = 'chat.casual',
  CHAT_EMOTIONAL = 'chat.emotional',
  CHAT_QUESTION = 'chat.question',
  TOOL_SEARCH = 'tool.search',
  TOOL_EXTRACT = 'tool.extract',
  TOOL_QUERY = 'tool.query',
  TASK_CODE = 'task.code',
  TASK_AUTOMATION = 'task.automation',
  TASK_ANALYSIS = 'task.analysis',
  SCHEDULE_CREATE = 'schedule.create',
  SCHEDULE_MODIFY = 'schedule.modify',
  SCHEDULE_CANCEL = 'schedule.cancel',
  SCHEDULE_QUERY = 'schedule.query',
  FEEDBACK_POSITIVE = 'feedback.positive',
  FEEDBACK_NEGATIVE = 'feedback.negative',
  FEEDBACK_CORRECTION = 'feedback.correction',
}

enum SceneType {
  CHAT = 'chat',
  TOOL = 'tool',
  TASK = 'task',
  SCHEDULE = 'schedule',
}
```

## 4. 任务管理 API

### 4.1 创建任务

```typescript
// POST /api/tasks
interface CreateTaskRequest {
  description: string;
  type: 'code' | 'automation' | 'analysis';
  params?: Record<string, any>;
  userId: string;
  channelId: string;
  priority?: 'low' | 'normal' | 'high';
}

interface CreateTaskResponse {
  taskId: string;
  status: 'created';
  plan?: ExecutionPlan;
  missingParams?: string[];
}
```

### 4.2 查询任务状态

```typescript
// GET /api/tasks/:taskId
interface TaskStatusResponse {
  taskId: string;
  status: 'pending' | 'planning' | 'running' | 'waiting_user' | 'completed' | 'failed' | 'cancelled';
  plan?: ExecutionPlan;
  progress: {
    totalSteps: number;
    completedSteps: number;
    currentStep?: string;
  };
  result?: TaskResult;
  error?: ApiError;
  createdAt: string;
  updatedAt: string;
}
```

### 4.3 控制任务

```typescript
// POST /api/tasks/:taskId/control
interface TaskControlRequest {
  action: 'pause' | 'resume' | 'cancel' | 'retry';
  params?: Record<string, any>;
}

interface TaskControlResponse {
  taskId: string;
  previousStatus: string;
  currentStatus: string;
}
```

### 4.4 补充任务参数

```typescript
// POST /api/tasks/:taskId/params
interface TaskParamsRequest {
  params: Record<string, any>;
}

interface TaskParamsResponse {
  taskId: string;
  status: 'updated';
  missingParams?: string[];
  ready: boolean;
}
```

### 4.5 查询任务列表

```typescript
// GET /api/tasks?userId=xxx&status=running&page=1&pageSize=10
interface TaskListRequest extends PaginationParams {
  userId?: string;
  status?: string;
  type?: string;
}

type TaskListResponse = PaginatedResponse<TaskSummary>;

interface TaskSummary {
  taskId: string;
  description: string;
  type: string;
  status: string;
  progress: number; // 0-100
  createdAt: string;
  updatedAt: string;
}
```

## 5. 规划引擎 API

### 5.1 创建执行计划

```typescript
// POST /api/planner/plan
interface CreatePlanRequest {
  taskDescription: string;
  taskType: string;
  availableTools: string[];
  constraints?: PlanConstraints;
}

interface PlanConstraints {
  maxSteps?: number;
  timeout?: number;
  allowedActions?: string[];
  forbiddenActions?: string[];
}

interface CreatePlanResponse {
  plan: ExecutionPlan;
  validation: PlanValidation;
}

interface ExecutionPlan {
  planId: string;
  description: string;
  steps: ExecutionStep[];
  dependencies: DependencyGraph;
  estimatedDuration: number;
  requiredResources: string[];
}

interface ExecutionStep {
  stepId: string;
  action: string;
  description: string;
  params: Record<string, any>;
  requiredParams: string[];
  optionalParams: string[];
  timeout: number;
  retryPolicy: RetryPolicy;
  onFailure: 'skip' | 'abort' | 'ask_user';
}

interface DependencyGraph {
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
}

interface RetryPolicy {
  maxRetries: number;
  retryInterval: number;
  backoffMultiplier: number;
  maxInterval: number;
}

interface PlanValidation {
  valid: boolean;
  warnings: string[];
  errors: string[];
}
```

### 5.2 更新执行计划

```typescript
// PUT /api/planner/plan/:planId
interface UpdatePlanRequest {
  additionalParams?: Record<string, any>;
  modifiedSteps?: Partial<ExecutionStep>[];
  removedSteps?: string[];
}

interface UpdatePlanResponse {
  plan: ExecutionPlan;
  changes: string[];
}
```

### 5.3 生成 CRON 规则

```typescript
// POST /api/planner/cron
interface GenerateCronRequest {
  naturalLanguage: string;
  timezone?: string;
}

interface GenerateCronResponse {
  rule: CronRule;
  alternatives?: CronRule[];
}

interface CronRule {
  expression: string;
  description: string;
  timezone: string;
  nextExecutions: string[]; // 未来5次执行时间
}
```

## 6. 定时任务 API

### 6.1 创建定时任务

```typescript
// POST /api/schedules
interface CreateScheduleRequest {
  name: string;
  description: string;
  cronExpression: string;
  timezone: string;
  taskTemplate: CreateTaskRequest;
  notifyOnComplete: boolean;
  notifyOnFailure: boolean;
  startTime?: string;
  endTime?: string;
  maxExecutions?: number;
}

interface CreateScheduleResponse {
  scheduleId: string;
  status: 'active';
  nextExecution: string;
}
```

### 6.2 查询定时任务

```typescript
// GET /api/schedules/:scheduleId
interface ScheduleDetailResponse {
  scheduleId: string;
  name: string;
  description: string;
  cronExpression: string;
  timezone: string;
  status: 'active' | 'paused' | 'expired' | 'cancelled';
  nextExecution: string;
  lastExecution?: string;
  executionCount: number;
  maxExecutions?: number;
  createdAt: string;
  updatedAt: string;
}
```

### 6.3 更新定时任务

```typescript
// PUT /api/schedules/:scheduleId
interface UpdateScheduleRequest {
  name?: string;
  description?: string;
  cronExpression?: string;
  timezone?: string;
  notifyOnComplete?: boolean;
  notifyOnFailure?: boolean;
  status?: 'active' | 'paused';
}

interface UpdateScheduleResponse {
  scheduleId: string;
  status: string;
  nextExecution: string;
}
```

### 6.4 删除定时任务

```typescript
// DELETE /api/schedules/:scheduleId
interface DeleteScheduleResponse {
  scheduleId: string;
  status: 'cancelled';
}
```

### 6.5 查询定时任务列表

```typescript
// GET /api/schedules?userId=xxx&status=active
interface ScheduleListRequest extends PaginationParams {
  userId?: string;
  status?: string;
}

type ScheduleListResponse = PaginatedResponse<ScheduleSummary>;

interface ScheduleSummary {
  scheduleId: string;
  name: string;
  cronExpression: string;
  status: string;
  nextExecution: string;
  executionCount: number;
}
```

### 6.6 查询执行历史

```typescript
// GET /api/schedules/:scheduleId/history
interface ScheduleHistoryRequest extends PaginationParams {}

type ScheduleHistoryResponse = PaginatedResponse<ScheduleExecution>;

interface ScheduleExecution {
  executionId: string;
  scheduleId: string;
  status: 'success' | 'failed' | 'skipped';
  startedAt: string;
  completedAt: string;
  duration: number;
  result?: any;
  error?: string;
}
```

## 7. 记忆系统 API

### 7.1 读取热记忆

```typescript
// GET /api/memory/hot/:sessionId
interface HotMemoryResponse {
  sessionId: string;
  userId: string;
  conversationHistory: ConversationTurn[];
  activeTasks: ActiveTask[];
  userPreferences: UserPreferences;
  contextVariables: Record<string, any>;
  lastUpdated: string;
}

interface ConversationTurn {
  turnId: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  intent?: IntentType;
  entities?: Entity[];
}

interface ActiveTask {
  taskId: string;
  description: string;
  status: string;
  progress: number;
}

interface UserPreferences {
  language: string;
  responseStyle: string;
  timezone: string;
  notificationSettings: NotificationSettings;
}

interface NotificationSettings {
  enabled: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  channels: string[];
}
```

### 7.2 更新热记忆

```typescript
// PATCH /api/memory/hot/:sessionId
interface UpdateHotMemoryRequest {
  conversationTurn?: ConversationTurn;
  activeTask?: ActiveTask;
  userPreferences?: Partial<UserPreferences>;
  contextVariables?: Record<string, any>;
}

interface UpdateHotMemoryResponse {
  sessionId: string;
  updated: boolean;
}
```

### 7.3 向量记忆检索

```typescript
// POST /api/memory/vector/search
interface VectorSearchRequest {
  query: string;
  userId: string;
  topK?: number;
  threshold?: number;
  type?: 'conversation' | 'task' | 'preference' | 'knowledge';
  timeRange?: {
    start: string;
    end: string;
  };
}

interface VectorSearchResponse {
  results: VectorSearchResult[];
  totalFound: number;
}

interface VectorSearchResult {
  id: string;
  content: string;
  score: number;
  metadata: {
    type: string;
    userId: string;
    sessionId?: string;
    taskId?: string;
    importance: number;
    tags: string[];
  };
  createdAt: string;
}
```

### 7.4 记忆归档

```typescript
// POST /api/memory/flush
interface MemoryFlushRequest {
  sessionId: string;
}

interface MemoryFlushResponse {
  sessionId: string;
  archivedItems: number;
  status: 'completed' | 'partial' | 'failed';
}
```

## 8. 工具调用 API

### 8.1 搜索工具

```typescript
// POST /api/tools/search
interface SearchToolRequest {
  query: string;
  engine?: 'google' | 'bing' | 'duckduckgo';
  maxResults?: number;
  language?: string;
}

interface SearchToolResponse {
  results: SearchResult[];
  totalResults: number;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}
```

### 8.2 内容提取工具

```typescript
// POST /api/tools/extract
interface ExtractToolRequest {
  url: string;
  extractType: 'text' | 'summary' | 'structured';
  options?: {
    maxLength?: number;
    format?: 'markdown' | 'plain' | 'json';
  };
}

interface ExtractToolResponse {
  content: string;
  metadata: {
    title?: string;
    author?: string;
    publishDate?: string;
    wordCount: number;
  };
}
```

### 8.3 查询工具

```typescript
// POST /api/tools/query
interface QueryToolRequest {
  source: string;
  query: string;
  params?: Record<string, any>;
}

interface QueryToolResponse {
  data: any;
  format: 'json' | 'table' | 'text';
  rowCount?: number;
}
```

## 9. 用户反馈 API

### 9.1 提交反馈

```typescript
// POST /api/feedback
interface FeedbackRequest {
  userId: string;
  messageId: string;
  type: 'positive' | 'negative' | 'correction';
  content?: string;
  correctedResponse?: string;
}

interface FeedbackResponse {
  feedbackId: string;
  status: 'received';
}
```

### 9.2 查询用户画像

```typescript
// GET /api/users/:userId/profile
interface UserProfileResponse {
  userId: string;
  preferences: UserPreferences;
  stats: {
    totalMessages: number;
    totalTasks: number;
    taskSuccessRate: number;
    feedbackScore: number;
  };
  recentTopics: string[];
  createdAt: string;
  lastActiveAt: string;
}
```

## 10. 系统管理 API

### 10.1 健康检查

```typescript
// GET /api/health
interface HealthCheckResponse {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  uptime: number;
  components: {
    redis: ComponentHealth;
    qdrant: ComponentHealth;
    database: ComponentHealth;
    glm: ComponentHealth;
    nemotron: ComponentHealth;
    openclaw: ComponentHealth;
  };
}

interface ComponentHealth {
  status: 'healthy' | 'unhealthy' | 'unknown';
  latency?: number;
  lastCheck: string;
  error?: string;
}
```

### 10.2 系统指标

```typescript
// GET /api/metrics
interface SystemMetricsResponse {
  system: {
    cpuUsage: number;
    memoryUsage: number;
    diskUsage: number;
  };
  application: {
    requestsPerMinute: number;
    averageResponseTime: number;
    errorRate: number;
    activeConnections: number;
  };
  business: {
    activeUsers: number;
    messagesProcessed: number;
    tasksRunning: number;
    scheduledTasks: number;
  };
}
```

## 11. WebSocket 事件

### 11.1 任务进度推送

```typescript
// WS /ws/tasks/:taskId
interface TaskProgressEvent {
  type: 'task.progress';
  taskId: string;
  step: string;
  progress: number;
  message: string;
  timestamp: string;
}

interface TaskCompletedEvent {
  type: 'task.completed';
  taskId: string;
  result: any;
  duration: number;
  timestamp: string;
}

interface TaskFailedEvent {
  type: 'task.failed';
  taskId: string;
  error: ApiError;
  step?: string;
  timestamp: string;
}

interface TaskNeedConfirmEvent {
  type: 'task.need_confirm';
  taskId: string;
  question: string;
  options: string[];
  timestamp: string;
}
```

### 11.2 系统通知推送

```typescript
// WS /ws/notifications/:userId
interface NotificationEvent {
  type: 'notification';
  category: 'task' | 'schedule' | 'system' | 'alert';
  title: string;
  message: string;
  data?: Record<string, any>;
  timestamp: string;
}
```

## 12. 错误码定义

| 错误码 | 说明 | HTTP 状态码 |
|--------|------|-------------|
| `ERR_INVALID_INPUT` | 输入参数无效 | 400 |
| `ERR_UNAUTHORIZED` | 未授权 | 401 |
| `ERR_FORBIDDEN` | 权限不足 | 403 |
| `ERR_NOT_FOUND` | 资源不存在 | 404 |
| `ERR_RATE_LIMIT` | 请求频率超限 | 429 |
| `ERR_INTERNAL` | 内部错误 | 500 |
| `ERR_LLM_TIMEOUT` | LLM 服务超时 | 504 |
| `ERR_LLM_ERROR` | LLM 服务错误 | 502 |
| `ERR_TOOL_ERROR` | 工具调用失败 | 502 |
| `ERR_PLAN_INVALID` | 执行计划无效 | 422 |
| `ERR_TASK_CANCELLED` | 任务已取消 | 409 |
| `ERR_SCHEDULE_CONFLICT` | 定时任务冲突 | 409 |
| `ERR_MEMORY_FULL` | 记忆存储已满 | 507 |
