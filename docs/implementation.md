# 小悠系统实现指南

## 1. 技术栈选型

### 1.1 核心技术栈

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| 运行时 | Node.js 20+ / Bun | 高性能 JavaScript 运行时 |
| 语言 | TypeScript 5.0+ | 类型安全，提升开发体验 |
| 框架 | Hono / Fastify | 轻量级 Web 框架 |
| ORM | Prisma / Drizzle | 数据库 ORM |
| 消息队列 | BullMQ / Redis | 任务队列和调度 |
| 向量数据库 | Qdrant / Milvus | 长期记忆存储 |
| 缓存 | Redis | 热记忆和缓存 |

### 1.2 AI/ML 技术栈

| 组件 | 技术选型 | 说明 |
|------|----------|------|
| LLM SDK | LangChain.js / LlamaIndex | LLM 应用开发框架 |
| Embedding | OpenAI Embeddings / BGE | 文本向量化 |
| 向量检索 | Qdrant Client | 向量相似度搜索 |

### 1.3 平台 SDK

| 平台 | SDK | 说明 |
|------|-----|------|
| Discord | discord.js | Discord 机器人开发 |
| Telegram | grammy / telegraf | Telegram Bot API |

## 2. 项目结构

```
xiaoyou/
├── src/
│   ├── adapters/           # 平台适配器
│   │   ├── discord/
│   │   │   ├── index.ts
│   │   │   ├── handlers.ts
│   │   │   └── types.ts
│   │   └── telegram/
│   │       ├── index.ts
│   │       ├── handlers.ts
│   │       └── types.ts
│   │
│   ├── gateway/            # 网关层
│   │   ├── parser.ts       # 消息解析
│   │   ├── multimodal.ts   # 多模态提取
│   │   └── ratelimit.ts    # 速率限制
│   │
│   ├── controller/         # 控制层
│   │   ├── intent.ts       # 意图识别
│   │   ├── router.ts       # 场景路由
│   │   └── context.ts      # 上下文管理
│   │
│   ├── services/           # 服务层
│   │   ├── chat/           # 聊天服务
│   │   ├── tool/           # 工具服务
│   │   ├── task/           # 任务服务
│   │   └── schedule/       # 定时服务
│   │
│   ├── executor/           # 执行层
│   │   ├── planner.ts      # 规划引擎
│   │   ├── executor.ts     # 执行引擎
│   │   └── scheduler.ts    # 调度引擎
│   │
│   ├── memory/             # 记忆系统
│   │   ├── hot.ts          # 热记忆
│   │   ├── vector.ts       # 向量记忆
│   │   └── flush.ts        # 记忆归档
│   │
│   ├── llm/                # LLM 集成
│   │   ├── glm.ts          # GLM-4.5-Air
│   │   ├── nemotron.ts     # Nemotron
│   │   └── prompts/        # Prompt 模板
│   │
│   ├── tools/              # 工具集
│   │   ├── search.ts
│   │   ├── extract.ts
│   │   └── query.ts
│   │
│   ├── openclaw/           # OpenClaw 集成
│   │   ├── agent.ts
│   │   └── cron.ts
│   │
│   ├── utils/              # 工具函数
│   │   ├── logger.ts
│   │   ├── error.ts
│   │   └── helpers.ts
│   │
│   ├── config/             # 配置
│   │   ├── index.ts
│   │   └── env.ts
│   │
│   └── index.ts            # 入口文件
│
├── prisma/                 # 数据库 Schema
│   └── schema.prisma
│
├── docs/                   # 文档
│   ├── design.md
│   ├── implementation.md
│   ├── api.md
│   └── configuration.md
│
├── tests/                  # 测试
│   ├── unit/
│   └── integration/
│
├── scripts/                # 脚本
│   └── seed.ts
│
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## 3. 核心模块实现

### 3.1 消息入口实现

Discord 和 Telegram 接入由系统自行实现，不依赖 OpenClaw Gateway。

```typescript
// src/index.ts
import { DiscordAdapter } from './adapters/discord';
import { TelegramAdapter } from './adapters/telegram';
import { GatewayService } from './gateway';
import { ControllerService } from './controller';
import { config } from './config';

async function main() {
  // 初始化服务
  const gateway = new GatewayService();
  const controller = new ControllerService();

  // 初始化 Discord 适配器
  const discordAdapter = new DiscordAdapter({
    token: config.discord.token,
    gateway,
    controller,
  });

  // 初始化 Telegram 适配器
  const telegramAdapter = new TelegramAdapter({
    token: config.telegram.token,
    gateway,
    controller,
  });

  // 启动服务
  await Promise.all([
    discordAdapter.start(),
    telegramAdapter.start(),
  ]);

  console.log('小悠系统已启动');
}

main().catch(console.error);
```

### 3.2 平台适配器实现

```typescript
// src/adapters/discord/index.ts
import { Client, GatewayIntentBits, Message } from 'discord.js';
import { PlatformAdapter, MessageHandler } from '../../types';

export class DiscordAdapter implements PlatformAdapter {
  private client: Client;
  private gateway: GatewayService;
  private controller: ControllerService;

  constructor(options: DiscordOptions) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
    this.gateway = options.gateway;
    this.controller = options.controller;
  }

  async start(): Promise<void> {
    // 注册消息处理器
    this.client.on('messageCreate', this.handleMessage.bind(this));
    
    // 注册交互处理器
    this.client.on('interactionCreate', this.handleInteraction.bind(this));
    
    // 登录
    await this.client.login(this.options.token);
  }

  private async handleMessage(message: Message): Promise<void> {
    // 忽略机器人消息
    if (message.author.bot) return;

    try {
      // 1. 解析消息
      const parsed = this.gateway.parseMessage({
        platform: 'discord',
        channelId: message.channelId,
        userId: message.author.id,
        content: message.content,
        attachments: message.attachments.map(a => ({
          type: this.getAttachmentType(a),
          url: a.url,
          name: a.name,
        })),
        timestamp: message.createdTimestamp,
      });

      // 2. 发送即时回执
      if (this.needsTyping(parsed)) {
        await message.channel.sendTyping();
      }

      // 3. 处理消息
      const response = await this.controller.handleMessage(parsed);

      // 4. 发送响应
      await this.sendResponse(message, response);

    } catch (error) {
      console.error('处理消息失败:', error);
      await message.reply('抱歉，处理您的请求时出现了问题。');
    }
  }

  private async sendResponse(
    message: Message,
    response: ResponseContent
  ): Promise<void> {
    if (response.type === 'text') {
      await message.reply(response.content);
    } else if (response.type === 'embed') {
      await message.reply({ embeds: [response.embed] });
    } else if (response.type === 'file') {
      await message.reply({ files: [response.file] });
    }
  }
}
```

### 3.3 Telegram 适配器实现

```typescript
// src/adapters/telegram/index.ts
import { Bot, Context } from 'grammy';
import { PlatformAdapter } from '../../types';

export class TelegramAdapter implements PlatformAdapter {
  private bot: Bot;
  private gateway: GatewayService;
  private controller: ControllerService;

  constructor(options: TelegramOptions) {
    this.bot = new Bot(options.token);
    this.gateway = options.gateway;
    this.controller = options.controller;
  }

  async start(): Promise<void> {
    // 注册消息处理器
    this.bot.on('message', this.handleMessage.bind(this));
    
    // 注册回调查询处理器
    this.bot.on('callback_query', this.handleCallback.bind(this));
    
    // 启动
    await this.bot.start();
  }

  private async handleMessage(ctx: Context): Promise<void> {
    const message = ctx.message!;
    
    // 忽略机器人消息
    if (message.from?.is_bot) return;

    try {
      // 1. 解析消息
      const parsed = this.gateway.parseMessage({
        platform: 'telegram',
        channelId: String(message.chat.id),
        userId: String(message.from?.id),
        content: message.text || '',
        attachments: this.extractAttachments(message),
        timestamp: message.date * 1000,
      });

      // 2. 发送即时回执
      await ctx.replyWithChatAction('typing');

      // 3. 处理消息
      const response = await this.controller.handleMessage(parsed);

      // 4. 发送响应
      await this.sendResponse(ctx, response);

    } catch (error) {
      console.error('处理消息失败:', error);
      await ctx.reply('抱歉，处理您的请求时出现了问题。');
    }
  }

  private async sendResponse(ctx: Context, response: ResponseContent): Promise<void> {
    if (response.type === 'text') {
      await ctx.reply(response.content);
    } else if (response.type === 'image') {
      await ctx.replyWithPhoto(response.url, { caption: response.caption });
    } else if (response.type === 'file') {
      await ctx.replyWithDocument(response.url);
    }
  }
}
```

### 3.4 OpenClaw Agent 集成（执行引擎）

基于 [OpenClaw](https://docs.openclaw.ai/zh-CN) 的任务执行引擎实现。

```typescript
// src/executor/openclaw-agent.ts
import { OpenClawClient } from 'openclaw-sdk';

export class OpenClawAgent {
  private client: OpenClawClient;

  constructor(config: OpenClawConfig) {
    this.client = new OpenClawClient({
      apiUrl: config.apiUrl,
      apiKey: config.apiKey,
    });
  }

  // 执行任务
  async executeTask(plan: ExecutionPlan): Promise<TaskResult> {
    const task = await this.client.createTask({
      type: 'multi_step',
      steps: plan.steps.map(step => ({
        action: step.action,
        params: step.params,
        timeout: step.timeout,
      })),
      dependencies: plan.dependencies,
    });

    // 等待任务完成
    return await this.waitForCompletion(task.id);
  }

  // 创建定时任务
  async createCronTask(schedule: ScheduleConfig): Promise<CronTask> {
    return await this.client.createCron({
      expression: schedule.cronExpression,
      task: schedule.taskTemplate,
      timezone: schedule.timezone,
    });
  }

  // 更新定时任务
  async updateCronTask(taskId: string, updates: Partial<ScheduleConfig>): Promise<void> {
    await this.client.updateCron(taskId, updates);
  }

  // 删除定时任务
  async deleteCronTask(taskId: string): Promise<void> {
    await this.client.deleteCron(taskId);
  }

  // 获取任务状态
  async getTaskStatus(taskId: string): Promise<TaskStatus> {
    return await this.client.getTask(taskId);
  }

  // 主动推送消息
  async pushNotification(userId: string, message: string): Promise<void> {
    await this.client.sendNotification({
      userId,
      message,
      timestamp: new Date().toISOString(),
    });
  }

  private async waitForCompletion(taskId: string): Promise<TaskResult> {
    return new Promise((resolve, reject) => {
      const poll = async () => {
        const status = await this.getTaskStatus(taskId);
        
        if (status.state === 'completed') {
          resolve(status.result);
        } else if (status.state === 'failed') {
          reject(new Error(status.error));
        } else {
          setTimeout(poll, 1000);
        }
      };
      
      poll();
    });
  }
}
```

### 3.5 OpenClaw CRON 集成（定时调度）

```typescript
// src/executor/openclaw-cron.ts
import { OpenClawClient } from 'openclaw-sdk';

export class OpenClawCron {
  private client: OpenClawClient;

  constructor(config: OpenClawConfig) {
    this.client = new OpenClawClient(config);
  }

  // 注册定时任务
  async register(rule: CronRule, task: TaskTemplate): Promise<string> {
    const cronTask = await this.client.createCron({
      expression: rule.expression,
      timezone: rule.timezone,
      task: {
        type: task.type,
        params: task.params,
        callback: task.callback,
      },
      startTime: rule.startTime,
      endTime: rule.endTime,
      maxExecutions: rule.maxExecutions,
    });

    return cronTask.id;
  }

  // 更新定时任务
  async update(taskId: string, rule: Partial<CronRule>): Promise<void> {
    await this.client.updateCron(taskId, {
      expression: rule.expression,
      timezone: rule.timezone,
    });
  }

  // 取消定时任务
  async cancel(taskId: string): Promise<void> {
    await this.client.deleteCron(taskId);
  }

  // 获取下次执行时间
  async getNextExecution(taskId: string): Promise<Date> {
    const task = await this.client.getCron(taskId);
    return new Date(task.nextExecution);
  }

  // 获取所有定时任务
  async listTasks(userId: string): Promise<CronTask[]> {
    return await this.client.listCrons({ userId });
  }
}
```

## 4. OpenClaw 安装与配置

### 4.1 安装 OpenClaw

```bash
# 全局安装 OpenClaw
npm install -g openclaw@latest

# 运行新手引导
openclaw onboard --install-daemon
```

### 4.2 OpenClaw 配置

OpenClaw 作为执行引擎，配置文件位于 `~/.openclaw/openclaw.json`：

```json
{
  "agents": {
    "xiaoyou": {
      "endpoint": "http://localhost:3000/api/callback",
      "timeout": 300000
    }
  },
  "cron": {
    "enabled": true,
    "timezone": "Asia/Shanghai"
  }
}
```

## 5. 测试与部署

### 5.1 本地开发测试

```bash
# 1. 启动 OpenClaw 服务
openclaw start

# 2. 启动小悠服务
npm run dev
```

### 5.2 生产部署

```bash
# 使用 Docker Compose
docker-compose up -d

# 或使用 PM2
pm2 start dist/index.js --name xiaoyou
```
  await Promise.all([
    discordAdapter.start(),
    telegramAdapter.start(),
  ]);

  console.log('小悠系统已启动');
}

main().catch(console.error);
```

### 3.2 平台适配器实现

```typescript
// src/adapters/discord/index.ts
import { Client, GatewayIntentBits, Message } from 'discord.js';
import { PlatformAdapter, MessageHandler } from '../../types';

export class DiscordAdapter implements PlatformAdapter {
  private client: Client;
  private gateway: GatewayService;
  private controller: ControllerService;

  constructor(options: DiscordOptions) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });
    this.gateway = options.gateway;
    this.controller = options.controller;
  }

  async start(): Promise<void> {
    // 注册消息处理器
    this.client.on('messageCreate', this.handleMessage.bind(this));
    
    // 注册交互处理器
    this.client.on('interactionCreate', this.handleInteraction.bind(this));
    
    // 登录
    await this.client.login(this.options.token);
  }

  private async handleMessage(message: Message): Promise<void> {
    // 忽略机器人消息
    if (message.author.bot) return;

    try {
      // 1. 解析消息
      const parsed = this.gateway.parseMessage({
        platform: 'discord',
        channelId: message.channelId,
        userId: message.author.id,
        content: message.content,
        attachments: message.attachments.map(a => ({
          type: this.getAttachmentType(a),
          url: a.url,
          name: a.name,
        })),
        timestamp: message.createdTimestamp,
      });

      // 2. 发送即时回执
      if (this.needsTyping(parsed)) {
        await message.channel.sendTyping();
      }

      // 3. 处理消息
      const response = await this.controller.handleMessage(parsed);

      // 4. 发送响应
      await this.sendResponse(message, response);

    } catch (error) {
      console.error('处理消息失败:', error);
      await message.reply('抱歉，处理您的请求时出现了问题。');
    }
  }

  private async sendResponse(
    message: Message,
    response: ResponseContent
  ): Promise<void> {
    if (response.type === 'text') {
      await message.reply(response.content);
    } else if (response.type === 'embed') {
      await message.reply({ embeds: [response.embed] });
    } else if (response.type === 'file') {
      await message.reply({ files: [response.file] });
    }
  }
}
```

### 3.3 网关层实现

```typescript
// src/gateway/parser.ts
import { ParsedMessage, RawMessage } from '../types';

export class MessageParser {
  parse(raw: RawMessage): ParsedMessage {
    return {
      id: this.generateId(),
      platform: raw.platform,
      channelId: raw.channelId,
      userId: raw.userId,
      
      // 原始内容
      rawContent: raw.content,
      
      // 清理后的文本
      textContent: this.cleanText(raw.content),
      
      // 提取的实体
      entities: this.extractEntities(raw.content),
      
      // 附件信息
      attachments: raw.attachments || [],
      
      // 时间戳
      timestamp: new Date(raw.timestamp),
      
      // 元数据
      metadata: {
        platform: raw.platform,
        guildId: raw.guildId,
        replyTo: raw.replyTo,
      },
    };
  }

  private cleanText(content: string): string {
    // 移除 @mention
    let cleaned = content.replace(/<@!?\d+>/g, '');
    // 移除多余空白
    cleaned = cleaned.replace(/\s+/g, ' ').trim();
    return cleaned;
  }

  private extractEntities(content: string): Entity[] {
    const entities: Entity[] = [];

    // 提取 URL
    const urlRegex = /https?:\/\/[^\s]+/g;
    let match;
    while ((match = urlRegex.exec(content)) !== null) {
      entities.push({ 
        type: 'url', 
        value: match[0], 
        start: match.index, 
        end: match.index + match[0].length 
      });
    }

    // 提取日期时间
    const dateRegex = /\d{4}[-/]\d{1,2}[-/]\d{1,2}/g;
    while ((match = dateRegex.exec(content)) !== null) {
      entities.push({ 
        type: 'date', 
        value: match[0], 
        start: match.index, 
        end: match.index + match[0].length 
      });
    }

    return entities;
  }
}
```

```typescript
// src/gateway/multimodal.ts
import { Attachment, MultimodalContent } from '../types';

export class MultimodalExtractor {
  async extract(attachments: Attachment[]): Promise<MultimodalContent[]> {
    const contents: MultimodalContent[] = [];

    for (const attachment of attachments) {
      switch (attachment.type) {
        case 'image':
          contents.push(await this.extractFromImage(attachment));
          break;
        case 'document':
          contents.push(await this.extractFromDocument(attachment));
          break;
        case 'audio':
          contents.push(await this.extractFromAudio(attachment));
          break;
      }
    }

    return contents;
  }

  private async extractFromImage(attachment: Attachment): Promise<MultimodalContent> {
    // 使用 OCR 或图像识别服务
    const ocrResult = await this.ocrService.recognize(attachment.url);
    
    return {
      type: 'image',
      url: attachment.url,
      extractedText: ocrResult.text,
      labels: ocrResult.labels,
      confidence: ocrResult.confidence,
    };
  }

  private async extractFromDocument(attachment: Attachment): Promise<MultimodalContent> {
    // 解析文档内容
    const content = await this.documentParser.parse(attachment.url);
    
    return {
      type: 'document',
      url: attachment.url,
      extractedText: content.text,
      metadata: content.metadata,
    };
  }
}
```

### 3.4 控制层实现

```typescript
// src/controller/intent.ts
import { GLMService } from '../llm/glm';
import { Intent, IntentType } from '../types';

export class IntentRecognizer {
  constructor(private glm: GLMService) {}

  async recognize(message: ParsedMessage): Promise<Intent> {
    // 使用 GLM 进行意图识别
    const prompt = this.buildIntentPrompt(message);
    const response = await this.glm.chat(prompt);
    
    // 解析响应
    const intent = this.parseIntentResponse(response);
    
    return intent;
  }

  private buildIntentPrompt(message: ParsedMessage): string {
    return `
你是一个意图识别系统。请分析以下用户消息，识别其意图。

用户消息：${message.textContent}

请从以下意图中选择最合适的一个：
- chat.casual: 日常闲聊
- chat.emotional: 情感陪伴
- chat.question: 简单问答
- tool.search: 搜索信息
- tool.extract: 提取信息
- tool.query: 查询数据
- task.code: 代码相关
- task.automation: 自动化任务
- task.analysis: 分析任务
- schedule.create: 创建定时任务
- schedule.modify: 修改定时任务
- schedule.cancel: 取消定时任务
- schedule.query: 查询定时任务

请以 JSON 格式返回：
{
  "intent": "意图类型",
  "confidence": 0.95,
  "entities": []
}
`;
  }

  private parseIntentResponse(response: string): Intent {
    try {
      const parsed = JSON.parse(response);
      return {
        type: parsed.intent as IntentType,
        confidence: parsed.confidence,
        entities: parsed.entities || [],
      };
    } catch {
      // 默认返回聊天意图
      return {
        type: IntentType.CHAT_CASUAL,
        confidence: 0.5,
        entities: [],
      };
    }
  }
}
```

```typescript
// src/controller/router.ts
import { Intent, SceneType } from '../types';
import { ChatService } from '../services/chat';
import { ToolService } from '../services/tool';
import { TaskService } from '../services/task';
import { ScheduleService } from '../services/schedule';

export class SceneRouter {
  private services: Map<SceneType, any>;

  constructor() {
    this.services = new Map([
      [SceneType.CHAT, new ChatService()],
      [SceneType.TOOL, new ToolService()],
      [SceneType.TASK, new TaskService()],
      [SceneType.SCHEDULE, new ScheduleService()],
    ]);
  }

  route(intent: Intent): SceneHandler {
    const scene = this.mapIntentToScene(intent);
    const service = this.services.get(scene);
    
    if (!service) {
      throw new Error(`Unknown scene: ${scene}`);
    }

    return service;
  }

  private mapIntentToScene(intent: Intent): SceneType {
    const mapping: Record<string, SceneType> = {
      'chat.': SceneType.CHAT,
      'tool.': SceneType.TOOL,
      'task.': SceneType.TASK,
      'schedule.': SceneType.SCHEDULE,
    };

    for (const [prefix, scene] of Object.entries(mapping)) {
      if (intent.type.startsWith(prefix)) {
        return scene;
      }
    }

    return SceneType.CHAT;
  }
}
```

### 3.5 记忆系统实现

```typescript
// src/memory/hot.ts
import { Redis } from 'ioredis';
import { HotMemory, ConversationTurn } from '../types';

export class HotMemoryStore {
  private redis: Redis;
  private ttl: number = 3600; // 1小时

  constructor(redis: Redis) {
    this.redis = redis;
  }

  async get(sessionId: string): Promise<HotMemory | null> {
    const key = this.getKey(sessionId);
    const data = await this.redis.get(key);
    
    if (!data) return null;
    
    return JSON.parse(data);
  }

  async update(sessionId: string, updates: Partial<HotMemory>): Promise<void> {
    const key = this.getKey(sessionId);
    const existing = await this.get(sessionId);
    
    const updated: HotMemory = {
      ...existing,
      ...updates,
      lastUpdated: new Date(),
    };
    
    await this.redis.setex(key, this.ttl, JSON.stringify(updated));
  }

  async addConversationTurn(
    sessionId: string,
    turn: ConversationTurn
  ): Promise<void> {
    const memory = await this.get(sessionId);
    
    if (!memory) {
      await this.create(sessionId, turn);
      return;
    }
    
    // 限制历史长度
    const maxHistory = 50;
    const history = memory.conversationHistory.slice(-maxHistory + 1);
    history.push(turn);
    
    await this.update(sessionId, {
      conversationHistory: history,
    });
  }

  private getKey(sessionId: string): string {
    return `hot_memory:${sessionId}`;
  }

  private async create(sessionId: string, firstTurn: ConversationTurn): Promise<void> {
    const memory: HotMemory = {
      sessionId,
      conversationHistory: [firstTurn],
      activeTasks: [],
      userPreferences: {},
      contextVariables: {},
      lastUpdated: new Date(),
      ttl: this.ttl,
    };
    
    const key = this.getKey(sessionId);
    await this.redis.setex(key, this.ttl, JSON.stringify(memory));
  }
}
```

```typescript
// src/memory/vector.ts
import { QdrantClient } from '@qdrant/js-client-rest';
import { VectorMemory, RetrievalOptions } from '../types';
import { EmbeddingService } from '../llm/embedding';

export class VectorMemoryStore {
  private client: QdrantClient;
  private embedding: EmbeddingService;
  private collectionName = 'xiaoyou_memories';

  constructor(client: QdrantClient, embedding: EmbeddingService) {
    this.client = client;
    this.embedding = embedding;
  }

  async store(memory: VectorMemory): Promise<void> {
    // 生成向量嵌入
    const vector = await this.embedding.embed(memory.content);

    // 存储到 Qdrant
    await this.client.upsert(this.collectionName, {
      wait: true,
      points: [
        {
          id: memory.id,
          vector,
          payload: {
            content: memory.content,
            metadata: memory.metadata,
            createdAt: memory.createdAt.toISOString(),
          },
        },
      ],
    });
  }

  async retrieve(
    query: string,
    options: RetrievalOptions
  ): Promise<VectorMemory[]> {
    // 生成查询向量
    const queryVector = await this.embedding.embed(query);

    // 向量搜索
    const results = await this.client.search(this.collectionName, {
      vector: queryVector,
      limit: options.topK || 10,
      score_threshold: options.threshold || 0.7,
      filter: this.buildFilter(options),
    });

    return results.map(result => ({
      id: result.id as string,
      content: result.payload.content as string,
      embedding: [], // 不返回向量
      metadata: result.payload.metadata as VectorMetadata,
      createdAt: new Date(result.payload.createdAt as string),
    }));
  }

  private buildFilter(options: RetrievalOptions): any {
    const filter: any = { must: [] };

    if (options.userId) {
      filter.must.push({
        key: 'metadata.userId',
        match: { value: options.userId },
      });
    }

    if (options.type) {
      filter.must.push({
        key: 'metadata.type',
        match: { value: options.type },
      });
    }

    return filter.must.length > 0 ? filter : undefined;
  }
}
```

### 3.6 执行引擎实现

```typescript
// src/executor/planner.ts
import { NemotronService } from '../llm/nemotron';
import { ExecutionPlan, ExecutionStep } from '../types';

export class PlannerEngine {
  constructor(private nemotron: NemotronService) {}

  async createPlan(task: TaskDescription): Promise<ExecutionPlan> {
    // 1. 调用 Nemotron 生成计划
    const prompt = this.buildPlanningPrompt(task);
    const response = await this.nemotron.chat(prompt);

    // 2. 解析响应
    const plan = this.parsePlanResponse(response);

    // 3. 验证计划
    this.validatePlan(plan);

    return plan;
  }

  private buildPlanningPrompt(task: TaskDescription): string {
    return `
你是一个任务规划专家。请将以下任务分解为可执行的步骤。

任务描述：${task.description}
任务类型：${task.type}
可用工具：${JSON.stringify(task.availableTools)}

请以 JSON 格式返回执行计划：
{
  "planId": "唯一ID",
  "description": "任务描述",
  "steps": [
    {
      "stepId": "step_1",
      "action": "动作名称",
      "params": {},
      "requiredParams": ["必需参数列表"],
      "timeout": 30000,
      "retryPolicy": {
        "maxRetries": 3,
        "retryInterval": 1000
      }
    }
  ],
  "dependencies": {
    "nodes": ["step_1", "step_2"],
    "edges": [{"from": "step_1", "to": "step_2"}]
  }
}
`;
  }

  private validatePlan(plan: ExecutionPlan): void {
    // 检查步骤完整性
    if (!plan.steps || plan.steps.length === 0) {
      throw new Error('计划必须包含至少一个步骤');
    }

    // 检查依赖关系
    const stepIds = new Set(plan.steps.map(s => s.stepId));
    for (const edge of plan.dependencies.edges) {
      if (!stepIds.has(edge.from) || !stepIds.has(edge.to)) {
        throw new Error('依赖关系引用了不存在的步骤');
      }
    }

    // 检查是否有循环依赖
    this.checkCyclicDependencies(plan.dependencies);
  }

  private checkCyclicDependencies(dependencies: DependencyGraph): void {
    // 使用 DFS 检测循环
    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    const hasCycle = (node: string): boolean => {
      visited.add(node);
      recursionStack.add(node);

      const neighbors = dependencies.edges
        .filter(e => e.from === node)
        .map(e => e.to);

      for (const neighbor of neighbors) {
        if (!visited.has(neighbor)) {
          if (hasCycle(neighbor)) return true;
        } else if (recursionStack.has(neighbor)) {
          return true;
        }
      }

      recursionStack.delete(node);
      return false;
    };

    for (const node of dependencies.nodes) {
      if (!visited.has(node)) {
        if (hasCycle(node)) {
          throw new Error('计划存在循环依赖');
        }
      }
    }
  }
}
```

```typescript
// src/executor/executor.ts
import { ExecutionPlan, ExecutionStatus, StepResult } from '../types';

export class ExecutorEngine {
  private status: Map<string, ExecutionStatus> = new Map();
  private results: Map<string, StepResult[]> = new Map();

  async executePlan(plan: ExecutionPlan): Promise<PlanResult> {
    const startTime = Date.now();
    
    // 初始化状态
    this.status.set(plan.planId, {
      status: 'running',
      currentStep: null,
      completedSteps: [],
      failedSteps: [],
    });

    try {
      // 按拓扑顺序执行
      const executionOrder = this.topologicalSort(plan.dependencies);
      
      for (const stepId of executionOrder) {
        const step = plan.steps.find(s => s.stepId === stepId)!;
        
        // 更新当前步骤
        this.updateStatus(plan.planId, { currentStep: stepId });

        // 执行步骤
        const result = await this.executeStep(step);
        
        if (result.status === 'failed') {
          // 处理失败
          await this.handleStepFailure(plan, step, result);
        }

        // 记录结果
        this.addResult(plan.planId, result);
      }

      // 完成
      const finalStatus = this.status.get(plan.planId)!;
      finalStatus.status = 'completed';
      
      return {
        planId: plan.planId,
        status: 'success',
        stepResults: this.results.get(plan.planId) || [],
        totalDuration: Date.now() - startTime,
      };

    } catch (error) {
      this.updateStatus(plan.planId, { status: 'failed', error });
      throw error;
    }
  }

  private async executeStep(step: ExecutionStep): Promise<StepResult> {
    const startTime = Date.now();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= step.retryPolicy.maxRetries; attempt++) {
      try {
        // 执行动作
        const output = await this.invokeAction(step.action, step.params);
        
        return {
          stepId: step.stepId,
          status: 'success',
          output,
          duration: Date.now() - startTime,
        };
      } catch (error) {
        lastError = error as Error;
        
        // 检查是否可重试
        if (!this.isRetryable(error) || attempt === step.retryPolicy.maxRetries) {
          break;
        }

        // 等待重试
        await this.sleep(step.retryPolicy.retryInterval * Math.pow(2, attempt));
      }
    }

    return {
      stepId: step.stepId,
      status: 'failed',
      error: lastError!,
      duration: Date.now() - startTime,
    };
  }

  private topologicalSort(dependencies: DependencyGraph): string[] {
    const inDegree = new Map<string, number>();
    const adjacency = new Map<string, string[]>();

    // 初始化
    for (const node of dependencies.nodes) {
      inDegree.set(node, 0);
      adjacency.set(node, []);
    }

    // 构建图
    for (const edge of dependencies.edges) {
      adjacency.get(edge.from)!.push(edge.to);
      inDegree.set(edge.to, inDegree.get(edge.to)! + 1);
    }

    // Kahn 算法
    const queue: string[] = [];
    const result: string[] = [];

    for (const [node, degree] of inDegree) {
      if (degree === 0) queue.push(node);
    }

    while (queue.length > 0) {
      const node = queue.shift()!;
      result.push(node);

      for (const neighbor of adjacency.get(node)!) {
        const newDegree = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, newDegree);
        if (newDegree === 0) queue.push(neighbor);
      }
    }

    return result;
  }
}
```

### 3.7 定时任务实现

```typescript
// src/executor/scheduler.ts
import { CronJob } from 'cron';
import { CronRule, ScheduleTask } from '../types';

export class SchedulerEngine {
  private jobs: Map<string, CronJob> = new Map();
  private executor: ExecutorEngine;

  constructor(executor: ExecutorEngine) {
    this.executor = executor;
  }

  async schedule(task: ScheduleTask): Promise<void> {
    // 创建 Cron 任务
    const job = new CronJob(
      task.rule.expression,
      async () => {
        await this.executeScheduledTask(task);
      },
      null,
      true, // 立即启动
      task.rule.timezone
    );

    this.jobs.set(task.id, job);
  }

  async unschedule(taskId: string): Promise<void> {
    const job = this.jobs.get(taskId);
    if (job) {
      job.stop();
      this.jobs.delete(taskId);
    }
  }

  async updateSchedule(task: ScheduleTask): Promise<void> {
    await this.unschedule(task.id);
    await this.schedule(task);
  }

  private async executeScheduledTask(task: ScheduleTask): Promise<void> {
    try {
      // 执行任务
      const result = await this.executor.executePlan(task.plan);

      // 根据配置决定是否通知
      if (task.notifyOnComplete) {
        await this.notifyUser(task.userId, result);
      }

      // 记录执行日志
      await this.logExecution(task.id, result);

    } catch (error) {
      console.error(`定时任务 ${task.id} 执行失败:`, error);
      
      if (task.notifyOnFailure) {
        await this.notifyFailure(task.userId, error);
      }
    }
  }

  getScheduledTasks(): ScheduleTask[] {
    // 返回所有已调度的任务信息
    return Array.from(this.jobs.entries()).map(([id, job]) => ({
      id,
      nextRun: job.nextDate().toJSDate(),
      running: job.running,
    }));
  }
}
```

## 4. 配置管理

### 4.1 环境变量

```bash
# .env.example

# 应用配置
NODE_ENV=development
PORT=3000
LOG_LEVEL=debug

# Discord 配置
DISCORD_TOKEN=your_discord_bot_token
DISCORD_CLIENT_ID=your_discord_client_id

# Telegram 配置
TELEGRAM_TOKEN=your_telegram_bot_token

# GLM 配置
GLM_API_KEY=your_glm_api_key
GLM_API_URL=https://api.glm.ai/v1

# Nemotron 配置
NEMOTRON_API_KEY=your_nemotron_api_key
NEMOTRON_API_URL=https://api.nvidia.com/v1

# OpenClaw 配置
OPENCLAW_API_URL=http://localhost:8080
OPENCLAW_API_KEY=your_openclaw_key

# Redis 配置
REDIS_URL=redis://localhost:6379

# Qdrant 配置
QDRANT_URL=http://localhost:6333
QDRANT_API_KEY=your_qdrant_key

# 数据库配置
DATABASE_URL=postgresql://user:password@localhost:5432/xiaoyou
```

### 4.2 配置加载

```typescript
// src/config/index.ts
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const configSchema = z.object({
  env: z.enum(['development', 'production', 'test']),
  port: z.number().default(3000),
  logLevel: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  
  discord: z.object({
    token: z.string(),
    clientId: z.string(),
  }),
  
  telegram: z.object({
    token: z.string(),
  }),
  
  glm: z.object({
    apiKey: z.string(),
    apiUrl: z.string().url(),
  }),
  
  nemotron: z.object({
    apiKey: z.string(),
    apiUrl: z.string().url(),
  }),
  
  openclaw: z.object({
    apiUrl: z.string().url(),
    apiKey: z.string(),
  }),
  
  redis: z.object({
    url: z.string().url(),
  }),
  
  qdrant: z.object({
    url: z.string().url(),
    apiKey: z.string().optional(),
  }),
  
  database: z.object({
    url: z.string().url(),
  }),
});

export const config = configSchema.parse({
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000'),
  logLevel: process.env.LOG_LEVEL || 'info',
  
  discord: {
    token: process.env.DISCORD_TOKEN!,
    clientId: process.env.DISCORD_CLIENT_ID!,
  },
  
  telegram: {
    token: process.env.TELEGRAM_TOKEN!,
  },
  
  glm: {
    apiKey: process.env.GLM_API_KEY!,
    apiUrl: process.env.GLM_API_URL!,
  },
  
  nemotron: {
    apiKey: process.env.NEMOTRON_API_KEY!,
    apiUrl: process.env.NEMOTRON_API_URL!,
  },
  
  openclaw: {
    apiUrl: process.env.OPENCLAW_API_URL!,
    apiKey: process.env.OPENCLAW_API_KEY!,
  },
  
  redis: {
    url: process.env.REDIS_URL!,
  },
  
  qdrant: {
    url: process.env.QDRANT_URL!,
    apiKey: process.env.QDRANT_API_KEY,
  },
  
  database: {
    url: process.env.DATABASE_URL!,
  },
});
```

## 5. 测试策略

### 5.1 单元测试

```typescript
// tests/unit/intent.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { IntentRecognizer } from '../../src/controller/intent';
import { GLMService } from '../../src/llm/glm';

describe('IntentRecognizer', () => {
  let recognizer: IntentRecognizer;
  let mockGLM: MockedGLMService;

  beforeEach(() => {
    mockGLM = createMockGLM();
    recognizer = new IntentRecognizer(mockGLM);
  });

  it('should recognize chat intent', async () => {
    mockGLM.chat.mockResolvedValue(JSON.stringify({
      intent: 'chat.casual',
      confidence: 0.95,
      entities: [],
    }));

    const message = createMockMessage('你好，今天天气怎么样？');
    const intent = await recognizer.recognize(message);

    expect(intent.type).toBe('chat.casual');
    expect(intent.confidence).toBeGreaterThan(0.9);
  });

  it('should recognize task intent', async () => {
    mockGLM.chat.mockResolvedValue(JSON.stringify({
      intent: 'task.code',
      confidence: 0.9,
      entities: [{ type: 'language', value: 'python' }],
    }));

    const message = createMockMessage('帮我写一个 Python 脚本');
    const intent = await recognizer.recognize(message);

    expect(intent.type).toBe('task.code');
    expect(intent.entities).toHaveLength(1);
  });
});
```

### 5.2 集成测试

```typescript
// tests/integration/flow.test.ts
import { describe, it, expect } from 'vitest';
import { TestClient } from '../helpers/client';

describe('Message Flow', () => {
  it('should handle chat message', async () => {
    const client = new TestClient();
    
    const response = await client.sendMessage({
      platform: 'discord',
      channelId: 'test-channel',
      userId: 'test-user',
      content: '你好',
    });

    expect(response.status).toBe('success');
    expect(response.content).toBeDefined();
  });

  it('should handle task request', async () => {
    const client = new TestClient();
    
    // 发送任务请求
    const taskResponse = await client.sendMessage({
      platform: 'discord',
      channelId: 'test-channel',
      userId: 'test-user',
      content: '帮我分析这个数据文件',
      attachments: [{
        type: 'document',
        url: 'https://example.com/data.csv',
        name: 'data.csv',
      }],
    });

    expect(taskResponse.status).toBe('accepted');
    expect(taskResponse.messageId).toBeDefined();

    // 等待任务完成
    const result = await client.waitForTaskResult(taskResponse.messageId);
    expect(result.status).toBe('completed');
  });
});
```

## 6. 部署指南

### 6.1 Docker 部署

```dockerfile
# Dockerfile
FROM node:20-alpine

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci --only=production

# 复制代码
COPY dist ./dist
COPY prisma ./prisma
RUN npx prisma generate

# 启动
CMD ["node", "dist/index.js"]
```

```yaml
# docker-compose.yml
version: '3.8'

services:
  xiaoyou:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - REDIS_URL=redis://redis:6379
      - QDRANT_URL=http://qdrant:6333
      - DATABASE_URL=postgresql://user:password@postgres:5432/xiaoyou
    depends_on:
      - redis
      - qdrant
      - postgres

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data

  qdrant:
    image: qdrant/qdrant:latest
    volumes:
      - qdrant_data:/qdrant/storage
    ports:
      - "6333:6333"

  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: password
      POSTGRES_DB: xiaoyou
    volumes:
      - postgres_data:/var/lib/postgresql/data

volumes:
  redis_data:
  qdrant_data:
  postgres_data:
```

### 6.2 启动命令

```bash
# 开发环境
npm run dev

# 生产环境
npm run build
npm run start

# Docker
docker-compose up -d
```

## 7. 监控与日志

### 7.1 日志配置

```typescript
// src/utils/logger.ts
import pino from 'pino';

export const logger = pino({
  level: config.logLevel,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
      ignore: 'pid,hostname',
    },
  },
});
```

### 7.2 健康检查

```typescript
// src/health.ts
import { Hono } from 'hono';

const healthApp = new Hono();

healthApp.get('/health', (c) => {
  return c.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

healthApp.get('/ready', async (c) => {
  // 检查各组件状态
  const checks = {
    redis: await checkRedis(),
    qdrant: await checkQdrant(),
    database: await checkDatabase(),
  };

  const allHealthy = Object.values(checks).every(v => v);

  return c.json(
    { status: allHealthy ? 'ready' : 'not_ready', checks },
    allHealthy ? 200 : 503
  );
});
```
