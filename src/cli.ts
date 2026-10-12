// 명령줄 진단: verify <도메인> [--max 100] [--concurrency 10] [--no-sitemap]
// 도메인 첫 페이지부터 사이트 전체를 진단하고, 끝나면 페이지별 점수를 표로 보여 준다.
import { createInterface } from "node:readline/promises";
import { closeRenderer, startCrawl, summarize, type PageRecord } from "./crawl.js";
import { CrawlError } from "./collector/http.js";

const USAGE = "사용법: verify <도메인> [--max 100] [--concurrency 10] [--no-sitemap]";
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
if (args.includes("-h") || args.includes("--help")) {
  console.log(`${USAGE}

  verify example.com              example.com 전체 진단 (동시 10개, 최대 100페이지)
  verify localhost:3000 --max 30  로컬 개발 서버 진단
  --max <n>          진단할 최대 페이지 수 (기본 100, 최대 1000)
  --concurrency <n>  동시 진단 수 (기본 10, 최대 20)
  --no-sitemap       사이트맵을 읽지 않고 링크만 따라감`);
  process.exit(0);
}

let input = args.find((a, i) => !a.startsWith("-") && !["--max", "--concurrency"].includes(args[i - 1] || ""));
if (!input) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  input = (await rl.question("진단할 도메인 (예: example.com): ")).trim();
  rl.close();
  if (!input) {
    console.error(USAGE);
    process.exit(1);
  }
}

/** 어떤 주소를 넣어도 그 도메인의 첫 페이지(/)부터 사이트 전체를 본다. */
function rootOf(value: string) {
  const v = value.trim();
  const m = /^([a-z][a-z\d+.-]*:\/\/)?([^/?#]+)/i.exec(v);
  return m ? `${m[1] || ""}${m[2]}/` : v;
}

let crawler;
try {
  crawler = startCrawl(rootOf(input), {
    maxPages: Number(flag("--max")) || undefined,
    concurrency: Number(flag("--concurrency")) || undefined,
    useSitemap: !args.includes("--no-sitemap"),
  });
} catch (error) {
  console.error(error instanceof CrawlError ? error.message : String(error));
  process.exit(1);
}
const { run } = crawler;
console.log(`진단 대상: ${run.inputUrl}  (동시 ${run.options.concurrency}개 · 최대 ${run.options.maxPages}페이지)\n`);

// ── 진행 상황: 한 줄을 계속 덮어쓴다 ──────────────────────
const tty = process.stdout.isTTY;
let lastLine = "";
function progress() {
  const s = summarize(run).counts;
  const line = `진행 ${s.done + s.failed + s.skipped}/${s.total}  (완료 ${s.done} · 실패 ${s.failed} · 건너뜀 ${s.skipped} · 진행 중 ${s.running})  ${run.stage}`;
  if (line === lastLine) return;
  lastLine = line;
  if (tty) process.stdout.write(`\r${line}\x1b[K`);
}
const timer = setInterval(progress, 500);
process.once("SIGINT", () => {
  console.log("\n중지 요청 — 진행 중인 페이지까지 마칩니다. (한 번 더 누르면 바로 종료)");
  crawler.stop();
  process.once("SIGINT", () => process.exit(130));
});

await crawler.done;
clearInterval(timer);
progress();
if (tty) process.stdout.write("\n");
await closeRenderer();

// ── 표 출력 ────────────────────────────────────────────────
// 한글 등 전각 문자는 터미널에서 두 칸을 차지한다
const wide = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
const width = (s: string) => [...s].reduce((w, ch) => w + (wide.test(ch) ? 2 : 1), 0);
const pad = (s: string, w: number, right = false) => {
  const fill = " ".repeat(Math.max(0, w - width(s)));
  return right ? fill + s : s + fill;
};
function cut(s: string, w: number) {
  if (width(s) <= w) return s;
  let out = "";
  for (const ch of s) {
    if (width(out + ch) > w - 3) break;
    out += ch;
  }
  return out + "...";
}

function table(headers: string[], rows: string[][], rightCols: number[]) {
  const widths = headers.map((h, c) => Math.max(width(h), ...rows.map((r) => width(r[c] ?? ""))));
  const line = "+" + widths.map((w) => "-".repeat(w + 2)).join("+") + "+";
  const fmt = (r: string[]) =>
    "| " + r.map((v, c) => pad(v ?? "", widths[c]!, rightCols.includes(c))).join(" | ") + " |";
  return [line, fmt(headers), line, ...rows.map(fmt), line].join("\n");
}

const score = (r?: PageRecord["seo"]) =>
  !r ? "-" : r.score !== null ? String(r.score) : `${r.scoreRange.min}~${r.scoreRange.max}`;
const site = run.scope.origin;
const urlWidth = Math.max(30, (process.stdout.columns || 120) - 64);
const rows = run.pages.map((p) => {
  const url = cut((p.finalUrl || p.url).replace(site, "") || "/", urlWidth);
  if (p.status !== "done") {
    const why = p.status === "failed" ? `실패: ${p.error}` : `건너뜀: ${p.note || p.stage}`;
    return [String(p.index + 1), "-", "", "-", "", "", "", `${url}  (${cut(why, 40)})`];
  }
  return [
    String(p.index + 1),
    score(p.seo),
    p.seo?.grade ?? "",
    score(p.geo),
    p.geo?.grade ?? "",
    String((p.seo?.counts.fail ?? 0) + (p.geo?.counts.fail ?? 0)),
    String((p.seo?.counts.warning ?? 0) + (p.geo?.counts.warning ?? 0)),
    url,
  ];
});

const s = summarize(run);
console.log(`\n페이지별 점수 — ${site}`);
console.log(table(["#", "SEO", "등급", "GEO", "등급", "필요", "권장", "주소"], rows, [0, 1, 3, 5, 6]));
console.log("  필요 = 개선 필요(fail) 수, 권장 = 개선 권장(warning) 수 (SEO+GEO 합계)");
console.log(
  `\n진단 ${s.counts.done}개 · 실패 ${s.counts.failed}개 · 건너뜀 ${s.counts.skipped}개` +
    (run.limitReached ? ` · 최대 ${run.options.maxPages}개 한도 도달(발견 ${run.discovered}개, --max 로 늘림)` : ""),
);
console.log(`평균 SEO ${s.average.seo ?? "-"} · GEO ${s.average.geo ?? "-"}`);

if (s.issues.length) {
  console.log("\n자주 나온 미흡 항목 (상위 10개)");
  console.log(
    table(
      ["구분", "항목", "필요", "권장", "페이지"],
      s.issues.slice(0, 10).map((i) => [
        i.tool.toUpperCase(),
        cut(i.label, 40),
        String(i.fail),
        String(i.warning),
        String(i.pages.length),
      ]),
      [2, 3, 4],
    ),
  );
}

process.exit(run.status === "failed" ? 1 : 0);
