// cli config 接口类型定义

export interface Config {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  port?: number;
  host?: string;
  dbPath?: string;
  pathWhitelist?: string[];
  corsOrigin?: string | string[];
  confirmPolicy?: 'auto' | 'ask' | 'deny';
}
