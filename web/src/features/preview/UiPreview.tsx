import { Badge, IconButton, Pill } from '../../shared/ui/primitives';
import {
  IconCheck,
  IconChevronDown,
  IconCloud,
  IconGitBranch,
  IconPlus,
  IconSend,
  IconSettings,
  IconSpinner,
} from '../../shared/ui/icons';
import { MOCK_PROJECT, MOCK_SESSIONS, MOCK_TURNS } from '../../shared/ui/harness-fixtures';
import { BrowserChrome } from '../../app/components/BrowserChrome';

/**
 * UI Harness 预览页（/ui-preview）。
 *
 * 用 mock fixtures 完整渲染新 UI（外壳 + 侧栏 + 对话流），
 * 不依赖后端 / store，便于设计走查、截图与回归对比。
 */
export function UiPreview() {
  return (
    <div className="flex h-screen flex-col bg-canvas">
      <BrowserChrome url="liskin.app/code · preview" />
      <div className="flex min-h-0 flex-1 overflow-hidden bg-panel">
        {/* 侧栏（静态 mock 版） */}
        <aside className="flex w-72 shrink-0 flex-col bg-sidebar">
          <div className="flex items-center gap-2 px-4 pb-3 pt-4">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-md bg-accent text-sm font-semibold text-white">
              L
            </span>
            <span className="text-[15px] font-semibold tracking-tight text-ink">Liskin Code</span>
            <Badge tone="neutral" className="ml-1">
              preview
            </Badge>
          </div>

          <div className="px-3">
            <div className="w-full rounded-xl2 border border-line bg-card p-3 shadow-panel">
              <span className="text-sm text-ink-faint">Ask Liskin to write code…</span>
              <div className="mt-6 flex justify-end">
                <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-accent-soft text-accent-ink">
                  <IconPlus size={15} />
                </span>
              </div>
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 px-3">
            <Pill icon={<IconGitBranch size={14} />}>{MOCK_PROJECT}</Pill>
            <Pill icon={<IconCloud size={14} />}>Cloud</Pill>
          </div>

          <div className="mt-4 flex items-center justify-between px-4 pb-1">
            <span className="text-xs font-medium uppercase tracking-wide text-ink-faint">
              Sessions
            </span>
            <span className="text-xs text-ink-faint">Active ▾</span>
          </div>

          <div className="flex-1 space-y-0.5 overflow-auto px-2 pb-2">
            {MOCK_SESSIONS.map((s, i) => {
              const active = i === 0;
              return (
                <div
                  key={s.id}
                  className={[
                    'flex w-full flex-col gap-0.5 rounded-lg px-3 py-2 text-left',
                    active ? 'bg-card shadow-panel' : '',
                  ].join(' ')}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={[
                        'truncate text-sm',
                        active ? 'font-medium text-ink' : 'text-ink/90',
                      ].join(' ')}
                    >
                      {s.title}
                    </span>
                    {s.status === 'answered' ? (
                      <Badge tone="accent">
                        <IconCheck size={11} /> Answered
                      </Badge>
                    ) : null}
                    {s.meta ? <Badge tone="ok">{s.meta}</Badge> : null}
                  </div>
                  <span className="truncate text-xs text-ink-faint">{s.project}</span>
                </div>
              );
            })}
          </div>

          <div className="flex items-center gap-1 border-t border-line px-3 py-2">
            <IconButton title="设置">
              <IconSettings size={16} />
            </IconButton>
            <span className="text-xs text-ink-faint">Settings</span>
          </div>
        </aside>

        {/* 对话面板（静态 mock 版） */}
        <main className="flex min-w-0 flex-1 flex-col border-l border-line bg-panel">
          <header className="flex items-center gap-2 border-b border-line px-5 py-3">
            <h1 className="truncate text-sm font-medium text-ink">
              Round subscription amounts to dollar
            </h1>
            <IconChevronDown size={15} className="text-ink-faint" />
          </header>

          <div className="flex-1 space-y-5 overflow-auto px-5 py-5">
            {MOCK_TURNS.map((turn) =>
              turn.role === 'user' ? (
                <div key={turn.id} className="flex justify-end">
                  <div className="max-w-[80%] rounded-xl2 rounded-br-md bg-accent-soft px-4 py-2.5 text-sm leading-relaxed text-accent-ink">
                    {turn.content}
                  </div>
                </div>
              ) : (
                <div key={turn.id} className="space-y-1.5">
                  {turn.steps?.map((step, idx) =>
                    step.kind === 'text' ? (
                      <div
                        key={idx}
                        className="flex items-center gap-2 px-1 text-sm leading-relaxed text-ink"
                      >
                        {step.state === 'running' ? (
                          <IconSpinner size={13} className="text-accent" />
                        ) : null}
                        <span
                          className={step.state === 'running' ? 'animate-pulse text-ink-faint' : ''}
                        >
                          {step.text}
                        </span>
                      </div>
                    ) : (
                      <div key={idx} className="flex items-center gap-2 px-1 py-0.5 text-sm">
                        <span className="inline-flex w-4 shrink-0 items-center justify-center">
                          <IconCheck size={13} className="text-ok" />
                        </span>
                        <span className="font-mono font-medium text-ink">{step.tool}</span>
                        <span className="truncate font-mono text-ink-soft">{step.text}</span>
                      </div>
                    ),
                  )}
                </div>
              ),
            )}
          </div>

          <div className="px-5 pb-5">
            <div className="flex items-end gap-2 rounded-xl2 border border-line bg-card p-2 shadow-composer">
              <textarea
                rows={1}
                readOnly
                className="max-h-40 flex-1 resize-none bg-transparent px-2 py-1.5 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
                placeholder="Reply to Liskin…"
              />
              <IconButton title="发送" className="bg-accent text-white hover:bg-accent-ink">
                <IconSend size={15} />
              </IconButton>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
