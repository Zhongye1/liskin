import { ChevronDown, Bell, Settings, Sprout } from 'lucide-react';
import { cn } from '../../shared/lib/utils';
import { Avatar, Badge } from '../../shared/ui/primitives';

interface HeadBarProps {
  brand?: string;
  stage?: string;
  avatarLabel?: string;
  avatarSrc?: string;
  githubUrl?: string;
  hasNotification?: boolean;
  onBellClick?: () => void;
  onSettingsClick?: () => void;
  onStageClick?: () => void;
}

/**
 * 顶部状态栏：品牌 + 阶段下拉 + GitHub + 设置 + 通知铃铛 + 头像。
 * 使用项目语义化设计令牌，图标统一走 lucide-react。
 */
export function HeadBar_Top({
  brand = 'Liskin Code Web',
  stage = 'AI4SE Preview',
  avatarLabel = 'Z',
  avatarSrc,
  githubUrl = 'https://github.com/Zhongye1/liskin',
  hasNotification = false,
  onBellClick,
  onSettingsClick,
  onStageClick,
}: HeadBarProps) {
  const iconBtn =
    'inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-faint transition hover:bg-line/60 hover:text-ink';

  return (
    <header className="flex items-center gap-1.5 border-b border-line bg-accent-soft px-4 py-2">
      {/* 品牌 */}
      <div className="flex items-center gap-2.5">
        <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-[13px] font-bold text-white shadow-[0_0_10px_rgba(204,122,91,0.35)]">
          L
        </span>
        <div className="flex flex-col leading-none">
          <span className="text-[14px] font-semibold tracking-tight text-ink">{brand}</span>
          <span className="text-[10px] text-ink-faint">Liskarm Agentcy</span>
        </div>
      </div>

      <div className="flex-1" />

      {/* 阶段标签 */}
      <button
        type="button"
        onClick={onStageClick}
        className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-card px-2.5 py-1 text-[11px] font-medium text-ink-soft transition hover:border-accent/40 hover:text-ink"
      >
        <Badge tone="neutral">{stage}</Badge>
        <ChevronDown size={12} strokeWidth={1.8} className="text-ink-faint" />
      </button>

      {/* GitHub 外链 */}
      <a
        href={githubUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={iconBtn}
        title="GitHub"
      >
        <Sprout size={15} strokeWidth={1.8} />
      </a>

      {/* 设置 */}
      <button type="button" onClick={onSettingsClick} className={iconBtn} title="设置">
        <Settings size={15} strokeWidth={1.8} />
      </button>

      {/* 通知铃铛 */}
      <button type="button" onClick={onBellClick} title="通知" className={cn(iconBtn, 'relative')}>
        <Bell size={15} strokeWidth={1.8} />
        {hasNotification ? (
          <span className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full bg-accent" />
        ) : null}
      </button>

      {/* 头像 — 复用项目 Avatar 原语 */}
      <Avatar label={avatarLabel} src={avatarSrc} size={28} />
    </header>
  );
}
