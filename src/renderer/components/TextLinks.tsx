import { Fragment } from "react";

type Part = { text: string; label?: string; href?: string };

/** 同じ長さのバッククォートで閉じる区間。コード内の括弧は数えない。 */
function codeEnd(text: string, start: number): number | undefined {
  const runs = /`+/g;
  runs.lastIndex = start;
  const open = runs.exec(text)!;
  for (let close; (close = runs.exec(text));) {
    if (close[0].length === open[0].length) return runs.lastIndex;
  }
}

/** 画像のURL・titleを一括で保護。引用符／山括弧内の丸括弧は閉じ括弧ではない。 */
function destinationEnd(text: string, start: number): number | undefined {
  if (text[start] !== "(") return;
  let depth = 1;
  let quoted: string | undefined;
  for (let end = start + 1; end < text.length; end++) {
    const char = text[end];
    if (char === "\\") end++;
    else if (quoted) {
      if (char === quoted) quoted = undefined;
    } else if (char === "<") quoted = ">";
    else if ((char === '"' || char === "'") && /\s/.test(text[end - 1] ?? "")) {
      quoted = char;
    } else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return end + 1;
  }
}

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
      const close = codeEnd(text, start);
      if (!close) continue;
      end = close;
    } else {
      const labelStart = end;
      let depth = 1;
      let nested = false;
      for (; end < text.length && depth; end++) {
        if (text[end] === "\\") end++;
        else if (text[end] === "`") {
          const close = codeEnd(text, end);
          if (close) end = close - 1;
          else while (text[end + 1] === "`") end++;
        } else if (text[end] === "[") {
          depth++;
          nested = true;
        } else if (text[end] === "]") {
          depth--;
          // 入れ子画像のtitle内の角括弧も、外側のラベルを閉じない。
          if (depth) end = (destinationEnd(text, end + 1) ?? end + 1) - 1;
        }
      }
      if (depth) continue;
      const destination = /^\(([^\s)]+)\)/.exec(text.slice(end));
      const destinationClose = destinationEnd(text, end);
      // 画像ラベルは destination の形式（reference・title 等）に関係なく保護する。
      if (!destinationClose && token[0] !== "![") continue;
      // 画像自身も、画像をラベルに含む外側のリンクも文字のまま。
      if (
        !nested &&
        token[0] === "[" &&
        destination &&
        end + destination[0].length === destinationClose
      ) {
        label = text.slice(labelStart, end - 1);
        href = destination[1];
      }
      end = destinationClose ?? end;
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
