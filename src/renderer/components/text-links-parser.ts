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

/** 次の非エスケープ引用符／山括弧を索引化し、未閉鎖区間を再走査しない。 */
function delimiterEnds(text: string): Map<number, number> {
  const ends = new Map<number, number>();
  const quotes = new Map<string, number>();
  let angles: number[] = [];
  for (const token of text.matchAll(/\\[\s\S]|['"<>]/g)) {
    const char = token[0];
    const start = token.index;
    if (char === "<") angles.push(start);
    else if (char === ">") {
      for (const open of angles) ends.set(open, start);
      angles = [];
    } else if (char === '"' || char === "'") {
      const previous = quotes.get(char);
      if (previous !== undefined) ends.set(previous, start);
      quotes.set(char, start);
    }
  }
  return ends;
}

/** 引用区間内の括弧は無視し、丸括弧の対応・未閉鎖の結果を再利用する。 */
function destinationFinder(text: string, delimiters: Map<number, number>) {
  const ends = new Map<number, number | undefined>();
  return function destinationEnd(start: number): number | undefined {
    if (text[start] !== "(") return;
    if (ends.has(start)) return ends.get(start);
    const opens = [start];
    for (let end = start + 1; end < text.length; end++) {
      const char = text[end];
      if (char === "\\") end++;
      else if (
        char === "<" ||
        ((char === '"' || char === "'") && /\s/.test(text[end - 1] ?? ""))
      ) {
        const close = delimiters.get(end);
        if (close === undefined) break;
        end = close;
      } else if (char === "(") {
        if (ends.has(end)) {
          const close = ends.get(end);
          if (close === undefined) break;
          end = close - 1;
        } else opens.push(end);
      } else if (char === ")") {
        ends.set(opens.pop()!, end + 1);
        if (!opens.length) return end + 1;
      }
    }
    for (const open of opens) ends.set(open, undefined);
  };
}

/** 入れ子の失敗ごとに長い区間の空白／空行を再検索せず、累積数で判定する。 */
function rangeChecks(text: string) {
  const spaces = new Uint32Array(text.length + 1);
  const paragraphs = new Uint32Array(text.length + 1);
  for (const blank of text.matchAll(/\r?\n[\t ]*\r?\n/g))
    paragraphs[blank.index + 1] = 1;
  for (let index = 0; index < text.length; index++) {
    spaces[index + 1] = spaces[index]! + Number(/\s/.test(text[index]!));
    paragraphs[index + 1] = paragraphs[index + 1]! + paragraphs[index]!;
  }
  return {
    hasSpace: (start: number, end: number) => spaces[end]! !== spaces[start]!,
    hasBlank: (start: number, end: number) =>
      paragraphs[end]! !== paragraphs[start]!,
  };
}

/** ラベルの入れ子も成功・未閉鎖を記録し、後続の各 `[` から末尾を再走査しない。 */
function labelFinder(
  text: string,
  destinationEnd: (start: number) => number | undefined,
) {
  type Label = { start: number; end: number; nested: boolean };
  const labels = new Map<number, Label | undefined>();
  return function labelEnd(start: number): Label | undefined {
    if (labels.has(start)) return labels.get(start);
    const opens: Label[] = [{ start, end: 0, nested: false }];
    for (let end = start + 1; end < text.length; end++) {
      if (text[end] === "\\") end++;
      else if (text[end] === "`") {
        const close = codeEnd(text, end);
        if (close) end = close - 1;
        else while (text[end + 1] === "`") end++;
      } else if (text[end] === "[") {
        opens[opens.length - 1]!.nested = true;
        if (labels.has(end)) {
          const close = labels.get(end);
          if (!close) break;
          end = (destinationEnd(close.end) ?? close.end) - 1;
        } else opens.push({ start: end, end: 0, nested: false });
      } else if (text[end] === "]") {
        const open = opens.pop()!;
        open.end = end + 1;
        labels.set(open.start, open);
        if (!opens.length) return open;
        // 入れ子画像のtitle内の角括弧も、外側のラベルを閉じない。
        end = (destinationEnd(end + 1) ?? end + 1) - 1;
      }
    }
    for (const open of opens) labels.set(open.start, undefined);
  };
}

/** 通常リンクと画像のdestination。妥当なtitleと閉じ括弧だけをまとめて保護する。 */
function linkDestination(
  text: string,
  start: number,
  delimiters: Map<number, number>,
  destinationEnd: (start: number) => number | undefined,
  ranges: ReturnType<typeof rangeChecks>,
): { end: number; href?: string } | undefined {
  if (text[start] !== "(") return;
  let end = start + 1;
  let literal = false;
  if (text[end] === "<") {
    const close = delimiters.get(end);
    if (close === undefined || ranges.hasBlank(end, close)) return;
    end = close + 1;
    literal = true;
  } else {
    // URL中の山括弧は従来どおり許可。エスケープや入れ子括弧は起動せず保護する。
    const url = /(?:\\[\s\S]|[^\s()])+/y;
    for (;;) {
      url.lastIndex = end;
      if (url.exec(text)) end = url.lastIndex;
      if (text[end] !== "(") break;
      const close = destinationEnd(end);
      if (close === undefined || ranges.hasSpace(end, close)) return;
      end = close;
      literal = true;
    }
  }
  const href = text.slice(start + 1, end);
  if (text[end] === ")") {
    if (destinationEnd(start) === end + 1)
      return {
        end: end + 1,
        href: !literal && href && !href.includes("\\") ? href : undefined,
      };
    return;
  }
  const space = /[\t ]*(?:\r?\n[\t ]*)?/y;
  space.lastIndex = end;
  space.exec(text);
  end = space.lastIndex;
  const char = text[end];
  const titleEnd =
    char === '"' || char === "'"
      ? delimiters.get(end)
      : char === "("
        ? destinationEnd(end)
        : undefined;
  if (titleEnd === undefined) return;
  space.lastIndex = char === "(" ? titleEnd : titleEnd + 1;
  space.exec(text);
  end = space.lastIndex;
  if (text[end] === ")" && !ranges.hasBlank(start, end))
    return { end: end + 1 };
}

/** リンクより先にコードと画像（入れ子を含む）を消費する。HTML は解釈しない。 */
export function splitLinks(text: string): Part[] {
  // リンクのないストリーミング本文では全体索引を作らない。
  if (!text.includes("[")) return [{ text }];
  const parts: Part[] = [];
  const delimiters = delimiterEnds(text);
  const destinationEnd = destinationFinder(text, delimiters);
  const ranges = rangeChecks(text);
  const destination = (start: number) =>
    linkDestination(text, start, delimiters, destinationEnd, ranges);
  const labelEnd = labelFinder(text, (start) => destination(start)?.end);
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
      const close = labelEnd(labelStart - 1);
      if (!close) continue;
      end = close.end;
      const image = token[0] === "![";
      // 通常ラベルは段落をまたがない。画像の保護範囲は狭めない。
      if (!image && ranges.hasBlank(labelStart, end - 1)) continue;
      const target = destination(end);
      const destinationClose = target?.end;
      // 画像ラベルは destination の形式（reference・title 等）に関係なく保護する。
      if (!destinationClose && !image) continue;
      // 画像自身も、画像をラベルに含む外側のリンクも文字のまま。
      if (!close.nested && !image && target?.href) {
        label = text.slice(labelStart, end - 1);
        href = target.href;
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
