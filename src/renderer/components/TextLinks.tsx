import { Fragment, memo } from "react";
import { splitLinks } from "./text-links-parser.js";
import { normalizeFileLink } from "../../shared/local-links.js";

/** HTML は解釈しない。コード・画像は文字のまま、明示的なリンクだけを許可する。 */
export const TextLinks = memo(function TextLinks({ text }: { text: string }) {
  return splitLinks(text).map((part, index) => {
    const { label } = part;
    if (!label || !part.href)
      return <Fragment key={index}>{part.text}</Fragment>;
    const href = normalizeFileLink(part.href);
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
});
