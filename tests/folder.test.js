import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { groupFiles, naturalCmp } from '../public/js/folder.js';

// 2026-11-04 에 만든 실제 르네 폴더의 파일 목록(경로만)
const PATHS = readFileSync(new URL('./fixtures/rene-folder.txt', import.meta.url), 'utf8').split('\n').filter(Boolean);
const groups = groupFiles(PATHS);
const of = (platform, lang) => groups.filter((g) => g.platform === platform && g.lang === lang);
const byTitle = (list, part) => list.find((g) => g.title.includes(part));

test('naturalCmp — 숫자 앞머리를 수로 비교', () => {
  assert.deepEqual(['10_a', '2_b', '01_c'].sort(naturalCmp), ['01_c', '2_b', '10_a']);
});

test('Instagram KO — 고정 3 · 릴스 3 · 피드 5 · 스토리 4, 프로필·하이라이트는 건너뜀', () => {
  const ig = of('ig', 'ko');
  assert.equal(ig.filter((g) => g.format === 'carousel').length, 3 + 5);
  assert.equal(ig.filter((g) => g.format === 'reel').length, 3);
  assert.equal(ig.filter((g) => g.format === 'story').length, 4);
  assert.equal(ig.length, 15);
  assert.ok(!ig.some((g) => /프로필|하이라이트/.test(g.dir)));
});

test('순서 — 폴더 번호 순, 고정 셋이 맨 앞', () => {
  const ig = of('ig', 'ko');
  assert.deepEqual(ig.slice(0, 3).map((g) => g.pinned), [true, true, true]);
  assert.match(ig[0].title, /고정 오른쪽 먼저/);
  assert.match(ig[3].title, /릴스 R1/);
  assert.equal(ig.findIndex((g) => g.format === 'story'), 11);
});

test('캐러셀 장 순서 · 캡션 파일', () => {
  const p1 = byTitle(of('ig', 'ko'), 'P1 나만의AI펫');
  assert.equal(p1.format, 'carousel');
  assert.deepEqual(p1.media.map((m) => m.split('/').pop()), ['01.png', '02.png', '03.png', '04.png', '05.png']);
  assert.match(p1.caption, /캡션\.txt$/);
  assert.equal(p1.reply, '');
});

test('릴스 — 영상 하나 + 커버, 커버는 장에 넣지 않는다', () => {
  const r1 = byTitle(of('ig', 'ko'), '릴스 R1');
  assert.equal(r1.format, 'reel');
  assert.deepEqual(r1.media.map((m) => m.split('/').pop()), ['영상.mp4']);
  assert.match(r1.cover, /커버\.jpg$/);
});

test('스토리 — 사진마다 게시물 하나', () => {
  const st = of('ig', 'ko').filter((g) => g.format === 'story');
  assert.deepEqual(st.map((g) => g.media.length), [1, 1, 1, 1]);
  assert.equal(st[0].caption, '');
});

test('Threads — 사진 2장 캐러셀 + 글 + 첫 댓글', () => {
  const th = of('th', 'ko');
  assert.equal(th.length, 6);
  for (const g of th) {
    assert.equal(g.format, 'carousel');
    assert.deepEqual(g.media.map((m) => m.split('/').pop()), ['1_제품사진.png', '2_사용화면.png']);
    assert.match(g.caption, /글\.txt$/);
    assert.match(g.reply, /첫댓글\.txt$/);
  }
});

test('영어 폴더는 lang=en, X 는 헤더 빼고 스레드 하나', () => {
  assert.equal(of('ig', 'en').length, 15);
  assert.equal(of('th', 'en').length, 6);
  const x = of('x', 'en');
  assert.equal(x.length, 1);
  assert.equal(x[0].format, 'thread');
  assert.deepEqual(x[0].media.map((m) => m.split('/').pop()), ['1_face.png', '2_lights.png', '3_show.png', '4_pick.png']);
  assert.match(x[0].caption, /첫스레드\.txt$/);
});

test('글 파일만 있는 Threads 폴더는 text, 미디어 없는 Instagram 폴더는 건너뜀', () => {
  const g = groupFiles(['r/스레드/T9_질문/글.txt', 'r/인스타/09_빈/캡션.txt']);
  assert.equal(g.length, 1);
  assert.equal(g[0].format, 'text');
  assert.equal(g[0].platform, 'th');
});

test('플랫폼을 모르는 폴더는 건너뜀', () => {
  assert.deepEqual(groupFiles(['r/아무거나/1.png']), []);
});
