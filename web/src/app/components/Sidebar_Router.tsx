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
 * 文字始终在 DOM 中（opacity 控制显隐），保证展开/收缩双向过渡动画。
 * 收缩态 hover 显示 Radix Tooltip，展开态 tooltip 受控关闭。
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

  // 文字显隐：始终渲染，opacity + overflow-hidden 控制
  const textClass = cn(
    'truncate whitespace-nowrap transition-opacity duration-150',
    expanded ? 'opacity-100' : 'opacity-0 overflow-hidden',
  );

  return (
    <Tooltip.Provider delayDuration={400} skipDelayDuration={200}>
      <nav
        className={cn(
          'flex shrink-0 flex-col items-start gap-0.5 border-r bg-sidebar p-2 py-4 transition-all duration-200 overflow-hidden',
          expanded ? 'w-36' : 'w-14',
        )}
      >
        {/* 品牌 Logo — 标不动，文字 opacity 过渡 */}
        <NavLink
          to="/"
          className={cn(
            'flex items-center rounded-xl font-semibold gap-3 px-2 mb-2 h-10 text-white transition hover:bg-accent-ink bg-accent shrink-0',
            expanded ? 'w-full' : 'w-10',
          )}
          title="Liskin Code"
        >
          <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-white/20 text-[11px] font-semibold">
            L
          </span>
          <span className={cn(textClass, 'text-sm')}>Liskin</span>
        </NavLink>

        {/* 导航项：统一结构，Tooltip 展开态受控关闭 */}
        {NAV_ITEMS.map((item) => {
          const active = isActive(item);

          return (
            <Tooltip.Root key={item.path} open={expanded ? false : undefined}>
              <Tooltip.Trigger asChild>
                <NavLink
                  to={item.path}
                  className={cn(
                    'flex items-center rounded-xl transition px-2.5 gap-3 shrink-0',
                    expanded ? 'w-full h-10' : 'h-10 w-10',
                    active
                      ? 'bg-accent-soft text-accent-ink'
                      : 'text-ink-faint hover:bg-line/60 hover:text-ink',
                  )}
                >
                  <item.icon size={20} strokeWidth={1.8} className="shrink-0" />
                  <span className={cn(textClass, 'text-sm font-medium')}>{item.name}</span>
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

        {/* 底部切换按钮 — 两枚图标始终在 DOM，opacity 交替显隐 */}
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className={cn(
            'mt-auto flex items-center rounded-lg text-ink-faint transition hover:bg-line/60 hover:text-ink shrink-0 relative',
            expanded ? 'gap-1.5 px-2 h-8' : 'h-8 w-8 justify-center',
          )}
          title={expanded ? '收缩侧栏' : '展开侧栏'}
        >
          <ChevronLeft
            size={15}
            strokeWidth={1.8}
            className={cn(
              'transition-opacity duration-150 align-middle',
              expanded ? 'opacity-100' : 'opacity-0 absolute inset-0 m-auto',
            )}
          />
          <ChevronRight
            size={15}
            strokeWidth={1.8}
            className={cn(
              'transition-opacity duration-150',
              expanded ? 'opacity-0 absolute inset-0 m-auto' : 'opacity-100',
            )}
          />
          <span className={cn(textClass, 'text-[11px]')}>收起</span>
        </button>
      </nav>
    </Tooltip.Provider>
  );
}
