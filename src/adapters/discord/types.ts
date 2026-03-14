import type { ControllerService } from '../../controller/index.js';
import type { GatewayService } from '../../gateway/index.js';

export interface DiscordAdapterOptions {
  token: string;
  gateway: GatewayService;
  controller: ControllerService;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
}
