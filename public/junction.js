// Junction membership is a geographic inference, not a verified camera inventory.
export const JUNCTION_RADIUS = 100;
export const DIRECTIONS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
const rad = n => n * Math.PI / 180;
export function metersBetween(a, b) {
  const x = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, x)));
}
function numeric(value) {
  return (typeof value === 'number' || typeof value === 'string' && value.trim() !== '') && Number.isFinite(Number(value)) ? Number(value) : NaN;
}
function coordinate(value) {
  if (typeof value === 'string') value = value.split(',');
  const lng = numeric(Array.isArray(value) ? value[0] : value?.lng ?? value?.getLng?.());
  const lat = numeric(Array.isArray(value) ? value[1] : value?.lat ?? value?.getLat?.());
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90 ? {lng, lat} : null;
}
const text = value => typeof value === 'string' ? value.trim() : '';
const canonical = value => text(value).replace(/\s+/g, '');
export function normalizeIntersections(info = {}) {
  const crosses = info.crosses ?? info.roadinters;
  return (Array.isArray(crosses) ? crosses : []).flatMap(c => {
    const position = coordinate(c?.location);
    const first = text(c?.firstRoadName ?? c?.first_name), second = text(c?.secondRoadName ?? c?.second_name);
    if (!position || !first || !second) return [];
    const names = [canonical(first), canonical(second)].sort();
    // Never use coordinates rounded into a grid as an equality test for junctions.
    return [{...position, first, second, signature: JSON.stringify(names), name: `${first} × ${second}`}];
  });
}
export function cameraSide(camera, junction) {
  if (metersBetween(camera, junction) <= 15) {
    // Travel direction (e.g. 北向南) is not the camera's side of the junction.
    const side = `${camera.name || ''} ${camera.description || ''}`.match(/(?:交叉口|交口|路口)(东北|东南|西北|西南|东|南|西|北)(?:侧|边|角|\s|$)/)?.[1];
    return side || '待确认';
  }
  const lng = rad(camera.lng - junction.lng), a = rad(junction.lat), b = rad(camera.lat);
  const bearing = (Math.atan2(Math.sin(lng) * Math.cos(b), Math.cos(a) * Math.sin(b) - Math.sin(a) * Math.cos(b) * Math.cos(lng)) * 180 / Math.PI + 360) % 360;
  return DIRECTIONS[Math.round(bearing / 45) % 8];
}
function matchesName(camera, anchor) {
  const source = canonical(`${camera.name || ''} ${camera.description || ''}`);
  return source.includes(canonical(anchor.first)) && source.includes(canonical(anchor.second));
}
function gradeSeparated(camera) {
  return /高架(?:桥|路)?上|桥上|高速|匝道|隧道|地下/.test(`${camera.name || ''} ${camera.description || ''}`);
}
export function groupJunctions(cameras, enabled = true) {
  if (!enabled) return {groups: [], singles: [...cameras]};
  const radius = JUNCTION_RADIUS;
  // Build one anchor per matching road pair and nearby center. Comparing with a
  // fixed representative (25 m) avoids chained merging of adjacent junctions.
  const candidates = cameras.flatMap(c => c.road?.intersections || [])
    .sort((a, b) => a.signature.localeCompare(b.signature) || a.lng - b.lng || a.lat - b.lat);
  const byRoad = new Map(), anchors = [];
  for (const candidate of candidates) {
    let family = byRoad.get(candidate.signature);
    if (!family) { family = []; byRoad.set(candidate.signature, family); }
    if (family.some(a => metersBetween(a, candidate) <= 25)) continue;
    const anchor = {...candidate, id: `junction:${candidate.signature}:${candidate.lng},${candidate.lat}`, members: []};
    family.push(anchor); anchors.push(anchor);
  }
  // A spatial grid keeps assigning a full visible camera set inexpensive.
  const cellSize = 0.005, grid = new Map();
  const cell = c => [Math.floor(c.lng / cellSize), Math.floor(c.lat / cellSize)];
  for (const a of anchors) {
    const key = cell(a).join(',');
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(a);
  }
  const singles = [];
  for (const camera of cameras) {
    if (gradeSeparated(camera)) { singles.push(camera); continue; }
    const [x, y] = cell(camera), nearby = [];
    // Source cameras are within Beijing (39–42° N); adjacent cells cover 200 m.
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const anchor of grid.get(`${x + dx},${y + dy}`) || []) {
        const distance = metersBetween(camera, anchor);
        if (distance <= radius) nearby.push({anchor, distance, named: matchesName(camera, anchor)});
      }
    }
    nearby.sort((a, b) => Number(b.named) - Number(a.named) || a.distance - b.distance);
    const best = nearby[0], next = nearby[1];
    // A near tie stays a single point. Missing evidence never proves membership.
    if (!best || next && best.named === next.named && next.distance - best.distance < 30) {
      singles.push(camera); continue;
    }
    best.anchor.members.push({...camera, junctionDistance: best.distance, side: cameraSide(camera, best.anchor)});
  }
  const groups = [];
  for (const anchor of anchors) {
    if (anchor.members.length < 2) { singles.push(...anchor.members); continue; }
    const sides = Object.fromEntries(DIRECTIONS.map(side => [side, anchor.members.filter(c => c.side === side).length]));
    groups.push({...anchor, sides, unknown: anchor.members.filter(c => c.side === '待确认').length, radius});
  }
  return {groups, singles};
}
export function junctionMarkerHTML(group) {
  const dots = DIRECTIONS.map((side, i) => {
    const angle = i * Math.PI / 4;
    const x = 32 + Math.sin(angle) * 24, y = 32 - Math.cos(angle) * 24;
    return `<circle class="junction-sector${group.sides[side] ? ' occupied' : ''}" cx="${x}" cy="${y}" r="4.5"/>`;
  }).join('');
  return `<svg viewBox="0 0 64 64" aria-hidden="true"><circle class="junction-halo" cx="32" cy="32" r="31"/><path class="junction-roads" d="M32 8V56M8 32H56"/>${dots}<circle class="junction-core" cx="32" cy="32" r="14"/><text class="junction-count" x="32" y="36">${group.members.length}</text><text class="junction-north" x="32" y="20">北</text></svg>${group.unknown ? '<span class="junction-unknown">?</span>' : ''}`;
}
