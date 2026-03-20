import WebSocket from 'ws';
import { createChildLogger } from '../utils/logger.js';
import { config } from '../config/index.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import { safeJsonParse } from '../utils/json.js';

const log = createChildLogger('openclaw-rpc');

// ============ 安全配置 ============
const SECURITY_CONFIG = {
  // 允许的 WebSocket 协议
  ALLOWED_PROTOCOLS: ['ws:', 'wss:'],
  // 私有 IP 地址正则 (SSRF 防护)
  PRIVATE_IP_PATTERNS: [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
    /^192\.168\./,
    /^0\.0\.0\.0$/,
    /^localhost$/i,
    /^::1$/,
    /^fc00:/i,
    /^fe80:/i,
  ],
  // 最大消息大小 (1MB)
  MAX_MESSAGE_SIZE: 1024 * 1024,
};

// 导出的类型
export interface SessionInfo {
  sessionId: string;
  userId: string;
  channelId: string;
  platform: string;
}

export interface TaskOptions {
  session?: SessionInfo;
  timeout?: number;
  onProgress?: (status: unknown) => void;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface RunningTask {
  taskId: string;
  planId: string;
  session: SessionInfo;
  startTime: number;
  status: 'pending' | 'running' | 'paused' | 'waiting_user';
  lastUpdate: number;
}

/**
 * OpenClaw WebSocket RPC 客户端
 *
 * 通过 WebSocket 与 OpenClaw Gateway 通信
 * Gateway 默认监听在 ws://127.0.0.1:18789
 */
export class OpenClawRpcClient {
  private ws: WebSocket | null = null;
  private requestId = 0;
  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>();
  private runningTasks = new Map<string, RunningTask>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private monitorInterval: NodeJS.Timeout | null = null;
  private isConnected = false;
  private validatedGatewayUrl: string;

  constructor(
    gatewayUrl: string = `ws://127.0.0.1:18789`,
    private token?: string,
  ) {
    // 验证并设置网关 URL
    this.validatedGatewayUrl = this.validateGatewayUrl(gatewayUrl);
  }

  /**
   * 验证 WebSocket URL 安全性
   */
  private validateGatewayUrl(url: string): string {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new XiaoyouError(ErrorCode.INTERNAL, `无效的 OpenClaw Gateway URL: ${url}`);
    }

    // 协议检查
    if (!SECURITY_CONFIG.ALLOWED_PROTOCOLS.includes(parsedUrl.protocol as 'ws:' | 'wss:')) {
      throw new XiaoyouError(
        ErrorCode.INTERNAL,
        `不允许的 WebSocket 协议: ${parsedUrl.protocol}`
      );
    }

    // SSRF 防护：检查是否为私有 IP（本地开发环境除外）
    const hostname = parsedUrl.hostname;
    const isLocalDevelopment = config.env === 'development' || hostname === '127.0.0.1' || hostname === 'localhost';

    if (!isLocalDevelopment) {
      for (const pattern of SECURITY_CONFIG.PRIVATE_IP_PATTERNS) {
        if (pattern.test(hostname)) {
          throw new XiaoyouError(
            ErrorCode.INTERNAL,
            '禁止连接到私有网络地址的 OpenClaw Gateway'
          );
        }
      }
    }

    return url;
  }

  /**
   * 连接到 OpenClaw Gateway
   */
  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    return new Promise((resolve, reject) => {
      log.info({ url: this.validatedGatewayUrl }, '连接 OpenClaw Gateway');

      const headers: Record<string, string> = {};
      if (this.token) {
        headers['Authorization'] = `Bearer ${this.token}`;
      }

      this.ws = new WebSocket(this.validatedGatewayUrl, { headers });

      this.ws.on('open', () => {
        log.info('OpenClaw Gateway 连接成功');
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this.startTaskMonitor();
        resolve();
      });

      this.ws.on('message', (data, isBinary) => {
        // 消息大小检查
        const messageSize = isBinary ? (data as Buffer).length : data.toString().length;
        if (messageSize > SECURITY_CONFIG.MAX_MESSAGE_SIZE) {
          log.warn({ size: messageSize, maxSize: SECURITY_CONFIG.MAX_MESSAGE_SIZE }, '收到超大消息，忽略');
          return;
        }
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (error) => {
        log.error({ error }, 'WebSocket 错误');
        this.isConnected = false;
        if (!this.pendingRequests.size) {
          reject(new XiaoyouError(ErrorCode.INTERNAL, 'OpenClaw Gateway 连接失败'));
        }
      });

      this.ws.on('close', () => {
        log.warn('WebSocket 连接关闭');
        this.isConnected = false;
        this.handleDisconnect();
      });
    });
  }

  /**
   * 断开连接
   */
  async disconnect(): Promise<void> {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }

    // 拒绝所有待处理的请求
    for (const [id, { reject, timeout }] of this.pendingRequests) {
      clearTimeout(timeout);
      reject(new Error('连接已断开'));
      this.pendingRequests.delete(id);
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
  }

  /**
   * 发送 RPC 调用
   */
  async call<T>(method: string, params?: unknown, timeoutMs = 30000): Promise<T> {
    if (!this.isConnected || this.ws?.readyState !== WebSocket.OPEN) {
      await this.connect();
    }

    const id = `${++this.requestId}`;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new XiaoyouError(ErrorCode.LLM_TIMEOUT, `RPC 调用超时: ${method}`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      const message = JSON.stringify(request);
      log.debug({ id, method }, '发送 RPC 请求');
      this.ws!.send(message);
    });
  }

  /**
   * 发送消息给 AI（核心方法）
   */
  async sendMessage(
    message: string,
    options?: TaskOptions,
  ): Promise<string> {
    const session = options?.session;

    // 如果有 session 信息，使用 session 发送
    if (session) {
      const sessionKey = this.buildSessionKey(session);

      const result = await this.call<{ content: string }>('agent.run', {
        sessionKey,
        message,
        waitForCompletion: true,
      }, options?.timeout || config.openclaw.taskTimeout);

      return result.content;
    }

    // 没有 session，创建临时会话
    const result = await this.call<{ content: string; sessionId: string }>('sessions.spawn', {
      message,
      agentId: 'main',
    }, options?.timeout || config.openclaw.taskTimeout);

    return result.content;
  }

  /**
   * 执行任务计划
   */
  async executePlan(
    planId: string,
    steps: Array<{ action: string; params: Record<string, unknown> }>,
    options?: TaskOptions,
  ): Promise<{ taskId: string; status: string }> {
    const session = options?.session;

    const result = await this.call<{ taskId: string; status: string }>('tasks.create', {
      type: 'multi_step',
      planId,
      steps,
      sessionKey: session ? this.buildSessionKey(session) : undefined,
      metadata: session ? {
        userId: session.userId,
        channelId: session.channelId,
        platform: session.platform,
      } : undefined,
    });

    // 记录运行中的任务
    if (session) {
      this.runningTasks.set(result.taskId, {
        taskId: result.taskId,
        planId,
        session,
        startTime: Date.now(),
        status: 'running',
        lastUpdate: Date.now(),
      });
    }

    return result;
  }

  /**
   * 获取任务状态
   */
  async getTaskStatus(taskId: string): Promise<{
    status: string;
    currentStep?: string;
    completedSteps: string[];
    failedSteps: string[];
    waitingForUser: boolean;
    result?: unknown;
    error?: string;
  }> {
    return this.call('tasks.get', { taskId });
  }

  /**
   * 控制任务（暂停/恢复/取消/重试）
   */
  async controlTask(taskId: string, action: 'pause' | 'resume' | 'cancel' | 'retry'): Promise<void> {
    const methodMap: Record<string, string> = {
      pause: 'tasks.pause',
      resume: 'tasks.resume',
      cancel: 'tasks.cancel',
      retry: 'tasks.retry',
    };

    await this.call(methodMap[action], { taskId });

    // 更新本地任务状态
    const task = this.runningTasks.get(taskId);
    if (task) {
      if (action === 'pause') task.status = 'paused';
      else if (action === 'resume') task.status = 'running';
      else if (action === 'cancel') this.runningTasks.delete(taskId);
      task.lastUpdate = Date.now();
    }
  }

  /**
   * 创建定时任务
   */
  async createCronTask(
    expression: string,
    task: { type: string; params: Record<string, unknown> },
    options?: {
      timezone?: string;
      session?: SessionInfo;
      callback?: string;
    },
  ): Promise<{ taskId: string }> {
    return this.call('cron.create', {
      expression,
      timezone: options?.timezone || config.timezone,
      task: {
        ...task,
        sessionKey: options?.session ? this.buildSessionKey(options.session) : undefined,
        callback: options?.callback,
      },
    });
  }

  /**
   * 更新定时任务
   */
  async updateCronTask(taskId: string, updates: {
    expression?: string;
    enabled?: boolean;
  }): Promise<void> {
    await this.call('cron.update', { taskId, ...updates });
  }

  /**
   * 删除定时任务
   */
  async deleteCronTask(taskId: string): Promise<void> {
    await this.call('cron.delete', { taskId });
  }

  /**
   * 获取用户的定时任务列表
   */
  async listCronTasks(userId: string): Promise<Array<{
    id: string;
    expression: string;
    status: string;
    nextExecution?: string;
  }>> {
    return this.call('cron.list', { userId });
  }

  /**
   * 发送通知给用户
   */
  async sendNotification(
    session: SessionInfo,
    message: string,
  ): Promise<void> {
    const sessionKey = this.buildSessionKey(session);

    await this.call('message.send', {
      sessionKey,
      message,
    });
  }

  /**
   * 获取运行中的任务数量
   */
  getRunningTaskCount(): number {
    return this.runningTasks.size;
  }

  /**
   * 获取指定用户的运行中任务
   */
  getUserTasks(userId: string): RunningTask[] {
    return Array.from(this.runningTasks.values())
      .filter(t => t.session.userId === userId);
  }

  /**
   * 构建 session key
   * 格式: agent:<agentId>:<channel>:direct:<peerId>
   */
  private buildSessionKey(session: SessionInfo): string {
    // OpenClaw session key 格式
    // agent:main:discord:direct:123456789
    return `agent:main:${session.platform}:direct:${session.userId}`;
  }

  /**
   * 处理收到的消息
   */
  private handleMessage(data: string): void {
    const response = safeJsonParse<JsonRpcResponse>(data);
    if (!response) {
      log.warn({ data: data.slice(0, 200) }, '解析消息失败');
      return;
    }

    // 检查是否是请求的响应
    const pending = this.pendingRequests.get(response.id);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(response.id);

      if (response.error) {
        pending.reject(new Error(response.error.message));
      } else {
        pending.resolve(response.result);
      }
    } else {
      // 可能是事件通知
      this.handleEvent(response);
    }
  }

  /**
   * 处理事件通知
   */
  private handleEvent(response: JsonRpcResponse): void {
    // 处理任务状态更新等事件
    const method = (response as unknown as { method?: string }).method;

    if (method === 'task.status' || method === 'task.completed' || method === 'task.failed') {
      const result = response.result as { taskId?: string; status?: string };
      if (result?.taskId) {
        const task = this.runningTasks.get(result.taskId);
        if (task) {
          task.status = result.status as RunningTask['status'];
          task.lastUpdate = Date.now();
        }
      }
    }

    log.debug({ response }, '收到事件');
  }

  /**
   * 处理断开连接
   */
  private handleDisconnect(): void {
    // 尝试重连
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);

      log.info({ attempt: this.reconnectAttempts, delay }, '尝试重连');

      setTimeout(() => {
        this.connect().catch(err => {
          log.error({ err }, '重连失败');
        });
      }, delay);
    }
  }

  /**
   * 启动任务监控
   * 自动检测卡住的任务并尝试恢复
   */
  private startTaskMonitor(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
    }

    this.monitorInterval = setInterval(() => {
      this.monitorTasks();
    }, 30000); // 每 30 秒检查一次
  }

  /**
   * 监控运行中的任务
   */
  private async monitorTasks(): Promise<void> {
    const now = Date.now();
    const stuckThreshold = 5 * 60 * 1000; // 5 分钟无更新视为卡住

    for (const [taskId, task] of this.runningTasks) {
      // 检查是否卡住
      if (task.status === 'running' && now - task.lastUpdate > stuckThreshold) {
        log.info({ taskId, planId: task.planId }, '检测到卡住的任务，尝试恢复');

        try {
          // 先查询状态
          const status = await this.getTaskStatus(taskId);

          if (status.status === 'paused') {
            // 任务暂停了，尝试恢复
            log.info({ taskId }, '任务已暂停，自动恢复');
            await this.controlTask(taskId, 'resume');
          } else if (status.status === 'running') {
            // 任务还在运行，更新时间
            task.lastUpdate = now;
          } else {
            // 任务已完成或失败，从列表移除
            this.runningTasks.delete(taskId);
          }
        } catch (error) {
          log.warn({ error, taskId }, '任务状态检查失败');
        }
      }

      // 检查是否超时
      const taskTimeout = config.openclaw.taskTimeout;
      if (now - task.startTime > taskTimeout) {
        log.warn({ taskId, planId: task.planId }, '任务执行超时');
        this.runningTasks.delete(taskId);
      }
    }
  }
}

// 导出单例
let rpcClient: OpenClawRpcClient | null = null;

export function getOpenClawRpcClient(): OpenClawRpcClient {
  if (!rpcClient) {
    rpcClient = new OpenClawRpcClient(
      config.openclaw.apiUrl.replace('http://', 'ws://').replace('https://', 'wss://'),
      config.openclaw.apiKey,
    );
  }
  return rpcClient;
}
