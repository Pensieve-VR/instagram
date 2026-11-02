// 배포 빌드 때 index.html 의 CSS·JS 주소에 판 번호(커밋)를 붙인다 — 브라우저가 옛 파일을 붙잡지 않게.
// Cloudflare Workers Builds 빌드 명령: node scripts/stamp.mjs  (배포 명령: npx wrangler deploy)
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const v = (process.env.WORKERS_CI_COMMIT_SHA || process.env.CF_PAGES_COMMIT_SHA || Date.now().toString(36)).slice(0, 8);
const file = new URL('../public/index.html', import.meta.url);
let html = readFileSync(file, 'utf8');
const mods = readdirSync(new URL('../public/js/', import.meta.url)).filter((f) => f.endsWith('.js')).sort();
const map = JSON.stringify({ imports: Object.fromEntries(mods.map((m) => [`/js/${m}`, `/js/${m}?v=${v}`])) });
html = html
  .replace(/<script type="importmap">[^<]*<\/script>/, `<script type="importmap">${map}</script>`)
  .replace(/(\/app\.css|\/js\/main\.js)\?v=[\w-]+/g, `$1?v=${v}`);
writeFileSync(file, html);
console.log(`stamped v=${v} · ${mods.length} modules`);
