import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { TLSSocket } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Readable } from "node:stream";
import ipaddr from "ipaddr.js";
import { publicApiHeaders } from "./request-headers.js";

export class CrawlError extends Error {
  constructor(
    message: string,
    public code = "FETCH_FAILED",
  ) {
    super(message);
  }
}
export interface FetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  redirects?: number;
  userAgent?: string;
  allowPrivateForTests?: boolean;
  method?: "GET" | "HEAD";
  /** Target-page headers; only recognized public API credentials are retained. */
  headers?: Record<string, string>;
  agents?: { http: http.Agent; https: https.Agent };
}
export interface FetchResponse {
  url: string;
  status: number;
  headers: Record<string, string>;
  buffer: Buffer;
  text: string;
  encodedBytes?: number;
  redirects?: { url: string; status: number; location: string }[];
  tls?: { valid: boolean; expiresAt?: string; issuer?: string };
}
/**
 * verify 로컬 추가: 로컬 개발 서버(localhost:3000 등) 진단 허용.
 * 켜져 있으면 내부망 주소·기본 외 포트·점 없는 호스트를 막지 않는다. 채점 규칙에는 영향이 없다.
 */
export const networkPolicy = { allowLocal: false };
export function isLocalHost(hostname: string): boolean {
  const host = hostname.replace(/[\[\]]/g, "");
  if (/(^|\.)(localhost|local|internal|home|test)$/i.test(host)) return true;
  return isIP(host) ? !isPublicAddress(host) : !host.includes(".");
}
export function normalizeUrl(input: string): string {
  const value = input.trim();
  if (!value || value.length > 2048)
    throw new CrawlError(
      "홈페이지 주소를 올바르게 입력해주세요.",
      "INVALID_URL",
    );
  let url: URL;
  try {
    url = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`,
    );
  } catch {
    throw new CrawlError("올바른 홈페이지 주소를 입력해주세요.", "INVALID_URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname ||
    (!networkPolicy.allowLocal &&
      !url.hostname.includes(".") &&
      !isIP(url.hostname.replace(/[\[\]]/g, "")))
  )
    throw new CrawlError(
      "공개된 HTTP 또는 HTTPS 홈페이지 주소를 입력해주세요.",
      "INVALID_URL",
    );
  if (!networkPolicy.allowLocal && url.port && !["80", "443"].includes(url.port))
    throw new CrawlError(
      "기본 웹 포트(80·443)만 분석할 수 있습니다.",
      "INVALID_URL",
    );
  url.hash = "";
  return url.href;
}
export function isPublicAddress(address: string): boolean {
  try {
    let ip = ipaddr.parse(address.replace(/[\[\]]/g, ""));
    if (ip.kind() === "ipv6" && (ip as ipaddr.IPv6).isIPv4MappedAddress())
      ip = (ip as ipaddr.IPv6).toIPv4Address();
    return ip.range() === "unicast";
  } catch {
    return false;
  }
}
export async function resolvePublic(url: URL, allowPrivateForTests = false) {
  allowPrivateForTests ||= networkPolicy.allowLocal;
  const host = url.hostname.replace(/[\[\]]/g, "");
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new CrawlError("지원하지 않는 주소입니다.", "BLOCKED_URL");
  if (
    !allowPrivateForTests &&
    (/(^|\.)(localhost|local|internal|home|test|invalid)$/i.test(host) ||
      (url.port && !["80", "443"].includes(url.port)))
  )
    throw new CrawlError("공개 웹사이트만 분석할 수 있습니다.", "BLOCKED_URL");
  let addresses: { address: string; family: number }[];
  try {
    addresses = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await dns.lookup(host, { all: true });
  } catch {
    throw new CrawlError(
      "도메인에 연결할 수 없습니다. 주소를 확인해주세요.",
      "DNS_FAILED",
    );
  }
  if (
    !addresses.length ||
    (!allowPrivateForTests &&
      addresses.some((a) => !isPublicAddress(a.address)))
  )
    throw new CrawlError(
      "내부 네트워크 주소는 분석할 수 없습니다.",
      "BLOCKED_URL",
    );
  return addresses.find((a) => a.family === 4) || addresses[0];
}

/** DNS-pinned transport: every redirect is separately resolved and validated. */
export async function safeFetch(
  input: string,
  options: FetchOptions = {},
): Promise<FetchResponse> {
  const url = new URL(input),
    address = await resolvePublic(url, options.allowPrivateForTests);
  const timeoutMs = options.timeoutMs ?? 15000,
    maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
  const response = await new Promise<FetchResponse>((resolve, reject) => {
    let settled = false;
    const done = (error?: Error, value?: FetchResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value!);
    };
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: options.method || "GET",
        agent:
          options.agents?.[url.protocol === "https:" ? "https" : "http"] ??
          false,
        family: address.family,
        lookup: (_hostname, _opts, callback) =>
          callback(null, address.address, address.family),
        rejectUnauthorized: false,
        headers: {
          "User-Agent":
            options.userAgent ||
            "Mozilla/5.0 (compatible; SeoGeoVerify/1.0; WebsiteDiagnostics)",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
          ...publicApiHeaders(url.href, options.headers),
        },
      },
      async (res) => {
        const headers: Record<string, string> = {};
        Object.entries(res.headers).forEach(([k, v]) => {
          if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
        });
        const status = res.statusCode || 0;
        const socket = res.socket;
        let tls: FetchResponse["tls"];
        if (socket instanceof TLSSocket) {
          const cert = socket.getPeerCertificate();
          tls = {
            valid: socket.authorized,
            expiresAt: cert.valid_to
              ? new Date(cert.valid_to).toISOString().slice(0, 10)
              : undefined,
            issuer: cert.issuer?.O ? String(cert.issuer.O) : undefined,
          };
        }
        try {
          if (options.method === "HEAD") {
            res.resume();
            done(undefined, {
              url: url.href,
              status,
              headers,
              buffer: Buffer.alloc(0),
              text: "",
              tls,
            });
            return;
          }
          // Redirect bodies are irrelevant; avoid decompressing a potentially large body.
          if ([301, 302, 303, 307, 308].includes(status) && headers.location) {
            res.destroy();
            done(undefined, {
              url: url.href,
              status,
              headers,
              buffer: Buffer.alloc(0),
              text: "",
              tls,
            });
            return;
          }
          if (Number(headers["content-length"]) > maxBytes * 2)
            throw new CrawlError(
              "응답 크기가 분석 한도를 초과했습니다.",
              "BODY_TOO_LARGE",
            );
          const encoding = headers["content-encoding"]?.toLowerCase();
          let encodedBytes = 0;
          res.on("data", (chunk) => {
            encodedBytes += chunk.length;
          });
          const decoded: Readable =
            encoding === "gzip"
              ? res.pipe(createGunzip())
              : encoding === "br"
                ? res.pipe(createBrotliDecompress())
                : encoding === "deflate"
                  ? res.pipe(createInflate())
                  : res;
          const chunks: Buffer[] = [];
          if (decoded !== res)
            res.on("error", (error) => decoded.destroy(error));
          let size = 0;
          for await (const chunk of decoded) {
            const bytes = Buffer.from(chunk);
            size += bytes.length;
            if (size > maxBytes) {
              decoded.destroy();
              throw new CrawlError(
                "응답 크기가 분석 한도를 초과했습니다.",
                "BODY_TOO_LARGE",
              );
            }
            chunks.push(bytes);
          }
          const buffer = Buffer.concat(chunks);
          const charset =
            /charset\s*=\s*["']?([\w-]+)/i.exec(
              headers["content-type"] || "",
            )?.[1] ||
            /<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i.exec(
              buffer.subarray(0, 1024).toString("latin1"),
            )?.[1] ||
            "utf-8";
          let text: string;
          try {
            text = new TextDecoder(charset).decode(buffer);
          } catch {
            text = buffer.toString("utf-8");
          }
          done(undefined, {
            url: url.href,
            status,
            headers,
            buffer,
            text,
            encodedBytes,
            tls,
          });
        } catch (e) {
          res.destroy();
          done(e instanceof Error ? e : new Error(String(e)));
        }
      },
    );
    const timer = setTimeout(() => {
      request.destroy();
      done(new CrawlError("사이트 응답 시간이 초과되었습니다.", "TIMEOUT"));
    }, timeoutMs);
    request.on("error", (e) =>
      done(new CrawlError(`사이트 연결 실패: ${e.message}`, "FETCH_FAILED")),
    );
    request.end();
  });
  if (
    [301, 302, 303, 307, 308].includes(response.status) &&
    response.headers.location
  ) {
    const redirects = options.redirects ?? 5;
    if (!redirects)
      throw new CrawlError(
        "리다이렉트 횟수가 너무 많습니다.",
        "TOO_MANY_REDIRECTS",
      );
    const destination = new URL(response.headers.location, url);
    const next = await safeFetch(destination.href, {
      ...options,
      headers: destination.origin === url.origin ? options.headers : undefined,
      redirects: redirects - 1,
    });
    return {
      ...next,
      redirects: [
        {
          url: url.href,
          status: response.status,
          location: new URL(response.headers.location, url).href,
        },
        ...(next.redirects || []),
      ],
    };
  }
  return response;
}
