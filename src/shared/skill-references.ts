export const SKILL_REFERENCE_LIMITS = { links: 40, entries: 20 };
export function validReferenceSource(skill: string, source: string): boolean {
  const base = skill.replace(/SKILL\.md$/, "");
  if (!source.startsWith(base) || source.length > 400) return false;
  const parts = source.slice(base.length).split("/");
  return (
    parts.length <= 6 &&
    parts.every(
      (s) =>
        /^[\p{L}\p{N}_][\p{L}\p{N}_ .()-]{0,79}$/u.test(s) &&
        !/[. ]$/.test(s) &&
        !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
    ) &&
    /\.(?:md|txt|rst)$/i.test(source) &&
    source !== skill
  );
}
/** Conservative inline Markdown links only; no URL fetch, HTML, scripts or recursive discovery. */
export function skillReferenceLinks(skill: string, body: string) {
  const entries: string[] = [],
    skipped: Record<string, number> = {};
  let fence = "",
    count = 0,
    truncated = false;
  const text = body
    .split(/\r?\n/)
    .filter((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker) {
        if (!fence) fence = marker[0]!;
        else if (marker[0] === fence) fence = "";
        return false;
      }
      return !fence;
    })
    .join("\n")
    .replace(/`[^`\n]*`/g, "");
  const links =
    /(!?)\[[^\]\r\n]{0,200}\]\(\s*(?:<([^<>\r\n]{1,300})>|([^\s()]{1,300}))(?:\s+["'][^"'\r\n]{0,200}["'])?\s*\)/g;
  for (const match of text.matchAll(links)) {
    if (
      ++count > SKILL_REFERENCE_LIMITS.links ||
      entries.length >= SKILL_REFERENCE_LIMITS.entries
    ) {
      truncated = true;
      break;
    }
    let target = match[2] ?? match[3]!;
    try {
      target = decodeURIComponent(target.split("#")[0]!);
    } catch {
      target = "";
    }
    if (target.startsWith("./")) target = target.slice(2);
    const source = skill.replace(/SKILL\.md$/, "") + target;
    if (match[1] || !validReferenceSource(skill, source)) {
      skipped.unsupported_or_unsafe_link =
        (skipped.unsupported_or_unsafe_link ?? 0) + 1;
      continue;
    }
    if (!entries.includes(source)) entries.push(source);
  }
  return { entries, skipped, truncated, limits: SKILL_REFERENCE_LIMITS };
}
