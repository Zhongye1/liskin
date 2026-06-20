import { z } from 'zod';

export const ConfigSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
  model: z.string().optional(),
  port: z.number().optional(),
  host: z.string().optional(),
  dbPath: z.string().optional(),
  pathWhitelist: z.array(z.string()).optional(),
  corsOrigin: z.union([z.string(), z.array(z.string())]).optional(),
  confirmPolicy: z.enum(['auto', 'ask', 'deny']).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
