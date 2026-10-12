import { chromium, type Browser } from "playwright";
import { load } from "cheerio";
import http from "node:http";
import https from "node:https";
import { createHash } from "node:crypto";
import { publicApiHeaders } from "./request-headers.js";
import { webUrl } from "../core/validation.js";
import {
  safeFetch,
  normalizeUrl,
  CrawlError,
  type FetchResponse,
} from "./http.js";
import type { CrawlSnapshot, Resource, Tool } from "../core/types.js";
import type { BrowserObservation, NetworkResource } from "../core/types.js";
import {
  vitalsScript,
  networkResource,
  inspectOmitted,
  probeVariants,
  contentRequest,
  telemetryRequest,
} from "./observation.js";

let browser: Browser | undefined;
let browserStart: Promise<Browser> | undefined;
async function getBrowser() {
  if (browser?.isConnected()) return browser;
  if (!browserStart)
    browserStart = chromium
      .launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH || undefined,
        args: [
          "--disable-background-networking",
          "--disable-features=WebRtcHideLocalIpsWithMdns",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ],
      })
      .then((b) => (browser = b))
      .finally(() => {
        browserStart = undefined;
      });
  return browserStart;
}
export async function closeRenderer() {
  await browser?.close();
  browser = undefined;
}

async function render(main: FetchResponse) {
  const b = await getBrowser();
  const context = await b.newContext({
    serviceWorkers: "block",
    acceptDownloads: false,
    javaScriptEnabled: true,
    viewport: { width: 1366, height: 768 },
    isMobile: false,
    deviceScaleFactor: 1,
  });
  let requests = 0,
    bytes = 0;
  const resources = new Map<string, NetworkResource>();
  resources.set(main.url, networkResource(main, "document"));
  const observation: BrowserObservation = {
    viewport: { width: 1366, height: 768 },
    observedMs: 0,
    resources: [],
    contentFailures: [],
    resourceFailures: [],
    omittedMedia: [],
    resourceLimitReached: false,
    omittedTelemetry: [],
  };
  const failed = (url: string, kind: string, reason: string) => {
    const list = contentRequest(kind, url)
      ? observation.contentFailures
      : observation.resourceFailures;
    if (list.length < 20) list.push(`${url}: ${reason}`);
  };
  const cache = new Map<string, Promise<FetchResponse>>();
  const agents = {
    http: new http.Agent({ keepAlive: true, maxSockets: 6 }),
    https: new https.Agent({ keepAlive: true, maxSockets: 6 }),
  };
  cache.set(main.url, Promise.resolve(main));
  // Mirror ordinary per-origin browser connection limits. Unbounded fresh TLS
  // connections can make otherwise reachable sites stop answering the crawl.
  const pending = new Map<string, (() => void)[]>();
  const active = new Map<string, number>();
  let closing = false;
  const fetchResource = async (
    url: string,
    method: "GET" | "HEAD",
    headers: Record<string, string>,
  ) => {
    const origin = new URL(url).origin;
    if ((active.get(origin) || 0) >= 6)
      await new Promise<void>((resolve) => {
        const queue = pending.get(origin) || [];
        queue.push(resolve);
        pending.set(origin, queue);
      });
    else active.set(origin, (active.get(origin) || 0) + 1);
    try {
      if (closing) throw new Error("브라우저 관찰 종료");
      if (bytes > 20 * 1024 * 1024) throw new Error("렌더링 리소스 한도");
      return await safeFetch(url, {
        timeoutMs: 6000,
        maxBytes: 2 * 1024 * 1024,
        agents,
        method,
        headers,
      });
    } finally {
      const next = pending.get(origin)?.shift();
      if (next) next();
      else active.set(origin, (active.get(origin) || 1) - 1);
    }
  };
  await context.routeWebSocket("**/*", (socket) => socket.close());
  await context.route("**/*", async (route) => {
    const req = route.request();
    if (telemetryRequest(req.url(), req.resourceType())) {
      const endpoint = new URL(req.url());
      const label = `${req.method()} ${endpoint.origin}${endpoint.pathname}`;
      if (!observation.omittedTelemetry!.includes(label))
        observation.omittedTelemetry!.push(label);
      await route.abort().catch(() => {});
      return;
    }
    if (
      ++requests > 200 ||
      !["GET", "HEAD"].includes(req.method()) ||
      !/^https?:\/\//.test(req.url())
    ) {
      if (requests > 200) observation.resourceLimitReached = true;
      failed(
        req.url(),
        req.resourceType(),
        "요청 한도 또는 지원하지 않는 요청",
      );
      await route.abort().catch(() => {});
      return;
    }
    if (req.resourceType() === "media") {
      if (!observation.omittedMedia.includes(req.url()))
        observation.omittedMedia.push(req.url());
      resources.set(req.url(), {
        url: req.url(),
        kind: "media",
        status: 0,
        sizeSource: "unknown",
        skipped: true,
      });
      await route.abort().catch(() => {});
      return;
    }
    try {
      if (bytes > 20 * 1024 * 1024) throw new Error("렌더링 리소스 한도");
      const method = req.method() as "GET" | "HEAD";
      let headers = ["fetch", "xhr"].includes(req.resourceType())
        ? publicApiHeaders(req.url(), await req.allHeaders())
        : {};
      for (let prior = req.redirectedFrom(); prior; prior = prior.redirectedFrom())
        if (new URL(prior.url()).origin !== new URL(req.url()).origin) headers = {};
      // Do not reuse an unauthenticated response for a public-key request (or HEAD for GET).
      const cacheKey =
        method === "GET" && !Object.keys(headers).length
          ? req.url()
          : `${method} ${req.url()} ${createHash("sha256").update(JSON.stringify(headers)).digest("hex")}`;
      if (!cache.has(cacheKey))
        cache.set(cacheKey, fetchResource(req.url(), method, headers));
      const response = await cache.get(cacheKey)!;
      bytes += response.buffer.length;
      resources.set(req.url(), networkResource(response, req.resourceType()));
      if (response.status >= 400)
        failed(req.url(), req.resourceType(), `HTTP ${response.status}`);
      if (response.url !== req.url()) {
        if (cacheKey === req.url())
          cache.set(response.url, Promise.resolve(response));
        await route.fulfill({
          status: 302,
          headers: { location: response.url },
          body: "",
        });
        return;
      }
      const responseHeaders = { ...response.headers };
      for (const key of [
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "connection",
        "set-cookie",
      ])
        delete responseHeaders[key];
      // HTML is from the isolated target, never from the host application's authenticated session.
      await route.fulfill({
        status: response.status,
        headers: responseHeaders,
        body: response.buffer,
      });
    } catch (e) {
      failed(
        req.url(),
        req.resourceType(),
        e instanceof Error ? e.message : "수집 실패",
      );
      if (bytes > 20 * 1024 * 1024) observation.resourceLimitReached = true;
      resources.set(req.url(), {
        url: req.url(),
        kind: req.resourceType(),
        status: 0,
        sizeSource: "unknown",
        skipped: true,
      });
      await route.abort().catch(() => {});
    }
  });
  const page = await context.newPage();
  await page.addInitScript({ content: vitalsScript });
  page.on("pageerror", (e) => {
    if (observation.contentFailures.length < 20)
      observation.contentFailures.push(
        `스크립트 실행: ${e.message.slice(0, 200)}`,
      );
  });
  // Popup and download surfaces must never become unbounded background work.
  context.on("page", (popup) => {
    if (popup !== page) void popup.close();
  });
  try {
    const started = Date.now();
    await page
      .goto(main.url, {
        waitUntil: "domcontentloaded",
        timeout: 18000,
      })
      .catch((error: Error) => {
        if (error.name !== "TimeoutError") throw error;
        // A slow blocking asset can time out navigation while the main document
        // is already available. Preserve that DOM and its explicit failure evidence.
        failed(main.url, "document", "문서 로딩 대기 시간 초과");
      });
    await page.waitForLoadState("networkidle", { timeout: 4500 }).catch(() => {
      observation.resourceLimitReached = true;
    });
    await page.waitForTimeout(2500);
    const vitals = (await page.evaluate("window.__aqVitals || {}")) as {
      lcpMs?: number;
      cls?: number;
    };
    Object.assign(observation, vitals, { observedMs: Date.now() - started });
    const html = await page.content();
    const finalUrl = new URL(page.url());
    finalUrl.hash = "";
    const response = await cache.get(finalUrl.href);
    if (!response || response.status < 200 || response.status >= 400)
      throw new Error("렌더링 후 최종 페이지 응답을 확인하지 못했습니다.");
    observation.resources = [...resources.values()].slice(0, 100);
    return { html, observation, response };
  } finally {
    closing = true;
    agents.http.destroy();
    agents.https.destroy();
    await context.close();
  }
}

async function resource(url: string): Promise<Resource> {
  try {
    const r = await safeFetch(url, { timeoutMs: 9000 });
    return {
      url: r.url,
      requestedUrl: url,
      status: r.status,
      body: r.text,
      headers: r.headers,
    };
  } catch (error) {
    return {
      url,
      status: 0,
      body: "",
      headers: {},
      error: error instanceof Error ? error.message : "수집 실패",
    };
  }
}
export async function collect(
  input: string,
  tool: Tool,
  onStage: (stage: string) => void = () => {},
): Promise<CrawlSnapshot> {
  const started = Date.now(),
    normalized = normalizeUrl(input);
  onStage("웹페이지 연결 중");
  let main: FetchResponse;
  try {
    main = await safeFetch(normalized);
  } catch (error) {
    // Explicit HTTPS failures must stay visible. Only bare domains get protocol fallback.
    if (
      !/^https?:\/\//i.test(input.trim()) &&
      error instanceof CrawlError &&
      ["FETCH_FAILED", "TIMEOUT"].includes(error.code)
    )
      main = await safeFetch(normalized.replace(/^https:/, "http:"));
    else throw error;
  }
  if (main.status < 200 || main.status >= 400)
    throw new CrawlError(
      `사이트에서 HTTP ${main.status} 응답을 반환했습니다. 접근 가능한 주소인지 확인해주세요.`,
      "HTTP_STATUS",
    );
  if (
    !/text\/html|application\/xhtml\+xml/i.test(
      main.headers["content-type"] || "",
    ) &&
    !/<html[\s>]/i.test(main.text)
  )
    throw new CrawlError("HTML 웹페이지 주소를 입력해주세요.", "NOT_HTML");
  let origin = new URL(main.url).origin;
  const empty = (path: string): Resource => ({
    url: origin + path,
    status: 0,
    body: "",
    headers: {},
  });
  const snapshot: CrawlSnapshot = {
    inputUrl: normalized,
    finalUrl: main.url,
    collectedAt: new Date().toISOString(),
    durationMs: 0,
    html: main.text,
    status: main.status,
    headers: main.headers,
    tls: main.tls,
    robots: empty("/robots.txt"),
    sitemap: empty("/sitemap.xml"),
    favicon: empty("/favicon.ico"),
    renderStatus: "skipped",
    warnings: [],
  };
  // Collect scored root files before the page fans out into asset requests.
  const resourceOrigin = origin;
  [snapshot.robots, snapshot.sitemap] = await Promise.all([
    resource(origin + "/robots.txt"),
    tool === "seo"
      ? resource(origin + "/sitemap.xml")
      : Promise.resolve(snapshot.sitemap),
  ]);
  {
    onStage(
      tool === "geo"
        ? "브라우저 렌더링·JSON-LD 추출 중"
        : "렌더링된 콘텐츠·제목 구조 확인 중",
    );
    try {
      const rendered = await render(main);
      main = rendered.response;
      origin = new URL(main.url).origin;
      Object.assign(snapshot, {
        finalUrl: main.url,
        html: main.text,
        status: main.status,
        headers: main.headers,
        tls: main.tls,
      });
      snapshot.browser = rendered.observation;
      snapshot.renderIncomplete =
        rendered.observation.contentFailures.length > 0;
      snapshot.renderedHtml = rendered.html;
      snapshot.renderStatus = "succeeded";
      if (snapshot.renderIncomplete)
        snapshot.warnings.push(
          `문서·스크립트·데이터 요청 또는 실행 ${rendered.observation.contentFailures.length}건을 완료하지 못했습니다. 일부 동적 콘텐츠는 확인되지 않았습니다.`,
        );
    } catch (e) {
      snapshot.renderStatus = "failed";
      snapshot.renderError =
        e instanceof Error ? e.message : "브라우저 실행 실패";
      snapshot.warnings.push(
        "브라우저 렌더링을 완료하지 못해 서버 HTML 기준으로 분석했습니다.",
      );
    }
  }
  onStage("리소스 용량·대표 주소·연결 문서 확인 중");
  const $page = load(snapshot.renderedHtml || snapshot.html);
  const candidates = [
    ...new Set(
      $page("a[href]")
        .toArray()
        .map((e) => webUrl($page(e).attr("href"), snapshot.finalUrl))
        .filter(
          (u): u is string =>
            !!u &&
            u.split("#")[0] !== snapshot.finalUrl.split("#")[0] &&
            !/[?]|logout|delete|remove|checkout|cart|unsubscribe/i.test(u),
        )
        .map((u) => {
          const url = new URL(u);
          url.hash = "";
          return url.href;
        }),
    ),
  ];
  candidates.sort(
    (a, b) =>
      Number(/privacy|terms|policy/i.test(a)) -
      Number(/privacy|terms|policy/i.test(b)),
  );
  const [variants, linkedPages, robots] = await Promise.all([
    probeVariants(snapshot.finalUrl),
    Promise.all(candidates.slice(0, 4).map(resource)),
    resourceOrigin === origin
      ? Promise.resolve(snapshot.robots)
      : resource(origin + "/robots.txt"),
    snapshot.browser
      ? inspectOmitted(snapshot.browser.resources)
      : Promise.resolve(),
  ]);
  snapshot.urlVariants = variants;
  snapshot.linkedPages = linkedPages;
  snapshot.robots = robots;
  if (tool === "seo") {
    onStage("메타 정보·사이트맵·보안 확인 중");
    const $ = load(snapshot.renderedHtml || main.text);
    const hasFavicon = $("link")
      .toArray()
      .some((e) =>
        /^(shortcut icon|icon|apple-touch-icon|apple-touch-icon-precomposed)$/i.test(
          $(e).attr("rel") || "",
        ),
      );
    const [robots, sitemap, favicon] = await Promise.all([
      Promise.resolve(snapshot.robots),
      resourceOrigin === origin
        ? Promise.resolve(snapshot.sitemap)
        : resource(origin + "/sitemap.xml"),
      hasFavicon
        ? Promise.resolve(empty("/favicon.ico"))
        : resource(origin + "/favicon.ico"),
    ]);
    const iconUrls = [
      ...new Set(
        $("link")
          .toArray()
          .filter((e) =>
            /^(shortcut icon|icon|apple-touch-icon|apple-touch-icon-precomposed)$/i.test(
              $(e).attr("rel") || "",
            ),
          )
          .map((e) => webUrl($(e).attr("href"), main.url))
          .filter((v): v is string => !!v),
      ),
    ].slice(0, 3);
    const icons = iconUrls.length
      ? await Promise.all(iconUrls.map(resource))
      : hasFavicon
        ? []
        : [favicon];
    Object.assign(snapshot, { robots, sitemap, favicon, icons });
    for (const r of [snapshot.robots, snapshot.sitemap])
      if (r.error) snapshot.warnings.push(`${r.url}: ${r.error}`);
  }
  snapshot.durationMs = Date.now() - started;
  onStage("항목별 점수 계산 중");
  return snapshot;
}
