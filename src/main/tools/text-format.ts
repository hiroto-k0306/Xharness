/** File tools support UTF-8 (with or without BOM). Use the first newline for mixed files. */
export function textFormat(original?: string) {
  const bom = original?.startsWith("\ufeff") ?? false;
  const newline = /\r?\n/.exec(original ?? "")?.[0] ?? "\n";
  return {
    body: original?.replace(/^\ufeff/, ""),
    normalize: (text: string) => text.replace(/\r?\n/g, newline),
    write(text: string) {
      const body = text.replace(/^\ufeff/, "").replace(/\r?\n/g, newline);
      return (
        (bom || (original === undefined && text.startsWith("\ufeff"))
          ? "\ufeff"
          : "") + body
      );
    },
    wrap: (body: string) => (bom ? "\ufeff" : "") + body,
  };
}
