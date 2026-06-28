/**
 * axios 实例 + 控制类请求封装。
 * 管理所有短请求（session CRUD、interrupt、confirm、provider CRUD、tools）。
 */
import axios, { type AxiosInstance } from 'axios';

import { ApiError, type CreateSessionBody, type ProviderView } from '../types/types';

const BASE = '/api/v1';

// —— axios 实例 —— //

const http: AxiosInstance = axios.create({
  baseURL: BASE,
  headers: { 'content-type': 'application/json' },
  timeout: 30_000,
});

// 响应拦截：统一错误归一化
http.interceptors.response.use(
  (res) => res,
  (error) => {
    if (axios.isAxiosError(error)) {
      const msg = (error.response?.data as { error?: string })?.error ?? error.message;
      throw new ApiError(error.response?.status ?? 0, msg);
    }
    throw error;
  },
);

// —— Sessions —— //

export const sessions = {
  create(body?: CreateSessionBody) {
    return http.post('/sessions', body).then((r) => r.data);
  },
  list() {
    return http.get<{ sessions: unknown[] }>('/sessions').then((r) => r.data);
  },
  get(sessionId: string) {
    return http.get(`/sessions/${encodeURIComponent(sessionId)}`).then((r) => r.data);
  },
  async close(sessionId: string): Promise<void> {
    await http.delete(`/sessions/${encodeURIComponent(sessionId)}`);
  },
  async interrupt(sessionId: string): Promise<void> {
    await http.post(`/sessions/${encodeURIComponent(sessionId)}/interrupt`);
  },
  confirm(sessionId: string, callId: string, decision: 'approve' | 'deny') {
    return http
      .post(`/sessions/${encodeURIComponent(sessionId)}/confirm`, {
        callId,
        decision,
      })
      .then((r) => r.data);
  },
};

// —— Providers —— //

export const providers = {
  list() {
    return http.get<ProviderView[]>('/providers').then((r) => r.data);
  },
  create(input: Record<string, unknown>) {
    return http.post<ProviderView>('/providers', input).then((r) => r.data);
  },
  update(id: string, patch: Record<string, unknown>) {
    return http
      .put<ProviderView>(`/providers/${encodeURIComponent(id)}`, patch)
      .then((r) => r.data);
  },
  async delete(id: string): Promise<void> {
    await http.delete(`/providers/${encodeURIComponent(id)}`);
  },
  activate(id: string) {
    return http
      .post<ProviderView>(`/providers/${encodeURIComponent(id)}/activate`)
      .then((r) => r.data);
  },
};

// —— Tools —— //

export const tools = {
  list() {
    return http.get<{ tools: unknown[] }>('/tools').then((r) => r.data);
  },
};
