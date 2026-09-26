/**
 * SVG 消毒。
 *
 * 两个原则:
 *
 * 1. **显示时用 `<img src="/s/{id}.svg">`,不内联。**
 *    浏览器对 `<img>` 里的 SVG 有硬隔离:不执行脚本、不加载外部资源、不能跑 SMIL。
 *    这比我自己写过滤器可靠得多 —— 它是浏览器保证的,不是我保证的。
 *
 * 2. **入库前白名单过滤。** 因为即使 `<img>`,SVG 里仍可以有指向站外的 href
 *    (会发起请求、泄露访问者 IP),以及 <foreignObject> 这种能塞 HTML 的东西。
 *    所以只放行画图真正需要的标签和属性。
 */

// 只允许这些标签 —— 全是纯画图用的
const ALLOWED_TAGS = new Set([
  'svg', 'g', 'defs', 'title', 'desc',
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'tspan',
  'linearGradient', 'radialGradient', 'stop', 'clipPath', 'mask', 'pattern',
]);

// 属性白名单(全小写比较)。on* 一律不放行。
const ALLOWED_ATTRS = new Set([
  'viewbox', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity',
  'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'opacity',
  'transform', 'font-size', 'font-family', 'font-weight', 'text-anchor',
  'dominant-baseline', 'letter-spacing', 'clip-path', 'mask', 'offset',
  'stop-color', 'stop-opacity', 'gradientunits', 'gradienttransform',
  'patternunits', 'patterncontentunits', 'id', 'class',
  'preserveaspectratio', 'xmlns',
]);

/** 颜色只允许这几种写法,挡掉 url(...) 这种能引外链的形式 */
const COLOR_OK = /^(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\)|none|currentColor|transparent|[a-z]{3,20})$/;

export function sanitizeSvg(input) {
  let s = String(input || '').trim();
  if (!s) return { ok: false, error: '空的' };
  if (s.length > 24000) return { ok: false, error: 'SVG 太大了(上限 24KB)' };

  // 一刀切掉最危险的东西(即使白名单漏了也挡一道)
  for (const bad of [/<\s*script/i, /<\s*foreignObject/i, /<\s*iframe/i, /<\s*use/i,
                     /<\s*image/i, /<\s*animate/i, /<\s*set/i, /<\s*handler/i,
                     /javascript:/i, /\bon[a-z]+\s*=/i]) {
    if (bad.test(s)) return { ok: false, error: 'SVG 里有不允许的内容(脚本、事件、外部引用)' };
  }

  // 逐个标签 + 逐个属性过一遍
  const out = s.replace(/<\/?([A-Za-z][\w:-]*)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))*)\s*\/?>/g,
    (whole, tag, attrs) => {
      if (!ALLOWED_TAGS.has(tag)) return '';
      const keep = [];
      for (const m of (attrs || '').matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
        const name = m[1].toLowerCase();
        const val = (m[2] ?? m[3] ?? m[4] ?? '').trim();
        if (!ALLOWED_ATTRS.has(name) && name !== 'xmlns:xlink') continue;
        if (/^on/i.test(name)) continue;
        // href 只允许站内锚点
        if (name === 'href' || name.endsWith(':href')) continue;
        // 颜色字段不许出现 url( 或 http
        if (/color|fill|stroke/i.test(name) && !COLOR_OK.test(val)) {
          if (/url\(|http|@import/i.test(val)) continue;
        }
        // xmlns 的值本身就是一个 http 地址(SVG 的命名空间),要放行;
        // 其余任何 http / url( / @import 一律不留 —— 那些才是会发起外部请求的
        const isXmlns = name === 'xmlns' || name === 'xmlns:xlink';
        if (!isXmlns && /url\(|https?:|@import|expression/i.test(val)) continue;
        if (isXmlns && !/^https?:\/\/www\.w3\.org\//.test(val)) continue;
        keep.push(`${m[1]}="${val.replace(/"/g, '&quot;')}"`);
      }
      const slash = whole.startsWith('</') ? '/' : '';
      return `<${slash}${tag}${keep.length ? ' ' + keep.join(' ') : ''}${whole.endsWith('/>') ? ' /' : ''}>`;
    });

  if (!out.includes('<svg')) return { ok: false, error: '这不是一段 SVG' };
  return { ok: true, svg: out };
}
