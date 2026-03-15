import { describe, expect, it } from 'vitest';
import { MetricsService } from '../../src/monitoring/metrics.js';

describe('MetricsService', () => {
  it('应统计请求、错误率和平均响应时间', () => {
    const metrics = new MetricsService();

    metrics.recordRequest({ durationMs: 100, success: true });
    metrics.recordRequest({ durationMs: 300, success: false });

    const snapshot = metrics.getSnapshot();
    expect(snapshot.application.requestCount).toBe(2);
    expect(snapshot.application.errorRate).toBe(0.5);
    expect(snapshot.application.avgResponseTime).toBe(200);
  });

  it('应统计消息用户数和任务成功率', () => {
    const metrics = new MetricsService();

    metrics.recordMessage('u1');
    metrics.recordMessage('u1');
    metrics.recordMessage('u2');
    metrics.recordTask(true);
    metrics.recordTask(false);

    const snapshot = metrics.getSnapshot();
    expect(snapshot.application.activeUsers).toBe(2);
    expect(snapshot.business.messageCount).toBe(3);
    expect(snapshot.business.taskCount).toBe(2);
    expect(snapshot.business.taskSuccessRate).toBe(0.5);
  });

  it('重置活跃用户后应清空 activeUsers 统计', () => {
    const metrics = new MetricsService();
    metrics.recordMessage('u1');
    metrics.recordMessage('u2');
    metrics.resetActiveUsers();

    const snapshot = metrics.getSnapshot();
    expect(snapshot.application.activeUsers).toBe(0);
  });
});
