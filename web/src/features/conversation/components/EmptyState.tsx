/**
 * 未选会话时的引导页：提示创建或选择会话。
 */
export function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="max-w-sm text-center">
        <span className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl2 bg-accent text-lg font-semibold text-white">
          L
        </span>
        <p className="text-lg font-medium text-ink">Liskin Code</p>
        <p className="mt-1 text-sm text-ink-faint">
          从左侧选择一个会话，或创建新会话开始
        </p>
      </div>
    </div>
  );
}
