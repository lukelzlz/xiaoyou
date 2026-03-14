import { config } from './config/index.js';
import { createChildLogger } from './utils/logger.js';
import { GatewayService } from './gateway/index.js';
import { ControllerService } from './controller/index.js';
import { GLMService } from './llm/glm.js';
import { NemotronService } from './llm/nemotron.js';
import { HotMemoryStore } from './memory/hot.js';
import { OpenClawAgent } from './executor/openclaw-agent.js';
import { DiscordAdapter } from './adapters/discord/index.js';
import { TelegramAdapter } from './adapters/telegram/index.js';
import { ChatService, ToolService, TaskService, ScheduleService } from './services/index.js';
import { SceneType } from './types/index.js';

const log = createChildLogger('main');

async function main() {
  log.info('小悠系统启动中...');

  // 初始化核心服务
  const glm = new GLMService();
  const nemotron = new NemotronService();
  const memory = new HotMemoryStore();
  const openclaw = new OpenClawAgent();
  const gateway = new GatewayService();

  // 初始化控制器
  const controller = new ControllerService(glm, memory);

  // 注册场景处理器
  controller.registerHandler(SceneType.CHAT, new ChatService());
  controller.registerHandler(SceneType.TOOL, new ToolService());
  controller.registerHandler(SceneType.TASK, new TaskService(nemotron, openclaw));
  controller.registerHandler(SceneType.SCHEDULE, new ScheduleService(nemotron, openclaw));

  // 初始化平台适配器
  const adapters = [];

  if (config.discord.token) {
    const discord = new DiscordAdapter({
      token: config.discord.token,
      gateway,
      controller,
    });
    adapters.push(discord.start());
  }

  if (config.telegram.token) {
    const telegram = new TelegramAdapter({
      token: config.telegram.token,
      gateway,
      controller,
    });
    adapters.push(telegram.start());
  }

  if (adapters.length === 0) {
    log.warn('未配置任何平台适配器，请检查 .env 文件');
    return;
  }

  await Promise.all(adapters);

  log.info(`小悠系统已启动 (${config.env} 模式)`);
}

main().catch((error) => {
  log.fatal({ error }, '小悠系统启动失败');
  process.exit(1);
});
