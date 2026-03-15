import os from 'node:os';
import { createChildLogger } from '../utils/logger.js';
import type { MonitoringMetrics } from '../types/index.js';

const log = createChildLogger('metrics');

interface RequestSample {
  durationMs: number;
  success: boolean;
}

export class MetricsService {
  private requestCount = 0;
  private errorCount = 0;
  private totalResponseTime = 0;
  private messageCount = 0;
  private taskCount = 0;
  private taskSuccessCount = 0;
  private activeUsers = new Set<string>();
  private lastCpuUsage = process.cpuUsage();
  private lastCpuSampleAt = process.hrtime.bigint();

  recordRequest(sample: RequestSample): void {
    this.requestCount += 1;
    this.totalResponseTime += sample.durationMs;
    if (!sample.success) {
      this.errorCount += 1;
    }
  }

  recordMessage(userId: string): void {
    this.messageCount += 1;
    this.activeUsers.add(userId);
  }

  recordTask(success: boolean): void {
    this.taskCount += 1;
    if (success) {
      this.taskSuccessCount += 1;
    }
  }

  getSnapshot(): MonitoringMetrics {
    return {
      system: {
        cpuUsage: this.sampleCpuUsage(),
        memoryUsage: this.sampleMemoryUsage(),
        diskUsage: 0,
      },
      application: {
        requestCount: this.requestCount,
        errorRate: this.requestCount === 0 ? 0 : this.errorCount / this.requestCount,
        avgResponseTime: this.requestCount === 0 ? 0 : this.totalResponseTime / this.requestCount,
        activeUsers: this.activeUsers.size,
      },
      business: {
        messageCount: this.messageCount,
        taskCount: this.taskCount,
        taskSuccessRate: this.taskCount === 0 ? 0 : this.taskSuccessCount / this.taskCount,
      },
    };
  }

  resetActiveUsers(): void {
    this.activeUsers.clear();
  }

  logSnapshot(): void {
    log.info({ metrics: this.getSnapshot() }, '监控指标快照');
  }

  private sampleMemoryUsage(): number {
    const total = os.totalmem();
    const free = os.freemem();
    if (total === 0) {
      return 0;
    }
    return (total - free) / total;
  }

  private sampleCpuUsage(): number {
    const currentUsage = process.cpuUsage();
    const currentAt = process.hrtime.bigint();
    const elapsedMicros = Number(currentAt - this.lastCpuSampleAt) / 1000;

    if (elapsedMicros <= 0) {
      return 0;
    }

    const userDiff = currentUsage.user - this.lastCpuUsage.user;
    const systemDiff = currentUsage.system - this.lastCpuUsage.system;
    const ratio = (userDiff + systemDiff) / elapsedMicros / os.cpus().length;

    this.lastCpuUsage = currentUsage;
    this.lastCpuSampleAt = currentAt;

    return Math.max(0, Math.min(ratio, 1));
  }
}

export const metricsService = new MetricsService();
