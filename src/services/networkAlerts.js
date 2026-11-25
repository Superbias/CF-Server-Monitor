import { getLatestMetricsForAllServers } from '../database/schema.js';
import { getHistoryIdRange, getServerHistoryInfo } from '../database/indexOptimization.js';
import { getAllServers } from '../utils/cache.js';
import { buildAgentConfig } from '../utils/agentConfig.js';
import { normalizeBooleanSetting } from '../utils/settings.js';
import { sendNotification } from './notification.js';

const MINUTE = 60_000;
const STATE_KEY = 'network_alert_state';
const CARRIERS = ['ct', 'cu', 'cm'];
const fresh = (row, now) => row && Number.isFinite(Number(row.timestamp)) && now >= Number(row.timestamp) && now - Number(row.timestamp) <= 2 * MINUTE;
const number = value => value === null || value === undefined || value === '' || value === false || value === 'false' ? null : Number(value);
const failed = row => CARRIERS.every(c => number(row[`loss_${c}`]) === 100 && !(number(row[`ping_${c}`]) > 0));
const recovered = row => CARRIERS.some(c => number(row[`ping_${c}`]) > 0 && number(row[`loss_${c}`]) !== 100);

// A gap or any non-failure sample breaks the continuous failure window.
export function evaluateNetworkWindow(rows, now) {
  const sorted = [...rows].sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
  if (!fresh(sorted[0], now)) return { status: 'unknown' };
  if (recovered(sorted[0])) return { status: 'recovered' };
  let previous = Number(sorted[0].timestamp);
  const latest = previous;
  for (const row of sorted) {
    const time = Number(row.timestamp);
    if (!failed(row) || !Number.isFinite(time) || previous - time > 2 * MINUTE) break;
    previous = time;
    if (latest - time >= 10 * MINUTE) return { status: 'failed', since: time };
  }
  return { status: 'unknown' };
}

export async function checkNetworkAlerts(env, { siteSettings, now = Date.now() } = {}) {
  if (normalizeBooleanSetting(siteSettings?.network_alert_enabled) !== 'true') return;
  if (!siteSettings.tg_bot_token && normalizeBooleanSetting(siteSettings.notification_webhook_enabled) !== 'true') return;
  const db = env.DB;
  const stored = await db.prepare('SELECT value FROM settings WHERE key = ?').bind(STATE_KEY).first();
  let state;
  try { state = JSON.parse(stored?.value || '{}'); } catch { state = {}; }
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  const servers = await getAllServers(db);
  const latest = await getLatestMetricsForAllServers(db);
  const valid = new Set(servers.map(s => String(s.id)));
  for (const id of Object.keys(state)) if (!valid.has(id)) delete state[id];
  for (const server of servers) {
    try {
      const config = buildAgentConfig(server, siteSettings);
      const targets = CARRIERS.map(c => config[`custom_${c}`]);
      const signature = JSON.stringify(targets);
      if (config.ping_mode !== 'tcp' || targets.some(t => !t)) { delete state[server.id]; continue; }
      if (state[server.id]?.signature !== signature) state[server.id] = { signature, observedAt: now };
      const metric = latest.get(server.id);
      if (!fresh(metric, now)) continue;
      let result = evaluateNetworkWindow([metric], now);
      if (failed(metric) && !state[server.id]?.notifiedAt) {
        const info = await getServerHistoryInfo(db, server.id, server);
        const range = getHistoryIdRange(info.partitionId, Math.max(now - 13 * MINUTE, info.startTimestamp || 0, state[server.id].observedAt), now);
        const history = await db.prepare(`SELECT timestamp, ping_ct, ping_cu, ping_cm, loss_ct, loss_cu, loss_cm
          FROM metrics_history WHERE id >= ? AND id <= ? ORDER BY id DESC`).bind(range.startId, range.endId).all();
        result = evaluateNetworkWindow((history.results || []).filter(row => row.timestamp >= state[server.id].observedAt), now);
      }
      const active = state[server.id]?.notifiedAt;
      if ((result.status === 'failed' && !active) || (result.status === 'recovered' && active)) {
        const recovery = result.status === 'recovered';
        const message = recovery
          ? `${server.name}：三网 TCP 探测已恢复，至少一条线路连接成功。`
          : `${server.name}：电信、联通、移动 TCP 探测连续至少 10 分钟全部失败（100% 丢包），节点仍在上报。疑似网络异常，不代表已确认被墙。\n方向：VPS → 国内目标\n目标：${targets.join(' / ')}`;
        const error = await sendNotification(siteSettings, message, { event: recovery ? '三网网络恢复' : '疑似网络异常', emoji: recovery ? '✅' : '⚠️', message });
        if (error) { console.error('[Network alerts]', error); continue; }
        if (recovery) delete state[server.id].notifiedAt;
        else state[server.id].notifiedAt = now;
      }
    } catch (error) { console.error('[Network alerts]', server.id, error.message); }
  }
  const value = JSON.stringify(state);
  if (value !== (stored?.value || '{}')) await db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').bind(STATE_KEY, value).run();
}
