export function redact(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of [...secrets]
    .filter((s) => s.length >= 8)
    .sort((a, b) => b.length - a.length)) {
    result = result.split(secret).join(secret.slice(0, 6) + "…");
  }
  return result
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, (s) => s.slice(0, 6) + "…")
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      (s) => s.slice(0, 6) + "…",
    );
}
