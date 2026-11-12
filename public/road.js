import { normalizeIntersections } from './junction.js';
// Nearby roads are evidence, never proof of the road or vertical level carrying a camera.
const uncertain = /待确认|不确定|疑似|可能|推测|存疑/;
const junction = /交口|交叉|附近|旁|下方|下面|桥下|出口|入口|收费站/;
function nameKind(text) {
  if (/辅路|辅道|地面道路|地面层|高架下|桥下|下道|高速出口|高速入口|匝道/.test(text)) return 'other';
  if (/主路|主道|高架上|高架桥上|高架路上/.test(text)) return 'major';
  if (/高速|高架路/.test(text) && !junction.test(text)) return 'major';
  return 'unknown';
}
function roadDistance(value) {
  if (!['string', 'number'].includes(typeof value) || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}
function matches(text, name) {
  if (text.includes(name)) return true;
  // Compare road families too, so a nearby auxiliary road can expose a conflict.
  const base = name.replace(/(?:主路|主道|辅路|辅道)$/, '').replace(/(?:高速公路|高速路|高架路)$/, '');
  return base.length >= 3 && text.includes(base);
}
export function classifyRoad(camera, roads = [], info = {}) {
  const text = `${camera.name || ''} ${camera.description || ''}`;
  const nearbyRoads = [];
  for (const road of Array.isArray(roads) ? roads : []) {
    const meters = roadDistance(road?.distance);
    if (typeof road?.name !== 'string' || road.name.trim().length < 3 || meters === null || meters > 100) continue;
    const existing = nearbyRoads.find(r => r.name === road.name);
    if (existing) existing.distance = Math.min(existing.distance, meters);
    else nearbyRoads.push({name: road.name, distance: meters, direction: typeof road.direction === 'string' ? road.direction : ''});
  }
  nearbyRoads.sort((a, b) => a.distance - b.distance);
  const candidates = nearbyRoads.filter(r => r.distance <= 40 && matches(text, r.name));
  const sourceKind = nameKind(text);
  let kind = uncertain.test(text) ? 'unknown' : sourceKind;
  let reason = uncertain.test(text) ? '来源描述存在不确定信息' : kind === 'major' ? '来源名称或描述提到主路、高速或高架' : kind === 'other' ? '来源名称或描述提到辅路、地面或匝道' : '道路归属待确认';
  if (!uncertain.test(text)) {
    if (candidates.length > 1) {
      kind = 'unknown'; reason = '高德附近有多条匹配道路，可能涉及主辅路、交叉或上下层，需核对';
    } else if (candidates.length === 1) {
      const candidate = candidates[0], hint = nameKind(candidate.name);
      if (sourceKind !== 'unknown' && hint !== 'unknown' && hint !== sourceKind) {
        kind = 'unknown'; reason = `来源描述与高德附近道路「${candidate.name}」存在主辅路冲突，需核对`;
      } else if (hint !== 'unknown' && !junction.test(text)) {
        kind = hint; reason = `高德附近唯一匹配道路：${candidate.name}，约 ${Math.round(candidate.distance)} 米（辅助推测）`;
      }
    }
  }
  let level = '待确认；高德附近道路不提供探头所在层级';
  if (!uncertain.test(text)) {
    if (/高架下|桥下|地面层|地面道路/.test(text)) level = '地面 / 桥下（来源描述，待核验）';
    else if (/高架上|高架桥上|高架路上/.test(text)) level = '高架上（来源描述，待核验）';
  }
  const crossings = (Array.isArray(info.crosses) ? info.crosses : []).slice(0, 3).map(c => [c?.firstRoadName, c?.secondRoadName].filter(n => typeof n === 'string' && n).join(' × ')).filter(Boolean);
  return {kind, reason, level, nearbyRoads: nearbyRoads.slice(0, 5), crossings, intersections: normalizeIntersections(info), address: typeof info.formattedAddress === 'string' ? info.formattedAddress : ''};
}
