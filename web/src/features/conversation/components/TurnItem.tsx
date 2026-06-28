import type { Turn } from '../lib/events';
import { ToolStep, TextStep, ConfirmCard } from './Steps';
import { Loader } from 'lucide-react';

export function TurnItem({ turn }: { turn: Turn }) {
  return (
    <div className="space-y-3">
      {/* 用户气泡 */}
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-xl2 rounded-br-md bg-accent-soft px-4 py-2.5 text-sm leading-relaxed text-accent-ink">
          {turn.userContent}
        </div>
      </div>

      {/* assistant 步骤序列 */}
      <div className="space-y-1.5">
        {turn.steps.map((step) => {
          if (step.kind === 'text') {
            return <TextStep key={step.id} step={step} />;
          }
          return <ToolStep key={step.id} step={step} />;
        })}
        {turn.status === 'running' ? (
          <div className="flex items-center gap-2 pl-1 text-xs text-ink-faint">
            <Loader size={13} />
            <span className="animate-pulse">Pondering…</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export { ConfirmCard };
