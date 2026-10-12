import { load } from "cheerio";
import { category, check, finish, na, unknown } from "./shared.js";
import { contentChecks, geoAccess } from "./extended.js";
import {
  expectedGroups,
  profileOrder,
  schemaRegistry,
  scoredTypes,
  type SchemaDefinition,
} from "./schema.js";
import type {
  Check,
  CrawlSnapshot,
  EntitySummary,
  JsonLdBlock,
  Profile,
} from "./types.js";

import {
  extractJsonLd,
  fingerprint,
  ancestors,
  isType,
  type Entity,
} from "./jsonld.js";
import { externalLinks, identifier, propertyValid } from "./geo-values.js";
import { percentage } from "./validation.js";
import {
  scoringSnapshot,
  incompleteStructuredDataCollection,
  isHomepage,
} from "./collection.js";
export { extractJsonLd } from "./jsonld.js";
const mean = (xs: number[]) =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
export async function analyzeGeo(
  s: CrawlSnapshot,
  selected?: Profile[],
  registry: Record<string, SchemaDefinition> = schemaRegistry,
) {
  s = scoringSnapshot(s);
  const raw = await extractJsonLd(s.html, "server", s.finalUrl),
    rendered = s.renderedHtml
      ? await extractJsonLd(s.renderedHtml, "rendered", s.finalUrl)
      : undefined;
  const extracted = rendered?.blocks.length ? rendered : raw;
  const serverKeys = new Set(raw.blocks.map((b) => fingerprint(b.raw)));
  const selectedKeys = new Set(extracted.blocks.map((b) => fingerprint(b.raw)));
  const blocks: JsonLdBlock[] = extracted.blocks.map((b) => ({
    ...b,
    observedIn:
      rendered?.blocks.length && serverKeys.has(fingerprint(b.raw))
        ? ("both" as const)
        : b.source,
    source: serverKeys.has(fingerprint(b.raw)) ? ("server" as const) : b.source,
  }));
  if (extracted !== raw)
    blocks.push(
      ...raw.blocks
        .filter((b) => !selectedKeys.has(fingerprint(b.raw)))
        .map((b) => ({ ...b, analyzed: false })),
    );
  blocks.forEach((b, i) => (b.index = i + 1));
  const activeBlocks = blocks.filter((b) => b.analyzed !== false);
  const uncertain =
    activeBlocks.some((b) => b.validation === "unsupported") ||
    incompleteStructuredDataCollection(s, activeBlocks.length > 0);
  const nodes = extracted.nodes;
  const byType = new Map<string, Entity[]>();
  extracted.entities.forEach(({ type, value }) => {
    const objects = byType.get(type);
    if (objects) objects.push(value);
    else byType.set(type, [value]);
  });
  const has = (...ts: string[]) =>
    [...byType.keys()].some((t) => ts.some((parent) => isType(t, parent)));
  const detectedProfiles: Profile[] = [];
  if (has("Organization")) detectedProfiles.push("corporate");
  if (has("Service")) detectedProfiles.push("service");
  if (has("Product")) detectedProfiles.push("commerce");
  if (has("Article", "BlogPosting", "NewsArticle"))
    detectedProfiles.push("article");
  if (has("LocalBusiness")) detectedProfiles.push("local");
  if (has("FAQPage", "QAPage")) detectedProfiles.push("faq");
  const profileEvidence = detectedProfiles.map(
    (p) => `${p}: 구조화 데이터에서 발견`,
  );
  const profiles =
    selected === undefined
      ? detectedProfiles
      : profileOrder.filter((p) => selected.includes(p));
  const groups = profiles.flatMap((p) => expectedGroups[p]);
  const eligibleTypes = scoredTypes(profiles);
  const root = isHomepage(s);
  const publisherTypes = ["Organization", "LocalBusiness"];
  const publishers = [...byType.entries()]
    .filter(([t]) => publisherTypes.some((p) => isType(t, p)))
    .flatMap(([, objects]) => objects);
  const base: Check[] = [
    check(
      "jsonld_exists",
      "JSON-LD 구조화 데이터 존재",
      5,
      blocks.length ? 5 : 0,
      `채점 기준: ${extracted === raw ? "서버 HTML" : "렌더링 HTML"} · ${activeBlocks.length}개 블록. 서버에만 남은 블록도 아래 원문에 보존합니다.`,
      { fix: "JSON-LD 구조화 데이터를 페이지에 추가하세요." },
    ),
    blocks.length
      ? check(
          "jsonld_valid",
          "JSON-LD 구문·문맥 해석",
          5,
          activeBlocks.every((b) => b.valid) ? 5 : 0,
          `${activeBlocks.filter((b) => b.valid).length}/${activeBlocks.length}개 블록 JSON-LD 해석 완료 · 속성의 기본 형식은 아래 자체 기준으로 별도 검사합니다.`,
          {
            evidence: blocks
              .filter((b) => !b.valid)
              .map((b) => `블록 ${b.index}: ${b.error}`)
              .join("\n"),
            fix: "JSON-LD의 구문 오류를 수정하세요.",
          },
        )
      : na(
          "jsonld_valid",
          "JSON-LD 문법 유효",
          5,
          "JSON-LD가 없어 평가하지 않습니다.",
        ),
    blocks.length
      ? check(
          "jsonld_ssr",
          "구조화 데이터 서버 렌더링",
          6,
          activeBlocks.every((b) => b.source === "server") ? 6 : 0,
          activeBlocks.every((b) => b.source === "server")
            ? "채점 블록 모두 서버 HTML에서도 확인했습니다."
            : raw.blocks.length
              ? "서버에도 블록이 있으나 렌더링 후 추가·변경이 있습니다. 블록별 출처를 확인하세요."
              : "서버 HTML에는 없고 렌더링 후에 발견했습니다.",
          {
            fix: "구조화 데이터를 서버 HTML에 포함하세요.",
            confidence: "inferred",
          },
        )
      : na(
          "jsonld_ssr",
          "구조화 데이터 서버 렌더링",
          6,
          "JSON-LD가 없어 평가하지 않습니다.",
        ),
    check(
      "publisher_exists",
      "발행 주체 선언",
      10,
      publishers.length ? 10 : 0,
      publishers.length
        ? `발행 주체 ${publishers.length}개 발견`
        : "채점한 HTML에서 Organization·LocalBusiness 및 하위 타입을 확인하지 못했습니다.",
      { fix: "발행 주체 엔티티를 선언하세요." },
    ),
    check(
      "page_identity",
      "사이트·페이지 엔티티",
      5,
      has("WebSite", "WebPage") ? 5 : 0,
      has("WebSite", "WebPage")
        ? "WebSite 또는 WebPage 타입 선언을 발견했습니다. 현재 페이지와의 내용 일치는 별도 확인이 필요합니다."
        : "WebSite·WebPage가 없습니다.",
      { fix: "WebSite·WebPage 엔티티를 선언하세요." },
    ),
    root
      ? na(
          "breadcrumb",
          "이동경로",
          4,
          "루트 페이지는 이동경로 채점에서 제외합니다.",
        )
      : check(
          "breadcrumb",
          "이동경로",
          4,
          has("BreadcrumbList") ? 4 : 0,
          has("BreadcrumbList")
            ? "BreadcrumbList를 발견했습니다."
            : "이동경로 엔티티가 없습니다.",
          { fix: "BreadcrumbList를 추가하세요." },
        ),
  ];
  if (groups.length)
    groups.forEach((g, i) => {
      const max =
        Math.floor(20 / groups.length) + (i < 20 % groups.length ? 1 : 0);
      base.push(
        check(
          `expected_${g.id}`,
          `[선택 유형] ${g.label}`,
          max,
          has(...g.types) ? max : 0,
          `${g.types.join(" · ")} ${has(...g.types) ? "발견" : "없음"}`,
          { fix: `${g.label}를 추가하세요.`, confidence: "inferred" },
        ),
      );
    });
  else
    base.push(
      na(
        "expected_none",
        "선택 유형 기대 엔티티",
        20,
        "선택한 유형은 공통 기반으로 평가합니다.",
      ),
    );

  const exactRatios = new Map<string, number>();
  const entities: EntitySummary[] = [...byType.entries()].map(
    ([type, objects]) => {
      const criteriaType = ancestors(type).find((t) =>
        Object.hasOwn(registry, t),
      );
      const d = criteriaType ? registry[criteriaType] : undefined,
        missing: EntitySummary["missing"] = [];
      const coverage = (
        properties: string[],
        kind: "required" | "recommended",
      ) => {
        const valid = (o: Entity, p: string) =>
          p.split("|").some((key) => propertyValid(key, o[key], nodes));
        for (const p of properties) {
          const count = objects.filter((o) => !valid(o, p)).length;
          if (count)
            missing.push({
              property: p.replaceAll("|", " 또는 "),
              kind,
              count,
              examples: objects
                .filter((o) => !valid(o, p))
                .slice(0, 3)
                .map((o) => `${o["@id"]} → ${p}`),
            });
        }
        return properties.length
          ? mean(
              objects.map(
                (o) =>
                  properties.filter((p) => valid(o, p)).length /
                  properties.length,
              ),
            )
          : 1;
      };
      const required = d ? coverage(d.required, "required") : 0;
      const recommended = d ? coverage(d.recommended, "recommended") : 0;
      exactRatios.set(type, required);
      return {
        type,
        label: d?.label || type,
        count: objects.length,
        defined: !!d,
        criteriaType,
        scored: !!d && eligibleTypes.has(type),
        richResult: !!d?.rich,
        requiredCoverage: percentage(required),
        recommendedCoverage: percentage(recommended),
        missing,
        idCoverage: percentage(
          mean(objects.map((o) => (identifier(o["@id"]) ? 1 : 0))),
        ),
      };
    },
  );
  const scored = entities.filter((e) => e.scored),
    requiredRatio = mean(scored.map((e) => exactRatios.get(e.type) || 0));
  const requiredScore = Math.round(30 * requiredRatio);
  const requiredMissing = scored.flatMap((e) =>
    e.missing
      .filter((m) => m.kind === "required")
      .map(
        (m) =>
          `${e.type}.${m.property} (${m.count}/${e.count}개 누락 또는 형식 확인)`,
      ),
  );
  const b: Check[] = scored.length
    ? [
        check(
          "required_properties",
          "필수 속성 충족",
          30,
          requiredScore,
          `채점 대상 ${scored.length}개 타입의 필수 속성 평균 충족률 ${Math.round(requiredRatio * 100)}% · 30점 배점으로 반올림`,
          {
            evidence: requiredMissing.join("\n"),
            fix: "자체 기준에서 누락되었거나 기본 형식이 맞지 않는 속성을 확인하세요.",
            confidence: "inferred",
          },
        ),
        check(
          "recommended_properties",
          "자체 권장 속성 · 참고",
          0,
          0,
          `평균 충족률 ${Math.round(mean(scored.map((e) => e.recommendedCoverage)))}% · 점수에는 반영하지 않습니다.`,
          { status: "info", applicable: false, confidence: "inferred" },
        ),
      ]
    : [
        na(
          "required_properties",
          "필수 속성 충족",
          30,
          "채점 대상 엔티티가 없습니다.",
        ),
      ];
  // Service objects are not principal @id targets in observed reference results.
  const major = scored.filter(
    (e) => e.criteriaType && registry[e.criteriaType]?.major,
  );
  const idRatio = mean(
    major.map((e) =>
      mean(
        (byType.get(e.type) || []).map((o) => (identifier(o["@id"]) ? 1 : 0)),
      ),
    ),
  );
  const sameAs = [
    ...new Set(publishers.flatMap((p) => externalLinks(p.sameAs, s.finalUrl))),
  ];
  const c: Check[] = [
    major.length
      ? check(
          "id_coverage",
          "HTTP(S) @id 식별자",
          9,
          Math.round(9 * idRatio),
          `${major.length}개 주요 타입의 평균 부여율 ${percentage(idRatio)}%`,
          {
            evidence: major
              .map((e) => `${e.type}: ${e.idCoverage}%`)
              .join("\n"),
            fix: "주요 엔티티에 @id를 부여하세요.",
            confidence: "inferred",
          },
        )
      : na(
          "id_coverage",
          "@id 식별자 부여",
          9,
          "평가 대상 주요 타입이 없습니다.",
        ),
    publishers.length
      ? check(
          "same_as",
          "sameAs 외부 URL 형식",
          6,
          sameAs.length ? 6 : 0,
          `유효한 외부 URL ${sameAs.length}개 · 실제 접근 및 공식 프로필 여부는 별도 확인이 필요합니다.`,
          {
            evidence: sameAs.join("\n"),
            fix: "발행 주체를 sameAs로 외부 프로필과 연결하세요.",
            confidence: "inferred",
          },
        )
      : na(
          "same_as",
          "sameAs 외부 연결",
          6,
          "발행 주체가 없어 평가하지 않습니다.",
        ),
  ];
  const visible = load(s.renderedHtml || s.html);
  visible("script,style,template,noscript").remove();
  const normalizeName = (value: string) =>
    value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const bodyNames = normalizeName(
    visible("body").text() +
      " " +
      visible("img[alt]")
        .toArray()
        .map((e) => visible(e).attr("alt") || "")
        .join(" "),
  );
  const publisherNames = publishers.map((p) =>
    [p.name, p.alternateName]
      .flat(Infinity)
      .filter(
        (v): v is string =>
          typeof v === "string" && normalizeName(v).length >= 2,
      ),
  );
  const unmatched = publisherNames.filter(
    (names) =>
      names.length &&
      !names.some((name) => bodyNames.includes(normalizeName(name))),
  );
  const publisherVisible = check(
    "publisher_visible",
    "발행 주체와 본문 이름 대조 · 참고",
    0,
    0,
    `발행 주체 ${publisherNames.length}개 중 이름·별칭을 본문 또는 이미지 대체 텍스트에서 직접 대조하지 못한 항목 ${unmatched.length}개. 약칭·번역·표기 차이는 직접 확인하세요.`,
    {
      status: unmatched.length ? "warning" : "info",
      applicable: false,
      evidence: unmatched.map((names) => names.join(" / ")).join("\n"),
      fix: "구조화 데이터의 회사명·별칭이 실제 표시된 발행 주체와 일치하는지 확인하세요.",
      confidence: "inferred",
    },
  );
  if (s.renderStatus === "failed") {
    const note =
      "브라우저 렌더링을 완료하지 못해 서버 HTML 기준으로 분석했습니다.";
    if (!s.warnings.includes(note))
      s = { ...s, warnings: [...s.warnings, note] };
  }
  // Existing entities remain inspectable even when an unrelated resource fails.
  // An unsupported context, however, can change the meaning of properties and links.
  const unsupported = activeBlocks.some(
    (block) => block.validation === "unsupported",
  );
  for (const item of [...base, ...b, ...c]) {
    if (!item.applicable) continue;
    if (unsupported && item.id !== "jsonld_exists")
      Object.assign(
        item,
        unknown(
          item,
          "지원하지 않는 JSON-LD 문맥 때문에 이 의미·속성 검사를 확정하지 않습니다.",
        ),
      );
    else if (
      uncertain &&
      item.points === 0 &&
      (item.id === "jsonld_exists" ||
        item.id === "publisher_exists" ||
        item.id === "page_identity" ||
        item.id === "breadcrumb" ||
        item.id.startsWith("expected_"))
    )
      Object.assign(
        item,
        unknown(
          item,
          "동적 콘텐츠 수집이 완료되지 않아 엔티티 부재를 확정하지 않습니다.",
        ),
      );
  }
  const result = finish(
    "geo",
    s,
    load(s.renderedHtml || s.html)("title")
      .first()
      .text()
      .trim(),
    [
      category("A", "핵심 엔티티 구성", 55, base),
      category("B", "속성 완성도", 30, b, 30),
      category("C", "엔티티 연결성", 15, c, 15),
    ],
    {
      entities,
      jsonLdBlocks: blocks,
      detectedProfiles,
      selectedProfiles: profiles,
      partial: uncertain,
      profileEvidence,
      supplementary: [
        contentChecks(s, profiles),
        geoAccess(s),
        category("publisher", "발행 주체 대조", 0, [publisherVisible]),
      ],
    },
  );
  return result;
}
