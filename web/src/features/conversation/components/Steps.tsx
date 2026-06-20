import type { Step } from '../lib/events';
import { useSessionStore } from '../store/session-store';
import { formatToolArgs } from '../../../shared/lib/tool-views';
import { Markdown } from '../../../shared/components/Markdown';

export function TextStep({ step }: { step: Extract<Step, { kind: 'text' }> }) {
  const text = step.parts.join('');
  return (
    <div className="max-w-[90%] rounded-lg border border-slate-200 bg-white px-3 py-2">
      <Markdown content={text} />
    </div>
  );
}

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: '⏳', cls: 'text-slate-400' },
  confirm: { label: '🔒', cls: 'text-amber-600' },
  running: { label: '◉', cls: 'text-blue-500 animate-pulse' },
  done: { label: '✓', cls: 'text-emerald-600' },
  error: { label: '✗', cls: 'text-red-600' },
};

export function ToolStep({ step }: { step: Extract<Step, { kind: 'tool' }> }) {
  if (step.kind !== 'tool') {return null;}
  const badge = STATUS_BADGE[step.status] ?? STATUS_BADGE.pending;
  const output = [...step.stdout, ...step.stderr].join('');
  return (
    <div className="max-w-[90%] rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs">
      <div className="mb-1 flex items-center gap-2">
        <span className={`font-mono ${badge.cls}`}>{badge.label}</span>
        <span className="font-mono font-medium text-slate-700">{step.call.name}</span>
        <span className="text-slate-500">{formatToolArgs(step.call)}</span>
      </div>
      {output ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-slate-900 p-2 text-[11px] leading-relaxed text-slate-100">
{output}
        </pre>
      ) : null}
      {step.result ? <TerminalOutput text={step.result.content} ok={step.result.ok} /> : null}
      {step.status === 'confirm' ? <ConfirmCard callId={step.call.id} /> : null}
    </div>
  );
}

/** 工具结果：成功时尝试 markdown 渲染（常含代码/列表），失败时终端式红字。 */
function TerminalOutput({ text, ok }: { text: string; ok: boolean }) {
  if (!ok) {
    return (
      <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-red-950 p-2 text-[11px] text-red-200">
        {text}
      </pre>
    );
  }
  return (
    <div className="mt-1 max-h-64 overflow-auto rounded bg-white p-2 text-[11px] text-slate-600">
      <Markdown content={text} />
    </div>
  );
}

export function ConfirmCard({ callId }: { callId: string }) {
  void callId;
  const approve = useSessionStore((s) => s.approveTool);
  const deny = useSessionStore((s) => s.denyTool);
  return (
    <div className="mt-2 flex items-center gap-2">
      <span className="text-amber-700">需要确认工具调用</span>
      <button
        type="button"
        onClick={() => void approve()}
        className="rounded bg-emerald-600 px-2 py-0.5 text-white hover:bg-emerald-700"
      >
        批准
      </button>
      <button
        type="button"
        onClick={() => void deny()}
        className="rounded bg-red-600 px-2 py-0.5 text-white hover:bg-red-700"
      >
        拒绝
      </button>
    </div>
  );
}
