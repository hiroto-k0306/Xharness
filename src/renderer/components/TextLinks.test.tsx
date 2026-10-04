// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TextLinks } from "./TextLinks.js";
afterEach(cleanup);
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
