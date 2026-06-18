import { z } from 'zod';

export const ProviderProtocolSchema = z.enum(['openai-compatible']);
export type ProviderProtocol = z.infer<typeof ProviderProtocolSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  protocol: ProviderProtocolSchema,
  baseURL: z.string().url().optional(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  organization: z.string().optional(),
  timeout: z.number().int().positive().optional(),
  maxRetries: z.number().int().nonnegative().optional(),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
