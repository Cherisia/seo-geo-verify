export type Tool = "seo" | "geo";
export type AuditMode = Tool | "combined";
export type Profile =
  | "corporate"
  | "service"
  | "commerce"
  | "article"
  | "local"
  | "faq";
export type CheckStatus = "pass" | "warning" | "fail" | "na" | "error" | "info";
export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  points: number;
  maxPoints: number;
  applicable: boolean;
  detail: string;
  evidence?: string;
  evidenceNote?: string;
  fix?: string;
  confidence: "confirmed" | "inferred" | "implementation";
}
export interface Category {
  id: string;
  label: string;
  points: number;
  maxPoints: number;
  effectiveMaxPoints: number;
  nominalMaxPoints: number;
  unknownPoints: number;
  checks: Check[];
}
export interface NetworkResource {
  url: string;
  kind: string;
  status: number;
  bytes?: number;
  sizeSource: "response" | "header" | "unknown";
  cacheMaxAge?: number;
  skipped?: boolean;
  error?: string;
}
export interface BrowserObservation {
  viewport: { width: number; height: number };
  observedMs: number;
  lcpMs?: number;
  cls?: number;
  resources: NetworkResource[];
  contentFailures: string[];
  resourceFailures: string[];
  omittedMedia: string[];
  omittedTelemetry?: string[];
  resourceLimitReached: boolean;
}
export interface UrlProbe {
  inputUrl: string;
  finalUrl?: string;
  status?: number;
  redirects?: { url: string; status: number; location: string }[];
  error?: string;
}
export interface Resource {
  url: string;
  requestedUrl?: string;
  status: number;
  body: string;
  headers: Record<string, string>;
  error?: string;
}
export interface CrawlSnapshot {
  inputUrl: string;
  finalUrl: string;
  collectedAt: string;
  durationMs: number;
  html: string;
  renderedHtml?: string;
  status: number;
  headers: Record<string, string>;
  tls?: { valid: boolean; expiresAt?: string; issuer?: string };
  robots: Resource;
  sitemap: Resource;
  favicon: Resource;
  icons?: Resource[];
  renderIncomplete?: boolean;
  renderStatus: "succeeded" | "failed" | "skipped";
  renderError?: string;
  browser?: BrowserObservation;
  urlVariants?: UrlProbe[];
  linkedPages?: Resource[];
  warnings: string[];
}
export interface JsonLdBlock {
  index: number;
  raw: string;
  valid: boolean;
  jsonValid?: boolean;
  validation?: "valid" | "invalid" | "unsupported";
  schemaTypes?: number;
  observedIn?: "both" | "server" | "rendered";
  analyzed?: boolean;
  error?: string;
  source: "server" | "rendered";
  types: Record<string, number>;
}
export interface EntitySummary {
  type: string;
  label: string;
  count: number;
  requiredCoverage: number;
  recommendedCoverage: number;
  criteriaType?: string;
  missing: {
    property: string;
    kind: "required" | "recommended";
    count: number;
    examples?: string[];
  }[];
  scored: boolean;
  defined: boolean;
  richResult: boolean;
  idCoverage: number;
}
export interface Improvement {
  ruleId: string;
  category: string;
  label: string;
  estimatedGain: number;
  detail: string;
}
export interface AuditResult {
  tool: Tool;
  inputUrl: string;
  finalUrl: string;
  checkedAt: string;
  ruleSetVersion: string;
  title: string;
  keyword: string;
  score: number | null;
  assessedScore: number | null;
  assessmentCoverage: number;
  unknownPoints: number;
  totalApplicablePoints: number;
  scoreRange: { min: number; max: number };
  rawPoints: number;
  effectiveMaxPoints: number;
  grade: string;
  gradeIndex: number;
  categories: Category[];
  supplementary?: Category[];
  security: Check[];
  improvements: Improvement[];
  detectedProfiles: Profile[];
  selectedProfiles: Profile[];
  entities: EntitySummary[];
  jsonLdBlocks: JsonLdBlock[];
  warnings: string[];
  durationMs: number;
  partial: boolean;
  renderStatus: CrawlSnapshot["renderStatus"];
  browser?: BrowserObservation;
  profileEvidence?: string[];
  counts: Record<CheckStatus, number>;
}
export interface Job {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  stage: string;
  inputUrl: string;
  tool: AuditMode;
  createdAt: string;
  finishedAt?: string;
  result?: AuditResult;
  /** Combined audits share one collected snapshot and one history entry. */
  results?: Record<Tool, AuditResult>;
  error?: string;
  parentId?: string;
}
export interface HistoryRow {
  id: string;
  inputUrl: string;
  finalUrl: string;
  tool: Tool;
  title: string;
  score: number;
  grade: string;
  createdAt: string;
  categoryScores: number[];
}
export interface KeywordMetric {
  keyword: string;
  pc: number | string;
  mobile: number | string;
  total: number | string;
  competition: string;
}
export interface KeywordDemand {
  status: "ready" | "unconfigured" | "error";
  keyword: string;
  provider: string;
  checkedAt?: string;
  primary?: KeywordMetric;
  related?: KeywordMetric[];
  message?: string;
}
