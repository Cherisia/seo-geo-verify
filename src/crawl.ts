// 사이트 전체 진단: 시작 주소 아래 페이지를 찾아 collect → analyzeSeo·analyzeGeo 순서로 채점한다.
// 채점 규칙은 src/core, 페이지 수집은 src/collector에 있다.
import { randomUUID } from "node:crypto";
import { load } from "cheerio";
import { analyzeGeo, analyzeSeo, RULESET_VERSION } from "./core/index.js";
import type { AuditResult, Check, CheckStatus, Tool } from "./core/types.js";
import { webUrl } from "./core/validation.js";
import { collect, closeRenderer } from "./collector/index.js";
import { CrawlError, isLocalHost, networkPolicy, normalizeUrl, safeFetch } from "./collector/http.js";

export type PageStatus = "queued" | "running" | "done" | "failed" | "skipped";
export interface PageRecord {
  index: number;
  url: string;
  finalUrl?: string;
  source: "start" | "sitemap" | "link";
  depth: number;
  status: PageStatus;
  stage: string;
  error?: string;
  note?: string;
  seo?: AuditResult;
  geo?: AuditResult;
  startedAt?: string;
  finishedAt?: string;
}
export interface RunOptions {
  maxPages: number;
  concurrency: number;
  useSitemap: boolean;
}
export interface Run {
  id: string;
  inputUrl: string;
  scope: { origin: string; prefix: string };
  options: RunOptions;
  status: "running" | "done" | "stopped" | "failed";
  stage: string;
  error?: string;
  ruleSetVersion: string;
  /** 로컬 개발 서버 진단(내부망 허용) */
  local?: boolean;
  createdAt: string;
  finishedAt?: string;
  discovered: number;
  limitReached: boolean;
  pages: PageRecord[];
}

const SKIP_EXT =
  /\.(pdf|jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|mov|avi|mp3|wav|ogg|zip|rar|7z|gz|tar|exe|dmg|apk|docx?|xlsx?|pptx?|hwp|hwpx|csv|txt|xml|json|js|css|woff2?|ttf|eot|rss|atom)$/i;
// 연결 문서 후보에서 빼는 주소 (로그아웃·장바구니 등 상태를 바꾸는 주소)
const SKIP_LINK = /[?]|logout|delete|remove|checkout|cart|unsubscribe/i;

export function pageKey(href: string) {
  const u = new URL(href);
  u.hash = "";
  return u.href;
}

export function scopeOf(href: string) {
  const u = new URL(href);
  const prefix = u.pathname.replace(/\/[^/]*\.[a-z0-9]+$/i, "/").replace(/\/+$/, "");
  return { origin: u.origin, prefix };
}

export function inScope(href: string, scope: Run["scope"]) {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return false;
  }
  if (u.origin !== scope.origin) return false;
  if (SKIP_EXT.test(u.pathname)) return false;
  if (!scope.prefix) return true;
  return u.pathname === scope.prefix || u.pathname.startsWith(scope.prefix + "/");
}

async function sitemapUrls(origin: string, limit: number): Promise<string[]> {
  const sitemaps = new Set<string>([origin + "/sitemap.xml"]);
  try {
    const robots = await safeFetch(origin + "/robots.txt", { timeoutMs: 9000 });
    if (robots.status === 200)
      for (const m of robots.text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)) {
        const u = webUrl(m[1]);
        if (u) sitemaps.add(u);
      }
  } catch {}
  const found: string[] = [];
  const seen = new Set<string>();
  const queue = [...sitemaps];
  while (queue.length && seen.size < 30 && found.length < limit * 5) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    try {
      const r = await safeFetch(url, { timeoutMs: 12000, maxBytes: 20 * 1024 * 1024 });
      if (r.status !== 200) continue;
      const $ = load(r.text, { xmlMode: true });
      const locOf = (e: any) =>
        $(e)
          .children()
          .toArray()
          .find((c: any) => c.tagName?.split(":").at(-1) === "loc");
      for (const e of $("*").toArray() as any[]) {
        const tag = e.tagName?.split(":").at(-1);
        if (tag !== "url" && tag !== "sitemap") continue;
        const loc = locOf(e);
        const u = loc ? webUrl($(loc).text().trim()) : undefined;
        if (!u) continue;
        if (tag === "sitemap") queue.push(u);
        else found.push(u);
      }
    } catch {}
  }
  return found;
}

function pageLinks(html: string, base: string) {
  const $ = load(html);
  const out = new Set<string>();
  for (const e of $("a[href]").toArray()) {
    const u = webUrl($(e).attr("href"), base);
    if (!u || SKIP_LINK.test(u)) continue;
    out.add(pageKey(u));
  }
  return [...out];
}

export interface Crawler {
  run: Run;
  stop(): void;
  done: Promise<Run>;
}

export function startCrawl(input: string, partial: Partial<RunOptions> = {}): Crawler {
  // 로컬 개발 서버 주소면 이번 진단에 한해 내부망 접근을 연다(한 번에 진단 하나만 돌린다).
  const trimmed = input.trim();
  const hasScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed);
  let host = "";
  try {
    host = new URL(hasScheme ? trimmed : `http://${trimmed}`).hostname;
  } catch {}
  networkPolicy.allowLocal = !!host && isLocalHost(host);
  // 로컬 개발 서버는 보통 http 라서 프로토콜을 안 적으면 http 로 본다
  const start = pageKey(
    normalizeUrl(networkPolicy.allowLocal && !hasScheme ? `http://${trimmed}` : trimmed),
  );
  const options: RunOptions = {
    maxPages: Math.max(1, Math.min(1000, partial.maxPages ?? 100)),
    concurrency: Math.max(1, Math.min(20, partial.concurrency ?? 10)),
    useSitemap: partial.useSitemap ?? true,
  };
  const run: Run = {
    id: new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "-" + randomUUID().slice(0, 6),
    inputUrl: start,
    scope: scopeOf(start),
    options,
    status: "running",
    stage: "시작 페이지 진단 중",
    ruleSetVersion: RULESET_VERSION,
    local: networkPolicy.allowLocal,
    createdAt: new Date().toISOString(),
    discovered: 1,
    limitReached: false,
    pages: [],
  };
  let stopped = false;
  const known = new Set<string>();
  const finals = new Map<string, number>();
  const queue: PageRecord[] = [];

  const enqueue = (url: string, source: PageRecord["source"], depth: number) => {
    const key = pageKey(url);
    if (known.has(key) || !inScope(key, run.scope)) return;
    known.add(key);
    run.discovered = known.size;
    if (run.pages.length >= options.maxPages) {
      run.limitReached = true;
      return;
    }
    const page: PageRecord = {
      index: run.pages.length,
      url: key,
      source,
      depth,
      status: "queued",
      stage: "대기 중",
    };
    run.pages.push(page);
    queue.push(page);
  };

  async function auditPage(page: PageRecord) {
    page.status = "running";
    page.startedAt = new Date().toISOString();
    try {
      // 수집 1회(seo 모드) → SEO·GEO 각각 채점
      const snapshot = await collect(page.url, "seo", (stage) => {
        page.stage = stage;
      });
      page.finalUrl = pageKey(snapshot.finalUrl);
      if (page.index === 0) {
        // 시작 주소가 리다이렉트되면(http→https, www 등) 범위를 최종 주소 기준으로 다시 잡는다
        run.scope = scopeOf(page.finalUrl);
        known.add(page.finalUrl);
      }
      const dup = finals.get(page.finalUrl);
      if (page.finalUrl !== page.url && (dup !== undefined || !inScope(page.finalUrl, run.scope))) {
        page.status = "skipped";
        page.note =
          dup !== undefined
            ? `${page.finalUrl}(으)로 리다이렉트됩니다. 같은 페이지를 #${dup + 1}에서 진단했습니다.`
            : `진단 범위 밖 주소 ${page.finalUrl}(으)로 리다이렉트됩니다.`;
        page.stage = "건너뜀";
        return;
      }
      finals.set(page.finalUrl, page.index);
      page.seo = analyzeSeo(snapshot);
      page.geo = await analyzeGeo(snapshot);
      if (page.finalUrl !== page.url) page.note = `${page.finalUrl}(으)로 리다이렉트됩니다.`;
      page.status = "done";
      page.stage = "진단 완료";
      for (const link of pageLinks(snapshot.renderedHtml || snapshot.html, snapshot.finalUrl))
        enqueue(link, "link", page.depth + 1);
    } catch (error) {
      page.status = "failed";
      page.stage = "진단 실패";
      page.error =
        error instanceof CrawlError
          ? error.message
          : error instanceof Error
            ? `사이트를 분석하지 못했습니다: ${error.message}`
            : "사이트를 분석하지 못했습니다.";
    } finally {
      page.finishedAt = new Date().toISOString();
    }
  }

  const done = (async () => {
    try {
      enqueue(start, "start", 0);
      await auditPage(queue.shift()!);
      if (run.pages[0]!.status === "failed") {
        run.status = "failed";
        run.error = run.pages[0]!.error;
        return run;
      }
      if (options.useSitemap && !stopped) {
        run.stage = "사이트맵에서 페이지 찾는 중";
        for (const u of await sitemapUrls(run.scope.origin, options.maxPages))
          enqueue(u, "sitemap", 1);
      }
      run.stage = "하위 페이지 진단 중";
      let active = 0;
      await new Promise<void>((resolve) => {
        const pump = () => {
          if (stopped) for (const p of queue.splice(0)) Object.assign(p, { status: "skipped", stage: "중지됨" });
          while (!stopped && active < options.concurrency && queue.length) {
            const page = queue.shift()!;
            active++;
            void auditPage(page).finally(() => {
              active--;
              pump();
            });
          }
          if (!active && !queue.length) resolve();
        };
        pump();
      });
      run.status = stopped ? "stopped" : "done";
      return run;
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : "진단 실패";
      return run;
    } finally {
      run.stage = run.status === "done" ? "진단 완료" : run.status === "stopped" ? "중지됨" : "진단 실패";
      run.finishedAt = new Date().toISOString();
    }
  })();

  return {
    run,
    stop() {
      stopped = true;
    },
    done,
  };
}

export { closeRenderer };

// ── 요약 ────────────────────────────────────────────────

export interface IssueSummary {
  tool: Tool;
  id: string;
  label: string;
  category: string;
  fix?: string;
  detail: string;
  fail: number;
  warning: number;
  unknown: number;
  lostPoints: number;
  maxPoints: number;
  pages: { index: number; url: string; status: CheckStatus; points: number; detail: string }[];
}

function scoredChecks(result: AuditResult) {
  return result.categories.flatMap((c) => c.checks.map((check) => ({ category: c.label, check })));
}

export function summarize(run: Run) {
  const done = run.pages.filter((p) => p.status === "done");
  const avg = (tool: Tool) => {
    const scores = done.map((p) => p[tool]?.score).filter((s): s is number => typeof s === "number");
    return scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
  };
  const issues = new Map<string, IssueSummary>();
  for (const page of done)
    for (const tool of ["seo", "geo"] as Tool[]) {
      const result = page[tool];
      if (!result) continue;
      for (const { category, check } of scoredChecks(result) as { category: string; check: Check }[]) {
        if (!["fail", "warning", "error"].includes(check.status)) continue;
        const key = `${tool}:${check.id}`;
        let item = issues.get(key);
        if (!item) {
          item = {
            tool,
            id: check.id,
            label: check.label,
            category,
            fix: check.fix,
            detail: check.detail,
            fail: 0,
            warning: 0,
            unknown: 0,
            lostPoints: 0,
            maxPoints: check.maxPoints,
            pages: [],
          };
          issues.set(key, item);
        }
        if (!item.fix && check.fix) item.fix = check.fix;
        if (check.status === "fail") item.fail++;
        else if (check.status === "warning") item.warning++;
        else item.unknown++;
        if (check.applicable) item.lostPoints += check.maxPoints - check.points;
        item.pages.push({
          index: page.index,
          url: page.finalUrl || page.url,
          status: check.status,
          points: check.points,
          detail: check.detail,
        });
      }
    }
  return {
    counts: {
      total: run.pages.length,
      done: done.length,
      failed: run.pages.filter((p) => p.status === "failed").length,
      skipped: run.pages.filter((p) => p.status === "skipped").length,
      running: run.pages.filter((p) => p.status === "running").length,
      queued: run.pages.filter((p) => p.status === "queued").length,
    },
    average: { seo: avg("seo"), geo: avg("geo") },
    issues: [...issues.values()].sort(
      (a, b) => b.fail + b.warning - (a.fail + a.warning) || b.lostPoints - a.lostPoints,
    ),
  };
}
