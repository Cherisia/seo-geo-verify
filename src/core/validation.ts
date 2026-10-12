export function webUrl(value: unknown, base?: string): string | undefined {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\u0000-\u0020]/.test(value.trim())
  )
    return;
  // Reject malformed absolute URLs that URL's forgiving parser repairs as relative paths.
  if (/^https?:/i.test(value) && !/^https?:\/\/[^/?#]+/i.test(value)) return;
  if (/^[a-z][\w+.-]*:/i.test(value) && !/^https?:/i.test(value)) return;
  try {
    const url = new URL(value.trim(), base);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    )
      return;
    return url.href;
  } catch {
    return;
  }
}
export function languageTag(value: string) {
  try {
    return !!value && Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}
export function percentage(ratio: number) {
  // A nonzero defect must not be rounded into a claim of complete coverage.
  return ratio >= 1 ? 100 : Math.min(99.9, Math.round(ratio * 1000) / 10);
}
export function credit(max: number, ratio: number) {
  return ratio >= 1 ? max : Math.min(max - 1, Math.round(max * ratio));
}
export function googleHeaderDirectives(header: string) {
  let agent = "*";
  return header.split(",").filter((value) => {
    const scoped = /^\s*([\w-]+)\s*:\s*/.exec(value);
    const scopedAgent = scoped?.[1]?.toLowerCase();
    if (
      scopedAgent &&
      ![
        "unavailable_after",
        "max-snippet",
        "max-image-preview",
        "max-video-preview",
      ].includes(scopedAgent)
    )
      agent = scopedAgent;
    return agent === "*" || agent === "googlebot";
  });
}
export function robotsAccess(body: string, target: string) {
  const groups: {
    agents: string[];
    rules: { allow: boolean; path: string }[];
  }[] = [];
  let group: (typeof groups)[number] | undefined;
  for (const line of body.split(/\r?\n/)) {
    const match = /^\s*([\w-]+)\s*:\s*(.*?)\s*$/.exec(line.split("#")[0] || "");
    if (!match) continue;
    const key = match[1]!.toLowerCase(),
      value = match[2] || "";
    if (key === "user-agent") {
      if (!group || group.rules.length) {
        group = { agents: [], rules: [] };
        groups.push(group);
      }
      if (value) group.agents.push(value.toLowerCase());
    } else if (group && ["allow", "disallow"].includes(key)) {
      group.rules.push({ allow: key === "allow", path: value });
    }
  }
  const valid = groups.some((g) => g.agents.length);
  const specific = groups.filter((g) => g.agents.includes("googlebot"));
  const selected = specific.length
    ? specific
    : groups.filter((g) => g.agents.includes("*"));
  const url = new URL(target),
    path = url.pathname + url.search;
  const matches = selected
    .flatMap((g) => g.rules)
    .filter((rule) => {
      if (!rule.path || rule.path.length > 2048) return false;
      const anchored = rule.path.endsWith("$");
      const pattern = (anchored ? rule.path.slice(0, -1) : rule.path)
        .split("*")
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp(`^${pattern}${anchored ? "$" : ""}`).test(path);
    })
    .sort(
      (a, b) =>
        b.path.replace(/[*$]/g, "").length -
          a.path.replace(/[*$]/g, "").length ||
        Number(b.allow) - Number(a.allow),
    );
  return {
    valid,
    allowed: matches[0]?.allow ?? true,
    matched: matches[0]?.path,
    specific: !!specific.length,
  };
}
