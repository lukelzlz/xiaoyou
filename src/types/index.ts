// 意图类型枚举
export enum IntentType {
  // 聊天类
  CHAT_CASUAL = 'chat.casual',
  CHAT_EMOTIONAL = 'chat.emotional',
  CHAT_QUESTION = 'chat.question',

  // 工具类
  TOOL_SEARCH = 'tool.search',
  TOOL_EXTRACT = 'tool.extract',
  TOOL_QUERY = 'tool.query',

  // 任务类
  TASK_CODE = 'task.code',
  TASK_AUTOMATION = 'task.automation',
  TASK_ANALYSIS = 'task.analysis',

  // 定时类
  SCHEDULE_CREATE = 'schedule.create',
  SCHEDULE_MODIFY = 'schedule.modify',
  SCHEDULE_CANCEL = 'schedule.cancel',
  SCHEDULE_QUERY = 'schedule.query',

  // 反馈类
  FEEDBACK_POSITIVE = 'feedback.positive',
  FEEDBACK_NEGATIVE = 'feedback.negative',
  FEEDBACK_CORRECTION = 'feedback.correction',
}

// 场景类型枚举
export enum SceneType {
  CHAT = 'chat',
  TOOL = 'tool',
  TASK = 'task',
  SCHEDULE = 'schedule',
}

// 意图识别结果
export interface Intent {
  type: IntentType;
  confidence: number;
  entities: Entity[];
}

// 实体
export interface Entity {
  type: string;
  value: string;
  start: number;
  end: number;
  confidence?: number;
}

// 平台类型
export type Platform = 'discord' | 'telegram';

// 附件类型
export interface Attachment {
  type: 'image' | 'document' | 'audio' | 'video';
  url: string;
  name: string;
  size?: number;
  mimeType?: string;
}

// 原始消息
export interface RawMessage {
  platform: Platform;
  channelId: string;
  userId: string;
  content: string;
  attachments?: Attachment[];
  timestamp: number;
  guildId?: string;
  replyTo?: string;
}

// 解析后的消息
export interface ParsedMessage {
  id: string;
  platform: Platform;
  channelId: string;
  userId: string;
  rawContent: string;
  textContent: string;
  entities: Entity[];
  attachments: Attachment[];
  timestamp: Date;
  metadata: {
    platform: Platform;
    guildId?: string;
    replyTo?: string;
  };
}

// 响应内容
export type ResponseContent =
  | { type: 'text'; content: string }
  | { type: 'embed'; title: string; description: string; fields?: EmbedField[] }
  | { type: 'file'; url: string; name: string }
  | { type: 'image'; url: string; caption?: string };

export interface EmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

// 对话轮次
export interface ConversationTurn {
  turnId: string;
  timestamp: Date;
  role: 'user' | 'assistant' | 'system';
  content: string;
  intent?: IntentType;
  entities?: Entity[];
  sentiment?: string;
}

// 活动任务
export interface ActiveTask {
  taskId: string;
  description: string;
  status: string;
  progress: number;
}

// 用户偏好
export interface UserPreferences {
  language: string;
  responseStyle: 'concise' | 'detailed' | 'casual' | 'formal';
  timezone: string;
  notificationSettings: NotificationSettings;
  customSettings?: Record<string, unknown>;
}

// 通知设置
export interface NotificationSettings {
  enabled: boolean;
  quietHoursStart?: string;
  quietHoursEnd?: string;
  channels: string[];
}

// 热记忆
export interface HotMemory {
  sessionId: string;
  userId: string;
  conversationHistory: ConversationTurn[];
  activeTasks: ActiveTask[];
  userPreferences: UserPreferences;
  contextVariables: Record<string, unknown>;
  lastUpdated: Date;
  ttl: number;
}

// 向量记忆
export interface VectorMemory {
  id: string;
  content: string;
  embedding: number[];
  metadata: VectorMetadata;
  createdAt: Date;
  expiresAt?: Date;
}

// 向量元数据
export interface VectorMetadata {
  type: 'conversation' | 'task' | 'preference' | 'knowledge';
  userId: string;
  sessionId?: string;
  taskId?: string;
  importance: number;
  accessCount: number;
  tags: string[];
}

// 检索选项
export interface RetrievalOptions {
  topK?: number;
  threshold?: number;
  userId?: string;
  type?: VectorMetadata['type'];
  timeRange?: {
    start: Date;
    end: Date;
  };
}

// 执行计划
export interface ExecutionPlan {
  planId: string;
  description: string;
  steps: ExecutionStep[];
  dependencies: DependencyGraph;
  estimatedDuration: number;
  requiredResources: string[];
}

// 执行步骤
export interface ExecutionStep {
  stepId: string;
  action: string;
  description?: string;
  params: Record<string, unknown>;
  requiredParams: string[];
  optionalParams: string[];
  timeout: number;
  retryPolicy: RetryPolicy;
  onFailure: 'skip' | 'abort' | 'ask_user';
}

// 依赖图
export interface DependencyGraph {
  nodes: string[];
  edges: Array<{ from: string; to: string }>;
}

// 重试策略
export interface RetryPolicy {
  maxRetries: number;
  retryInterval: number;
  backoffMultiplier: number;
  maxInterval: number;
  retryableErrors: string[];
}

// 步骤结果
export interface StepResult {
  stepId: string;
  status: 'success' | 'failed' | 'skipped';
  output?: unknown;
  error?: Error;
  duration: number;
}

// 计划结果
export interface PlanResult {
  planId: string;
  status: 'success' | 'partial' | 'failed' | 'cancelled';
  stepResults: StepResult[];
  totalDuration: number;
  artifacts?: Artifact[];
}

// 产物
export interface Artifact {
  type: string;
  name: string;
  content: string;
  url?: string;
}

// CRON 规则
export interface CronRule {
  expression: string;
  description: string;
  timezone: string;
  startTime?: Date;
  endTime?: Date;
  maxExecutions?: number;
}

// 定时任务
export interface ScheduleTask {
  id: string;
  userId: string;
  name: string;
  description?: string;
  rule: CronRule;
  plan: ExecutionPlan;
  notifyOnComplete: boolean;
  notifyOnFailure: boolean;
  status: 'active' | 'paused' | 'expired' | 'cancelled';
  executionCount: number;
  lastExecution?: Date;
  nextExecution?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// 任务描述
export interface TaskDescription {
  description: string;
  type: string;
  availableTools?: string[];
  constraints?: PlanConstraints;
}

// 计划约束
export interface PlanConstraints {
  maxSteps?: number;
  timeout?: number;
  allowedActions?: string[];
  forbiddenActions?: string[];
}

// 执行状态
export interface ExecutionStatus {
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'waiting_user';
  currentStep?: string;
  completedSteps: string[];
  failedSteps: string[];
  error?: Error;
}

// 消息处理器类型
export type MessageHandler = (message: ParsedMessage) => Promise<ResponseContent>;

// 平台适配器接口
export interface PlatformAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(channelId: string, content: ResponseContent): Promise<void>;
  sendTyping(channelId: string): Promise<void>;
}
