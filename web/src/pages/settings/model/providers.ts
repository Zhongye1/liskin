/**
 * Provider CRUD：全部走 api/http.ts 的 axios 实例。
 * 原文件的手写 fetch 已迁移至 api/http.ts，此处仅做类型适配 re-export。
 */
import { providers as api } from '../../../api';
import type {
  ProviderCreateInput,
  ProviderUpdateInput,
  ProviderView,
} from '../../../api/types/types';

export type { ProviderCreateInput, ProviderUpdateInput, ProviderView };

export const listProviders = (): Promise<ProviderView[]> => api.list();

export const createProvider = (input: ProviderCreateInput): Promise<ProviderView> =>
  api.create(input as unknown as Record<string, unknown>);

export const updateProvider = (id: string, patch: ProviderUpdateInput): Promise<ProviderView> =>
  api.update(id, patch as unknown as Record<string, unknown>);

export const deleteProvider = (id: string) => api.delete(id);

export const activateProvider = (id: string): Promise<ProviderView> => api.activate(id);
