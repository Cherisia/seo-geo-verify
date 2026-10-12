import type {
  AuditResult,
  Category,
  Check,
  CheckStatus,
  CrawlSnapshot,
  Tool,
} from "./types.js";
export const RULESET_VERSION = "seo-geo-verify-2026.10.12";
export function check(
  id: string,
  label: string,
  maxPoints: number,
  points: number,
  detail: string,
  options: Partial<Check> = {},
): Check {
  const applicable = options.applicable ?? true;
  const result: Check = {
    id,
    label,
    maxPoints,
    points: applicable ? Math.max(0, Math.min(maxPoints, points)) : 0,
    applicable,
    status: !applicable
      ? "na"
      : points >= maxPoints
        ? "pass"
        : points > 0
          ? "warning"
          : "fail",
    detail,
    confidence: "confirmed",
    ...options,
  };
  // A generic rule's remediation is relevant only when a problem was observed.
  if (result.status !== "fail" && result.status !== "warning")
    delete result.fix;
  return result;
}
export const na = (
  id: string,
  label: string,
  maxPoints: number,
  detail: string,
) => check(id, label, maxPoints, 0, detail, { applicable: false });
export function unknown(item: Check, reason: string): Check {
  return {
    ...item,
    status: "error",
    applicable: false,
    points: 0,
    detail: `${reason}\n관측 내용: ${item.detail}`,
    fix: undefined,
  };
}
export function category(
  id: string,
  label: string,
  nominalMaxPoints: number,
  checks: Check[],
  emptyDisplay = 0,
): Category {
  const active = checks.filter((c) => c.applicable && c.status !== "error");
  const effectiveMaxPoints = active.reduce((sum, c) => sum + c.maxPoints, 0);
  return {
    id,
    label,
    nominalMaxPoints,
    unknownPoints: checks
      .filter((c) => c.status === "error")
      .reduce((n, c) => n + c.maxPoints, 0),
    points: active.reduce((sum, c) => sum + c.points, 0),
    maxPoints: effectiveMaxPoints || emptyDisplay,
    effectiveMaxPoints,
    checks,
  };
}
export function finish(
  tool: Tool,
  snapshot: CrawlSnapshot,
  title: string,
  categories: Category[],
  extra: Partial<AuditResult> = {},
): AuditResult {
  const rawPoints = categories.reduce((n, c) => n + c.points, 0);
  const effectiveMaxPoints = categories.reduce(
    (n, c) => n + c.effectiveMaxPoints,
    0,
  );
  const unknownPoints = categories.reduce((n, c) => n + c.unknownPoints, 0);
  const totalApplicablePoints = effectiveMaxPoints + unknownPoints;
  const partial = !!extra.partial || unknownPoints > 0;
  const assessedScore = effectiveMaxPoints
    ? rawPoints >= effectiveMaxPoints
      ? 100
      : Math.round((rawPoints / effectiveMaxPoints) * 100)
    : null;
  const score = partial ? null : assessedScore;
  const scoreRange =
    score !== null
      ? { min: score, max: score }
      : {
          min: totalApplicablePoints
            ? Math.floor((rawPoints / totalApplicablePoints) * 100)
            : 0,
          max: totalApplicablePoints
            ? Math.min(
                rawPoints < effectiveMaxPoints ? 99 : 100,
                Math.ceil(
                  ((rawPoints + unknownPoints) / totalApplicablePoints) * 100,
                ),
              )
            : 100,
        };
  const gradeIndex =
    score === null
      ? -1
      : score >= 90
        ? 5
        : score >= 80
          ? 4
          : score >= 70
            ? 3
            : score >= 60
              ? 2
              : score >= 50
                ? 1
                : 0;
  const grades =
    tool === "seo"
      ? ["비닐하우스", "초가집", "오두막", "벽돌집", "빌딩", "펜트하우스"]
      : ["취약", "부족", "미흡", "보통", "양호", "우수"];
  const counts: Record<CheckStatus, number> = {
    pass: 0,
    warning: 0,
    fail: 0,
    na: 0,
    error: 0,
    info: 0,
  };
  categories.flatMap((c) => c.checks).forEach((c) => counts[c.status]++);
  const improvements = categories
    .flatMap((c) =>
      c.checks
        .filter((i) => i.applicable && i.points < i.maxPoints)
        .map((i) => ({
          ruleId: i.id,
          category: c.id,
          label: i.fix || `${i.label} 항목을 보완하세요.`,
          estimatedGain: totalApplicablePoints
            ? Math.round(
                ((i.maxPoints - i.points) / totalApplicablePoints) * 100,
              )
            : 0,
          detail: i.detail,
        })),
    )
    .sort((a, b) => b.estimatedGain - a.estimatedGain);
  return {
    tool,
    inputUrl: snapshot.inputUrl,
    finalUrl: snapshot.finalUrl,
    checkedAt: snapshot.collectedAt,
    ruleSetVersion: RULESET_VERSION,
    title,
    keyword: extractKeyword(title),
    score,
    assessedScore,
    assessmentCoverage: totalApplicablePoints
      ? Math.floor((effectiveMaxPoints / totalApplicablePoints) * 1000) / 10
      : 0,
    unknownPoints,
    totalApplicablePoints,
    scoreRange,
    rawPoints,
    effectiveMaxPoints,
    grade: grades[gradeIndex] || "미확정",
    gradeIndex,
    categories,
    security: [],
    improvements,
    detectedProfiles: [],
    selectedProfiles: [],
    entities: [],
    jsonLdBlocks: [],
    warnings: [...snapshot.warnings],
    durationMs: snapshot.durationMs,
    browser: snapshot.browser,
    renderStatus: snapshot.renderStatus,
    counts,
    ...extra,
    partial,
  };
}
export function extractKeyword(title: string) {
  return (title.split(/\s*[|·—–]\s*|\s+-\s+/)[0] || "").trim().slice(0, 40);
}
export const hasValue = (value: unknown): boolean =>
  value !== null &&
  value !== undefined &&
  (typeof value === "string"
    ? value.trim().length > 0
    : Array.isArray(value)
      ? value.some(hasValue)
      : typeof value === "object"
        ? Object.keys(value).length > 0
        : true);
