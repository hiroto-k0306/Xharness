// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { TextLinks } from "./TextLinks.js";
import { splitLinks } from "./text-links-parser.js";

// 解析結果を変えず、配列形式などの内部実装と独立した呼び出し境界を監視する。
vi.mock("./text-links-parser.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./text-links-parser.js")>();
  return { ...original, splitLinks: vi.fn(original.splitLinks) };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
it.each([
  "``[code](file:///C:/a.txt)``",
  "```[code](file:///C:/a.txt)```",
  "before ````[code](file:///C:/a.txt)```` after",
  "``one ` [code](file:///C:/a.txt) ` two``",
  "``line one\n[code](file:///C:/a.txt)\nline two``",
  "~~~\n[code](file:///C:/a.txt)\n~~~",
  "~~~~typescript\n[code](file:///C:/a.txt)\n~~~\n[still code](https://example.com)\n~~~~",
  "````\n[code](file:///C:/a.txt)\n```\n[still code](https://example.com)\n`````",
  "   ~~~\r\n[code](file:///C:/a.txt)\r\n   ~~~",
  "~~~\n[unclosed](file:///C:/a.txt)",
  "````\n[unclosed](file:///C:/a.txt)",
  "[![preview](file:///C:/a.png)](https://example.com)",
  "[![preview](https://example.com/a.png)](file:///C:/a.txt)",
  "[text ![preview](file:///C:/a.png) text](file:///C:/a.txt)",
  "![alt [nested](file:///C:/a.txt)](https://example.com/a.png)",
  "[![preview][image]](file:///C:/a.txt)",
])("keeps code and nested images literal: %s", (text) => {
  const { container } = render(<TextLinks text={text} />);
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe(text);
});
it.each([
  "![alt [file](file:///C:/a.txt)][preview]\n\n[preview]: https://example.com/a.png",
  '![alt [file](file:///C:/a.txt)](https://example.com/a.png "title")',
  "![alt [file](file:///C:/a.txt)](<https://example.com/a.png> 'title')",
  "![alt [file](https://example.com)](file:///C:/a.png (title))",
  "![alt [file](file:///C:/a.txt)][]",
  "![alt [file](file:///C:/a.txt)]",
])("protects the entire image label regardless of destination: %s", (image) => {
  const { container } = render(
    <TextLinks text={`${image}\n[outside](file:///C:/b.txt)`} />,
  );
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(
    screen.getByRole("link", { name: "outside" }).getAttribute("href"),
  ).toBe("file:///C:/b.txt");
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe(`${image}\noutside`);
});
it.each([
  "![alt `]` [file](file:///C:/a.txt)](https://example.com/a.png)",
  "![alt ``] ` [`` [file](https://example.com)](file:///C:/a.png)",
  "![alt `[` [file](file:///C:/a.txt)](https://example.com/a.png)",
  "![alt `line\n]` [file](file:///C:/a.txt)][preview]",
  '![alt](https://example.com/a.png "[file](file:///C:/a.txt)")',
  "![alt](<https://example.com/a.png> '[web](https://example.com)')",
  "![alt](file:///C:/a.png ([file](file:///C:/a.txt)))",
  '![alt](https://example.com/a.png "before ) [file](file:///C:/a.txt) after")',
  '![alt](https://example.com/a.png "escaped \\" [file](file:///C:/a.txt)")',
  '![alt](https://example.com/a.png\n"[file](file:///C:/a.txt)")',
  '![alt `]` [file](file:///C:/a.txt)](https://example.com/a.png "[web](https://example.com)")',
  '[![alt `]` [file](file:///C:/a.txt)](https://example.com/a.png "[web](https://example.com)")](file:///C:/b.txt)',
  '[![alt](https://example.com/a.png "unmatched ] [file](file:///C:/a.txt)")](https://example.com)',
  '[![alt](https://example.com/a.png "unmatched [ [file](file:///C:/a.txt)")](file:///C:/a.txt)',
  '![alt](<https://example.com/a)b.png> "[file](file:///C:/a.txt)")',
  '![alt](https://example.com/it\'s.png "[file](file:///C:/a.txt)")',
  "[unsupported](file:///C:/a(b).txt)",
  "[unsupported](file:///C:/a\\)b.txt)",
  "[unsupported](https://example.com/a\\)b)",
  '[unsupported](https://example.com "[file](file:///C:/a.txt)")',
])("protects image labels with code and the entire title: %s", (image) => {
  const { container } = render(
    <TextLinks
      text={`${image}\n[outside](file:///C:/outside.txt) [web](https://example.org)`}
    />,
  );
  expect(screen.getAllByRole("link")).toHaveLength(2);
  expect(
    screen.getByRole("link", { name: "outside" }).getAttribute("href"),
  ).toBe("file:///C:/outside.txt");
  expect(screen.getByRole("link", { name: "web" }).getAttribute("href")).toBe(
    "https://example.org",
  );
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe(`${image}\noutside web`);
});
it.each([
  "```[code](file:///C:/a.txt)```",
  "   ````[code](file:///C:/a.txt)````",
  "```info ` [code](file:///C:/a.txt)```",
])("does not mistake backticks in fence info for a fence: %s", (code) => {
  const { container } = render(
    <TextLinks text={`${code}\n[file](file:///C:/b.txt)`} />,
  );
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "file" }).getAttribute("href")).toBe(
    "file:///C:/b.txt",
  );
  expect(container.textContent).toBe(`${code}\nfile`);
});
it.each(["\n", "\r\n"])(
  "protects multiline image labels with %j",
  (newline) => {
    const image = `![alt${newline}[file](file:///C:/a.txt)](https://example.com/a.png)`;
    const { container } = render(
      <TextLinks text={`${image}${newline}[outside](file:///C:/b.txt)`} />,
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "outside" }).getAttribute("href"),
    ).toBe("file:///C:/b.txt");
    expect(container.textContent).toBe(`${image}${newline}outside`);
  },
);
it.each(["\n\n", "\n \t\n", "\r\n\r\n", "\r\n \t\r\n"])(
  "keeps ordinary labels across a blank line literal: %j",
  (blank) => {
    const invalid = `[a${blank}b](file:///C:/a.txt)`;
    const { container } = render(
      <TextLinks text={`${invalid} [outside](file:///C:/outside.txt)`} />,
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "outside" }).getAttribute("href"),
    ).toBe("file:///C:/outside.txt");
    expect(container.textContent).toBe(`${invalid} outside`);
  },
);
it.each(["\n", "\r\n"])(
  "still allows a single label newline: %j",
  (newline) => {
    render(<TextLinks text={`[a${newline}b](https://example.com)`} />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
  },
);
it("keeps image protection even when its label contains a blank line", () => {
  const image = "![alt\n\n[file](file:///C:/a.txt)](https://example.com/a.png)";
  const { container } = render(
    <TextLinks text={`${image} [outside](file:///C:/outside.txt)`} />,
  );
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "outside" })).toBeTruthy();
  expect(container.textContent).toBe(`${image} outside`);
});
it.each([
  "[a](b 'c) ... [file](file:///C:/a.txt) ... 'z'",
  "[a](b 'c) ... [file](file:///C:/a.txt) ... 'z')",
  '[a](b "c) ... [file](file:///C:/a.txt) ... "z")',
  "[a](b 'c)\n\n[file](file:///C:/a.txt)\n\n'z')",
  '[a](b "c)\r\n\r\n[file](file:///C:/a.txt)\r\n\r\n"z")',
  '[a](b "title\n\n[file](file:///C:/a.txt)")',
])("does not consume later links after an invalid title: %s", (text) => {
  const { container } = render(<TextLinks text={text} />);
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "file" }).getAttribute("href")).toBe(
    "file:///C:/a.txt",
  );
  expect(container.textContent).toBe(
    text.replace("[file](file:///C:/a.txt)", "file"),
  );
});
it.each([
  '[unsupported](https://example.com "[file](file:///C:/a.txt)")',
  "[unsupported](https://example.com '[file](file:///C:/a.txt)')",
  "[unsupported](https://example.com ([file](file:///C:/a.txt)))",
  '[unsupported](https://example.com\n"[file](file:///C:/a.txt)")',
])("keeps a syntactically complete ordinary title literal: %s", (text) => {
  const { container } = render(
    <TextLinks text={`${text} [outside](https://example.org)`} />,
  );
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "outside" })).toBeTruthy();
  expect(container.textContent).toBe(`${text} outside`);
});
it.each(["[a](", "![a](", "[a](b '", "[a](b("])(
  "handles long unfinished destinations without hiding a following link: %s",
  (prefix) => {
    const invalid = prefix.repeat(30_000);
    const { container } = render(
      <TextLinks text={`${invalid}\n[outside](file:///C:/outside.txt)`} />,
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByRole("link", { name: "outside" })).toBeTruthy();
    expect(container.textContent).toBe(`${invalid}\noutside`);
  },
);
it.each([
  "[a](b(".repeat(30_000) + " " + ")".repeat(60_000),
  "[a](b (".repeat(30_000) + "\n\n" + ")".repeat(60_000),
  "[a".repeat(30_000),
  "![a".repeat(30_000),
  "[".repeat(30_000),
  "[".repeat(30_000) + "\n\n" + "]".repeat(30_000),
])(
  "handles balanced invalid destinations and unfinished labels: %#",
  (invalid) => {
    const { container } = render(
      <TextLinks text={`${invalid}\n[outside](file:///C:/outside.txt)`} />,
    );
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(
      screen.getByRole("link", { name: "outside" }).getAttribute("href"),
    ).toBe("file:///C:/outside.txt");
    expect(container.textContent).toBe(`${invalid}\noutside`);
  },
);
it.each([
  '[x](<https://example.com> "[file](file:///C:/a.txt)")',
  "[x](<https://example.com> '[file](file:///C:/a.txt)')",
  "[x](<https://example.com/a)b> ([file](file:///C:/a.txt)))",
  '[x](https://example.com/?q=<x> "[file](file:///C:/a.txt)")',
  '![alt](https://example.com/a(b).png "[file](file:///C:/a.txt)")',
  '![alt](https://example.com/a\\)b.png "[file](file:///C:/a.txt)")',
  '![alt](<> "[file](file:///C:/a.txt)")',
  '![alt]( "[file](file:///C:/a.txt)")',
  '[![alt](<https://example.com> "unmatched ] [file](file:///C:/a.txt)")](https://example.org)',
])("protects complete angle destinations and image titles: %s", (text) => {
  const { container } = render(
    <TextLinks text={`${text} [outside](https://example.org)`} />,
  );
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "outside" })).toBeTruthy();
  expect(container.textContent).toBe(`${text} outside`);
});
it.each([
  "![a](b 'c) ... [file](file:///C:/a.txt) ... 'z')",
  '![a](b "c) ... [file](file:///C:/a.txt) ... "z")',
  '![a](<b> "c) ... [file](file:///C:/a.txt) ... "z")',
  '![a](b "title\n\n[file](file:///C:/a.txt)")',
  '![alt [inside](file:///C:/hidden.txt)](b "title\r\n\r\n[file](file:///C:/a.txt)")',
])("does not hide later links after an invalid image title: %s", (text) => {
  const { container } = render(
    <TextLinks text={`${text} [web](https://example.org)`} />,
  );
  expect(screen.getAllByRole("link")).toHaveLength(2);
  expect(screen.getByRole("link", { name: "file" })).toBeTruthy();
  expect(screen.getByRole("link", { name: "web" })).toBeTruthy();
  expect(container.textContent).toBe(
    text.replace("[file](file:///C:/a.txt)", "file") + " web",
  );
});
it("keeps HTTPS URLs containing literal angle brackets clickable", () => {
  const { container } = render(
    <TextLinks text="[web](https://example.com/?q=<x>)" />,
  );
  expect(screen.getByRole("link", { name: "web" }).getAttribute("href")).toBe(
    "https://example.com/?q=<x>",
  );
  expect(container.querySelector("x")).toBeNull();
});
it("preserves link-free text and reuses unchanged text on rerender", () => {
  const plain = "plain <script> `code` \n".repeat(10_000);
  const { container, rerender } = render(<TextLinks text={plain} />);
  expect(container.textContent).toBe(plain);
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  expect(splitLinks).toHaveBeenCalledTimes(1);
  rerender(<TextLinks text={plain} />);
  expect(splitLinks).toHaveBeenCalledTimes(1);
  const text = "[file](file:///C:/a.txt)";
  rerender(<TextLinks text={text} />);
  expect(splitLinks).toHaveBeenCalledTimes(2);
  expect(splitLinks).toHaveBeenLastCalledWith(text);
  rerender(<TextLinks text={text} />);
  expect(splitLinks).toHaveBeenCalledTimes(2);
  rerender(<TextLinks text="[file](file:///C:/b.txt)" />);
  expect(splitLinks).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("link").getAttribute("href")).toBe(
    "file:///C:/b.txt",
  );
});
it.each([
  String.raw`[unsupported](https://example.com/a\b)`,
  String.raw`[unsupported](https://example.com/a\)b)`,
])("keeps backslash HTTPS destinations literal: %s", (text) => {
  const { container } = render(
    <TextLinks text={`${text} [outside](https://example.org)`} />,
  );
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: "outside" })).toBeTruthy();
  expect(container.textContent).toBe(`${text} outside`);
});
it.each([
  ["link-free text", "plain <script> `code` \n".repeat(30_000)],
  ["unfinished URL", "[a](".repeat(30_000)],
  ["unfinished image URL", "![a](".repeat(30_000)],
  ["unfinished title", "[a](b '".repeat(30_000)],
  ["invalid balanced URL", "[a](b(".repeat(30_000) + " " + ")".repeat(60_000)],
  [
    "invalid balanced title",
    "[a](b (".repeat(30_000) + "\n\n" + ")".repeat(60_000),
  ],
  ["unfinished label", "[a".repeat(30_000)],
  ["unfinished image label", "![a".repeat(30_000)],
  ["unfinished brackets", "[".repeat(30_000)],
  ["invalid balanced label", "[".repeat(30_000) + "\n\n" + "]".repeat(30_000)],
])(
  "bounds synchronous SSR time for %s",
  (name, invalid) => {
    // 同期の再走査を明示判定。通常の数十msに対し、負荷・低速機の余裕を5秒取る。
    // 粗い回帰検知であり絶対性能の保証ではない。テスト全体のtimeoutとは区別する。
    renderToStaticMarkup(<TextLinks text="[warmup](https://example.org)" />);
    const linkFree = name === "link-free text";
    const text = linkFree
      ? invalid
      : `${invalid}\n[outside](file:///C:/outside.txt)`;
    const start = performance.now();
    const html = renderToStaticMarkup(<TextLinks text={text} />);
    expect(performance.now() - start).toBeLessThan(5000);
    expect(html.match(/<a /g) ?? []).toHaveLength(linkFree ? 0 : 1);
    if (!linkFree) expect(html).toContain('href="file:///C:/outside.txt"');
    else expect(html).toContain("&lt;script&gt;");
  },
  30_000,
);
it("still links text outside protected regions", () => {
  render(
    <TextLinks
      text={
        "``[code](file:///C:/a.txt)`` [file](file:///C:/b.txt)\n~~~\n[code](file:///C:/a.txt)\n~~~\n[![preview](file:///C:/a.png)](https://example.com) [web](https://example.com)"
      }
    />,
  );
  expect(screen.getAllByRole("link")).toHaveLength(2);
  expect(screen.getByRole("link", { name: "file" }).getAttribute("href")).toBe(
    "file:///C:/b.txt",
  );
  expect(screen.getByRole("link", { name: "web" }).getAttribute("href")).toBe(
    "https://example.com",
  );
});
it("renders escaped explicit file links and keeps HTTPS browser behavior", () => {
  const { container } = render(
    <TextLinks
      text={
        "[日本 file](file:///C:/work/a%20b.txt) [web](https://example.com) <script>alert(1)</script>"
      }
    />,
  );
  expect(
    screen.getByRole("link", { name: "日本 file" }).getAttribute("href"),
  ).toBe("file:///C:/work/a%20b.txt");
  expect(screen.getByRole("link", { name: "web" }).getAttribute("target")).toBe(
    "_blank",
  );
  expect(container.querySelector("script")).toBeNull();
  expect(container.textContent).toContain("<script>alert(1)</script>");
});
it("does not turn code, images, HTML, remote file URLs or dangerous schemes into links", () => {
  const { container } = render(
    <TextLinks
      text={
        '`[code](file:///C:/a)`\n```\n[fenced](file:///C:/a)\n```\n![image](https://example.com/i.png) [bad](javascript:alert) [remote](file://server/share/a) [http](http://example.com) <a href="file:///C:/a" onclick="run()">raw</a>'
      }
    />,
  );
  expect(screen.queryAllByRole("link")).toHaveLength(0);
  expect(container.querySelector("img")).toBeNull();
});
