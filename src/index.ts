import { config } from './config/index.js';
import { createChildLogger } from './utils/logger.js';
import { GatewayService } from './gateway/index.js';
import { ControllerService } from './controller/index.js';
import { GLMService } from './llm/glm.js';
import { NemotronService } from './llm/nemotron.js';
import { HotMemoryStore } from './memory/hot.js';
import { VectorMemoryStore } from './memory/vector.js';
import { MemoryFlush } from './memory/flush.js';
import { OpenClawAgent } from './executor/openclaw-agent.js';
import { OpenClawCron } from './executor/openclaw-cron.js';
import { DiscordAdapter } from './adapters/discord/index.js';
import { TelegramAdapter } from './adapters/telegram/index.js';
import { ChatService, ToolService, TaskService, ScheduleService } from './services/index.js';
import { SceneType } from './types/index.js';
import type { PlatformAdapter } from './types/index.js';

const log = createChildLogger('main');

async function main() {
  log.info('小悠系统启动中...');

  // 初始化核心服务
  const glm = new GLMService();
  const nemotron = new NemotronService();
  const memory = new HotMemoryStore();
  const vectorMemory = new VectorMemoryStore(glm);
  const openclaw = new OpenClawAgent();
  const openclawCron = new OpenClawCron();
  const gateway = new GatewayService();

  // 初始化向量数据库
  await vectorMemory.init();

  // 初始化记忆归档服务
  const memoryFlush = new MemoryFlush(memory, vectorMemory);
  memoryFlush.start();

  // 初始化控制器
  const controller = new ControllerService(glm, memory);

  // 注册场景处理器
  controller.registerHandler(SceneType.CHAT, new ChatService(glm, memory, vectorMemory, memoryFlush));
  controller.registerHandler(SceneType.TOOL, new ToolService());
  controller.registerHandler(SceneType.TASK, new TaskService(nemotron, openclaw, memoryFlush));
  controller.registerHandler(
    SceneType.SCHEDULE,
    new ScheduleService(nemotron, openclaw, openclawCron),
  );

  // 初始化平台适配器
  const activeAdapters: PlatformAdapter[] = [];
  const startPromises: Promise<void>[] = [];

  if (config.discord.token) {
    const discord = new DiscordAdapter({
      token: config.discord.token,
      gateway,
      controller,
    });
    activeAdapters.push(discord);
    startPromises.push(discord.start());
  }

  if (config.telegram.token) {
    const telegram = new TelegramAdapter({
      token: config.telegram.token,
      gateway,
      controller,
    });
    activeAdapters.push(telegram);
    startPromises.push(telegram.start());
  }

  if (startPromises.length === 0) {
    log.warn('未配置任何平台适配器，请检查 .env 文件');
    return;
  }

  await Promise.all(startPromises);

  // 优雅关闭处理
  const shutdown = async (signal: string) => {
    log.info({ signal }, '收到关闭信号，正在优雅关闭...');
    try {
      memoryFlush.stop();
      gateway.destroy();
      await Promise.allSettled(activeAdapters.map((adapter) => adapter.stop()));
      log.info('所有服务已关闭');
      process.exit(0);
    } catch (error) {
      log.error({ error }, '关闭过程中发生错误');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  log.info(`小悠系统已启动 (${config.env} 模式)`);
}

main().catch((error) => {
  log.fatal({ error }, '小悠系统启动失败');
  process.exit(1);
});
