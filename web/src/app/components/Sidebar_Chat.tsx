import type { SessionInfo } from '@liskin/core';
import { Badge, IconButton, Pill } from '../../shared/ui/primitives';
import { IconCloud, IconGitBranch, IconPlus, IconSettings } from '../../shared/ui/icons';

interface Sidebar_Chat_Props {
  sessions: SessionInfo[];
  activeSessionId?: string;
  project?: string;
  onNewSession: () => void;
  onSelectSession: (id: string) => void;
  onOpenSettings: () => void;
}

/**
 * 左侧栏：品牌头、内联 composer、项目/Cloud 选择、会话列表、设置入口。
 * 纯展示组件——数据与回调由 App（连 store）注入，便于在预览页用 mock 复用。
 */
export function Sidebar_Chat({
  sessions,
  activeSessionId,
  project = 'liskin/workspace',
  onNewSession,
  onSelectSession,
  onOpenSettings,
}: Sidebar_Chat_Props) {
  return (
    <aside className="flex w-72 shrink-0 flex-col bg-sidebar">
      {/* 品牌头 */}
      <div className="flex items-center gap-2 px-4 pb-3 pt-4">
        <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-accent text-sm font-semibold text-white">
          L
        </span>
        <span className="text-[15px] font-semibold tracking-tight text-ink">Liskin Code</span>
        <Badge tone="neutral" className="ml-1">
          preview
        </Badge>
      </div>

      {/* 内联 composer 卡片 */}
      <div className="px-3">
        <button
          type="button"
          onClick={onNewSession}
          className="group w-full rounded-xl2 border border-line bg-card p-3 text-left shadow-panel transition hover:border-accent/40"
        >
          <span className="text-sm text-ink-faint">Ask Liskin to write code…</span>
          <div className="mt-6 flex justify-end">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-accent-ink transition group-hover:bg-accent group-hover:text-white">
              <IconPlus size={15} />
            </span>
          </div>
        </button>
      </div>

      {/* 项目 / Cloud 选择 */}
      <div className="mt-3 grid grid-cols-2 gap-2 px-3">
        <Pill icon={<IconGitBranch size={14} />} className="col-span-1">
          {project}
        </Pill>
        <Pill icon={<IconCloud size={14} />} className="col-span-1">
          Cloud
        </Pill>
      </div>

      {/* 会话列表 */}
      <div className="mt-4 flex items-center justify-between px-4 pb-1">
        <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">Sessions</span>
        <button
          type="button"
          onClick={onNewSession}
          className="text-xs text-ink-faint transition hover:text-accent-ink"
        >
          Active ▾
        </button>
      </div>

      <div className="flex-1 space-y-0.5 overflow-auto px-2 pb-2">
        {sessions.length === 0 ? (
          <p className="px-2 py-4 text-xs text-ink-faint">还没有会话，点击上方开始</p>
        ) : (
          sessions.map((s) => {
            const active = s.id === activeSessionId;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelectSession(s.id)}
                title={s.id}
                className={[
                  'group flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left transition',
                  active ? 'bg-card shadow-panel' : 'hover:bg-card/60',
                ].join(' ')}
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={[
                      'truncate text-sm',
                      active ? 'font-medium text-ink' : 'text-ink/90',
                    ].join(' ')}
                  >
                    {sessionTitle(s)}
                  </span>
                  {s.messageCount > 0 ? (
                    <Badge tone={active ? 'accent' : 'neutral'}>{s.messageCount}</Badge>
                  ) : null}
                </div>
                <span className="truncate text-xs text-ink-faint">{project}</span>
              </button>
            );
          })
        )}
      </div>

      {/* 底部设置 */}
      <div className="flex items-center gap-1 border-t border-line px-3 py-2">
        <IconButton onClick={onOpenSettings} title="设置">
          <IconSettings size={16} />
        </IconButton>
        <span className="text-xs text-ink-faint">Settings</span>
      </div>
    </aside>
  );
}

/** 会话标题兜底：协议层 SessionInfo 暂无 title 字段，用 id 短哈希占位。 */
function sessionTitle(s: SessionInfo): string {
  return `Session ${s.id.slice(0, 8)}`;
}
