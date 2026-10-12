import { XMLValidator } from "fast-xml-parser";
import { load } from "cheerio";
import { webUrl } from "./validation.js";
export function inspectSitemap(body: string) {
  const issues: string[] = [];
  if (
    /<!DOCTYPE|<!ENTITY/i.test(body.replace(/<!--[^]*?-->/g, "")) ||
    XMLValidator.validate(body) !== true
  )
    return {
      exists: false,
      valid: false,
      count: 0,
      issues: ["XML 문법 오류 또는 지원하지 않는 문서 선언"],
    };
  const $ = load(body, { xmlMode: true });
  const roots = $.root().children().toArray();
  const local = (e: any) => e.tagName?.split(":").at(-1);
  const root =
    roots.length === 1 && ["urlset", "sitemapindex"].includes(local(roots[0]))
      ? local(roots[0])
      : "";
  if (!root)
    return {
      exists: false,
      valid: false,
      count: 0,
      issues: ["루트가 urlset 또는 sitemapindex가 아닙니다."],
    };
  const namespace = (e: any) => {
    const attr = e.tagName.includes(":")
      ? `xmlns:${e.tagName.split(":")[0]}`
      : "xmlns";
    for (let node = e; node && node.type !== "root"; node = node.parent) {
      const ns = $(node).attr(attr);
      if (ns) return ns;
    }
    return "";
  };
  const ns = "http://www.sitemaps.org/schemas/sitemap/0.9";
  if (namespace(roots[0]) !== ns)
    issues.push("사이트맵 namespace가 없거나 다릅니다.");
  const rows = $(roots[0]!)
    .children()
    .toArray()
    .filter(
      (e) =>
        local(e) === (root === "urlset" ? "url" : "sitemap") &&
        namespace(e) === ns,
    );
  if (!rows.length) issues.push("URL 항목이 없습니다.");
  rows.forEach((row, i) => {
    const locs = $(row)
      .children()
      .toArray()
      .filter((e) => local(e) === "loc" && namespace(e) === ns);
    const loc = locs.length === 1 ? $(locs[0]!).text().trim() : "";
    if (loc.length >= 2048 || !webUrl(loc))
      issues.push(`${i + 1}번째 loc: 유효한 절대 HTTP(S) URL이 아닙니다.`);
  });
  return { exists: true, valid: !issues.length, count: rows.length, issues };
}
