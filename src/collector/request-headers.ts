/** Forward only public Data API credentials created by the isolated target page.
 * JWT claims classify legacy anon keys; Supabase still validates their signature.
 * Never forward cookies, signed-in user tokens, or privileged backend keys.
 */
export function publicApiHeaders(
  input: string,
  headers: Record<string, string> = {},
): Record<string, string> {
  const url = new URL(input);
  const project = /^([a-z0-9]+)\.supabase\.co$/.exec(url.hostname)?.[1];
  if (
    url.protocol !== "https:" ||
    url.port ||
    !project ||
    !url.pathname.startsWith("/rest/v1/")
  )
    return {};
  const source = Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const key = source.apikey;
  if (!key || key.length > 4096) return {};
  const publishable = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  if (!publishable) {
    if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key))
      return {};
    try {
      const claims = JSON.parse(
        Buffer.from(key.split(".")[1], "base64url").toString(),
      );
      if (claims?.role !== "anon" || claims?.ref !== project) return {};
    } catch {
      return {};
    }
  }
  const allowed: Record<string, string> = { apikey: key };
  // Preserve only the matching anonymous bearer, never a separate user session.
  if (!publishable && source.authorization === `Bearer ${key}`)
    allowed.authorization = source.authorization;
  return allowed;
}
