import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/**
 * assistant 文本的 markdown 渲染：GFM + 代码高亮。
 * 代码块走 rehype-highlight（highlight.js），终端式深色卡片。
 * 文本块（非代码）继承父级 prose 排版，但不引额外 tailwind-typography，用最小手写样式。
 */
function CodeBlock({ className, children }: { className?: string; children?: unknown }) {
  const lang = /language-(?<lang>\w+)/u.exec(className ?? '')?.groups?.lang ?? 'text';
  const code = String(children ?? '');
  return (
    <div className="my-2 overflow-hidden rounded-lg border border-slate-700 bg-slate-900">
      <div className="flex items-center justify-between border-b border-slate-700 px-3 py-1">
        <span className="font-mono text-[10px] uppercase tracking-wide text-slate-400">{lang}</span>
      </div>
      <pre className="overflow-auto p-3 text-[12px] leading-relaxed">
        <code className={className}>{code.replace(/\n$/u, '')}</code>
      </pre>
    </div>
  );
}

function MarkdownImpl({ content }: { content: string }) {
  return (
    <div className="markdown-body max-w-full text-sm leading-relaxed text-slate-800">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={{
          code({ className, children, ...props }) {
            // inline code（无 language- class 且无换行）走内联样式
            const isBlock = /language-/u.test(className ?? '');
            if (isBlock) {
              return <CodeBlock className={className}>{children}</CodeBlock>;
            }
            return (
              <code
                className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[12px] text-slate-800"
                {...props}
              >
                {children}
              </code>
            );
          },
          a({ children, ...props }) {
            return (
              <a
                className="text-blue-600 underline hover:text-blue-800"
                target="_blank"
                rel="noreferrer"
                {...props}
              >
                {children}
              </a>
            );
          },
          ul: ({ children }) => <ul className="my-1 list-disc pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-1 list-decimal pl-5">{children}</ol>,
          li: ({ children }) => <li className="my-0.5">{children}</li>,
          p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
          h1: ({ children }) => <h1 className="mb-2 mt-3 text-base font-semibold">{children}</h1>,
          h2: ({ children }) => <h2 className="mb-2 mt-3 text-sm font-semibold">{children}</h2>,
          h3: ({ children }) => <h3 className="mb-1 mt-2 text-sm font-semibold">{children}</h3>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-slate-300 pl-3 text-slate-600">
              {children}
            </blockquote>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-auto">
              <table className="border-collapse text-xs">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-slate-300 bg-slate-50 px-2 py-1 text-left">{children}</th>
          ),
          td: ({ children }) => <td className="border border-slate-300 px-2 py-1">{children}</td>,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

export const Markdown = memo(MarkdownImpl);
