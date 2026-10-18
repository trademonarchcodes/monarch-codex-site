const ORIGIN = "https://monarchcodex.online";

export async function onRequest(context) {
  const incoming = context.request;
  const incomingUrl = new URL(incoming.url);
  const targetUrl = new URL(incomingUrl.pathname + incomingUrl.search, ORIGIN);

  const headers = new Headers(incoming.headers);
  headers.delete("host");
  headers.set("x-forwarded-host", incomingUrl.host);
  headers.set("x-forwarded-proto", "https");

  // The browser talks to this Pages address, but the application and session
  // store remain on the existing Hostinger origin.
  if (headers.has("origin")) headers.set("origin", ORIGIN);
  if (headers.has("referer")) {
    try {
      const referer = new URL(headers.get("referer"));
      headers.set("referer", ORIGIN + referer.pathname + referer.search);
    } catch {}
  }

  const upstreamRequest = new Request(targetUrl.toString(), {
    method: incoming.method,
    headers,
    body: ["GET", "HEAD"].includes(incoming.method) ? undefined : incoming.body,
    redirect: "manual"
  });

  let upstream;
  try {
    upstream = await fetch(upstreamRequest);
  } catch {
    return new Response("Monarch Codex is temporarily unable to reach its application server. Please try again shortly.", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }
    });
  }

  const outHeaders = new Headers(upstream.headers);
  outHeaders.delete("content-length");
  outHeaders.delete("content-encoding");
  outHeaders.delete("content-security-policy-report-only");

  const location = outHeaders.get("location");
  if (location) {
    try {
      const redirectUrl = new URL(location, ORIGIN);
      if (redirectUrl.hostname === "monarchcodex.online" || redirectUrl.hostname === "www.monarchcodex.online") {
        outHeaders.set("location", incomingUrl.origin + redirectUrl.pathname + redirectUrl.search + redirectUrl.hash);
      }
    } catch {}
  }

  // Session cookies must belong to the public Pages host, not Hostinger's domain.
  const setCookie = outHeaders.get("set-cookie");
  if (setCookie) outHeaders.set("set-cookie", setCookie.replace(/;\\s*domain=[^;]+/ig, ""));

  const contentType = outHeaders.get("content-type") || "";
  if (contentType.includes("text/html") || contentType.includes("javascript") || contentType.includes("json") || contentType.includes("css")) {
    let body = await upstream.text();
    body = body
      .replaceAll("https://www.monarchcodex.online", incomingUrl.origin)
      .replaceAll("http://www.monarchcodex.online", incomingUrl.origin)
      .replaceAll("https://monarchcodex.online", incomingUrl.origin)
      .replaceAll("http://monarchcodex.online", incomingUrl.origin);
    outHeaders.set("cache-control", "no-store");
    return new Response(body, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders });
  }

  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: outHeaders });
}
