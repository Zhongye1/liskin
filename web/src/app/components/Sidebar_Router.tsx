import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { MessageSquare, Folder, BookOpen, Settings, ChevronRight, ChevronLeft } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { cn } from '../../shared/lib/utils';

interface NavItem {
  name: string;
  path: string;
  icon: typeof MessageSquare;
}

const NAV_ITEMS: NavItem[] = [
  { name: '会话', path: '/', icon: MessageSquare },
  { name: '项目', path: '/projects', icon: Folder },
  { name: '知识库', path: '/knowledge', icon: BookOpen },
  { name: '设置', path: '/settings', icon: Settings },
];

/**
 * 最左侧纵向路由栏：顶级 section 切换。
 * 默认窄图标列（64px），点击底部 > 展开为图标+文字（160px），点击 < 收缩。
 * 收缩态 hover 显示 Radix Tooltip，展开态文字自说明，无需 tooltip。
 */
export function Sidebar_Router() {
  const [expanded, setExpanded] = useState(false);
  const location = useLocation();

  const isActive = (item: NavItem) => {
    if (item.path === '/') {
      return location.pathname === '/' || location.pathname.startsWith('/sessions/');
    }
    return location.pathname.startsWith(item.path);
  };

  const linkClass = (active: boolean) =>
    cn(
      'flex items-center rounded-xl transition px-2.5 gap-3',
      expanded ? ' w-full h-10' : 'h-10 w-10',
      active ? 'bg-accent-soft text-accent-ink' : 'text-ink-faint hover:bg-line/60 hover:text-ink',
    );

  return (
    <Tooltip.Provider delayDuration={400} skipDelayDuration={200}>
      <nav
        className={cn(
          'flex shrink-0 flex-col items-start p-2 py-4 gap-0.5 border-r transition-all duration-200',
          expanded ? 'w-36' : 'w-14',
        )}
      >
        {/* 品牌 Logo — 标不动，只控制文字显隐 */}
        <NavLink
          to="/"
          className={cn(
            'flex items-center rounded-xl font-semibold gap-3 px-2 mb-2 h-10 text-white transition hover:bg-accent-ink bg-accent',
            expanded ? 'w-full' : 'w-10',
          )}
          title="Liskin Code"
        >
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/20 text-[11px] font-semibold">
            L
          </span>
          {expanded && <span className="whitespace-nowrap">Liskin</span>}
        </NavLink>

        {/* 导航项 */}
        {NAV_ITEMS.map((item) => {
          const active = isActive(item);

          // 展开态：直接返回 NavLink，与 Logo 同为 nav 的直接子元素，对齐完全一致
          if (expanded) {
            return (
              <NavLink key={item.path} to={item.path} className={linkClass(active)}>
                <item.icon size={20} strokeWidth={1.8} className="shrink-0" />
                <span className="truncate text-sm font-medium whitespace-nowrap">{item.name}</span>
              </NavLink>
            );
          }

          // 收缩态：包裹 Tooltip
          return (
            <Tooltip.Root key={item.path}>
              <Tooltip.Trigger asChild>
                <NavLink to={item.path} className={linkClass(active)}>
                  <item.icon size={20} strokeWidth={1.8} className="shrink-0" />
                </NavLink>
              </Tooltip.Trigger>
              <Tooltip.Portal>
                <Tooltip.Content
                  side="right"
                  sideOffset={10}
                  className="rounded-lg bg-ink px-2.5 py-1.5 text-xs font-medium text-white shadow-panel"
                >
                  {item.name}
                  <Tooltip.Arrow className="fill-ink" />
                </Tooltip.Content>
              </Tooltip.Portal>
            </Tooltip.Root>
          );
        })}

        {/* 底部切换按钮 */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'mt-auto flex items-center rounded-lg text-ink-faint transition hover:bg-line/60 hover:text-ink',
            expanded ? 'gap-1.5 px-2 h-8' : 'h-8 w-8 justify-center',
          )}
          title={expanded ? '收缩侧栏' : '展开侧栏'}
        >
          {expanded ? (
            <>
              <ChevronLeft size={15} strokeWidth={1.8} />
              <span className="text-[11px] whitespace-nowrap">收起</span>
            </>
          ) : (
            <ChevronRight size={15} strokeWidth={1.8} />
          )}
        </button>
      </nav>
    </Tooltip.Provider>
  );
}
