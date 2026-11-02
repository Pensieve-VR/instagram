// 문법 검사 — 모든 JS 를 모듈로 파싱해 본다. 깨진 채로 올리지 않는다. (npm run check)
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const files = [];
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f);
    if (f === 'node_modules' || f.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p); else if (/\.m?js$/.test(f)) files.push(p);
  }
};
walk(process.cwd());
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--input-type=module', '--check'], { input: readFileSync(f, 'utf8'), stdio: ['pipe', 'ignore', 'pipe'] }); }
  catch (e) { bad++; console.error(`${f}: ${String(e.stderr || '').split('\n').find((x) => /Error/.test(x)) || '문법 오류'}`); }
}
console.log(bad ? `문법 오류 ${bad}` : `${files.length}개 파일 문법 통과`);
process.exit(bad ? 1 : 0);
