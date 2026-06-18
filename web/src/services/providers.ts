// 模型 Provider 配置（多服务商）：走 Vite dev 代理到本地 agent 服务。
// chat 流式逻辑已迁至 kernel/HttpSseKernelClient，这里只管 provider CRUD。
const BASE = '/api/v1/providers';

export interface ProviderConfigView {
  id: string;
  name: string;
  protocol: string;
  baseURL?: string;
  model: string;
  apiKey: string; // 服务端返回的是已掩码字符串
  organization?: string;
  timeout?: number;
  maxRetries?: number;
  isActive: boolean;
  source: 'env' | 'user';
}

export interface ProviderCreateInput {
  id: string;
  name: string;
  protocol: string;
  baseURL?: string;
  model: string;
  apiKey: string;
  organization?: string;
  timeout?: number;
  maxRetries?: number;
}

export type ProviderUpdateInput = Partial<Omit<ProviderCreateInput, 'id'>>;

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function listProviders(): Promise<ProviderConfigView[]> {
  const res = await fetch(BASE);
  return jsonOrThrow<ProviderConfigView[]>(res);
}

export async function createProvider(
  input: ProviderCreateInput,
): Promise<ProviderConfigView> {
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return jsonOrThrow<ProviderConfigView>(res);
}

export async function updateProvider(
  id: string,
  patch: ProviderUpdateInput,
): Promise<ProviderConfigView> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return jsonOrThrow<ProviderConfigView>(res);
}

export async function deleteProvider(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`${res.status}: ${text || res.statusText}`);
  }
}

export async function activateProvider(id: string): Promise<ProviderConfigView> {
  const res = await fetch(`${BASE}/${encodeURIComponent(id)}/activate`, {
    method: 'POST',
  });
  return jsonOrThrow<ProviderConfigView>(res);
}
