import type { ControllerService } from '../../controller/index.js';
import type { GatewayService } from '../../gateway/index.js';

export interface TelegramAdapterOptions {
  token: string;
  gateway: GatewayService;
  controller: ControllerService;
  apiUrl?: string;
}

export interface InlineKeyboard {
  inline_keyboard: Array<
    Array<{
      text: string;
      callback_data?: string;
      url?: string;
    }>
  >;
}
