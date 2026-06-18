import type { Turn } from '../../kernel/events';
import { ToolStep, TextStep, ConfirmCard } from './Steps';

export function TurnItem({ turn }: { turn: Turn }) {
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-lg bg-slate-800 px-3 py-2 text-sm text-white">
          {turn.userContent}
        </div>
      </div>
      <div className="space-y-2">
        {turn.steps.map((step) => {
          if (step.kind === 'text') {return <TextStep key={step.id} step={step} />;}
          return <ToolStep key={step.id} step={step} />;
        })}
        {turn.status === 'running' ? (
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue-500" />
            运行中…
          </div>
        ) : null}
      </div>
    </div>
  );
}

export { ConfirmCard };
