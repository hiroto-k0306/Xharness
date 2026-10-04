// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TextLinks } from "./TextLinks.js";
afterEach(cleanup);
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
