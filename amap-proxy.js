// AMap returns JSONP with application/json. With nosniff, browsers refuse to
// execute that response. Only retype a matching callback wrapping valid JSON.
export function amapContentType(url, upstreamType, bytes) {
  const fallback = upstreamType || 'application/json';
  const callbacks = url.searchParams.getAll('callback');
  if (callbacks.length !== 1 || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callbacks[0])) return fallback;
  const body = new TextDecoder().decode(bytes).trim();
  const prefix = callbacks[0] + '(';
  const suffix = body.endsWith(');') ? 2 : body.endsWith(')') ? 1 : 0;
  if (!suffix || !body.startsWith(prefix)) return fallback;
  try { JSON.parse(body.slice(prefix.length, -suffix)); }
  catch { return fallback; }
  return 'text/javascript; charset=utf-8';
}
