/**
 * WebSocket 推送服务
 *
 * 实现任务进度推送和系统通知功能
 */
import { WebSocketServer, WebSocket } from 'ws';
import { createChildLogger } from '../utils/logger.js';
import { ErrorCode, XiaoyouError } from '../utils/error.js';
import { config } from '../config/index.js';
import { randomUUID } from 'node:crypto';
import { authenticationService } from '../security/index.js';

const log = createChildLogger('websocket');

// ============ 类型定义 ============

export interface TaskProgressEvent {
  type: 'task.progress';
  taskId: string;
  step: string;
  progress: number;
  message: string;
  timestamp: string;
}

export interface TaskCompletedEvent {
  type: 'task.completed';
  taskId: string;
  result: unknown;
  duration: number;
  timestamp: string;
}

export interface TaskFailedEvent {
  type: 'task.failed';
  taskId: string;
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
  step?: string;
  timestamp: string;
}

export interface TaskNeedConfirmEvent {
  type: 'task.need_confirm';
  taskId: string;
  question: string;
  options: string[];
  timestamp: string;
}

export interface NotificationEvent {
  type: 'notification';
  category: 'task' | 'schedule' | 'system' | 'alert';
  title: string;
  message: string;
  data?: Record<string, unknown>;
  timestamp: string;
}

export type WebSocketEvent = 
  | TaskProgressEvent 
  | TaskCompletedEvent 
  | TaskFailedEvent 
  | TaskNeedConfirmEvent 
  | NotificationEvent;

export interface WebSocketMessage {
  event: string;
  data: WebSocketEvent;
}

interface ClientConnection {
  id: string;
  ws: WebSocket;
  userId: string;
  subscriptions: Set<string>; // 订阅的 taskId 列表
  connectedAt: Date;
  lastPingAt: Date;
}

// ============ WebSocket 服务器 ============

export class WebSocketPushService {
  private wss: WebSocketServer | null = null;
  private clients: Map<string, ClientConnection> = new Map();
  private userClients: Map<string, Set<string>> = new Map(); // userId -> clientIds
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * 启动 WebSocket 服务器
   * @param port 端口号
   */
  async start(port: number = 3001): Promise<void> {
    if (this.wss) {
      log.warn('WebSocket 服务器已在运行');
      return;
    }

    this.wss = new WebSocketServer({ port });

    this.wss.on('connection', (ws, req) => {
      this.handleConnection(ws, req);
    });

    this.wss.on('error', (error) => {
      log.error({ error }, 'WebSocket 服务器错误');
    });

    // 启动心跳检测
    this.heartbeatInterval = setInterval(() => {
      this.checkHeartbeat();
    }, 30000);

    log.info({ port }, 'WebSocket 服务器已启动');
  }

  /**
   * 停止 WebSocket 服务器
   */
  async stop(): Promise<void> {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // 关闭所有客户端连接
    for (const [clientId, client] of this.clients) {
      client.ws.close(1001, '服务器关闭');
    }
    this.clients.clear();
    this.userClients.clear();

    // 关闭服务器
    if (this.wss) {
      await new Promise<void>((resolve) => {
        this.wss!.close(() => {
          log.info('WebSocket 服务器已关闭');
          resolve();
        });
      });
      this.wss = null;
    }
  }

  /**
   * 处理新连接
   * 支持两种认证方式：
   * 1. Bearer Token（推荐）：通过 URL 参数 token 或 Authorization header
   * 2. API Key（服务间通信）：通过 x-api-key header
   */
  private async handleConnection(ws: WebSocket, req: any): Promise<void> {
    const clientId = randomUUID();
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    
    // 获取认证凭据
    const token = url.searchParams.get('token') ||
      (req.headers['authorization'] as string)?.replace('Bearer ', '');
    const apiKey = req.headers['x-api-key'] as string;
    
    let userId: string;
    let isAuthenticated = false;

    // 优先验证 JWT Token
    if (token) {
      try {
        // 验证 token 并获取用户信息
        const decoded = await this.verifyToken(token);
        userId = decoded.userId;
        isAuthenticated = true;
        log.info({ clientId, userId, authMethod: 'jwt' }, 'JWT 认证成功');
      } catch (error) {
        log.warn({ clientId, error }, 'JWT 认证失败');
        ws.close(4001, 'Authentication failed: Invalid token');
        return;
      }
    }
    // 验证 API Key（用于服务间通信）
    else if (apiKey) {
      if (this.validateApiKey(apiKey)) {
        // API Key 认证成功，从 URL 获取 userId（可信来源）
        userId = url.searchParams.get('userId') || 'system';
        isAuthenticated = true;
        log.info({ clientId, userId, authMethod: 'api-key' }, 'API Key 认证成功');
      } else {
        log.warn({ clientId }, 'API Key 认证失败');
        ws.close(4001, 'Authentication failed: Invalid API key');
        return;
      }
    }
    // 未提供认证凭据
    else {
      // 检查是否允许匿名连接（仅限特定配置）
      const allowAnonymous = process.env.WS_ALLOW_ANONYMOUS === 'true';
      if (allowAnonymous) {
        userId = 'anonymous';
        isAuthenticated = true;
        log.info({ clientId }, '匿名连接已允许');
      } else {
        log.warn({ clientId }, '缺少认证凭据');
        ws.close(4001, 'Authentication required');
        return;
      }
    }

    const client: ClientConnection = {
      id: clientId,
      ws,
      userId: String(userId),
      subscriptions: new Set(),
      connectedAt: new Date(),
      lastPingAt: new Date(),
    };

    this.clients.set(clientId, client);

    // 添加到用户连接映射
    if (!this.userClients.has(client.userId)) {
      this.userClients.set(client.userId, new Set());
    }
    this.userClients.get(client.userId)!.add(clientId);

    log.info({ clientId, userId: client.userId }, '客户端已连接');

    // 设置消息处理
    ws.on('message', (data) => {
      this.handleMessage(client, data.toString());
    });

    ws.on('close', () => {
      this.handleDisconnect(clientId);
    });

    ws.on('error', (error) => {
      log.error({ error, clientId }, '客户端连接错误');
    });

    ws.on('pong', () => {
      client.lastPingAt = new Date();
    });

    // 发送连接成功消息
    this.sendToClient(client, {
      event: 'connected',
      data: {
        type: 'connected',
        clientId,
        userId: client.userId,
        timestamp: new Date().toISOString(),
      } as any,
    });
  }

  /**
   * 验证 JWT Token
   */
  private async verifyToken(token: string): Promise<{ userId: string; exp?: number }> {
    // 使用认证服务验证 token
    // 这里我们直接调用 authenticationService 的内部方法
    const decoded = authenticationService.verifyToken(token);
    return {
      userId: decoded.userId,
      exp: decoded.exp,
    };
  }

  /**
   * 验证 API Key
   */
  private validateApiKey(apiKey: string): boolean {
    const validApiKey = process.env.WS_API_KEY;
    if (!validApiKey) {
      log.warn('WS_API_KEY not configured, API key authentication disabled');
      return false;
    }
    return apiKey === validApiKey;
  }

  /**
   * 处理客户端消息
   */
  private handleMessage(client: ClientConnection, data: string): void {
    try {
      const message = JSON.parse(data);
      log.debug({ clientId: client.id, message }, '收到客户端消息');

      switch (message.type || message.action) {
        case 'subscribe':
          this.handleSubscribe(client, message.taskId);
          break;

        case 'unsubscribe':
          this.handleUnsubscribe(client, message.taskId);
          break;

        case 'ping':
          client.lastPingAt = new Date();
          this.sendToClient(client, { event: 'pong', data: { timestamp: new Date().toISOString() } as any });
          break;

        default:
          log.warn({ clientId: client.id, type: message.type }, '未知消息类型');
      }
    } catch (error) {
      log.error({ error, clientId: client.id, data }, '解析客户端消息失败');
    }
  }

  /**
   * 处理订阅任务
   */
  private handleSubscribe(client: ClientConnection, taskId: string): void {
    client.subscriptions.add(taskId);
    log.info({ clientId: client.id, taskId }, '订阅任务');

    this.sendToClient(client, {
      event: 'subscribed',
      data: { taskId, timestamp: new Date().toISOString() } as any,
    });
  }

  /**
   * 处理取消订阅
   */
  private handleUnsubscribe(client: ClientConnection, taskId: string): void {
    client.subscriptions.delete(taskId);
    log.info({ clientId: client.id, taskId }, '取消订阅');

    this.sendToClient(client, {
      event: 'unsubscribed',
      data: { taskId, timestamp: new Date().toISOString() } as any,
    });
  }

  /**
   * 处理断开连接
   */
  private handleDisconnect(clientId: string): void {
    const client = this.clients.get(clientId);
    if (!client) return;

    // 从用户连接映射中移除
    const userClientSet = this.userClients.get(client.userId);
    if (userClientSet) {
      userClientSet.delete(clientId);
      if (userClientSet.size === 0) {
        this.userClients.delete(client.userId);
      }
    }

    this.clients.delete(clientId);
    log.info({ clientId, userId: client.userId }, '客户端已断开');
  }

  /**
   * 心跳检测
   */
  private checkHeartbeat(): void {
    const now = Date.now();
    const timeout = 60000; // 60秒超时

    for (const [clientId, client] of this.clients) {
      if (now - client.lastPingAt.getTime() > timeout) {
        log.warn({ clientId }, '客户端心跳超时，断开连接');
        client.ws.close(1001, '心跳超时');
        this.handleDisconnect(clientId);
      } else {
        client.ws.ping();
      }
    }
  }

  /**
   * 发送消息给客户端
   */
  private sendToClient(client: ClientConnection, message: WebSocketMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(message));
    }
  }

  // ============ 公共推送方法 ============

  /**
   * 推送任务进度
   */
  async pushTaskProgress(taskId: string, event: Omit<TaskProgressEvent, 'type' | 'timestamp'>): Promise<void> {
    const fullEvent: TaskProgressEvent = {
      type: 'task.progress',
      taskId,
      ...event,
      timestamp: new Date().toISOString(),
    };

    await this.broadcastToTaskSubscribers(taskId, {
      event: 'task.progress',
      data: fullEvent,
    });
  }

  /**
   * 推送任务完成
   */
  async pushTaskCompleted(taskId: string, event: Omit<TaskCompletedEvent, 'type' | 'timestamp'>): Promise<void> {
    const fullEvent: TaskCompletedEvent = {
      type: 'task.completed',
      taskId,
      ...event,
      timestamp: new Date().toISOString(),
    };

    await this.broadcastToTaskSubscribers(taskId, {
      event: 'task.completed',
      data: fullEvent,
    });
  }

  /**
   * 推送任务失败
   */
  async pushTaskFailed(taskId: string, event: Omit<TaskFailedEvent, 'type' | 'timestamp'>): Promise<void> {
    const fullEvent: TaskFailedEvent = {
      type: 'task.failed',
      taskId,
      ...event,
      timestamp: new Date().toISOString(),
    };

    await this.broadcastToTaskSubscribers(taskId, {
      event: 'task.failed',
      data: fullEvent,
    });
  }

  /**
   * 推送需要确认的任务
   */
  async pushTaskNeedConfirm(taskId: string, event: Omit<TaskNeedConfirmEvent, 'type' | 'timestamp'>): Promise<void> {
    const fullEvent: TaskNeedConfirmEvent = {
      type: 'task.need_confirm',
      taskId,
      ...event,
      timestamp: new Date().toISOString(),
    };

    await this.broadcastToTaskSubscribers(taskId, {
      event: 'task.need_confirm',
      data: fullEvent,
    });
  }

  /**
   * 推送系统通知给用户
   */
  async pushNotification(userId: string, event: Omit<NotificationEvent, 'type' | 'timestamp'>): Promise<void> {
    const fullEvent: NotificationEvent = {
      type: 'notification',
      ...event,
      timestamp: new Date().toISOString(),
    };

    await this.broadcastToUser(userId, {
      event: 'notification',
      data: fullEvent,
    });
  }

  /**
   * 广播给任务订阅者
   */
  private async broadcastToTaskSubscribers(taskId: string, message: WebSocketMessage): Promise<void> {
    let sentCount = 0;

    for (const client of this.clients.values()) {
      if (client.subscriptions.has(taskId)) {
        this.sendToClient(client, message);
        sentCount++;
      }
    }

    log.debug({ taskId, sentCount }, '广播给任务订阅者');
  }

  /**
   * 广播给用户所有连接
   */
  private async broadcastToUser(userId: string, message: WebSocketMessage): Promise<void> {
    const clientIds = this.userClients.get(userId);
    if (!clientIds || clientIds.size === 0) {
      log.debug({ userId }, '用户没有在线连接');
      return;
    }

    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client) {
        this.sendToClient(client, message);
      }
    }

    log.debug({ userId, connectionCount: clientIds.size }, '广播给用户');
  }

  /**
   * 广播给所有连接
   */
  async broadcastAll(message: WebSocketMessage): Promise<void> {
    for (const client of this.clients.values()) {
      this.sendToClient(client, message);
    }

    log.debug({ clientCount: this.clients.size }, '广播给所有连接');
  }

  // ============ 统计方法 ============

  /**
   * 获取连接统计
   */
  getStats(): {
    totalConnections: number;
    uniqueUsers: number;
    subscriptions: number;
  } {
    let totalSubscriptions = 0;
    for (const client of this.clients.values()) {
      totalSubscriptions += client.subscriptions.size;
    }

    return {
      totalConnections: this.clients.size,
      uniqueUsers: this.userClients.size,
      subscriptions: totalSubscriptions,
    };
  }

  /**
   * 检查用户是否在线
   */
  isUserOnline(userId: string): boolean {
    const clients = this.userClients.get(userId);
    return clients !== undefined && clients.size > 0;
  }

  /**
   * 获取用户连接数
   */
  getUserConnectionCount(userId: string): number {
    return this.userClients.get(userId)?.size || 0;
  }
}

// ============ 导出单例 ============

export const webSocketPushService = new WebSocketPushService();
