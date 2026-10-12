import { load } from "cheerio";
import jsonld, { type Options, type JsonLdDocument } from "jsonld";
import context from "./schema-context.json" with { type: "json" };
import vocabulary from "./schema-vocabulary.json" with { type: "json" };
import type { JsonLdBlock } from "./types.js";
export type Entity = Record<string, any>;
export const schemaName = (key: string) =>
  key.replace(/^https?:\/\/schema\.org\//, "");
export const isSchema = (key: string) => /^https?:\/\/schema\.org\//.test(key);
const parents = vocabulary.parents as Record<string, string[]>;
export const ranges = vocabulary.ranges as Record<string, string[]>;
export function ancestors(type: string, seen = new Set<string>()): string[] {
  if (seen.has(type)) return [];
  seen.add(type);
  return [
    type,
    ...(Object.hasOwn(parents, type) ? parents[type] || [] : []).flatMap((p) =>
      ancestors(p, seen),
    ),
  ];
}
export const isType = (type: string, parent: string) =>
  ancestors(type).includes(parent);
const loader = async (url: string) => {
  if (
    /^https?:\/\/schema\.org\/?(?:docs\/jsonldcontext\.json(?:ld)?)?$/.test(url)
  )
    return {
      contextUrl: undefined,
      documentUrl: url,
      document: context as unknown as JsonLdDocument,
    };
  throw new Error(
    "외부 context는 자동 조회하지 않습니다. Schema.org 또는 인라인 context로 별도 확인하세요.",
  );
};
function bounded(value: unknown, depth = 0, state = { count: 0 }) {
  if (++state.count > 30_000 || depth > 60)
    throw new Error("JSON-LD 크기 또는 중첩 깊이 한도를 초과했습니다.");
  if (Array.isArray(value)) value.forEach((v) => bounded(v, depth + 1, state));
  else if (value && typeof value === "object")
    Object.values(value).forEach((v) => bounded(v, depth + 1, state));
}
export function fingerprint(raw: string) {
  const sort = (v: any): any =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sort(v[k])]),
          )
        : v;
  try {
    const v = JSON.parse(raw);
    bounded(v);
    return JSON.stringify(sort(v));
  } catch {
    return raw.trim();
  }
}
export async function extractJsonLd(
  html: string,
  source: JsonLdBlock["source"] = "server",
  base = "https://example.com/",
) {
  const $ = load(html),
    blocks: JsonLdBlock[] = [],
    expanded: any[] = [];
  const scripts = $("script")
    .toArray()
    .filter(
      (e) =>
        ($(e).attr("type") || "").trim().toLowerCase() ===
        "application/ld+json",
    );
  for (const [i, e] of scripts.entries()) {
    const raw = $(e).html() || "";
    const block: JsonLdBlock = {
      index: i + 1,
      raw,
      valid: false,
      jsonValid: false,
      source,
      observedIn: source,
      analyzed: true,
      types: Object.create(null),
    };
    let limited = false,
      unsupported = false;
    try {
      if (i >= 100 || raw.length > 500_000) {
        limited = true;
        throw new Error(
          "JSON-LD 분석 한도(100개 블록·블록당 500KB)를 초과했습니다.",
        );
      }
      const value = JSON.parse(raw.replace(/^\s*<!--|-->\s*$/g, "").trim());
      block.jsonValid = true;
      if (!value || typeof value !== "object")
        throw new Error("JSON-LD 문서에는 객체 또는 객체 배열이 필요합니다.");
      try {
        bounded(value);
      } catch (e) {
        limited = true;
        throw e;
      }
      const nodes = (await jsonld.expand(
        value as JsonLdDocument,
        {
          base,
          safe: true,
          documentLoader: async (url: string) => {
            try {
              return await loader(url);
            } catch (e) {
              unsupported = true;
              throw e;
            }
          },
        } as Options.Expand,
      )) as any[];
      const walk = (node: any) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        for (const type of node["@type"] || [])
          if (typeof type === "string" && isSchema(type))
            block.types[schemaName(type)] =
              (block.types[schemaName(type)] || 0) + 1;
        Object.values(node).forEach(walk);
      };
      walk(nodes);
      block.schemaTypes = Object.values(block.types).reduce((a, b) => a + b, 0);
      block.valid = true;
      block.validation = "valid";
      expanded.push(...nodes);
    } catch (e) {
      block.validation = limited || unsupported ? "unsupported" : "invalid";
      block.error = unsupported
        ? "외부 context를 자동 조회하지 않아 의미를 확인할 수 없습니다."
        : e instanceof Error
          ? e.message
          : "JSON-LD 해석 오류";
    }
    blocks.push(block);
  }
  // Flatten together so fragments sharing an @id across scripts become one node.
  const flat = (await jsonld.flatten(expanded as JsonLdDocument, undefined, {
    documentLoader: loader,
  } as Options.Flatten)) as unknown as any[];
  const nodes = new Map<string, Entity>();
  const values = (v: any): any =>
    Array.isArray(v)
      ? v.map(values)
      : v && typeof v === "object" && "@value" in v
        ? v["@value"]
        : v && typeof v === "object" && "@list" in v
          ? values(v["@list"])
          : v;
  const ingest = (list: any[]) => {
    for (const node of list) {
      if (node["@graph"]) ingest(node["@graph"]);
      const value: Entity = Object.create(null);
      for (const [key, v] of Object.entries(node)) {
        if (key === "@graph") continue;
        const translated =
          key === "@type"
            ? (v as string[]).map((t) => (isSchema(t) ? schemaName(t) : t))
            : values(v);
        value[isSchema(key) ? schemaName(key) : key] = translated;
      }
      nodes.set(node["@id"], value);
    }
  };
  ingest(flat);
  const entities = [...nodes.values()].flatMap((value) =>
    (value["@type"] || [])
      .filter((type: string) => !type.includes(":"))
      .map((type: string) => ({ type, value })),
  );
  return { blocks, entities, nodes };
}
