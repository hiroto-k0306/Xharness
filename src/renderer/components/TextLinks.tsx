import { Fragment } from "react";

/** HTML は解釈しない。コード・画像は文字のまま、明示的なリンクだけを許可する。 */
export function TextLinks({ text }: { text: string }) {
  const parts = text.split(
    /(```[\s\S]*?(?:```|$)|`[^`\n]*`|!?\[[^\]\n]+\]\([^\s)]+\))/g,
  );
  return parts.map((part, index) => {
    const match = /^\[([^\]\n]+)\]\(([^\s)]+)\)$/.exec(part);
    if (!match) return <Fragment key={index}>{part}</Fragment>;
    const label = match[1]!;
    const href = match[2]!;
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
        return <Fragment key={index}>{part}</Fragment>;
      return (
        <a key={index} href={href} target="_blank" rel="noopener noreferrer">
          {label}
        </a>
      );
    } catch {
      return <Fragment key={index}>{part}</Fragment>;
    }
  });
}
