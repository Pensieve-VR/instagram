// 배포 — Cloudflare Workers Builds 의 배포 명령: node scripts/deploy.mjs
// 1) wrangler deploy (코드·바인딩·크론)
// 2) 빌드 변수(설정 › 빌드 › 변수 및 암호)에 넣은 비밀을 런타임 비밀로 옮긴다 — 값은 표준 입력으로만 넘기고 어디에도 찍지 않는다.
import { spawnSync } from 'node:child_process';

// 앱 ID·구성 ID 는 비밀이 아니라 wrangler.jsonc vars 에 둔다 — 같은 이름을 비밀로 올리면 배포가 충돌한다
const SECRETS = ['PASSWORDS', 'ANTHROPIC_API_KEY', 'SESSION_SECRET', 'IG_APP_SECRET', 'THREADS_APP_SECRET'];
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const deploy = spawnSync(npx, ['wrangler', 'deploy'], { stdio: 'inherit' });
console.log(`[deploy] wrangler deploy 종료 코드 ${deploy.status}`);

const found = Object.fromEntries(SECRETS.filter((k) => String(process.env[k] || '').trim()).map((k) => [k, String(process.env[k]).trim()]));
const names = Object.keys(found);
let syncOk = true;
if (!names.length) {
  console.log('[deploy] 빌드 변수에 비밀이 없어 옮길 것이 없습니다 — 런타임 비밀은 그대로 둡니다');
} else {
  console.log(`[deploy] 빌드 변수의 비밀 ${names.length}개를 런타임으로 옮깁니다: ${names.join(', ')}`);
  const bulk = spawnSync(npx, ['wrangler', 'secret', 'bulk'], { input: JSON.stringify(found), stdio: ['pipe', 'inherit', 'inherit'] });
  syncOk = bulk.status === 0;
  console.log(syncOk ? '[deploy] 비밀 옮기기 완료' : `[deploy] ⚠ 비밀 옮기기 실패(코드 ${bulk.status}) — 설정 › 변수 및 비밀(런타임)에 직접 넣어 주세요`);
}
process.exit(deploy.status === 0 && syncOk ? 0 : 1);
