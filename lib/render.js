// 르네 카드 — HTML 틀을 Browser Rendering(BROWSER 바인딩)으로 찍어 JPEG 로. 바인딩이 없으면 renderReady=false(호출자가 알린다).
// 디자인: 르네 브랜드 — 종이(#f2f1ed) 위 먹(#292c26), 라일락, LED(#3fe3d2). 큰 글자가 곧 그림이다.
export const renderReady = (env) => !!env.BROWSER;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const br = (s) => esc(s).replace(/\\n|\n/g, '<br>');
const FONT = '<link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css">';

export const WORDMARK = (ink = '#292c26', dot = '#3fe3d2') => `<svg viewBox="0 0 418 152" fill="none"><g stroke="${ink}" stroke-width="17" stroke-linecap="round" stroke-linejoin="round"><path d="M22 127V61M22 88C25 62 47 52 66 62"/><path d="M98 91H160C161 49 96 47 96 91C96 126 131 140 160 119"/><path d="M194 127V61M194 88C194 49 255 49 255 88V127"/><path d="M291 91H353C354 49 289 47 289 91C289 126 324 140 353 119"/><path d="M318 32L336 16"/></g><circle cx="392" cy="123" r="13" fill="${dot}"/></svg>`;

const CSS = `*{box-sizing:border-box;margin:0;padding:0}
html,body{background:#f2f1ed}
body{font-family:Pretendard,"Apple SD Gothic Neo","Noto Sans KR",sans-serif;color:#292c26;-webkit-font-smoothing:antialiased;word-break:keep-all;overflow-wrap:break-word}
.f{position:relative;overflow:hidden;background:#f2f1ed;width:1080px}
.top{position:absolute;left:72px;right:72px;top:64px;display:flex;align-items:center;justify-content:space-between}
.wm{height:40px;width:110px}.wm svg{height:100%;width:auto;display:block}
.pg{font:700 26px Pretendard;color:#a3a39c;letter-spacing:.02em}
.foot{position:absolute;left:72px;right:72px;bottom:56px;display:flex;justify-content:space-between;align-items:center;font:600 26px Pretendard;color:#a3a39c}
.kick{display:inline-flex;align-items:center;gap:14px;padding:12px 24px;border-radius:999px;background:#dccbe0;font:800 30px Pretendard;letter-spacing:-.01em}
.kick::before{content:"";width:14px;height:14px;border-radius:50%;background:#3fe3d2;box-shadow:0 0 12px #3fe3d2}
h1{font-weight:900;letter-spacing:-.045em;line-height:1.08}
.sub{font-weight:600;font-size:40px;letter-spacing:-.025em;line-height:1.4;color:#6d6e68}
.ph{border-radius:40px;overflow:hidden;background:#e1ddd3 center/cover no-repeat;box-shadow:0 30px 60px -24px rgba(41,44,38,.35)}
.win{background:#fbfaf7;border:2px solid #e1ddd3;border-radius:40px;box-shadow:0 30px 60px -20px rgba(41,44,38,.18);overflow:hidden}
.bar{height:84px;border-bottom:2px solid #e1ddd3;display:flex;align-items:center;gap:14px;padding:0 34px;font:900 30px Pretendard;letter-spacing:-.03em}
.bar i{width:16px;height:16px;border-radius:50%;background:#3fe3d2;box-shadow:0 0 12px #3fe3d2}
.msgs{padding:40px 34px;display:flex;flex-direction:column;gap:26px}
.bub{max-width:82%;padding:30px 36px;border-radius:34px;font:600 40px/1.42 Pretendard;letter-spacing:-.02em}
.me{margin-left:auto;background:#292c26;color:#fff;border-bottom-right-radius:10px}
.ai{background:#efede6;border-bottom-left-radius:10px}
.who{font:800 24px Pretendard;color:#a3a39c;margin:0 0 -14px 10px;display:flex;align-items:center;gap:10px}
.who i{width:12px;height:12px;border-radius:50%;background:#3fe3d2}
ul{list-style:none;display:flex;flex-direction:column;gap:34px}
li{display:flex;gap:30px;align-items:flex-start;font:800 60px/1.25 Pretendard;letter-spacing:-.035em}
li::before{content:"";flex:none;width:24px;height:24px;margin-top:24px;border-radius:50%;background:#3fe3d2;box-shadow:0 0 14px #3fe3d2}
.cbox{display:flex;align-items:center;gap:22px;background:#fbfaf7;border:2px solid #e1ddd3;border-radius:999px;padding:22px 26px 22px 34px;font:600 38px Pretendard;color:#a3a39c}
.cbox b{color:#292c26;font-weight:900}
.cbox .send{margin-left:auto;padding:16px 30px;border-radius:999px;background:#292c26;color:#fff;font:800 30px Pretendard}
.dm{display:inline-flex;align-items:center;gap:16px;background:#dccbe0;border-radius:32px 32px 32px 10px;padding:24px 32px;font:700 34px Pretendard;letter-spacing:-.02em}
.dm i{width:14px;height:14px;border-radius:50%;background:#3fe3d2;box-shadow:0 0 12px #3fe3d2}`;

function frame(inner, { h, idx, total, handle }) {
  const pg = total > 1 ? `<span class="pg">${idx}/${total}</span>` : '';
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8">${FONT}<style>${CSS}</style></head><body>
<div class="f" style="height:${h}px"><div class="top"><span class="wm">${WORDMARK()}</span>${pg}</div>${inner}
<div class="foot"><span>${handle ? '@' + esc(handle) : ''}</span><span></span></div></div></body></html>`;
}
const titleSize = (t, big = 132) => { const longest = Math.max(...String(t || '').split(/\\n|\n/).map((l) => l.length), 1); return longest > 11 ? Math.round(big * 0.7) : longest > 8 ? Math.round(big * 0.84) : big; };

// card: {t, ...} · ctx: {photo(url), idx, total, handle, story}
export function cardHtml(card, ctx = {}) {
  const h = ctx.story ? 1920 : 1350;
  const photo = ctx.photo ? `background-image:url('${esc(ctx.photo)}')` : '';
  const c = card || {};
  let inner = '';
  switch (c.t) {
    case 'photo':
      inner = `<div class="ph" style="position:absolute;left:72px;right:72px;top:150px;height:${h - 560}px;${photo}"></div>
<div style="position:absolute;left:72px;right:72px;bottom:130px"><h1 style="font-size:${titleSize(c.title, 96)}px">${br(c.title)}</h1>${c.sub ? `<p class="sub" style="margin-top:20px">${br(c.sub)}</p>` : ''}</div>`;
      break;
    case 'chat': {
      const lines = (c.lines || []).slice(0, 4).map((l) => l.who === 'me'
        ? `<div class="bub me">${br(l.text)}</div>`
        : `<div class="who"><i></i>르네</div><div class="bub ai">${br(l.text)}</div>`).join('');
      inner = `${c.title ? `<h1 style="position:absolute;left:72px;right:72px;top:170px;font-size:${titleSize(c.title, 88)}px">${br(c.title)}</h1>` : ''}
<div class="win" style="position:absolute;left:72px;right:72px;top:${c.title ? 420 : 190}px"><div class="bar"><i></i>르네</div><div class="msgs">${lines}</div></div>`;
      break;
    }
    case 'list':
      inner = `<h1 style="position:absolute;left:72px;right:72px;top:190px;font-size:${titleSize(c.title, 108)}px">${br(c.title)}</h1>
<ul style="position:absolute;left:72px;right:72px;top:${h === 1920 ? 760 : 620}px;gap:48px">${(c.items || []).slice(0, 4).map((x) => `<li>${br(x)}</li>`).join('')}</ul>`;
      break;
    case 'end':
      inner = `<div style="position:absolute;left:72px;right:72px;top:${h === 1920 ? 520 : 300}px;display:flex;flex-direction:column;gap:56px">
<h1 style="font-size:${titleSize(c.title, 120)}px">${br(c.title)}</h1>
<div class="cbox"><b>${esc(c.kw || '르네')}</b><span>댓글 달기…</span><span class="send">게시</span></div>
<div class="dm"><i></i>${br(c.note || 'DM 으로 보내드려요')}</div></div>
<div style="position:absolute;left:72px;bottom:150px;width:460px">${WORDMARK()}</div>`;
      break;
    default: { // cover
      const withPhoto = !!ctx.photo;
      inner = `<div style="position:absolute;left:72px;right:72px;top:180px">${c.kicker ? `<span class="kick">${esc(c.kicker)}</span>` : ''}
<h1 style="margin-top:40px;font-size:${titleSize(c.title, withPhoto ? 116 : 140)}px">${br(c.title)}</h1>${c.sub ? `<p class="sub" style="margin-top:30px">${br(c.sub)}</p>` : ''}</div>
${withPhoto ? `<div class="ph" style="position:absolute;left:72px;right:72px;bottom:130px;height:${h === 1920 ? 900 : 520}px;${photo}"></div>` : ''}`;
    }
  }
  return frame(inner, { h, idx: ctx.idx || 1, total: ctx.total || 1, handle: ctx.handle || '' });
}

// 여러 장을 한 브라우저에서 — 무료 요금제 브라우저 시간을 아낀다. 실패한 장은 null.
export async function renderMany(env, jobs) {
  if (!env.BROWSER) return jobs.map(() => null);
  const { default: puppeteer } = await import('@cloudflare/puppeteer');
  let browser;
  try { browser = await puppeteer.launch(env.BROWSER); }
  catch (e) { console.error('render launch', e && e.message); return jobs.map(() => null); } // 브라우저 한도·장애 — 글은 살리고 카드는 「다시 찍기」로
  const out = [];
  try {
    const page = await browser.newPage();
    for (const j of jobs) {
      try {
        await page.setViewport({ width: 1080, height: j.height, deviceScaleFactor: 1 });
        await page.setContent(j.html, { waitUntil: 'networkidle0', timeout: 20000 });
        try { await page.evaluate(() => document.fonts && document.fonts.ready); } catch { /* 글꼴 대기 실패는 무시 */ }
        const buf = await page.screenshot({ type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: 1080, height: j.height } });
        out.push(new Uint8Array(buf));
      } catch (e) { console.error('render', e && e.message); out.push(null); }
    }
  } finally { try { await browser.close(); } catch { /* 이미 닫힘 */ } }
  return out;
}
