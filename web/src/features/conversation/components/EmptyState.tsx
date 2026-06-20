/**
 * 未选会话时的引导页：提示创建或选择会话。
 */
export function EmptyState() {
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center">
        <p className="text-lg font-medium text-slate-400">Liskin Code</p>
        <p className="mt-2 text-sm text-slate-400">
          从左侧选择一个会话，或创建新会话开始
        </p>
      </div>
    </div>
  );
}
