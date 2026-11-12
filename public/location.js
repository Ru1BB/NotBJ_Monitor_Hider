// WGS84 -> GCJ-02 approximation adapted from wandergis/coordtransform (MIT).
// Copyright (c) 2015 记忆的残骸. See THIRD_PARTY_NOTICES.md.
function beijingGpsToGcj02(lng, lat) {
  // Limit the approximation to this app's Beijing-area data coverage.
  if (lng < 115 || lng > 118 || lat < 39 || lat > 42) return null;
  const pi = Math.PI, x = lng - 105, y = lat - 35;
  const wave = (20 * Math.sin(6 * x * pi) + 20 * Math.sin(2 * x * pi)) * 2 / 3;
  let dLat = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x)) + wave;
  dLat += (20*Math.sin(y*pi) + 40*Math.sin(y*pi/3)) * 2/3;
  dLat += (160*Math.sin(y*pi/12) + 320*Math.sin(y*pi/30)) * 2/3;
  let dLng = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x)) + wave;
  dLng += (20*Math.sin(x*pi) + 40*Math.sin(x*pi/3)) * 2/3;
  dLng += (150*Math.sin(x*pi/12) + 300*Math.sin(x*pi/30)) * 2/3;
  const rad = lat*pi/180, magic = 1 - 0.00669342162296594323 * Math.sin(rad)**2;
  const sqrt = Math.sqrt(magic), a = 6378245;
  return {
    lng: lng + dLng*180 / (a/sqrt*Math.cos(rad)*pi),
    lat: lat + dLat*180 / (a*(1-0.00669342162296594323)/(magic*sqrt)*pi),
    approximate: true
  };
}
function validPosition(lng, lat) {
  return Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90;
}

// Always settle, even if the SDK throws, returns malformed data, or never calls back.
export async function gpsToAmap(lng, lat, convertFrom, timeout = 5000) {
  if (!validPosition(lng, lat)) throw Error('浏览器返回的位置无效，请重新定位或手动选点');
  const converted = await new Promise(resolve => {
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true; clearTimeout(timer); resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeout);
    try {
      convertFrom([lng, lat], 'gps', (status, result) => {
        if (settled) return;
        try {
          const p = result?.locations?.[0];
          const x = p?.getLng ? p.getLng() : p?.lng;
          const y = p?.getLat ? p.getLat() : p?.lat;
          finish(status === 'complete' && validPosition(x, y) ? {lng:x, lat:y, approximate:false} : null);
        } catch { finish(null); }
      });
    } catch { finish(null); }
  });
  if (converted) return converted;
  const fallback = beijingGpsToGcj02(lng, lat);
  if (fallback) return fallback;
  throw Error('坐标转换服务暂不可用，请重试或在设置中手动选点');
}
