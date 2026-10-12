import { ancestors, isType, ranges, type Entity } from "./jsonld.js";
import { webUrl } from "./validation.js";

const items = (v: any): any[] =>
  Array.isArray(v)
    ? v.flatMap(items)
    : v === undefined || v === null
      ? []
      : [v];
export const textValue = (v: unknown) => typeof v === "string" && !!v.trim();
export const identifier = (v: unknown) => typeof v === "string" && !!webUrl(v);
export function propertyValid(
  property: string,
  raw: unknown,
  nodes: Map<string, Entity>,
): boolean {
  const values = items(raw);
  if (!values.length) return false;
  const validate = (v: any): boolean => {
    if (property === "price")
      return (
        (typeof v === "number" && Number.isFinite(v) && v >= 0) ||
        (typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v))
      );
    if (property === "priceCurrency")
      return typeof v === "string" && /^[A-Z]{3}$/.test(v);
    if (["position", "width", "height"].includes(property))
      return (
        (typeof v === "number" && Number.isInteger(v) && v > 0) ||
        (typeof v === "string" && /^[1-9]\d*$/.test(v))
      );
    if (
      [
        "datePublished",
        "dateModified",
        "dateCreated",
        "priceValidUntil",
      ].includes(property)
    )
      return (
        typeof v === "string" &&
        /^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(v) &&
        Number.isFinite(Date.parse(v)) &&
        new Date(v.slice(0, 10) + "T00:00:00Z")
          .toISOString()
          .startsWith(v.slice(0, 10))
      );
    const allowed = Object.hasOwn(ranges, property)
      ? ranges[property] || []
      : ["Text"];
    if (typeof v === "string") {
      if (!v.trim()) return false;
      if (
        ["url", "image", "logo", "sameAs", "item", "target"].includes(property)
      )
        return !!webUrl(v);
      return (
        allowed.some(
          (r) =>
            ["Text", "URL", "Date", "DateTime", "Time", "Duration"].includes(
              r,
            ) || ancestors(r).includes("Text"),
        ) &&
        (!allowed.every((r) => r === "URL") || !!webUrl(v))
      );
    }
    if (typeof v === "number")
      return (
        Number.isFinite(v) &&
        allowed.some((r) => ["Number", "Integer", "Float"].includes(r))
      );
    if (typeof v === "boolean") return allowed.includes("Boolean");
    if (!v || typeof v !== "object") return false;
    const id = v["@id"];
    const node = typeof id === "string" ? nodes.get(id) : undefined;
    if (allowed.includes("URL") && identifier(id)) return true;
    if (
      ["image", "logo", "target", "item"].includes(property) &&
      identifier(id) &&
      !node
    )
      return true;
    if (
      property === "address" &&
      node &&
      ["streetAddress", "addressLocality"].some((p) =>
        items(node[p]).some(textValue),
      )
    )
      return true;
    if (!node) return false;
    const types: string[] = node["@type"] || [];
    return types.some((t) => allowed.some((r) => isType(t, r)));
  };
  return values.every(validate);
}
export function externalLinks(raw: unknown, base: string) {
  return items(raw)
    .map((v) => webUrl(typeof v === "object" ? v?.["@id"] : v))
    .filter(
      (v): v is string => !!v && new URL(v).hostname !== new URL(base).hostname,
    );
}
