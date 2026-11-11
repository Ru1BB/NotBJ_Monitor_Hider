// Classifications are hints, not proof of the road carrying a camera.
export function classifyRoad(camera, roads = []) {
  const text = `${camera.name || ''} ${camera.description || ''}`;
  if (/待确认|不确定|疑似|可能|推测|存疑/.test(text)) return {kind:'unknown', reason:'来源描述存在不确定信息'};
  if (/辅路|辅道|地面道路|地面层|高架下|桥下|下道|高速出口|高速入口|匝道/.test(text)) return {kind:'other', reason:'探头名称或描述包含辅路、地面或匝道'};
  if (/主路|主道|高架上|高架桥上|高架路上/.test(text)) return {kind:'major', reason:'探头名称或描述明确提到主路或高架'};
  if (/高速/.test(text) && !/交口|交叉|附近|旁|下方|下面|桥下|出口|入口|收费站/.test(text)) return {kind:'major', reason:'探头名称或描述提到高速'};
  const candidates = roads.filter(r => {
    if (typeof r.name !== 'string' || r.name.length < 3 || r.distance === '' || r.distance == null || !Number.isFinite(Number(r.distance)) || Number(r.distance) > 40) return false;
    const shortName = r.name.replace(/(?:高速公路|高速路|高架路)$/, '');
    return text.includes(r.name) || (shortName.length >= 3 && shortName !== r.name && text.includes(shortName));
  });
  if (candidates.length !== 1) return {kind:'unknown', reason: candidates.length > 1 ? '附近有多条匹配道路，无法确定所属道路' : '道路归属待确认'};
  const road = candidates[0].name;
  if (/辅路|辅道/.test(road)) return {kind:'other', reason:`高德附近匹配道路：${road}，仅供参考`};
  if (/高速公路|高速路|高架路/.test(road) && !/交口|交叉|附近|旁|下方|下面|桥下|出口|入口|收费站/.test(text)) return {kind:'major', reason:`高德附近匹配道路：${road}，仅供参考`};
  return {kind:'unknown', reason:`高德附近匹配道路：${road}，道路归属待确认`};
}
