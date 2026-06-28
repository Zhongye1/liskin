import type { Step } from '../lib/events';
import { useParams } from 'react-router-dom';
import { useSessionStore } from '../store/session-store';
import { formatToolArgs } from '../../../shared/lib/tool-views';
import { Markdown } from '../../../shared/components/Markdown';
import { IconCheck, IconSpinner } from '../../../shared/ui/icons';

export function TextStep({ step }: { step: Extract<Step, { kind: 'text' }> }) {
  const text = step.parts.join('');
  return (
    <div className="px-1 text-sm leading-relaxed text-ink">
      <Markdown content={text} />
    </div>
  );
}

/** 工具步骤状态点：复刻设计稿的彩色圆点 + 状态语义。 */
function StatusDot({ status }: { status: string }) {
  if (status === 'running') {
    return <IconSpinner size={13} className="text-accent" />;
  }
  if (status === 'done') {
    return <IconCheck size={13} className="text-ok" />;
  }
  if (status === 'error') {
    return <span className="text-sm leading-none text-danger">✗</span>;
  }
  if (status === 'confirm') {
    return <span className="text-sm leading-none text-warn">🔒</span>;
  }
  return <span className="h-1.5 w-1.5 rounded-full bg-ink-faint" />;
}

export function ToolStep({ step }: { step: Extract<Step, { kind: 'tool' }> }) {
  if (step.kind !== 'tool') {
    return null;
  }
  const output = [...step.stdout, ...step.stderr].join('');
  return (
    <div className="px-1">
      {/* 单行步骤：状态点 · 工具名 · 参数 */}
      <div className="flex items-center gap-2 py-0.5 text-sm">
        <span className="inline-flex w-4 shrink-0 items-center justify-center">
          <StatusDot status={step.status} />
        </span>
        <span className="font-mono font-medium text-ink">{step.call.name}</span>
        <span className="truncate font-mono text-ink-soft">{formatToolArgs(step.call)}</span>
      </div>

      {/* 流式输出 */}
      {output ? (
        <pre className="mb-1 ml-6 mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-ink/95 p-2.5 text-[11px] leading-relaxed text-panel">
          {output}
        </pre>
      ) : null}

      {/* 工具结果 */}
      {step.result ? <TerminalOutput text={step.result.content} ok={step.result.ok} /> : null}

      {step.status === 'confirm' ? <ConfirmCard callId={step.call.id} /> : null}
    </div>
  );
}

/** 工具结果：成功时尝试 markdown 渲染（常含代码/列表），失败时终端式红字。 */
function TerminalOutput({ text, ok }: { text: string; ok: boolean }) {
  if (!ok) {
    return (
      <pre className="ml-6 mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-danger/10 p-2.5 text-[11px] text-danger">
        {text}
      </pre>
    );
  }
  return (
    <div className="ml-6 mt-1 max-h-64 overflow-auto rounded-lg border border-line bg-card p-2.5 text-[11px] text-ink-soft">
      <Markdown content={text} />
    </div>
  );
}

export function ConfirmCard({ callId }: { callId: string }) {
  void callId;
  const { sessionId } = useParams<{ sessionId: string }>();
  const approve = useSessionStore((s) => s.approveTool);
  const deny = useSessionStore((s) => s.denyTool);
  return (
    <div className="ml-6 mt-2 flex items-center gap-2 text-xs">
      <span className="text-warn">需要确认工具调用</span>
      <button
        type="button"
        onClick={() => {
          if (sessionId) {
            void approve(sessionId);
          }
        }}
        className="rounded-md bg-ok px-2.5 py-1 font-medium text-white transition hover:opacity-90"
      >
        批准
      </button>
      <button
        type="button"
        onClick={() => {
          if (sessionId) {
            void deny(sessionId);
          }
        }}
        className="rounded-md bg-danger px-2.5 py-1 font-medium text-white transition hover:opacity-90"
      >
        拒绝
      </button>
    </div>
  );
}
