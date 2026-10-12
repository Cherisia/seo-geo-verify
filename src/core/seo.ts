import { load } from "cheerio";
import { inspectSitemap } from "./sitemap.js";
import {
  languageTag,
  robotsAccess,
  webUrl,
  googleHeaderDirectives,
} from "./validation.js";
import { category, check, finish, na } from "./shared.js";
import { scoringSnapshot, seoDocument } from "./collection.js";
import { deliveryChecks, urlChecks, contentChecks } from "./extended.js";
import type { Check, CrawlSnapshot } from "./types.js";

export function analyzeSeo(s: CrawlSnapshot) {
  s = scoringSnapshot(s);
  // Include noscript fallback markup, as a non-JavaScript HTML crawler does.
  const $ = load(seoDocument(s), { scriptingEnabled: false });
  const title = $("title").first().text().trim();
  const metas = $("meta").toArray();
  const meta = (name: string, attr = "name") =>
    metas
      .filter(
        (e) => ($(e).attr(attr) || "").toLowerCase() === name.toLowerCase(),
      )
      .map((e) => $(e).attr("content")?.trim() || "")
      .filter(Boolean);
  const code = (selector: string, limit = 5) =>
    $(selector)
      .toArray()
      .slice(0, limit)
      .map((e) => $.html(e))
      .join("\n");
  const images = $("img").toArray();
  const missingAlt = images.filter((e) => !$(e).attr("alt")?.trim());
  // Heading counts and hierarchy must describe the same selected document.
  const headings = $("h1,h2,h3,h4,h5,h6").toArray();
  const hierarchy: string[] = [];
  let last = 0;
  for (const h of headings) {
    const level = Number(h.tagName.slice(1));
    if (last === 0 && level !== 1) hierarchy.push(`첫 제목이 H${level}입니다.`);
    else if (last && level > last + 1)
      hierarchy.push(`H${last} 다음에 H${level}이 나타납니다.`);
    last = level;
  }
  const content = category("content", "콘텐츠 SEO", 50, [
    check(
      "title_exists",
      "웹사이트 제목",
      9,
      title ? 9 : 0,
      title ? `제목 ${title.length}자` : "페이지 제목이 없습니다.",
      {
        evidence: code("title"),
        fix: "페이지 주제를 담은 title을 작성하세요.",
      },
    ),
    check(
      "title_single",
      "Title 태그 단일 사용",
      2,
      $("title").length === 1 ? 2 : 0,
      `Title 태그 ${$("title").length}개`,
      { evidence: code("title"), fix: "Title 태그를 한 개로 정리하세요." },
    ),
    check(
      "description_exists",
      "웹사이트 설명",
      7,
      meta("description").length ? 7 : 0,
      meta("description")[0] || "메타 설명이 없습니다.",
      {
        evidence: meta("description").length
          ? `<meta name="description" content="${meta("description")[0]}">`
          : undefined,
        fix: "페이지 내용을 요약하는 메타 설명을 추가하세요.",
      },
    ),
    check(
      "h1_exists",
      "제목태그 H1",
      7,
      $("h1").length ? 7 : 0,
      `H1 태그 ${$("h1").length}개`,
      { evidence: code("h1"), fix: "페이지 대표 제목을 H1으로 작성하세요." },
    ),
    check(
      "h1_single",
      "H1 태그 단일 사용",
      4,
      $("h1").length === 1 ? 4 : 0,
      `H1 태그 ${$("h1").length}개 · 한 개 사용 권장`,
      { fix: "H1 태그를 한 개로 정리하세요." },
    ),
    check(
      "h2_structure",
      "제목태그 H2",
      5,
      $("h2").length ? 5 : 0,
      `H2 태그 ${$("h2").length}개`,
      { evidence: code("h2"), fix: "내용을 H2 소제목으로 나누세요." },
    ),
    check(
      "heading_hierarchy",
      "제목 태그 계층 구조",
      7,
      headings.length && !hierarchy.length ? 7 : 0,
      hierarchy.length
        ? hierarchy.slice(0, 5).join(" ")
        : headings.length
          ? "제목이 단계별 순서를 지킵니다."
          : "제목 태그가 없습니다.",
      {
        evidence: headings
          .slice(0, 60)
          .map(
            (e) =>
              `${"  ".repeat(Number(e.tagName.slice(1)) - 1)}${e.tagName.toUpperCase()} ${$(e).text().trim().slice(0, 90)}`,
          )
          .join("\n"),
        fix: "제목을 H1부터 순서대로 구성하세요.",
      },
    ),
    check(
      "img_alt",
      "이미지 ALT 설명",
      9,
      images.length
        ? Math.floor((9 * (images.length - missingAlt.length)) / images.length)
        : 9,
      images.length
        ? `전체 ${images.length}개 중 ALT 설명 없음 ${missingAlt.length}개 · 기본 점수는 빈 ALT도 설명 없음으로 집계합니다. 장식 이미지의 빈 ALT는 접근성 목적에 맞게 유지할 수 있습니다.`
        : "이미지가 없습니다.",
      {
        evidence: missingAlt
          .slice(0, 3)
          .map((e) => $.html(e))
          .join("\n"),
        fix: "내용이 있는 이미지에 대체 설명을 작성하세요.",
        confidence: "inferred",
        status: missingAlt.length
          ? missingAlt.length === images.length
            ? "fail"
            : "warning"
          : "pass",
      },
    ),
  ]);
  const https = new URL(s.finalUrl).protocol === "https:";
  const mixed = $("[src],[srcset],object[data],[href]")
    .toArray()
    .flatMap((e) =>
      ["href", "src", "srcset", "data"].flatMap((a) => {
        const v = $(e).attr(a);
        return v && /(^|[\s,])http:\/\//i.test(v)
          ? [`${e.tagName}[${a}] ${v.slice(0, 160)}`]
          : [];
      }),
    );
  $("style,[style]").each((_, e) => {
    const css = (
      e.tagName === "style" ? $(e).text() : $(e).attr("style") || ""
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of css.matchAll(/url\(\s*["']?(http:\/\/[^\s)'";]+)/gi))
      mixed.push(`CSS url: ${m[1]!.slice(0, 160)}`);
  });
  const canonicalLinks = $("link")
    .filter((_, e) => ($(e).attr("rel") || "").toLowerCase() === "canonical")
    .toArray();
  const canonical =
    canonicalLinks.length === 1
      ? webUrl($(canonicalLinks[0]).attr("href"), s.finalUrl)
      : undefined;
  const validTls = https && s.tls?.valid === true;
  const doctype = /^\s*<!doctype\s+html\s*>/i.test(
    s.html.replace(/<!--[^]*?-->/g, ""),
  );
  const technical = category("technical", "기술적 SEO", 20, [
    check(
      "https",
      "HTTPS · SSL 인증서",
      5,
      validTls ? 5 : 0,
      !https
        ? "HTTP로 연결됩니다."
        : `HTTPS 연결${s.tls?.expiresAt ? ` · 만료 ${s.tls.expiresAt}` : ""}${s.tls?.valid === false ? " · 인증서 유효성 확인 실패" : ""}`,
      {
        fix: "유효한 인증서로 HTTPS를 제공하세요.",
        ...(https && !s.tls
          ? {
              status: "error" as const,
              applicable: false,
              detail: "HTTPS 주소지만 인증서 정보를 수집하지 못했습니다.",
            }
          : {}),
      },
    ),
    check(
      "mixed_content",
      "HTTP 링크·리소스 선언",
      2,
      https && !mixed.length ? 2 : 0,
      mixed.length
        ? `HTTP 링크·리소스 ${mixed.length}개 발견`
        : https
          ? "검사한 HTML·인라인 CSS에 HTTP 링크·리소스 선언이 없습니다."
          : "HTTPS 연결이 아닙니다.",
      {
        evidence: mixed.slice(0, 10).join("\n"),
        fix: "페이지가 불러오는 HTTP 리소스를 HTTPS로 정리하세요.",
        confidence: "inferred",
        evidenceNote:
          "최대 10개. 기본 점수는 일반 이동 링크도 포함합니다. HTTP 이동 링크 자체가 브라우저의 혼합 콘텐츠 차단 대상이라는 뜻은 아닙니다.",
      },
    ),
    check(
      "canonical",
      "캐노니컬 URL 기본 형식",
      5,
      canonical ? 5 : 0,
      canonical
        ? `${canonical} · 대상 응답과 내용 일치는 별도 확인이 필요합니다.`
        : `선언 ${canonicalLinks.length}개 · 하나의 유효한 HTTP(S) URL을 확인하지 못했습니다.`,
      {
        evidence: canonical
          ? `<link rel="canonical" href="${canonical}">`
          : undefined,
        fix: "대표 페이지 URL을 canonical로 선언하세요.",
      },
    ),
    check(
      "viewport",
      "Viewport 메타 태그",
      4,
      meta("viewport").length ? 4 : 0,
      meta("viewport")[0] || "Viewport가 없습니다.",
      { fix: "width=device-width를 포함한 viewport를 추가하세요." },
    ),
    check(
      "lang_attr",
      "HTML 언어 태그 형식",
      2,
      languageTag($("html").attr("lang")?.trim() || "") ? 2 : 0,
      $("html").attr("lang") || "lang 속성이 없습니다.",
      { fix: "html 요소에 문서 언어를 지정하세요." },
    ),
    check(
      "doctype",
      "HTML5 DOCTYPE",
      2,
      doctype ? 2 : 0,
      doctype ? "HTML5 문서 선언이 있습니다." : "HTML5 문서 선언이 없습니다.",
      { fix: "문서 시작에 <!DOCTYPE html>을 추가하세요." },
    ),
  ]);
  const faviconLinks = $("link")
    .toArray()
    .filter((e) =>
      /^(shortcut icon|icon|apple-touch-icon|apple-touch-icon-precomposed)$/i.test(
        $(e).attr("rel") || "",
      ),
    );
  const iconResults = s.icons || (faviconLinks.length ? [] : [s.favicon]);
  const favicon =
    faviconLinks.some(
      (e) =>
        !!webUrl($(e).attr("href"), s.finalUrl) ||
        /^data:image\/[\w.+-]+(?:;[^,]*)?,.+/i.test($(e).attr("href") || ""),
    ) ||
    iconResults.some(
      (r) =>
        r.status >= 200 &&
        r.status < 300 &&
        /^image\//i.test(r.headers["content-type"] || ""),
    );
  const uncheckedIcon =
    faviconLinks.some((e) => !!webUrl($(e).attr("href"), s.finalUrl)) &&
    !iconResults.length;
  // A robots.txt-discovered alternate is useful information, but outside the
  // reference's root /sitemap.xml check (also applies to saved v5 snapshots).
  const rootSitemap =
    new URL(s.sitemap.requestedUrl || s.sitemap.url).pathname ===
    "/sitemap.xml";
  const xml = rootSitemap ? s.sitemap.body.trim() : "";
  const sitemapInfo = inspectSitemap(xml);
  const sitemapFound =
    s.sitemap.status >= 200 && s.sitemap.status < 300 && sitemapInfo.exists;
  const sitemapValid = sitemapFound && sitemapInfo.valid;
  const locCount = sitemapInfo.count;
  const robotsFound =
    s.robots.status >= 200 &&
    s.robots.status < 300 &&
    !/<html|<!doctype\s+html/i.test(s.robots.body);
  const access = robotsAccess(s.robots.body, s.finalUrl);
  const headerDirectives = googleHeaderDirectives(
    s.headers["x-robots-tag"] || "",
  );
  const indexing = [
    ...meta("robots"),
    ...meta("googlebot"),
    ...headerDirectives,
  ];
  const noindex = indexing.some((v) =>
    /(?:^|[\s,:])(noindex|none)(?:$|[\s,])/i.test(v),
  );
  const ogNames = [
    "og:title",
    "og:description",
    "og:image",
    "og:url",
    "og:type",
    "og:site_name",
  ];
  const ogFound = ogNames.filter((n) =>
    metas.some((e) => ($(e).attr("property") || "").toLowerCase() === n),
  );
  const resourceCheck = (c: Check, error?: string) =>
    error
      ? {
          ...c,
          detail: `수집 실패: ${error}`,
          confidence: "implementation" as const,
          status: "error" as const,
          applicable: false,
          points: 0,
          fix: undefined,
        }
      : c;
  const search = category("search_engine", "검색엔진 친화도", 20, [
    resourceCheck(
      check(
        "favicon",
        "파비콘 연결 확인",
        2,
        favicon ? 2 : 0,
        favicon
          ? "아이콘 링크 선언 또는 이미지 응답을 확인했습니다."
          : "유효한 아이콘 이미지 응답을 확인하지 못했습니다.",
        {
          evidence: [
            ...faviconLinks.slice(0, 3).map((e) => $.html(e)),
            ...iconResults.map(
              (r) =>
                `${r.url}: ${r.error || `HTTP ${r.status} ${r.headers["content-type"] || ""}`}`,
            ),
          ].join("\n"),
          evidenceNote:
            "아이콘 링크가 있으면 기본 점수를 부여합니다. 응답 확인 결과는 참고이며 그림 내용의 적절성은 검사하지 않습니다.",
          fix: "사이트 아이콘을 연결하세요.",
        },
      ),
      !favicon
        ? iconResults.find((r) => r.error)?.error ||
            (uncheckedIcon
              ? "저장된 결과에 아이콘 응답이 없습니다. 새로 진단해 주세요."
              : undefined)
        : undefined,
    ),
    resourceCheck(
      check(
        "sitemap_exists",
        "sitemap.xml 존재",
        4,
        sitemapFound ? 4 : 0,
        sitemapFound
          ? s.sitemap.url
          : "유효한 사이트맵 파일을 찾지 못했습니다.",
        { fix: "사이트맵을 생성하고 공개하세요." },
      ),
      s.sitemap.error,
    ),
    resourceCheck(
      check(
        "sitemap_valid",
        "사이트맵 URL 기본 형식",
        4,
        sitemapValid ? 4 : 0,
        sitemapValid
          ? `${locCount}개 위치 · lastmod ${/<lastmod/i.test(xml) ? "포함" : "없음 (권장)"}`
          : sitemapInfo.issues.slice(0, 5).join(" ") ||
              "사이트맵 응답을 확인하세요.",
        {
          evidence: xml.slice(0, 2000),
          fix: "사이트맵 XML과 URL 목록을 올바르게 작성하세요.",
        },
      ),
      s.sitemap.error,
    ),
    resourceCheck(
      check(
        "robots_exists",
        "robots.txt 존재",
        2,
        robotsFound ? 2 : 0,
        robotsFound ? s.robots.url : "robots.txt를 찾지 못했습니다.",
        { fix: "사이트 루트에 robots.txt를 추가하세요." },
      ),
      s.robots.error,
    ),
    resourceCheck(
      check(
        "robots_valid",
        "현재 페이지 크롤링·색인 지시",
        2,
        robotsFound && access.valid && access.allowed && !noindex ? 2 : 0,
        `${access.valid ? `Googlebot 경로 규칙: ${access.allowed ? "허용" : "차단"}${access.matched ? ` (${access.matched})` : ""}` : "유효한 User-agent 그룹을 확인하지 못했습니다."} · noindex/none ${noindex ? "발견" : "미발견"} · 실제 색인 여부는 검사하지 않습니다.`,
        {
          evidence: `${s.robots.body.slice(0, 2000)}\n색인 지시: ${indexing.filter(Boolean).join(" | ") || "(없음)"}`,
          fix: "검색 노출을 원한다면 현재 페이지의 차단 규칙과 noindex 지시를 확인하세요.",
          evidenceNote:
            "robots.txt 앞 2,000자. Googlebot 및 * 그룹의 경로 규칙과 기본 noindex 지시 검사입니다.",
        },
      ),
      s.robots.error,
    ),
    check(
      "og_tags",
      "Open Graph 기본 값",
      6,
      ogFound.length,
      `${ogFound.length}/6개 · ${ogNames.filter((n) => !ogFound.includes(n)).join(", ") || "모두 작성됨"}`,
      {
        evidence: ogNames
          .map(
            (n) =>
              `${n}: ${ogFound.includes(n) ? meta(n, "property")[0] || "(빈 값)" : "(태그 없음)"}`,
          )
          .join("\n"),
        fix: "meta property 속성으로 OG 정보를 작성하세요.",
        evidenceNote:
          "property로 선언된 태그의 존재를 채점합니다. 빈 값·내용·URL 적합성과 이미지 응답은 별도 확인이 필요합니다.",
        confidence: "inferred",
      },
    ),
  ]);
  const rasterImages = images.filter(
    (e) => !/\.svg(?:[?#]|$)|^data:image\/svg/i.test($(e).attr("src") || ""),
  );
  const webp = rasterImages.filter((e) =>
    [
      $(e).attr("src") || "",
      $(e).attr("srcset") || "",
      ...$(e)
        .parent("picture")
        .find("source")
        .toArray()
        .map((x) => $(x).attr("srcset") || ""),
    ].some((v) =>
      /(?:^|[\s,])[^\s,]+\.(?:webp|avif)(?:[?#][^\s,]*)?(?:\s|,|$)|^data:image\/(?:webp|avif)[,;]/i.test(
        v,
      ),
    ),
  );
  const lazy = images.filter(
    (e) => ($(e).attr("loading") || "").toLowerCase() === "lazy",
  );
  const hints = $("link")
    .toArray()
    .filter(
      (e) =>
        /^(preload|preconnect)$/i.test($(e).attr("rel")?.trim() || "") &&
        !!webUrl($(e).attr("href"), s.finalUrl) &&
        (($(e).attr("rel") || "").toLowerCase() !== "preload" ||
          /^(audio|document|embed|fetch|font|image|object|script|style|track|video|worker)$/.test(
            $(e).attr("as") || "",
          )),
    );
  const compression = (s.headers["content-encoding"] || "")
    .toLowerCase()
    .split(",")
    .every((v) => ["gzip", "br", "deflate", "zstd"].includes(v.trim()));
  const speed = category("speed", "속도 최적화", 10, [
    rasterImages.length
      ? check(
          "webp_usage",
          "WebP 이미지 사용",
          4,
          webp.length
            ? Math.max(1, Math.round((webp.length / rasterImages.length) * 4))
            : 0,
          `${rasterImages.length}개 이미지 중 ${webp.length}개 WebP·AVIF 사용 (SVG 제외)`,
          {
            confidence: "inferred",
            fix: "이미지를 WebP 또는 AVIF로 제공하세요.",
          },
        )
      : na(
          "webp_usage",
          "WebP·AVIF 이미지",
          4,
          "평가할 래스터 이미지가 없습니다.",
        ),
    check(
      "http_compression",
      "HTTP 압축",
      4,
      compression ? 4 : 0,
      `Content-Encoding: ${s.headers["content-encoding"] || "(없음)"}`,
      { fix: "서버에 gzip 또는 Brotli 압축을 적용하세요." },
    ),
    images.length
      ? check(
          "lazy_loading",
          "이미지 지연 로딩 (lazy loading)",
          1,
          lazy.length ? 1 : 0,
          `${images.length}개 이미지 중 ${lazy.length}개에 loading="lazy" 적용`,
          {
            fix: '화면 아래 이미지에 loading="lazy"를 적용하세요.',
            confidence: "inferred",
          },
        )
      : na("lazy_loading", "이미지 지연 로딩", 1, "이미지가 없습니다."),
    check(
      "resource_hints",
      "리소스 힌트 (preload/preconnect)",
      1,
      hints.length ? 1 : 0,
      `유효한 preload·preconnect 등 리소스 힌트 ${hints.length}개`,
      {
        fix: "중요 리소스의 preconnect 또는 preload를 설정하세요.",
        confidence: "inferred",
      },
    ),
  ]);
  const h = s.headers;
  const securityRule = (
    id: string,
    label: string,
    pass: boolean,
    detail: string,
    fix: string,
    failureStatus: "fail" | "warning" = "warning",
  ) =>
    check(id, label, 0, 0, detail, {
      status: pass ? "pass" : failureStatus,
      applicable: false,
      fix,
      confidence: "implementation",
    });
  const hstsAges = (h["strict-transport-security"] || "")
    .split(";")
    .map((v) => v.trim())
    .filter((v) => /^max-age\s*=/i.test(v));
  const policies = (h["referrer-policy"] || "")
    .toLowerCase()
    .split(",")
    .map((v) => v.trim())
    .filter((v) =>
      [
        "no-referrer",
        "no-referrer-when-downgrade",
        "origin",
        "origin-when-cross-origin",
        "same-origin",
        "strict-origin",
        "strict-origin-when-cross-origin",
        "unsafe-url",
      ].includes(v),
    );
  const policy = policies.at(-1);
  const csp = (h["content-security-policy"] || "")
    .match(/(?:^|;)\s*frame-ancestors\s+([^;]+)/i)?.[1]
    ?.trim();
  const security = [
    securityRule(
      "server_header",
      "웹서버 정보 노출",
      !(h.server || "").trim(),
      (h.server || "").trim()
        ? `Server: ${h.server?.trim()} · 응답에 서버 또는 프록시 식별 정보가 포함되어 있습니다. 원본 서버 종류나 취약점의 존재를 확정하는 검사는 아닙니다.`
        : "Server 헤더에 공개된 식별 정보가 없습니다.",
      "서버·프록시 설정에서 불필요한 Server 헤더 정보 공개를 줄일 수 있는지 확인하세요.",
      "warning",
    ),
    securityRule(
      "framework_disclosure",
      "프레임워크 정보 노출",
      !h["x-powered-by"]?.trim() && !h["x-aspnet-version"]?.trim(),
      `X-Powered-By: ${h["x-powered-by"]?.trim() || "(없음)"}\nX-AspNet-Version: ${h["x-aspnet-version"]?.trim() || "(없음)"}`,
      "프레임워크 버전 응답 헤더를 숨기세요.",
      "warning",
    ),
    csp && !/^(DENY|SAMEORIGIN)$/i.test(h["x-frame-options"]?.trim() || "")
      ? check(
          "x_frame_options",
          "프레임 포함 제한",
          0,
          0,
          `X-Frame-Options: ${h["x-frame-options"] || "(없음)"}\nCSP frame-ancestors: ${csp}\n대체 정책이 선언되어 있습니다. 허용 대상과 전체 정책의 적용 여부를 확인하세요.`,
          { status: "info", applicable: false, confidence: "implementation" },
        )
      : securityRule(
          "x_frame_options",
          "프레임 포함 제한",
          /^(DENY|SAMEORIGIN)$/i.test(h["x-frame-options"]?.trim() || ""),
          h["x-frame-options"] || "헤더가 없습니다.",
          "페이지 용도에 맞는 CSP frame-ancestors 또는 X-Frame-Options를 검토하세요.",
        ),
    securityRule(
      "x_content_type_options",
      "X-Content-Type-Options",
      h["x-content-type-options"]?.trim().toLowerCase() === "nosniff",
      h["x-content-type-options"] || "헤더가 없습니다.",
      "X-Content-Type-Options: nosniff",
    ),
    securityRule(
      "hsts",
      "HSTS",
      https &&
        hstsAges.length === 1 &&
        /^max-age\s*=\s*\d+$/i.test(hstsAges[0] || "") &&
        Number(hstsAges[0]!.split("=")[1]) > 0,
      `${h["strict-transport-security"] || "(헤더 없음)"}${!https ? " · HTTP 응답의 HSTS는 적용되지 않습니다." : ""}`,
      "HTTPS 응답의 양의 정수 max-age를 확인하세요. includeSubDomains는 모든 하위 도메인의 HTTPS 준비 후 검토하세요.",
    ),
    securityRule(
      "referrer_policy",
      "Referrer-Policy",
      /^(no-referrer|same-origin|strict-origin|strict-origin-when-cross-origin)$/i.test(
        policy || "",
      ),
      `${h["referrer-policy"] || "(헤더 없음)"}\n마지막으로 인식되는 정책: ${policy || "(없음)"}`,
      "Referrer-Policy: strict-origin-when-cross-origin",
    ),
  ];
  const categories = [content, technical, search, speed];
  for (const c of categories)
    for (const item of c.checks) {
      if (item.evidence && !item.evidenceNote)
        item.evidenceNote =
          "파싱된 HTML의 일부입니다. 일반 요소 최대 5개, 문제 이미지 3개, 제목 60개, XML 2,000자까지 표시합니다.";
    }
  return finish(
    "seo",
    s,
    title,
    categories.map((c) =>
      category(c.id, c.label, c.nominalMaxPoints, c.checks),
    ),
    {
      security,
      supplementary: [deliveryChecks(s), urlChecks(s), contentChecks(s)],
      partial: categories.some((c) =>
        c.checks.some((i) => i.status === "error"),
      ),
    },
  );
}
