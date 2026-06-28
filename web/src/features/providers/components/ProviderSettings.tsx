/* eslint-disable max-lines -- 旧组件，Step 3.3 会重写 */
import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '../../../shared/ui/button';
import {
  activateProvider,
  createProvider,
  deleteProvider,
  listProviders,
  updateProvider,
  type ProviderView,
  type ProviderCreateInput,
  type ProviderUpdateInput,
} from '../services/providers';

interface DraftForm {
  id: string;
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  organization: string;
  timeout: string;
  maxRetries: string;
}

const EMPTY_FORM: DraftForm = {
  id: '',
  name: '',
  baseURL: '',
  apiKey: '',
  model: '',
  organization: '',
  timeout: '',
  maxRetries: '',
};

function rowToForm(row: ProviderView): DraftForm {
  return {
    id: row.id,
    name: row.name,
    baseURL: row.baseURL ?? '',
    apiKey: '', // 编辑时空字符串 = 保持原值
    model: row.model,
    organization: row.organization ?? '',
    timeout: row.timeout?.toString() ?? '',
    maxRetries: row.maxRetries?.toString() ?? '',
  };
}

function buildPayload(
  form: DraftForm,
  isCreate: boolean,
): ProviderCreateInput | ProviderUpdateInput {
  const out: Record<string, unknown> = {
    name: form.name,
    model: form.model,
    protocol: 'openai-compatible',
  };
  if (isCreate) {
    out.id = form.id;
    out.apiKey = form.apiKey;
  } else if (form.apiKey) {
    out.apiKey = form.apiKey;
  }
  if (form.baseURL) {
    out.baseURL = form.baseURL;
  }
  if (form.organization) {
    out.organization = form.organization;
  }
  const timeoutNum = Number.parseInt(form.timeout, 10);
  if (Number.isFinite(timeoutNum) && timeoutNum > 0) {
    out.timeout = timeoutNum;
  }
  const retriesNum = Number.parseInt(form.maxRetries, 10);
  if (Number.isFinite(retriesNum) && retriesNum >= 0) {
    out.maxRetries = retriesNum;
  }
  return out as ProviderCreateInput | ProviderUpdateInput;
}

export function ProviderSettings() {
  const [list, setList] = useState<ProviderView[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<DraftForm>(EMPTY_FORM);

  const refresh = async () => {
    try {
      setLoading(true);
      setError(null);
      const rows = await listProviders();
      setList(rows);
    } catch (error_) {
      setError(error_ instanceof Error ? error_.message : String(error_));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const isEditing = editingId !== null;

  const startEdit = (row: ProviderView) => {
    setEditingId(row.id);
    setForm(rowToForm(row));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setForm(EMPTY_FORM);
  };

  const submit = async () => {
    try {
      if (isEditing && editingId) {
        const patch = buildPayload(form, false) as ProviderUpdateInput;
        await updateProvider(editingId, patch);
        toast.success('已更新');
      } else {
        if (!form.id || !form.name || !form.model || !form.apiKey) {
          toast.error('id / name / model / apiKey 必填');
          return;
        }
        const payload = buildPayload(form, true) as ProviderCreateInput;
        await createProvider(payload);
        toast.success('已创建');
      }
      setEditingId(null);
      setForm(EMPTY_FORM);
      await refresh();
    } catch (error_) {
      toast.error(error_ instanceof Error ? error_.message : String(error_));
    }
  };

  const handleActivate = async (id: string) => {
    try {
      await activateProvider(id);
      toast.success(`已切换到 ${id}`);
      await refresh();
    } catch (error_) {
      toast.error(error_ instanceof Error ? error_.message : String(error_));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteProvider(id);
      toast.success('已删除');
      await refresh();
    } catch (error_) {
      toast.error(error_ instanceof Error ? error_.message : String(error_));
    }
  };

  return (
    <div className="rounded-xl border bg-white p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-700">模型 Provider 配置</h3>
        <Button intent="ghost" size="sm" onClick={() => void refresh()} disabled={loading}>
          刷新
        </Button>
      </div>

      {error ? <p className="mb-3 rounded bg-red-50 p-2 text-xs text-red-600">{error}</p> : null}

      <div className="mb-4 space-y-2">
        {list.length === 0 ? (
          <p className="text-xs text-slate-400">暂无 provider，请新建一个。</p>
        ) : (
          list.map((row) => (
            <div
              key={row.id}
              className="flex items-center justify-between rounded border bg-slate-50 p-2 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono">{row.id}</span>
                  <span className="text-slate-500">·</span>
                  <span>{row.name}</span>
                  {row.isActive ? <span className="text-emerald-600">● active</span> : null}
                  <span className="rounded bg-slate-200 px-1 text-[10px] text-slate-600">
                    {row.source}
                  </span>
                </div>
                <div className="mt-1 truncate text-[11px] text-slate-500">
                  {row.protocol} · {row.model}
                  {row.baseURL ? ` · ${row.baseURL}` : ''} · key={row.apiKey}
                </div>
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  intent="ghost"
                  size="sm"
                  onClick={() => void handleActivate(row.id)}
                  disabled={row.isActive}
                >
                  设为当前
                </Button>
                <Button intent="ghost" size="sm" onClick={() => startEdit(row)}>
                  编辑
                </Button>
                <Button
                  intent="ghost"
                  size="sm"
                  onClick={() => void handleDelete(row.id)}
                  disabled={row.isActive}
                >
                  删除
                </Button>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="rounded border bg-slate-50 p-3">
        <h4 className="mb-2 text-xs font-medium text-slate-700">
          {isEditing ? `编辑 ${editingId}` : '新增 provider'}
        </h4>
        <div className="grid grid-cols-2 gap-2 text-xs">
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">id（创建必填）</span>
            <input
              className="rounded border px-2 py-1"
              value={form.id}
              onChange={(e) => setForm({ ...form, id: e.target.value })}
              disabled={isEditing}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">name</span>
            <input
              className="rounded border px-2 py-1"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">model</span>
            <input
              className="rounded border px-2 py-1"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">baseURL（可选）</span>
            <input
              className="rounded border px-2 py-1"
              value={form.baseURL}
              onChange={(e) => setForm({ ...form, baseURL: e.target.value })}
            />
          </label>
          <label className="col-span-2 flex flex-col gap-1">
            <span className="text-slate-500">
              apiKey{isEditing ? '（留空 = 保持不变）' : '（必填）'}
            </span>
            <input
              type="password"
              className="rounded border px-2 py-1"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              placeholder={isEditing ? '••••（不修改请留空）' : 'sk-...'}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">organization（可选）</span>
            <input
              className="rounded border px-2 py-1"
              value={form.organization}
              onChange={(e) => setForm({ ...form, organization: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">timeout ms（可选）</span>
            <input
              className="rounded border px-2 py-1"
              value={form.timeout}
              onChange={(e) => setForm({ ...form, timeout: e.target.value })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">maxRetries（可选）</span>
            <input
              className="rounded border px-2 py-1"
              value={form.maxRetries}
              onChange={(e) => setForm({ ...form, maxRetries: e.target.value })}
            />
          </label>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          {isEditing ? (
            <Button intent="ghost" size="sm" onClick={cancelEdit}>
              取消
            </Button>
          ) : null}
          <Button size="sm" onClick={() => void submit()}>
            {isEditing ? '保存' : '创建'}
          </Button>
        </div>
      </div>
    </div>
  );
}
