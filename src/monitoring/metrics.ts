import os from 'node:os';
import { execSync } from 'node:child_process';
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
        diskUsage: this.sampleDiskUsage(),
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

  private sampleDiskUsage(): number {
    try {
      // Linux/macOS: 使用 df 命令获取磁盘使用率
      const output = execSync('df -k / 2>/dev/null | tail -1', {
        encoding: 'utf-8',
        timeout: 1000,
      }).trim();

      // 输出格式: Filesystem 1K-blocks Used Available Use% Mounted on
      const parts = output.split(/\s+/);
      const used = parseInt(parts[2], 10);
      const total = parseInt(parts[1], 10);

      if (total === 0 || isNaN(used) || isNaN(total)) {
        return 0;
      }

      return used / total;
    } catch {
      // Windows 或其他环境：降级处理
      return 0;
    }
  }
}

export const metricsService = new MetricsService();
