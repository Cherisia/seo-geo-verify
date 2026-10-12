import { load } from "cheerio";
import { category, check, na, unknown } from "./shared.js";
import { robotsAccess, webUrl, googleHeaderDirectives } from "./validation.js";
import type { Check, CrawlSnapshot, Profile } from "./types.js";

const mb = (n: number) => `${(n / 1_000_000).toFixed(2)} MB`;
const contentUnavailable = (s: CrawlSnapshot) =>
  s.renderStatus !== "succeeded" || !!s.renderIncomplete;
export function deliveryChecks(s: CrawlSnapshot) {
  const b = s.browser;
  const absent = (id: string, label: string, max: number) =>
    unknown(
      check(id, label, max, 0, "관찰 데이터 없음"),
      "브라우저 관찰을 다시 실행해야 합니다.",
    );
  if (!b)
    return category("delivery", "리소스·화면 안정성", 20, [
      absent("resource_budget", "리소스 용량", 8),
      absent("layout_stability", "관찰 구간 화면 안정성", 6),
      absent("static_cache", "정적 리소스 캐시", 6),
      check(
        "observed_lcp",
        "관찰 구간 LCP · 참고",
        0,
        0,
        "측정 자료가 없습니다. 다시 진단해 주세요.",
        { status: "info", applicable: false },
      ),
    ]);
  const resources = b.resources.filter(
    (r) => r.status >= 200 && r.status < 300,
  );
  const sized = resources.filter((r) => r.bytes !== undefined);
  const bytes = sized.reduce((n, r) => n + (r.bytes || 0), 0);
  const incomplete =
    b.resources.some((r) => r.bytes === undefined || r.status === 0) ||
    b.resourceLimitReached;
  let budget = check(
    "resource_budget",
    "리소스 용량",
    8,
    bytes <= 2_000_000 ? 8 : bytes <= 5_000_000 ? 4 : 0,
    `응답·헤더에서 확인한 리소스 합계 ${mb(bytes)} · ${sized.length}/${b.resources.length}개 크기 확인. 실제 전송량과 다를 수 있는 파일 크기 합계이며 미디어는 본문 대신 Content-Length를 사용합니다. 자체 예산: 2 MB 이하 / 5 MB 이하 / 초과.`,
    {
      evidence: [...sized]
        .sort((a, b) => (b.bytes || 0) - (a.bytes || 0))
        .slice(0, 12)
        .map(
          (r) =>
            `${r.url}\n${mb(r.bytes || 0)} · ${r.sizeSource === "header" ? "HEAD 헤더" : "수집 응답"}${r.skipped ? " · 본문 생략" : ""}`,
        )
        .join("\n"),
      fix: "큰 동영상·이미지를 압축하고 화면 진입 또는 사용자 요청 시 로드하세요.",
      confidence: "inferred",
    },
  );
  if (incomplete && bytes <= 5_000_000)
    budget = unknown(
      budget,
      "확인하지 못한 리소스가 있어 전체 용량 등급을 확정하지 않습니다.",
    );
  const limited =
    b.resourceFailures.length > 0 ||
    b.contentFailures.length > 0 ||
    b.omittedMedia.length > 0 ||
    b.resourceLimitReached;
  let layout =
    b.cls === undefined
      ? absent("layout_stability", "관찰 구간 화면 안정성", 6)
      : check(
          "layout_stability",
          "관찰 구간 화면 안정성",
          6,
          b.cls <= 0.1 ? 6 : b.cls <= 0.25 ? 3 : 0,
          `CLS ${b.cls.toFixed(3)} · 사용자 입력 없는 세션 창의 최대 이동량. ${Math.round(b.observedMs / 1000)}초 관찰이며 실제 방문자 28일 데이터가 아닙니다.`,
          {
            fix: "이미지·영상 영역을 미리 확보하고 레이아웃을 움직이는 초기 애니메이션을 확인하세요.",
            confidence: "inferred",
          },
        );
  if (limited && layout.status === "pass")
    layout = unknown(
      layout,
      "일부 리소스를 생략하거나 수집하지 못해 화면 안정성 통과를 확정하지 않습니다.",
    );
  const staticFiles = resources.filter((r) =>
    ["image", "media", "font", "stylesheet", "script"].includes(r.kind),
  );
  const cacheFailures = staticFiles.filter(
    (r) => (r.cacheMaxAge || 0) < 86400 && (r.bytes || 0) >= 100_000,
  );
  let cache = staticFiles.length
    ? check(
        "static_cache",
        "대용량 정적 리소스 캐시",
        6,
        cacheFailures.length ? 0 : 6,
        `확인한 정적 파일 ${staticFiles.length}개 중 100 KB 이상이며 max-age 1일 미만인 파일 ${cacheFailures.length}개. 개인화·변경 주기를 고려할 자체 권고입니다.`,
        {
          evidence: cacheFailures
            .slice(0, 8)
            .map((r) => `${r.url}: max-age ${r.cacheMaxAge ?? "없음"}`)
            .join("\n"),
          fix: "공개 정적 파일은 버전이 바뀌면 URL도 바꾸고 적절한 캐시 수명을 설정하세요.",
          confidence: "inferred",
        },
      )
    : na(
        "static_cache",
        "대용량 정적 리소스 캐시",
        6,
        "관찰된 정적 파일이 없습니다.",
      );
  if (incomplete && !cacheFailures.length)
    cache = unknown(cache, "정적 리소스 일부의 응답을 확인하지 못했습니다.");
  const lcp = check(
    "observed_lcp",
    "관찰 구간 LCP · 참고",
    0,
    0,
    `${b.lcpMs === undefined ? "측정되지 않음" : `${(b.lcpMs / 1000).toFixed(2)}초`} · 화면 ${b.viewport.width}×${b.viewport.height}, 격리 프록시 경유, 네트워크·CPU 감속 없음. 미디어 ${b.omittedMedia.length}건 본문 생략. Lighthouse 및 실제 방문자 Core Web Vitals와 비교 가능한 종합 성능 점수가 아닙니다.`,
    { status: "info", applicable: false },
  );
  return category("delivery", "리소스·화면 안정성", 20, [
    budget,
    layout,
    cache,
    lcp,
  ]);
}

export function urlChecks(s: CrawlSnapshot) {
  const probes = s.urlVariants;
  const final = new URL(s.finalUrl);
  const http = probes?.find((p) => {
    const u = new URL(p.inputUrl);
    return u.protocol === "http:" && u.hostname === final.hostname;
  });
  const successful = (p: NonNullable<typeof http>) =>
    !!p.finalUrl && p.status! >= 200 && p.status! < 300;
  const permanent = (p: NonNullable<typeof http>) =>
    successful(p) &&
    p.finalUrl === s.finalUrl &&
    !!p.redirects?.length &&
    p.redirects.every((r) => [301, 308].includes(r.status));
  let https = check(
    "https_redirect",
    "HTTP → 대표 HTTPS 주소",
    6,
    final.protocol === "https:" && http && permanent(http) ? 6 : 0,
    http
      ? `${http.inputUrl} → ${http.finalUrl || http.error} · HTTP ${http.status ?? "미확인"}`
      : "HTTP 변형 주소 검사 자료가 없습니다.",
    {
      evidence: JSON.stringify(http?.redirects || [], null, 2),
      fix: "HTTP 주소를 대표 HTTPS 주소로 301 또는 308 리디렉션하세요.",
    },
  );
  if (!http || http.error || [405, 501].includes(http.status || 0))
    https = unknown(https, "HTTP 주소의 응답을 확인하지 못했습니다.");
  const alt =
    probes?.filter((p) => new URL(p.inputUrl).hostname !== final.hostname) ||
    [];
  const live = alt.filter(successful);
  let host: Check = live.length
    ? check(
        "host_consolidation",
        "www 대표 주소 통일",
        4,
        live.every(permanent) ? 4 : 0,
        `접근 가능한 대체 주소 ${live.length}개 중 대표 주소로 영구 이동 ${live.filter(permanent).length}개. canonical과 함께 검토하는 권고이며 중복 주소 자체를 검색 패널티로 판단하지 않습니다.`,
        {
          evidence: live
            .map((p) => `${p.inputUrl} → ${p.finalUrl} (${p.status})`)
            .join("\n"),
          fix: "사용하지 않는 www 변형 주소를 대표 주소로 영구 리디렉션하세요.",
          confidence: "inferred",
          status: live.every(permanent) ? "pass" : "warning",
        },
      )
    : na(
        "host_consolidation",
        "www 대표 주소 통일",
        4,
        "접근 가능한 www 변형 주소가 없습니다. 별도 호스트 생성은 필수가 아닙니다.",
      );
  // DNS absence is a legitimate unconfigured alias; other failures are not proof of absence.
  if (
    !probes ||
    alt.some((p) => p.error && !/도메인에 연결할 수 없습니다/.test(p.error)) ||
    alt.some((p) => [405, 501].includes(p.status || 0))
  )
    host = unknown(host, "대체 주소의 상태를 확정할 수 없습니다.");
  return category("discovery", "대표 주소", 10, [https, host]);
}

export function pageSignals(s: CrawlSnapshot) {
  const $ = load(s.renderedHtml || s.html);
  $(
    "script,style,noscript,template,nav,header,footer,[hidden],[aria-hidden=true]",
  ).remove();
  const text = $("body").text().replace(/\s+/g, " ").trim();
  const headings = $("h1,h2,h3")
    .toArray()
    .map((e) => $(e).text().trim());
  const service =
    /서비스|솔루션|software|service|solution|플랫폼|확장 프로그램/i.test(
      headings.join(" ") + " " + text.slice(0, 500),
    );
  const action =
    /무료|체험|문의|상담|구독|요금|설치|download|pricing|trial|contact/i.test(
      text,
    );
  return { $, text, headings, service: service && action };
}

export function contentChecks(s: CrawlSnapshot, profiles: Profile[] = []) {
  const { $, text, headings, service } = pageSignals(s);
  const paragraphs = $("p,li,dd")
    .toArray()
    .map((e) => $(e).text().replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 60);
  const commercial =
    service || profiles.includes("service") || profiles.includes("commerce");
  const docs = $("a[href]")
    .toArray()
    .map((e) => ({
      text: $(e).text().trim(),
      url: webUrl($(e).attr("href"), s.finalUrl),
    }))
    .filter(
      (a) =>
        a.url &&
        !a.url.startsWith(s.finalUrl.split("#")[0] + "#") &&
        a.url !== s.finalUrl &&
        !/privacy|terms|policy|개인정보|이용약관/i.test(a.url + " " + a.text),
    );
  const found = docs.map((a) =>
    s.linkedPages?.find(
      (p) => (p.requestedUrl || p.url) === a.url?.split("#")[0],
    ),
  );
  const accessible = found.filter(
    (p) =>
      p &&
      p.status >= 200 &&
      p.status < 300 &&
      /text\/html|application\/xhtml/i.test(p.headers["content-type"] || "") &&
      load(p.body)("body").text().trim().length > 0,
  );
  const checks = [
    check(
      "readable_content",
      "읽을 수 있는 본문",
      8,
      text.length >= 300 ? 8 : text.length >= 100 ? 4 : 0,
      `메뉴·푸터·스크립트 등을 제외한 본문 ${text.length}자. 자체 최소 정보량 기준이며 정확성·독창성·품질을 판정하지 않습니다.`,
      {
        evidence: text.slice(0, 600),
        fix: "서비스 대상·제공 범위·사용 방법을 사용자가 읽을 수 있는 본문으로 설명하세요.",
        confidence: "inferred",
      },
    ),
    check(
      "explanatory_sections",
      "제목과 설명 문단",
      6,
      headings.length >= 2 && paragraphs.length >= 2
        ? 6
        : paragraphs.length
          ? 3
          : 0,
      `제목 ${headings.length}개 · 60자 이상 설명 문단 ${paragraphs.length}개. 문단의 내용 타당성이나 AI 인용 가능성을 보증하지 않는 구성 검사입니다.`,
      {
        evidence: headings.slice(0, 12).join("\n"),
        fix: "주요 질문·기능마다 제목과 구체적인 설명을 작성하세요.",
        confidence: "inferred",
      },
    ),
    commercial
      ? check(
          "service_documents",
          "상세 문서·서비스로 연결",
          6,
          accessible.length ? 6 : 0,
          `앵커·약관 외 웹 링크 ${docs.length}개 · 표본에서 본문이 있는 HTML 문서 접근 확인 ${accessible.length}개. 링크의 공식성·내용 적합성·서비스 품질은 별도 확인이 필요합니다.`,
          {
            evidence: docs
              .slice(0, 8)
              .map((a) => `${a.text}: ${a.url}`)
              .join("\n"),
            fix: "실제로 열리는 서비스, 사용 안내, 요금·조건 또는 사례 문서로 연결하세요.",
            confidence: "inferred",
            status: accessible.length ? "pass" : "warning",
          },
        )
      : na(
          "service_documents",
          "상세 문서·서비스로 연결",
          6,
          "서비스·상품 소개로 확인되지 않아 평가하지 않습니다.",
        ),
  ];
  if (
    commercial &&
    docs.length &&
    !accessible.length &&
    found.some((p) => !p || p.error || [401, 403, 429].includes(p.status))
  ) {
    const item = checks.find((c) => c.id === "service_documents")!;
    Object.assign(
      item,
      unknown(
        item,
        "연결 문서의 표본 수집만으로 접근 가능한 상세 문서 존재를 확정할 수 없습니다.",
      ),
    );
  }
  if (contentUnavailable(s))
    for (const item of checks)
      if (item.applicable)
        Object.assign(
          item,
          unknown(
            item,
            "본문 수집이 완료되지 않아 콘텐츠 구성을 확정하지 않습니다.",
          ),
        );
  const pages = s.linkedPages;
  const broken =
    pages?.filter(
      (r) => r.status >= 400 && ![401, 403, 429].includes(r.status),
    ) || [];
  const inaccessible =
    pages?.filter((r) => r.error || [401, 403, 429].includes(r.status)) || [];
  checks.push(
    check(
      "linked_documents",
      "연결 문서 응답 · 참고",
      0,
      0,
      pages
        ? `연결 문서 ${pages.length}개 표본: 오류 응답 ${broken.length}개, 확인 불가 ${inaccessible.length}개. 전체 링크 검사가 아닙니다.`
        : "연결 문서 수집 자료가 없습니다.",
      {
        status: broken.length ? "warning" : "info",
        applicable: false,
        evidence: pages
          ?.map((p) => `${p.url}: ${p.error || `HTTP ${p.status}`}`)
          .join("\n"),
        fix: "오류 응답을 반환하는 문서 링크를 수정하세요.",
      },
    ),
  );
  checks.push(
    check(
      "answer_evidence",
      "사용 조건·근거 자료 · 수동 확인",
      0,
      0,
      "대상 사용자, 사용 절차, 비용·조건, 측정 방법, 출처가 있는 사례를 확인하세요. 관련 단어의 등장만으로 신뢰성이나 AI 인용 가능성을 자동 통과시키지 않습니다. FAQ 형식은 필수가 아닙니다.",
      { status: "info", applicable: false, confidence: "inferred" },
    ),
  );
  return category("content_readiness", "본문·문서 연결", 20, checks);
}

export function geoAccess(s: CrawlSnapshot) {
  const $ = load(s.renderedHtml || s.html);
  const directives = [
    ...googleHeaderDirectives(s.headers["x-robots-tag"] || ""),
    ...$("meta[name]")
      .toArray()
      .filter((e) =>
        ["robots", "googlebot"].includes(
          ($(e).attr("name") || "").toLowerCase(),
        ),
      )
      .map((e) => $(e).attr("content") || ""),
  ].join(" ");
  const access = robotsAccess(s.robots.body, s.finalUrl);
  const snippetRestricted =
    /\b(noindex|none|nosnippet)\b|\bmax-snippet\s*:\s*0\b/i.test(directives);
  const blocked =
    snippetRestricted || (s.robots.status === 200 && !access.allowed);
  let item = check(
    "search_access",
    "검색 크롤링·스니펫 지시",
    6,
    blocked ? 0 : 6,
    `Googlebot 경로 ${access.allowed ? "허용" : "차단"} · 색인·스니펫 제한 ${snippetRestricted ? "발견" : "미발견"}. 실제 색인과 AI 인용은 측정하지 않습니다. robots.txt 404는 기본 허용으로 처리합니다.`,
    {
      evidence: `${s.robots.body.slice(0, 1500)}\n${directives}`,
      fix: "공개 검색 노출을 원한다면 크롤링·색인·스니펫 제한 의도를 확인하세요.",
    },
  );
  if (
    s.robots.error ||
    ![200, 404, 410].includes(s.robots.status) ||
    contentUnavailable(s)
  )
    item = unknown(item, "접근 지시의 수집 상태를 확인해야 합니다.");
  return category("access", "검색 접근성", 6, [item]);
}
