import type {
  BrowserObservation,
  NetworkResource,
  UrlProbe,
} from "../core/types.js";
import { safeFetch, type FetchResponse } from "./http.js";

export const vitalsScript = `(() => {
  const state = window.__aqVitals = { lcpMs: undefined, cls: 0 };
  let sum = 0, first = 0, last = -Infinity;
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) state.lcpMs = e.startTime; }).observe({type:'largest-contentful-paint',buffered:true}); } catch {}
  try { new PerformanceObserver(list => { for (const e of list.getEntries()) {
    if (e.hadRecentInput) continue;
    if (e.startTime - last >= 1000 || e.startTime - first >= 5000) { sum = 0; first = e.startTime; }
    sum += e.value; last = e.startTime; state.cls = Math.max(state.cls, sum);
  }}).observe({type:'layout-shift',buffered:true}); } catch { state.cls = undefined; }
})();`;

export function networkResource(
  r: FetchResponse,
  kind: string,
  head = false,
): NetworkResource {
  const length = r.headers["content-length"];
  const bytes = head
    ? length && /^\d+$/.test(length)
      ? Number(length)
      : undefined
    : r.encodedBytes;
  const cache = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(
    r.headers["cache-control"] || "",
  );
  return {
    url: r.url,
    kind,
    status: r.status,
    bytes,
    sizeSource: bytes === undefined ? "unknown" : head ? "header" : "response",
    cacheMaxAge: cache ? Number(cache[1]) : undefined,
    skipped: head || undefined,
  };
}

export async function inspectOmitted(resources: NetworkResource[]) {
  // Never download arbitrary video bodies merely to determine their size.
  const pending = resources
    .filter((r) => r.sizeSource === "unknown")
    .slice(0, 12);
  for (let i = 0; i < pending.length; i += 4) {
    await Promise.all(
      pending.slice(i, i + 4).map(async (r) => {
        try {
          const response = await safeFetch(r.url, {
            method: "HEAD",
            timeoutMs: 4000,
            redirects: 3,
          });
          Object.assign(r, networkResource(response, r.kind, true));
        } catch (e) {
          r.error = e instanceof Error ? e.message : "크기 확인 실패";
        }
      }),
    );
  }
}

export async function probeVariants(finalUrl: string): Promise<UrlProbe[]> {
  const original = new URL(finalUrl);
  const variants = new Set<string>();
  for (const protocol of ["http:", "https:"]) {
    const url = new URL(original);
    url.protocol = protocol;
    url.port = "";
    variants.add(url.href);
    if (!/^[\d.]+$/.test(url.hostname) && !url.hostname.includes(":")) {
      url.hostname = url.hostname.startsWith("www.")
        ? url.hostname.slice(4)
        : `www.${url.hostname}`;
      variants.add(url.href);
    }
  }
  variants.delete(finalUrl);
  return Promise.all(
    [...variants].map(async (inputUrl) => {
      try {
        const r = await safeFetch(inputUrl, {
          method: "HEAD",
          timeoutMs: 5000,
          redirects: 3,
        });
        return {
          inputUrl,
          finalUrl: r.url,
          status: r.status,
          redirects: r.redirects || [],
        };
      } catch (e) {
        return {
          inputUrl,
          error: e instanceof Error ? e.message : "연결 실패",
        };
      }
    }),
  );
}

export function contentRequest(kind: string, url?: string) {
  // Some animation players fetch image frames through fetch/XHR. A missing
  // image frame is an asset failure, not a missing page/JSON data response.
  if (
    url &&
    ["fetch", "xhr"].includes(kind) &&
    /\.(?:avif|webp|png|jpe?g|gif|svg)(?:[?#]|$)/i.test(url)
  )
    return false;
  return ["document", "script", "xhr", "fetch"].includes(kind);
}

export { telemetryRequest } from "../core/collection.js";

export const observationLimits = (b: BrowserObservation) =>
  `화면 ${b.viewport.width}×${b.viewport.height} · ${Math.round(b.observedMs / 1000)}초 관찰 · 격리 프록시 경유, 네트워크·CPU 감속 없음 · 미디어 본문 ${b.omittedMedia.length}건 생략. Lighthouse 또는 실제 방문자 Core Web Vitals가 아닙니다.`;
