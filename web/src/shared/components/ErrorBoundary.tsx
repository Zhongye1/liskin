import { isRouteErrorResponse, useRouteError } from 'react-router-dom';

export function ErrorBoundary() {
  const error = useRouteError();

  if (isRouteErrorResponse(error)) {
    return (
      <div className="flex h-screen items-center justify-center bg-slate-50">
        <div className="text-center">
          <p className="text-4xl font-bold text-slate-300">{error.status}</p>
          <p className="mt-2 text-sm text-slate-500">
            {error.status === 404 ? '会话不存在或已被删除' : error.statusText}
          </p>
          <a href="/" className="mt-4 inline-block text-sm text-blue-600 hover:underline">
            返回首页
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen items-center justify-center bg-slate-50">
      <div className="text-center">
        <p className="text-sm text-slate-500">
          {error instanceof Error ? error.message : '发生未知错误'}
        </p>
        <a href="/" className="mt-4 inline-block text-sm text-blue-600 hover:underline">
          返回首页
        </a>
      </div>
    </div>
  );
}
