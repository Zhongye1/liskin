import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { MessageSquare, Folder, BookOpen, Settings, ChevronRight, ChevronLeft } from 'lucide-react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { cn } from '../../shared/lib/utils';
import { pageIndex } from '../hooks/useWipeNavigate';

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
 * 跨 section 导航通过 onClick+viewTransition 触发方向擦除。
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
    'truncate whitespace-nowrap transition-opacity',
    expanded ? 'opacity-100 duration-150' : 'opacity-0 overflow-hidden duration-0',
  );

  return (
    <Tooltip.Provider delayDuration={400} skipDelayDuration={200}>
      <nav
        className={cn(
          'flex shrink-0 flex-col items-start gap-0.5 border-r bg-sidebar p-2 py-4 transition-all duration-200 overflow-hidden',
          expanded ? 'w-36' : 'w-14',
        )}
      >
        {/* 导航项：统一结构，Tooltip 展开态受控关闭 */}
        {NAV_ITEMS.map((item) => {
          const active = isActive(item);

          return (
            <Tooltip.Root key={item.path} open={expanded ? false : undefined}>
              <Tooltip.Trigger asChild>
                <NavLink
                  to={item.path}
                  viewTransition
                  onClick={() => {
                    const from = pageIndex(location.pathname);
                    const target = pageIndex(item.path);
                    if (from !== target) {
                      document.documentElement.dataset.dir = target > from ? 'forward' : 'back';
                    }
                  }}
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
              'transition-opacity',
              expanded
                ? 'opacity-100 duration-150'
                : 'opacity-0 absolute inset-0 m-auto duration-0',
            )}
          />
          <ChevronRight
            size={15}
            strokeWidth={1.8}
            className={cn(
              'transition-opacity',
              expanded
                ? 'opacity-0 absolute inset-0 m-auto duration-0'
                : 'opacity-100 duration-150',
            )}
          />
          <span
            className={cn(
              'text-[11px] whitespace-nowrap transition-opacity',
              expanded ? 'opacity-100 duration-150' : 'opacity-0 absolute duration-0',
            )}
          >
            收起
          </span>
        </button>
      </nav>
    </Tooltip.Provider>
  );
}
