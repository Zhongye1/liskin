import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

const ORDER = ['/', '/projects', '/knowledge', '/settings'] as const;

export function pageIndex(pathname: string): number {
  if (pathname === '/' || pathname.startsWith('/sessions/')) {return 0;}
  if (pathname.startsWith('/projects')) {return 1;}
  if (pathname.startsWith('/knowledge')) {return 2;}
  if (pathname.startsWith('/settings')) {return 3;}
  return 0;
}

export function pageKey(pathname: string): string {
  return ORDER[pageIndex(pathname)] ?? pathname;
}

/**
 * 带方向擦除的导航：跨 section 才触发 View Transition。
 * 顺序(target > from) → data-dir="forward"（从左到右擦入）
 * 逆序(target < from) → data-dir="back"（从右往左擦入）
 */
export function useWipeNavigate() {
  const navigate = useNavigate();
  const location = useLocation();

  return useCallback(
    (to: string) => {
      const from = pageIndex(location.pathname);
      const target = pageIndex(to);

      // 同 section 内部跳转（如切换会话）不做整页擦除
      if (from === target) {
        navigate(to);
        return;
      }
      document.documentElement.dataset.dir = target > from ? 'forward' : 'back';
      navigate(to, { viewTransition: true });
    },
    [navigate, location.pathname],
  );
}
