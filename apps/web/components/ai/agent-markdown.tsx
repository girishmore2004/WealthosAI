import { Fragment, ReactNode } from "react";

// Minimal, dependency-free renderer for the markdown the agent produces: headings, pipe tables, bullet/numbered lists,
// **bold** and paragraphs. Output is plain React elements (no HTML injection); anything unrecognised renders as text.

const inline = (text: string): ReactNode[] =>
  text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") && part.length > 4 ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );

const isRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
const isDivider = (l: string): boolean => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const cells = (l: string): string[] => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

export function AgentMarkdown({ text }: { text: string }): JSX.Element {
  const lines = text.split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  let key = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i += 1; continue; }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      out.push(<div key={key++} className={level <= 2 ? "mt-3 text-base font-semibold" : "mt-2 text-sm font-semibold"}>{inline(h[2])}</div>);
      i += 1; continue;
    }

    if (isRow(line) && i + 1 < lines.length && isDivider(lines[i + 1])) {
      const head = cells(line);
      const align = cells(lines[i + 1]).map((c) => (c.endsWith(":") ? "right" : "left"));
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && isRow(lines[i])) { body.push(cells(lines[i])); i += 1; }
      out.push(
        <div key={key++} className="my-2 overflow-x-auto">
          <table className="min-w-full border-collapse text-xs">
            <thead>
              <tr>{head.map((c, j) => <th key={j} className={`border-b border-line px-2 py-1 font-semibold ${align[j] === "right" ? "text-right" : "text-left"}`}>{inline(c)}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, ri) => (
                <tr key={ri}>{head.map((_, j) => <td key={j} className={`border-b border-line/50 px-2 py-1 align-top ${align[j] === "right" ? "text-right tabular-nums" : "text-left"}`}>{inline(r[j] ?? "")}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) { items.push(lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, "")); i += 1; }
      out.push(<ul key={key++} className="my-1 list-disc space-y-0.5 pl-5">{items.map((t, j) => <li key={j}>{inline(t)}</li>)}</ul>);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,4})\s/.test(lines[i]) && !isRow(lines[i]) && !/^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) { para.push(lines[i]); i += 1; }
    out.push(<p key={key++} className="my-1">{inline(para.join(" "))}</p>);
  }
  return <div className="break-words text-sm leading-6">{out}</div>;
}
