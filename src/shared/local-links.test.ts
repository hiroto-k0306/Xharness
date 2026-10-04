import { expect, it } from "vitest";
import { normalizeFileLink } from "./local-links.js";

it.each([
  ["D:/releases/Setup.exe", "file:///D:/releases/Setup.exe"],
  ["c:/work/", "file:///c:/work/"],
  ["D:/日本/report#1.txt", "file:///D:/%E6%97%A5%E6%9C%AC/report%231.txt"],
  [
    "D:/a%20b/%28draft%29%5B1%5D%25.txt",
    "file:///D:/a%20b/%28draft%29%5B1%5D%25.txt",
  ],
  ["D:/a(b)[1]?'!.txt", "file:///D:/a%28b%29%5B1%5D%3F%27%21.txt"],
])(
  "normalizes explicit drive destinations without double encoding: %s",
  (path, url) => {
    expect(normalizeFileLink(path)).toBe(url);
  },
);
it.each([
  "file:///D:/a%20b.txt",
  "https://example.com/D:/a",
  "javascript:alert",
  "file://server/share/a",
  "//server/share/a",
  "../a.txt",
  "/a.txt",
  "D:a.txt",
  String.raw`D:\work\a.txt`,
  "D:/../a.txt",
  "D:/%2e%2e/a.txt",
  "D:/./a.txt",
  "D:/a%2fb.txt",
  "D:/a%5Cb.txt",
  "D:/a%00b.txt",
  "D:/a\nb.txt",
  "D:/a%ZZ.txt",
  "D:/a%.txt",
])(
  "does not reinterpret unsupported or ambiguous destinations: %s",
  (value) => {
    expect(normalizeFileLink(value)).toBe(value);
  },
);
