import { Avatar } from '../../shared/ui/primitives';

/**
 * 顶部浏览器外壳（装饰性）。
 * 复刻设计稿里的「标签页 + 地址栏」深色条，纯展示、不承载逻辑。
 */
export function BrowserChrome({ url = 'liskin.app/code' }: { url?: string }) {
  return (
    <div className="flex items-center gap-3 bg-canvas px-4 py-2 text-ink-faint">
      {/* 红绿灯 */}
      <div className="flex items-center gap-2">
        <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
        <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
        <span className="h-3 w-3 rounded-full bg-[#28c840]" />
      </div>

      {/* 活动标签页 */}
      <div className="ml-2 flex items-center gap-2 rounded-t-lg bg-panel px-3 py-1.5 text-xs font-medium text-ink">
        <span className="inline-flex h-4 w-4 items-center justify-center rounded bg-accent text-[10px] text-white">
          L
        </span>
        Liskin Code
      </div>

      {/* 地址栏 */}
      <div className="ml-2 flex flex-1 items-center gap-2 rounded-md bg-black/30 px-3 py-1.5 text-xs text-ink-faint">
        <span className="text-[13px]">🔒</span>
        <span className="truncate">{url}</span>
      </div>

      <Avatar label="Z" size={22} />
    </div>
  );
}
