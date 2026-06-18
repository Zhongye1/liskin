import { Link } from 'react-router-dom';

export default function Home() {
  return (
    <section className="space-y-4 rounded-xl border bg-white p-6 shadow-sm">
      <h2 className="text-xl font-semibold">liskin code</h2>
      <p className="text-sm text-slate-600">本地 Coding Agent — 内核与 UI 解耦的协议化前端。</p>
      <Link
        to="/chat"
        className="inline-block rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
      >
        进入 Chat
      </Link>
    </section>
  );
}
