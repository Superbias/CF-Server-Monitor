import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { getServerDetail } from '../utils/cache.js';
import { createSuccessResponse, createBadRequestResponse, createNotFoundResponse, createUnauthorizedResponse } from '../utils/errors.js';

export function validateRoutes(value) {
  if (!Array.isArray(value) || value.length !== 3) return false;
  const carriers = new Set();
  for (const route of value) {
    if (!route || typeof route !== 'object') return false;
    if (!['telecom', 'unicom', 'mobile'].includes(route.carrier) || carriers.has(route.carrier)) return false;
    carriers.add(route.carrier);
    if (typeof route.target !== 'string' || route.target.length > 253 || !route.target.length) return false;
    if (!['ok', 'incomplete', 'error', 'unsupported'].includes(route.status)) return false;
    if (typeof route.error !== 'string' || route.error.length > 500) return false;
    if (!Array.isArray(route.hops) || route.hops.length > 30) return false;
    for (const hop of route.hops) {
      if (!hop || typeof hop !== 'object') return false;
      if (!Number.isInteger(hop.ttl) || hop.ttl < 1 || hop.ttl > 30) return false;
      if (hop.ip !== null && (typeof hop.ip !== 'string' || hop.ip.length > 45)) return false;
      if (hop.asn !== null && (!Number.isInteger(hop.asn) || hop.asn < 1 || hop.asn > 4294967295)) return false;
      if (hop.rtt !== null && (typeof hop.rtt !== 'number' || !Number.isFinite(hop.rtt) || hop.rtt < 0 || hop.rtt > 120000)) return false;
    }
  }
  return true;
}

export async function handleReturnRoutes(request, env, sys) {
  const url = new URL(request.url);
  const uploading = request.method === 'POST';
  if (uploading && request.headers.get('Authorization') !== `Bearer ${env.API_SECRET}`) return createUnauthorizedResponse();
  const loggedIn = uploading || await checkAuth(request, env, sys);
  if (!uploading && sys.is_public !== 'true' && !loggedIn) return simpleAuthResponse();
  const id = url.searchParams.get('id');
  const family = url.searchParams.get('family') || '4';
  if (!['4', '6'].includes(family)) return createBadRequestResponse('Invalid address family');
  if (!id || id.length > 128) return createBadRequestResponse('Invalid server id');
  if (!await getServerDetail(env.DB, id, loggedIn)) return createNotFoundResponse();
  let routes, routesV6;
  if (uploading) {
    // Bound the streamed body even when Content-Length is absent.
    const reader = request.body?.getReader();
    if (!reader) return createBadRequestResponse('Missing body');
    let size = 0;
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); return createBadRequestResponse('Payload too large'); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    try { const body = JSON.parse(new TextDecoder().decode(bytes)); routes = body.routes; routesV6 = body.routes_v6; } catch { return createBadRequestResponse('Invalid JSON'); }
    if (!validateRoutes(routes)) return createBadRequestResponse('Invalid routes');
    if (routesV6 !== undefined && !validateRoutes(routesV6)) return createBadRequestResponse('Invalid IPv6 routes');
    // Keep only documented fields.
    routes = routes.map(r => ({ carrier: r.carrier, target: r.target, status: r.status, error: r.error,
      hops: r.hops.map(h => ({ ttl: h.ttl, ip: h.ip, asn: h.asn, rtt: h.rtt })) }));
  }
  const table = family === '6' && !uploading ? 'return_routes_v6' : 'return_routes';
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS ${table} (server_id TEXT PRIMARY KEY, measured_at INTEGER NOT NULL, routes TEXT NOT NULL)`).run();
  if (uploading) {
    const measuredAt = Date.now();
    await env.DB.prepare('INSERT INTO return_routes (server_id, measured_at, routes) VALUES (?, ?, ?) ON CONFLICT(server_id) DO UPDATE SET measured_at=excluded.measured_at, routes=excluded.routes').bind(id, measuredAt, JSON.stringify(routes)).run();
    if (routesV6 !== undefined) {
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS return_routes_v6 (server_id TEXT PRIMARY KEY, measured_at INTEGER NOT NULL, routes TEXT NOT NULL)').run();
      routesV6 = routesV6.map(r => ({ carrier: r.carrier, target: r.target, status: r.status, error: r.error,
        hops: r.hops.map(h => ({ ttl: h.ttl, ip: h.ip, asn: h.asn, rtt: h.rtt })) }));
      await env.DB.prepare('INSERT INTO return_routes_v6 (server_id, measured_at, routes) VALUES (?, ?, ?) ON CONFLICT(server_id) DO UPDATE SET measured_at=excluded.measured_at, routes=excluded.routes').bind(id, measuredAt, JSON.stringify(routesV6)).run();
    }
    return createSuccessResponse({ ok: true });
  }
  const row = await env.DB.prepare(`SELECT measured_at, routes FROM ${table} WHERE server_id = ?`).bind(id).first();
  return createSuccessResponse(row ? { measured_at: row.measured_at, routes: JSON.parse(row.routes) } : { measured_at: null, routes: [] }, { 'Cache-Control': 'no-store' });
}
