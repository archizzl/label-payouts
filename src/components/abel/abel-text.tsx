"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/*
 * Abel's replies: the little markdown it writes (paragraphs, lists, small tables, bold, and links
 * to the app's own pages). Links anywhere else are shown as plain text.
 */

function inline(text: string, onNavigate?: () => void): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (let m; (m = re.exec(text)); ) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1]) out.push(<strong key={m.index}>{m[1]}</strong>);
    else if (m[3].startsWith("/") && !m[3].startsWith("//"))
      out.push(
        <Link key={m.index} href={m[3]} onClick={onNavigate}>
          {m[2]}
        </Link>,
      );
    else out.push(m[2]);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

export function AbelText({ text, onNavigate }: { text: string; onNavigate?: () => void }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*] /, ""));
      blocks.push(
        <ul key={i} className="list-disc space-y-0.5 pl-5">
          {items.map((t, j) => (
            <li key={j}>{inline(t, onNavigate)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (line.trim().startsWith("|")) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        if (!/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) rows.push(cells(lines[i]));
        i++;
      }
      const [head, ...body] = rows;
      if (!head) continue;
      blocks.push(
        <div key={i} className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} className="border-b border-border py-1 pr-3 text-left font-bold">
                    {inline(c, onNavigate)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((r, k) => (
                <tr key={k}>
                  {r.map((c, j) => (
                    <td key={j} className="border-b border-border py-1 pr-3">
                      {inline(c, onNavigate)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*[-*] /.test(lines[i]) && !lines[i].trim().startsWith("|")) para.push(lines[i++].replace(/^#+\s*/, ""));
    blocks.push(<p key={i}>{inline(para.join(" "), onNavigate)}</p>);
  }
  return <div className="space-y-2">{blocks}</div>;
}
