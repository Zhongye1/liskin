import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/utils';
import { ChevronDown } from 'lucide-react';

/** 圆形头像（首字母兜底）。 */
export function Avatar({ label, src, size = 28 }: { label: string; src?: string; size?: number }) {
  return src ? (
    <img src={src} alt={label} width={size} height={size} className="rounded-full object-cover" />
  ) : (
    <span
      className="inline-flex items-center justify-center rounded-full bg-accent-soft font-medium text-accent-ink"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {label.slice(0, 1).toUpperCase()}
    </span>
  );
}

type BadgeTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger';

const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-line/60 text-ink-soft',
  accent: 'bg-accent-soft text-accent-ink',
  ok: 'bg-ok/10 text-ok',
  warn: 'bg-warn/10 text-warn',
  danger: 'bg-danger/10 text-danger',
};

/** 小徽标：状态 / 计数 / 标签。 */
export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium leading-none',
        BADGE_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** 选择器外观的胶囊按钮（仓库选择 / Cloud 选择等）。 */
export function Pill({
  icon,
  children,
  trailing = true,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  icon?: ReactNode;
  trailing?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex items-center gap-2 rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink transition hover:border-accent/40 hover:bg-accent-soft/40',
        className,
      )}
      {...props}
    >
      {icon ? <span className="text-ink-soft">{icon}</span> : null}
      <span className="min-w-0 flex-1 truncate text-left">{children}</span>
      {trailing ? <ChevronDown size={14} className="shrink-0 text-ink-faint" /> : null}
    </button>
  );
}

/** 仅图标的方形按钮。 */
export function IconButton({
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-soft transition hover:bg-line/60 hover:text-ink disabled:pointer-events-none disabled:opacity-40',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
