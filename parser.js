// Parse a limited JavaScript literal, never execute source-site code.
class LiteralParser {
  constructor(text) { this.text = text; this.i = 0; }
  ws() { while (true) { const m = this.text.slice(this.i).match(/^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)/); if (!m) break; this.i += m[0].length; } }
  value() {
    this.ws(); const c = this.text[this.i];
    if (c === '"' || c === "'") return this.string();
    if (c === '[' || c === '{') {
      this.i++; const out = c === '[' ? [] : {}; const end = c === '[' ? ']' : '}';
      while (true) { this.ws(); if (this.text[this.i] === end) { this.i++; return out; }
        if (c === '[') out.push(this.value()); else { let key; if ('"\''.includes(this.text[this.i])) key = this.string(); else { const m = this.text.slice(this.i).match(/^[\w$]+/); if (!m) throw Error('Invalid object key'); key = m[0]; this.i += key.length; } this.ws(); let value; if (this.text[this.i] === ':') { this.i++; this.ws(); if (key === 'icon' && /^icon\b/.test(this.text.slice(this.i))) { this.i += 4; value = null; } else value = this.value(); } else if (key === 'icon' && /[,}]/.test(this.text[this.i] || '')) value = null; else throw Error('Expected colon'); if (!['__proto__','constructor','prototype'].includes(key)) out[key] = value; }
        this.ws(); if (this.text[this.i] === ',') { this.i++; continue; } if (this.text[this.i] !== end) throw Error('Expected delimiter');
      }
    }
    const m = this.text.slice(this.i).match(/^(?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null)/i); if (!m) throw Error('Unsupported literal'); this.i += m[0].length; return JSON.parse(m[0].toLowerCase());
  }
  string() { const quote = this.text[this.i++]; let result = ''; while (this.i < this.text.length) { let c = this.text[this.i++]; if (c === quote) return result; if (c === '\\') { c = this.text[this.i++]; if (c === 'u') { const hex = this.text.slice(this.i,this.i+4); if (!/^[\da-f]{4}$/i.test(hex)) throw Error('Invalid escape'); result += String.fromCharCode(parseInt(hex,16)); this.i += 4; } else result += ({n:'\n',r:'\r',t:'\t',b:'\b',f:'\f'}[c] ?? c); } else result += c; } throw Error('Unterminated string'); }
}
const pick = (o, keys) => { for (const key of keys) { const found = Object.keys(o).find(k => k.toLowerCase() === key.toLowerCase()); if (found && o[found] != null) return o[found]; } return ''; };
const str = value => typeof value === 'string' || typeof value === 'number' ? String(value).trim().slice(0,1000) : '';
export function parseLabels(html) {
  const match = /\b(?:var\s+|let\s+|const\s+)?LabelsData\s*=\s*/i.exec(html); if (!match) throw Error('未找到 LabelsData');
  const raw = new LiteralParser(html.slice(match.index + match[0].length)).value(); if (!Array.isArray(raw)) throw Error('LabelsData 不是数组');
  const cameras = []; let invalid = 0;
  for (const row of raw) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) { invalid++; continue; }
    const position = Array.isArray(row.position) && row.position.length === 2 ? row.position : [pick(row,['lng','lon','longitude','jd']), pick(row,['lat','latitude','wd'])];
    const lng = position[0] === '' || position[0] == null ? NaN : Number(position[0]); const lat = position[1] === '' || position[1] == null ? NaN : Number(position[1]);
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || lng < 115 || lng > 118 || lat < 39 || lat > 42) { invalid++; continue; }
    const link = str(pick(row,['url','href','link','detailUrl'])); let url = '';
    try { const u = new URL(link, 'https://www.jinjing365.com/'); if (link && ['https:','http:'].includes(u.protocol) && ['jinjing365.com','www.jinjing365.com'].includes(u.hostname) && !u.username && !u.password) url = u.href; } catch {}
    cameras.push({ id: `camera-${cameras.length}`, name: str(pick(row,['name','title','label','mc'])) || '未命名探头', description: str(pick(row,['description','desc','address','location','direction','content'])), lng, lat, category: str(pick(row,['aa','category','type','class'])), date: str(pick(row,['time','date','addtime','datetime'])), editTime: str(pick(row,['edittime'])), url });
  }
  if (!cameras.length || invalid > cameras.length) throw Error(`解析结果异常：有效 ${cameras.length} 条，无效 ${invalid} 条`);
  return { cameras, invalid };
}
