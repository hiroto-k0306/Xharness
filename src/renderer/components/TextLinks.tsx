import { Fragment } from "react";

type Part = { text: string; label?: string; href?: string };

/** リンクより先にコードと画像（入れ子を含む）を消費する。HTML は解釈しない。 */
function splitLinks(text: string): Part[] {
  const parts: Part[] = [];
  // バッククォートのフェンスは info string にバッククォートを許さない。
  const tokens =
    /^ {0,3}(`{3,}(?![^\r\n]*`)|~{3,})[^\r\n]*(?:\r?\n|$)|`+|!?\[/gm;
  let cursor = 0;
  for (let token; (token = tokens.exec(text));) {
    const start = token.index;
    let end = tokens.lastIndex;
    let label: string | undefined;
    let href: string | undefined;
    if (token[1]) {
      const fence = token[1];
      const close = new RegExp(
        `^ {0,3}${fence[0]}{${fence.length},}[ \\t]*(?:\\r?\\n|$)`,
        "gm",
      );
      close.lastIndex = end;
      const match = close.exec(text);
      end = match ? close.lastIndex : text.length;
    } else if (token[0].startsWith("`")) {
      // 同じ長さのバッククォートだけが閉じる。改行を含む区間も保護する。
      const close = /`+/g;
      close.lastIndex = end;
      let match;
      while ((match = close.exec(text))) {
        if (match[0].length === token[0].length) break;
      }
      if (!match) continue;
      end = close.lastIndex;
    } else {
      const labelStart = end;
      let depth = 1;
      let nested = false;
      for (; end < text.length && depth; end++) {
        if (text[end] === "\\") end++;
        else if (text[end] === "[") {
          depth++;
          nested = true;
        } else if (text[end] === "]") depth--;
        else if (text[end] === "\n") break;
      }
      if (depth) continue;
      const destination = /^\(([^\s)]+)\)/.exec(text.slice(end));
      // 画像ラベルは destination の形式（reference・title 等）に関係なく保護する。
      if (!destination && token[0] !== "![") continue;
      // 画像自身も、画像をラベルに含む外側のリンクも文字のまま。
      if (!nested && token[0] === "[" && destination) {
        label = text.slice(labelStart, end - 1);
        href = destination[1];
      }
      end += destination?.[0].length ?? 0;
    }
    if (start > cursor) parts.push({ text: text.slice(cursor, start) });
    parts.push({ text: text.slice(start, end), label, href });
    cursor = end;
    tokens.lastIndex = end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor) });
  return parts;
}

/** HTML は解釈しない。コード・画像は文字のまま、明示的なリンクだけを許可する。 */
export function TextLinks({ text }: { text: string }) {
  return splitLinks(text).map((part, index) => {
    const { label, href } = part;
    if (!label || !href) return <Fragment key={index}>{part.text}</Fragment>;
    try {
      const url = new URL(href);
      if (
        url.protocol !== "https:" &&
        !(
          url.protocol === "file:" &&
          !url.host &&
          /^file:\/\/\/[a-z]:\//i.test(href)
        )
      )
        return <Fragment key={index}>{part.text}</Fragment>;
      return (
        <a key={index} href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      );
    } catch {
      return <Fragment key={index}>{part.text}</Fragment>;
    }
  });
}
