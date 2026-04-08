import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  h1: ({ children }) => (
    <h1 className="text-lg font-bold text-zinc-900 mt-5 first:mt-0 mb-2 pb-1 border-b border-zinc-200">
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-base font-semibold text-zinc-900 mt-4 mb-2">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-sm font-semibold text-zinc-800 mt-3 mb-1.5">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="text-sm font-medium text-zinc-800 mt-2 mb-1">{children}</h4>
  ),
  p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed text-zinc-800">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc pl-5 mb-3 space-y-1.5 text-zinc-800">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 mb-3 space-y-1.5 text-zinc-800">{children}</ol>
  ),
  li: ({ children }) => <li className="leading-relaxed [&>p]:mb-0">{children}</li>,
  strong: ({ children }) => <strong className="font-semibold text-zinc-900">{children}</strong>,
  em: ({ children }) => <em className="italic text-zinc-700">{children}</em>,
  a: ({ href, children }) => (
    <a
      href={href}
      className="text-emerald-700 underline underline-offset-2 hover:text-emerald-800"
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-4 border-zinc-300 pl-3 my-3 text-zinc-600 italic">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-zinc-200" />,
  code: ({ className, children }) => {
    const inline = !className;
    if (inline) {
      return (
        <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-[0.85em] font-mono text-zinc-800">
          {children}
        </code>
      );
    }
    return (
      <code className={`${className ?? ""} block font-mono text-xs text-zinc-800`}>{children}</code>
    );
  },
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 my-3 text-xs leading-relaxed">
      {children}
    </pre>
  ),
  table: ({ children }) => (
    <div className="overflow-x-auto my-3">
      <table className="min-w-full text-left text-sm border border-zinc-200 rounded-lg overflow-hidden">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-zinc-100">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-zinc-200 px-3 py-2 font-semibold text-zinc-900">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-b border-zinc-100 px-3 py-2 text-zinc-800">{children}</td>
  ),
  tr: ({ children }) => <tr className="even:bg-zinc-50/80">{children}</tr>,
};

type Props = {
  content: string;
  className?: string;
};

/** Renders model markdown (headings, lists, bold, tables, code) for light UI. */
export function MarkdownBody({ content, className = "" }: Props) {
  return (
    <div className={`text-sm ${className}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  );
}
