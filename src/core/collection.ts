import type { CrawlSnapshot } from "./types.js";
import { load } from "cheerio";

/** Static crawls are primary; client shells and deferred layouts need a loaded DOM. */
export function seoDocument(s: CrawlSnapshot) {
  if (!s.renderedHtml || s.renderStatus !== "succeeded") return s.html;
  const $ = load(s.html);
  $("script,style,template,noscript").remove();
  const emptyShell = !$("body").text().trim() && !$("h1,h2,img").length;
  const hydratedNuxt = /\bwindow\.__NUXT__\s*=/.test(s.html);
  // Deferred CSS loaders change preload into stylesheet after loading; evaluate
  // their final layout and resource hints together, once body parsing completes.
  const deferredLayout =
    $("link[rel='preload'][as='style'][onload]").length > 0;
  const rendered = load(s.renderedHtml);
  const bodyLoaded =
    rendered("body").text().trim().length > 0 ||
    rendered("body img").length > 0;
  return bodyLoaded && (emptyShell || hydratedNuxt || deferredLayout)
    ? s.renderedHtml
    : s.html;
}

/** Root inputs that resolve to a localized/index homepage remain homepages. */
export function isHomepage(s: CrawlSnapshot) {
  return (
    new URL(s.inputUrl).pathname === "/" || new URL(s.finalUrl).pathname === "/"
  );
}

/** Auxiliary failures do not invalidate structured data already in a loaded document. */
export function incompleteStructuredDataCollection(
  s: CrawlSnapshot,
  hasBlocks: boolean,
) {
  if (s.renderStatus !== "succeeded") return true;
  if (!s.renderIncomplete || hasBlocks) return false;
  const $ = load(s.renderedHtml || s.html);
  $("script,style,template,noscript").remove();
  // A failed app bootstrap can leave a small shell; absence in that shell is unknown.
  // A populated document is scored as observed, with collection warnings retained.
  return $("body").text().replace(/\s/g, "").length < 200;
}

/** Only known collection endpoints, never whole script/CDN domains. */
export function telemetryRequest(input: string, kind: string) {
  if (!["fetch", "xhr", "ping", "image", "other"].includes(kind)) return false;
  try {
    const { hostname, pathname } = new URL(input);
    return (
      ([
        "www.google-analytics.com",
        "region1.google-analytics.com",
        "analytics.google.com",
        "www.google.com",
        "stats.g.doubleclick.net",
      ].includes(hostname) &&
        /^\/(?:g\/|j\/)?collect\/?$/.test(pathname)) ||
      (hostname === "wcs.naver.com" && pathname === "/b") ||
      (hostname === "stat.tiara.daum.net" && pathname === "/track") ||
      ((/^o\d+\.ingest(?:\.[a-z]+)?\.sentry\.io$/.test(hostname) ||
        hostname === "aem-kakao-collector.onkakao.net") &&
        /^\/api\/\d+\/envelope\/?$/.test(pathname)) ||
      (hostname === "developer.mozilla.org" && pathname === "/pong/get") ||
      (hostname === "geoanalytics.ai.kr" && pathname === "/ingest/beacon") ||
      (hostname === "inblog.ai" && /^\/api\/log-(?:view|click)\/?$/.test(pathname))
    );
  } catch {
    return false;
  }
}

/** Repair the specific telemetry misclassification in saved v4 snapshots. */
export function scoringSnapshot(s: CrawlSnapshot): CrawlSnapshot {
  const browser = s.browser;
  if (!browser) return s;
  const contentFailures = browser.contentFailures.filter((failure) => {
    const url = /^https?:\/\/\S+/.exec(failure)?.[0]?.replace(/:$/, "");
    return !(
      url &&
      failure.includes("요청 한도 또는 지원하지 않는 요청") &&
      telemetryRequest(url, "fetch")
    );
  });
  if (contentFailures.length === browser.contentFailures.length) return s;
  return {
    ...s,
    browser: { ...browser, contentFailures },
    renderIncomplete: contentFailures.length > 0,
    warnings: s.warnings.flatMap((warning) =>
      warning.startsWith("문서·스크립트·데이터 요청 또는 실행")
        ? contentFailures.length
          ? [
              `문서·스크립트·데이터 요청 또는 실행 ${contentFailures.length}건을 완료하지 못했습니다. 일부 동적 콘텐츠는 확인되지 않았습니다.`,
            ]
          : []
        : [warning],
    ),
  };
}
