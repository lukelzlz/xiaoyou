import { describe, expect, it, vi } from 'vitest';
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

  it('应返回系统监控指标', () => {
    const metrics = new MetricsService();
    const snapshot = metrics.getSnapshot();

    expect(snapshot.system).toBeDefined();
    expect(typeof snapshot.system.cpuUsage).toBe('number');
    expect(typeof snapshot.system.memoryUsage).toBe('number');
    expect(typeof snapshot.system.diskUsage).toBe('number');
    expect(snapshot.system.cpuUsage).toBeGreaterThanOrEqual(0);
    expect(snapshot.system.cpuUsage).toBeLessThanOrEqual(1);
    expect(snapshot.system.memoryUsage).toBeGreaterThanOrEqual(0);
    expect(snapshot.system.memoryUsage).toBeLessThanOrEqual(1);
    expect(snapshot.system.diskUsage).toBeGreaterThanOrEqual(0);
    expect(snapshot.system.diskUsage).toBeLessThanOrEqual(1);
  });

  describe('diskUsage', () => {
    it('应正确返回磁盘使用率（范围 0-1）', () => {
      const metrics = new MetricsService();
      // 通过 spy 控制 sampleDiskUsage 的返回值
      const spy = vi.spyOn(metrics as unknown as { sampleDiskUsage: () => number }, 'sampleDiskUsage')
        .mockReturnValue(0.5);

      const snapshot = metrics.getSnapshot();
      expect(snapshot.system.diskUsage).toBe(0.5);

      spy.mockRestore();
    });

    it('应在环境不支持时返回 0', () => {
      const metrics = new MetricsService();
      const spy = vi.spyOn(metrics as unknown as { sampleDiskUsage: () => number }, 'sampleDiskUsage')
        .mockReturnValue(0);

      const snapshot = metrics.getSnapshot();
      expect(snapshot.system.diskUsage).toBe(0);

      spy.mockRestore();
    });

    it('实际 sampleDiskUsage 应返回合理值', () => {
      const metrics = new MetricsService();
      // 直接调用真实方法，验证在当前环境下不会崩溃并返回合理值
      const diskUsage = (metrics as unknown as { sampleDiskUsage: () => number }).sampleDiskUsage();
      expect(typeof diskUsage).toBe('number');
      expect(diskUsage).toBeGreaterThanOrEqual(0);
      expect(diskUsage).toBeLessThanOrEqual(1);
    });
  });
});
