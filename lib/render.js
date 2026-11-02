// 카드 이미지 — HTML 템플릿을 Browser Rendering(BROWSER 바인딩)으로 찍어 JPEG 로. 바인딩이 없으면 null(호출자가 대체 경로).
// 디자인은 페이퍼 노트: 종이 위에 먹. 각도마다 잉크 색 하나.

const ACCENT = { feature: '#3d7f7a', problem: '#a85c45', compare: '#4a5680', behind: '#8a6f52', question: '#7a6195', number: '#92742b', scene: '#b45a6a', notice: '#37322b' };
const PALETTE = { rose: '#b45a6a', navy: '#4a5680', teal: '#3d7f7a', ochre: '#92742b', violet: '#7a6195' };

const esc = (s) => String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FONT = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/pretendard@1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css">';
const BASE = `*{box-sizing:border-box;margin:0}html,body{width:100%;height:100%}body{font-family:"Pretendard Variable",Pretendard,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;background:#f4efe5;color:#37322b;-webkit-font-smoothing:antialiased;word-break:keep-all;overflow-wrap:break-word}`;

// Instagram 피드 카드 1080×1350 (4:5). headline 이 곧 그림이다.
export function cardHtml({ headline, sub, bullets = [], angle = 'feature', service = '', handle = '' }) {
  const ink = ACCENT[angle] || ACCENT.notice;
  const lines = (bullets || []).filter(Boolean).slice(0, 3);
  const size = headline && headline.length > 10 ? (headline.length > 16 ? 88 : 104) : 124;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">${FONT}<style>${BASE}
.card{position:relative;width:1080px;height:1350px;padding:96px 96px 88px;background:#fcf9f2;display:flex;flex-direction:column}
.card::before{content:"";position:absolute;inset:0;background-image:radial-gradient(#7d6c4c30 1.2px,transparent 1.3px);background-size:22px 22px;pointer-events:none}
.rail{position:absolute;left:96px;right:96px;top:72px;height:10px;border-radius:5px;background:${ink}}
.rail::after{content:"";position:absolute;left:0;top:-13px;width:36px;height:36px;border-radius:50%;background:#fcf9f2;border:9px solid ${ink}}
.eyebrow{position:relative;margin-top:48px;font-size:30px;font-weight:650;color:#6d6456;letter-spacing:.02em}
h1{position:relative;margin-top:54px;font-size:${size}px;line-height:1.14;font-weight:800;letter-spacing:-.03em;text-wrap:balance}
.sub{position:relative;margin-top:40px;font-size:44px;line-height:1.4;font-weight:500;color:#6d6456;max-width:860px}
ul{position:relative;list-style:none;margin-top:56px;display:grid;gap:22px}
li{font-size:38px;line-height:1.35;font-weight:600;padding-left:50px;position:relative}
li::before{content:"";position:absolute;left:4px;top:18px;width:18px;height:18px;border-radius:50%;background:${ink}}
.foot{position:relative;margin-top:auto;display:flex;align-items:center;justify-content:space-between;font-size:30px;color:#6d6456;font-weight:600}
.foot b{color:#37322b;font-weight:800;font-size:34px}
</style></head><body><div class="card"><div class="rail"></div>
<div class="eyebrow">${esc(service)}</div>
<h1>${esc(headline)}</h1>
${sub ? `<p class="sub">${esc(sub)}</p>` : ''}
${lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : ''}
<div class="foot"><b>${handle ? '@' + esc(handle) : ''}</b><span>${esc(service)}</span></div>
</div></body></html>`;
}

// 프로필 이미지 1080×1080 — 글자 한두 자. 로고를 주면 이 대신 로고를 쓴다.
export function monogramHtml({ monogram = 'P', palette = 'rose' }) {
  const ink = PALETTE[palette] || PALETTE.rose;
  const text = String(monogram || 'P').slice(0, 2);
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">${FONT}<style>${BASE}
.m{width:1080px;height:1080px;display:grid;place-items:center;background:#fcf9f2;position:relative}
.m::before{content:"";position:absolute;inset:0;background-image:radial-gradient(#7d6c4c30 1.2px,transparent 1.3px);background-size:22px 22px}
.ring{position:absolute;inset:120px;border-radius:50%;border:26px solid ${ink}}
.dot{position:absolute;left:50%;top:94px;width:72px;height:72px;margin-left:-36px;border-radius:50%;background:#fcf9f2;border:18px solid ${ink}}
span{position:relative;font-size:${text.length > 1 ? 380 : 480}px;font-weight:800;letter-spacing:-.05em;color:#37322b}
</style></head><body><div class="m"><div class="ring"></div><div class="dot"></div><span>${esc(text)}</span></div></body></html>`;
}
export const monogramSvg = ({ monogram = 'P', palette = 'rose' }) => {
  const ink = PALETTE[palette] || PALETTE.rose; const text = esc(String(monogram || 'P').slice(0, 2));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1080"><rect width="1080" height="1080" fill="#fcf9f2"/><circle cx="540" cy="540" r="407" fill="none" stroke="${ink}" stroke-width="26"/><circle cx="540" cy="130" r="27" fill="#fcf9f2" stroke="${ink}" stroke-width="18"/><text x="540" y="700" text-anchor="middle" font-family="Pretendard Variable,Pretendard,Apple SD Gothic Neo,sans-serif" font-weight="800" font-size="${text.length > 1 ? 380 : 480}" fill="#37322b" letter-spacing="-20">${text}</text></svg>`;
};

export const renderReady = (env) => !!env.BROWSER;

// HTML → JPEG(Uint8Array). Instagram 은 JPEG 만 받는다.
export async function renderJpeg(env, html, { width, height, quality = 92 }) {
  if (!env.BROWSER) return null;
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 20000 });
    try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch { /* 글꼴 대기 실패는 무시 */ }
    const buf = await page.screenshot({ type: 'jpeg', quality, clip: { x: 0, y: 0, width, height } });
    return new Uint8Array(buf);
  } finally {
    try { await browser.close(); } catch { /* 이미 닫힘 */ }
  }
}

// 올린 이미지가 PNG 등이면 JPEG 로 바꾼다(Instagram 용). 브라우저가 없으면 null.
export async function toJpeg(env, bytes, mime) {
  if (!env.BROWSER) return null;
  const b64 = btoa(String.fromCharCode(...bytes));
  const html = `<!doctype html><html><head><style>html,body{margin:0;background:#fff}img{display:block;max-width:1080px;max-height:1350px}</style></head><body><img id="i" src="data:${mime};base64,${b64}"></body></html>`;
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1350, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'load', timeout: 20000 });
    const el = await page.$('#i');
    const buf = await el.screenshot({ type: 'jpeg', quality: 92 });
    return new Uint8Array(buf);
  } finally { try { await browser.close(); } catch { /* 닫힘 */ } }
}
