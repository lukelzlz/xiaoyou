/**
 * 降级机制服务
 * 
 * 当外部服务不可用时提供降级策略
 */
import { createChildLogger } from '../utils/logger.js';
import { config } from '../config/index.js';

const log = createChildLogger('fallback');

// ============ 类型定义 ============

export type ServiceType = 'llm' | 'planner' | 'executor' | 'memory' | 'tool';

export type ServiceStatus = 'healthy' | 'degraded' | 'down';

export interface ServiceHealth {
  type: ServiceType;
  status: ServiceStatus;
  lastCheck: Date;
  errorCount: number;
  successCount: number;
  latency: number;
  message?: string;
}

export interface FallbackConfig {
  enabled: boolean;
  timeout: number;
  retries: number;
  cooldownPeriod: number;
  failureThreshold: number;
  successThreshold: number;
  fallbackMessage: string;
}

export interface FallbackStrategy {
  shouldFallback(): boolean;
  execute<T>(operation: () => Promise<T>, fallback: () => Promise<T>): Promise<T>;
  recordSuccess(): void;
  recordFailure(error: Error): void;
}

// ============ 默认降级配置 ============

const DEFAULT_FALLBACK_CONFIGS: Record<ServiceType, FallbackConfig> = {
  llm: {
    enabled: true,
    timeout: 15000,
    retries: 3,
    cooldownPeriod: 30000,
    failureThreshold: 5,
    successThreshold: 2,
    fallbackMessage: '抱歉，我暂时无法回复，请稍后再试。',
  },
  planner: {
    enabled: true,
    timeout: 30000,
    retries: 2,
    cooldownPeriod: 60000,
    failureThreshold: 3,
    successThreshold: 2,
    fallbackMessage: '任务规划服务暂时不可用，请稍后再试。',
  },
  executor: {
    enabled: true,
    timeout: 300000,
    retries: 1,
    cooldownPeriod: 60000,
    failureThreshold: 3,
    successThreshold: 1,
    fallbackMessage: '任务执行服务暂时不可用。',
  },
  memory: {
    enabled: true,
    timeout: 5000,
    retries: 2,
    cooldownPeriod: 10000,
    failureThreshold: 5,
    successThreshold: 2,
    fallbackMessage: '记忆服务暂时不可用。',
  },
  tool: {
    enabled: true,
    timeout: 10000,
    retries: 2,
    cooldownPeriod: 15000,
    failureThreshold: 3,
    successThreshold: 2,
    fallbackMessage: '工具服务暂时不可用。',
  },
};

// ============ 熔断器 ============

export class CircuitBreaker {
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private failureCount = 0;
  private successCount = 0;
  private lastFailureTime: Date | null = null;
  private config: FallbackConfig;

  constructor(config: FallbackConfig) {
    this.config = config;
  }

  /**
   * 检查是否应该降级
   */
  shouldFallback(): boolean {
    if (!this.config.enabled) {
      return false;
    }

    if (this.state === 'open') {
      // 检查是否进入半开状态
      if (this.lastFailureTime) {
        const elapsed = Date.now() - this.lastFailureTime.getTime();
        if (elapsed >= this.config.cooldownPeriod) {
          this.state = 'half-open';
          log.info('熔断器进入半开状态');
          return false;
        }
      }
      return true;
    }

    return false;
  }

  /**
   * 执行操作，失败时使用降级方案
   */
  async execute<T>(
    operation: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    if (this.shouldFallback()) {
      log.warn('服务降级中，使用备用方案');
      return fallback();
    }

    try {
      const result = await this.withTimeout(operation, this.config.timeout);
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure(error as Error);
      
      // 如果还有重试次数，尝试降级
      if (this.state === 'closed') {
        log.warn({ error }, '操作失败，尝试降级');
        return fallback();
      }
      
      throw error;
    }
  }

  /**
   * 记录成功
   */
  recordSuccess(): void {
    this.successCount++;
    this.failureCount = 0;

    if (this.state === 'half-open') {
      if (this.successCount >= this.config.successThreshold) {
        this.state = 'closed';
        this.successCount = 0;
        log.info('熔断器恢复到关闭状态');
      }
    }
  }

  /**
   * 记录失败
   */
  recordFailure(error: Error): void {
    this.failureCount++;
    this.successCount = 0;
    this.lastFailureTime = new Date();

    if (this.state === 'half-open') {
      this.state = 'open';
      log.warn({ error }, '熔断器从半开状态重新打开');
    } else if (this.failureCount >= this.config.failureThreshold) {
      this.state = 'open';
      log.warn(
        { failureCount: this.failureCount, threshold: this.config.failureThreshold },
        '熔断器打开'
      );
    }
  }

  /**
   * 带超时执行
   */
  private async withTimeout<T>(operation: () => Promise<T>, timeout: number): Promise<T> {
    return Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        setTimeout(() => reject(new Error(`操作超时 (${timeout}ms)`)), timeout);
      }),
    ]);
  }

  /**
   * 获取状态
   */
  getState(): { state: string; failureCount: number; successCount: number } {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
    };
  }

  /**
   * 重置
   */
  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    log.info('熔断器已重置');
  }
}

// ============ 降级管理器 ============

export class FallbackManager {
  private circuitBreakers: Map<ServiceType, CircuitBreaker> = new Map();
  private healthStatus: Map<ServiceType, ServiceHealth> = new Map();

  constructor() {
    // 初始化各服务的熔断器
    for (const [type, config] of Object.entries(DEFAULT_FALLBACK_CONFIGS)) {
      this.circuitBreakers.set(type as ServiceType, new CircuitBreaker(config));
      this.healthStatus.set(type as ServiceType, {
        type: type as ServiceType,
        status: 'healthy',
        lastCheck: new Date(),
        errorCount: 0,
        successCount: 0,
        latency: 0,
      });
    }
  }

  /**
   * 执行带降级的操作
   */
  async executeWithFallback<T>(
    serviceType: ServiceType,
    operation: () => Promise<T>,
    fallback: () => Promise<T>,
  ): Promise<T> {
    const breaker = this.circuitBreakers.get(serviceType);
    if (!breaker) {
      return operation();
    }

    const startTime = Date.now();

    try {
      const result = await breaker.execute(operation, fallback);
      this.updateHealth(serviceType, true, Date.now() - startTime);
      return result;
    } catch (error) {
      this.updateHealth(serviceType, false, Date.now() - startTime, (error as Error).message);
      throw error;
    }
  }

  /**
   * 检查服务是否应该降级
   */
  shouldFallback(serviceType: ServiceType): boolean {
    const breaker = this.circuitBreakers.get(serviceType);
    return breaker?.shouldFallback() || false;
  }

  /**
   * 获取服务健康状态
   */
  getHealth(serviceType: ServiceType): ServiceHealth {
    return this.healthStatus.get(serviceType) || {
      type: serviceType,
      status: 'unknown' as ServiceStatus,
      lastCheck: new Date(),
      errorCount: 0,
      successCount: 0,
      latency: 0,
    };
  }

  /**
   * 获取所有服务健康状态
   */
  getAllHealth(): ServiceHealth[] {
    return Array.from(this.healthStatus.values());
  }

  /**
   * 更新健康状态
   */
  private updateHealth(
    serviceType: ServiceType,
    success: boolean,
    latency: number,
    message?: string,
  ): void {
    const health = this.healthStatus.get(serviceType);
    if (!health) return;

    health.lastCheck = new Date();
    health.latency = latency;

    if (success) {
      health.successCount++;
      health.errorCount = 0;
      health.status = 'healthy';
      health.message = undefined;
    } else {
      health.errorCount++;
      health.message = message;

      // 根据错误次数更新状态
      const config = DEFAULT_FALLBACK_CONFIGS[serviceType];
      if (health.errorCount >= config.failureThreshold) {
        health.status = 'down';
      } else if (health.errorCount > 0) {
        health.status = 'degraded';
      }
    }
  }

  /**
   * 手动标记服务状态
   */
  markServiceStatus(serviceType: ServiceType, status: ServiceStatus, message?: string): void {
    const health = this.healthStatus.get(serviceType);
    if (!health) return;

    health.status = status;
    health.message = message;
    health.lastCheck = new Date();

    // 如果标记为 down，触发熔断器
    if (status === 'down') {
      const breaker = this.circuitBreakers.get(serviceType);
      if (breaker) {
        for (let i = 0; i < DEFAULT_FALLBACK_CONFIGS[serviceType].failureThreshold; i++) {
          breaker.recordFailure(new Error(message || '手动标记为不可用'));
        }
      }
    }

    log.info({ serviceType, status, message }, '服务状态已更新');
  }

  /**
   * 重置服务熔断器
   */
  resetService(serviceType: ServiceType): void {
    const breaker = this.circuitBreakers.get(serviceType);
    if (breaker) {
      breaker.reset();
    }

    const health = this.healthStatus.get(serviceType);
    if (health) {
      health.status = 'healthy';
      health.errorCount = 0;
      health.message = undefined;
    }

    log.info({ serviceType }, '服务已重置');
  }

  /**
   * 获取降级消息
   */
  getFallbackMessage(serviceType: ServiceType): string {
    return DEFAULT_FALLBACK_CONFIGS[serviceType]?.fallbackMessage || '服务暂时不可用';
  }
}

// ============ 降级响应生成器 ============

export class FallbackResponseGenerator {
  /**
   * 生成 LLM 降级响应
   */
  static generateLLMFallback(context?: { userMessage?: string; error?: string }): string {
    const responses = [
      '抱歉，我暂时无法处理您的请求，请稍后再试。',
      '系统繁忙中，请稍后再试。',
      '我遇到了一些问题，请稍后再联系我。',
    ];

    // 如果有上下文，尝试生成更相关的响应
    if (context?.userMessage) {
      const lowered = context.userMessage.toLowerCase();
      
      if (lowered.includes('你好') || lowered.includes('hi') || lowered.includes('hello')) {
        return '你好！抱歉我现在有点忙，请稍后再聊。';
      }
      
      if (lowered.includes('谢谢') || lowered.includes('感谢')) {
        return '不客气！';
      }
      
      if (lowered.includes('?') || lowered.includes('？')) {
        return '抱歉，我现在无法回答您的问题，请稍后再试。';
      }
    }

    return responses[Math.floor(Math.random() * responses.length)];
  }

  /**
   * 生成规划服务降级响应
   */
  static generatePlannerFallback(context?: { taskDescription?: string }): string {
    if (context?.taskDescription) {
      return `抱歉，任务规划服务暂时不可用。您的任务「${context.taskDescription.slice(0, 50)}...」已记录，稍后会处理。`;
    }
    return '任务规划服务暂时不可用，请稍后再试。';
  }

  /**
   * 生成执行器降级响应
   */
  static generateExecutorFallback(context?: { taskId?: string }): string {
    if (context?.taskId) {
      return `任务 ${context.taskId} 执行遇到问题，已暂停。请稍后重试或联系管理员。`;
    }
    return '任务执行服务暂时不可用，请稍后再试。';
  }

  /**
   * 生成记忆服务降级响应
   */
  static generateMemoryFallback(): string {
    // 记忆服务降级时，系统仍可工作，只是没有上下文
    return ''; // 静默降级
  }

  /**
   * 生成工具服务降级响应
   */
  static generateToolFallback(context?: { toolName?: string }): string {
    if (context?.toolName) {
      return `工具「${context.toolName}」暂时不可用，请稍后再试。`;
    }
    return '工具服务暂时不可用，请稍后再试。';
  }
}

// ============ 导出单例 ============

export const fallbackManager = new FallbackManager();
