import { isIP } from 'node:net';
import { getLatestMetricsForAllServers } from '../database/schema.js';
import { getAllServers, getServerDetail } from '../utils/cache.js';
import { checkAuth, simpleAuthResponse } from '../middleware/auth.js';
import { createSuccessResponse, createBadRequestResponse, createNotFoundResponse } from '../utils/errors.js';

const HOUR = 3600_000;
const API = 'https://api.globalping.io/v1';
const CARRIERS = {
  telecom: [4134, 4809, 4812, 4811, 58466],
  unicom: [4837, 9929, 17621, 4808],
  mobile: [9808, 56040, 56041, 56046, 56047, 24445],
};

export function publicIp(value, family) {
  const ip = String(value || '').trim();
  if (isIP(ip) !== Number(family)) return null;
  if (Number(family) === 6) {
    if (!/^[23][\da-f]{3}:/i.test(ip) || /^2001:db8:/i.test(ip)) return null;
    return new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  }
  const [a, b, c] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)) return null;
  return ip;
}

async function init(db) {
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS forward_routes (
      server_id TEXT NOT NULL, family INTEGER NOT NULL, target TEXT NOT NULL,
      next_run INTEGER NOT NULL DEFAULT 0, checked_at INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'waiting', started_at INTEGER, measurement_id TEXT,
      measured_at INTEGER, routes TEXT NOT NULL DEFAULT '[]', pending TEXT,
      error TEXT NOT NULL DEFAULT '', PRIMARY KEY(server_id, family))`),
    db.prepare('CREATE TABLE IF NOT EXISTS forward_route_asns (ip TEXT PRIMARY KEY, asn INTEGER, expires_at INTEGER NOT NULL)'),
    db.prepare(`CREATE TABLE IF NOT EXISTS forward_route_control (
      id INTEGER PRIMARY KEY, locked_until INTEGER NOT NULL, window INTEGER NOT NULL,
      used INTEGER NOT NULL, blocked_until INTEGER NOT NULL DEFAULT 0)`),
  ]);
}

async function api(path, options = {}) {
  return fetch(`${API}${path}`, { ...options, signal: AbortSignal.timeout(8000), headers: {
    'User-Agent': 'CFSM-Route-Probe/1.0', 'Accept-Encoding': 'gzip', 'Content-Type': 'application/json', ...options.headers,
  } });
}

export function chooseLocations(probes) {
  return Object.entries(CARRIERS).flatMap(([carrier, asns]) => {
    const asn = asns.find(n => probes.some(p => p.location?.country === 'CN' && p.location.asn === n));
    return asn ? [{ carrier, country: 'CN', asn, limit: 1 }] : [];
  });
}

export function normalizeMeasurement(data, target) {
  return Object.entries(CARRIERS).map(([carrier, asns]) => {
    const item = data.results?.find(r => r.probe?.country === 'CN' && asns.includes(r.probe.asn));
    const result = item?.result;
    const hops = (result?.hops || []).slice(0, 30).map((h, index) => ({
      ttl: index + 1, ip: isIP(h.resolvedAddress || '') ? h.resolvedAddress : null, asn: null,
      rtt: h.timings?.find(t => Number.isFinite(t.rtt) && t.rtt >= 0)?.rtt ?? null,
    }));
    return {
      carrier, target, status: !item || result?.status !== 'finished' ? 'error' : hops.some(h => h.ip && publicIp(h.ip, isIP(target)) === target) ? 'ok' : 'incomplete',
      error: !item ? '暂无该运营商可用探针' : result?.status !== 'finished' ? '测试探针未完成检测（可能离线或不支持该地址族）' : '',
      source: item ? { country: 'CN', city: item.probe.city, asn: item.probe.asn, network: item.probe.network } : null,
      hops,
    };
  });
}

async function syncTargets(db, now) {
  const servers = await getAllServers(db), metrics = await getLatestMetricsForAllServers(db);
  for (const server of servers) {
    const data = metrics.get(server.id);
    if (!data) continue;
    await db.batch([4, 6].map(family => {
      const target = publicIp(data[`ip_v${family}`], family) || '';
      return db.prepare(`INSERT INTO forward_routes (server_id, family, target) VALUES (?, ?, ?)
        ON CONFLICT(server_id, family) DO UPDATE SET target=excluded.target, next_run=0, state='waiting',
        measurement_id=NULL, pending=NULL, measured_at=NULL, routes='[]', error=''
        WHERE forward_routes.target != excluded.target`).bind(server.id, family, target);
    }));
  }
  await db.prepare('DELETE FROM forward_routes WHERE server_id NOT IN (SELECT id FROM servers)').run();
  await db.prepare('DELETE FROM forward_route_asns WHERE expires_at < ?').bind(now).run();
}

async function fail(db, row, message, now) {
  await db.prepare(`UPDATE forward_routes SET state='error', error=?, checked_at=?, pending=NULL,
    measurement_id=NULL WHERE server_id=? AND family=?`).bind(message, now, row.server_id, row.family).run();
}

async function poll(db, row, now) {
  try {
    const res = await api(`/measurements/${encodeURIComponent(row.measurement_id)}`);
    if (res.status === 429 || res.status >= 500) throw new Error('检测服务暂时繁忙');
    if (!res.ok) return fail(db, row, `读取检测结果失败（HTTP ${res.status}）`, now);
    const data = await res.json();
    if (data.status === 'in-progress') {
      if (now - row.started_at > 10 * 60_000) return fail(db, row, '去程检测超时', now);
      await db.prepare('UPDATE forward_routes SET checked_at=? WHERE server_id=? AND family=?').bind(now, row.server_id, row.family).run();
      return;
    }
    const routes = normalizeMeasurement(data, row.target);
    await db.prepare(`UPDATE forward_routes SET state='enriching', checked_at=?, pending=?, error=''
      WHERE server_id=? AND family=?`).bind(now, JSON.stringify(routes), row.server_id, row.family).run();
  } catch {
    if (now - row.started_at > 10 * 60_000) await fail(db, row, '检测服务不可用或检测超时', now);
  }
}

async function enrich(db, rows, now) {
  const parsed = rows.map(row => ({ row, routes: JSON.parse(row.pending) }));
  const ips = [...new Set(parsed.flatMap(p => p.routes.flatMap(r => r.hops.map(h => h.ip))))]
    .filter(ip => ip && publicIp(ip, isIP(ip)));
  const known = new Map();
  for (let i = 0; i < ips.length; i += 50) {
    const chunk = ips.slice(i, i + 50);
    const { results } = await db.prepare(`SELECT ip, asn FROM forward_route_asns WHERE expires_at > ? AND ip IN (${chunk.map(() => '?').join(',')})`).bind(now, ...chunk).all();
    for (const r of results) known.set(r.ip, r.asn);
  }
  // Bound external subrequests on the Workers free plan; resume enrichment next minute.
  const fresh = [], missing = ips.filter(ip => !known.has(ip)).slice(0, 20);
  // RIPEstat supports both families. Keep below its eight concurrent request limit.
  for (let i = 0; i < missing.length; i += 5) fresh.push(...await Promise.all(missing.slice(i, i + 5).map(async ip => {
    try {
      const response = await fetch(`https://stat.ripe.net/data/network-info/data.json?resource=${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(6000) });
      if (!response.ok) throw new Error('ASN service unavailable');
      const data = await response.json();
      if (data.status !== 'ok' || !Array.isArray(data.data?.asns)) throw new Error('ASN service unavailable');
      const asn = Number(data.data.asns[0]);
      return { ip, asn: Number.isInteger(asn) && asn > 0 ? asn : null, expires: now + 24 * HOUR };
    } catch { return { ip, asn: null, expires: now + 5 * 60_000 }; }
  })));
  if (fresh.length) await db.batch(fresh.map(r => db.prepare(`INSERT INTO forward_route_asns VALUES (?, ?, ?)
    ON CONFLICT(ip) DO UPDATE SET asn=excluded.asn, expires_at=excluded.expires_at`).bind(r.ip, r.asn, r.expires)));
  for (const r of fresh) known.set(r.ip, r.asn);
  for (const { row, routes } of parsed) {
    let complete = true;
    for (const route of routes) for (const hop of route.hops) {
      if (hop.ip && publicIp(hop.ip, isIP(hop.ip)) && !known.has(hop.ip)) complete = false;
      hop.asn = known.get(hop.ip) ?? null;
    }
    await db.prepare(`UPDATE forward_routes SET state=?, checked_at=?, measured_at=?, routes=?, pending=?
      WHERE server_id=? AND family=?`).bind(complete ? 'done' : 'enriching', now, row.started_at,
      JSON.stringify(routes), complete ? null : JSON.stringify(routes), row.server_id, row.family).run();
  }
}

export async function runForwardRoutes(env, now = Date.now()) {
  const db = env.DB, window = Math.floor(now / HOUR);
  await init(db);
  const lease = await db.prepare(`INSERT INTO forward_route_control (id, locked_until, window, used) VALUES (1, ?, ?, 0)
    ON CONFLICT(id) DO UPDATE SET locked_until=excluded.locked_until, window=excluded.window,
    used=CASE WHEN forward_route_control.window=excluded.window THEN used ELSE 0 END
    WHERE locked_until < ? RETURNING *`).bind(now + 55_000, window, now).first();
  if (!lease) return;
  try {
    if (new Date(now).getUTCMinutes() % 5 === 0) await syncTargets(db, now);
    const pending = await db.prepare("SELECT * FROM forward_routes WHERE state='pending' ORDER BY checked_at LIMIT 3").all();
    await Promise.all(pending.results.map(row => poll(db, row, now)));
    const enriching = await db.prepare("SELECT * FROM forward_routes WHERE state='enriching' ORDER BY checked_at LIMIT 3").all();
    await enrich(db, enriching.results, now);
    if (lease.blocked_until > now) return;
    const due = await db.prepare("SELECT * FROM forward_routes WHERE state NOT IN ('pending', 'enriching') AND next_run <= ? ORDER BY next_run, server_id, family LIMIT 3").bind(now).all();
    let locations;
    for (const row of due.results) {
      await db.prepare('UPDATE forward_routes SET next_run=?, checked_at=? WHERE server_id=? AND family=?').bind(now + HOUR, now, row.server_id, row.family).run();
      if (!row.target) { await fail(db, row, `节点未上报可用公网 IPv${row.family} 地址`, now); continue; }
      if (lease.used >= 240) { await fail(db, row, '免费检测额度已用完，等待下一小时', now); continue; }
      try {
        if (!locations) {
          const response = await api('/probes');
          if (!response.ok) throw new Error('无法读取可用测试探针');
          locations = chooseLocations(await response.json());
        }
        if (!locations.length) throw new Error('暂无国内三网可用探针');
        if (lease.used + locations.length > 240) throw new Error('免费检测额度已用完，等待下一小时');
        lease.used += locations.length;
        await db.prepare('UPDATE forward_route_control SET used=? WHERE id=1').bind(lease.used).run();
        const response = await api('/measurements', { method: 'POST', body: JSON.stringify({
          type: 'traceroute', target: row.target, measurementOptions: { protocol: 'ICMP' },
          locations: locations.map(({ carrier, ...location }) => location),
        }) });
        if (response.status === 429) {
          const retry = Math.max(60, Number(response.headers.get('Retry-After')) || 3600);
          await db.prepare('UPDATE forward_route_control SET blocked_until=? WHERE id=1').bind(now + retry * 1000).run();
          await fail(db, row, '检测服务限流，稍后自动重试', now);
          break;
        }
        if (!response.ok) throw new Error(`创建检测失败（HTTP ${response.status}）`);
        const data = await response.json();
        if (typeof data.id !== 'string' || !data.id.length || data.id.length > 128) throw new Error('检测服务返回无效任务');
        await db.prepare(`UPDATE forward_routes SET state='pending', started_at=?, measurement_id=?, error=''
          WHERE server_id=? AND family=?`).bind(now, data.id, row.server_id, row.family).run();
      } catch (error) { await fail(db, row, error.message || '检测服务暂不可用', now); }
    }
  } catch (error) { console.error('[Forward routes]', error.message); }
}

export async function handleForwardRoutes(request, env, sys) {
  const loggedIn = await checkAuth(request, env, sys);
  if (sys.is_public !== 'true' && !loggedIn) return simpleAuthResponse();
  const url = new URL(request.url), id = url.searchParams.get('id'), family = url.searchParams.get('family') || '4';
  if (!id || id.length > 128 || !['4', '6'].includes(family)) return createBadRequestResponse('Invalid server id or family');
  if (!await getServerDetail(env.DB, id, loggedIn)) return createNotFoundResponse();
  await init(env.DB);
  const row = await env.DB.prepare('SELECT * FROM forward_routes WHERE server_id=? AND family=?').bind(id, Number(family)).first();
  const routes = row ? JSON.parse(row.routes) : [];
  // Public dashboards intentionally hide node addresses, just like /api/servers.
  if (!loggedIn) for (const route of routes) {
    route.target = `节点 IPv${family}`;
    for (const hop of route.hops) hop.ip = null;
  }
  return createSuccessResponse({ measured_at: row?.measured_at ?? null, checked_at: row?.checked_at || null,
    state: row?.state || 'waiting', error: row?.error || '', routes }, { 'Cache-Control': 'no-store' });
}
