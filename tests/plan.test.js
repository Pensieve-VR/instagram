import test from 'node:test';
import assert from 'node:assert/strict';
import { kstParts, kstMs, dayKey, weekStart, transition, problems, suggestTimes, cleanTags, clip, composeCaption, DAY, FORMATS, normalizeBrand, DEFAULT_BRAND } from '../lib/plan.js';

test('KST 변환 — 자정 경계', () => {
  const ms = Date.UTC(2026, 10, 3, 15, 30); // UTC 11-03 15:30 = KST 11-04 00:30
  assert.deepEqual(kstParts(ms), { y: 2026, m: 10, d: 4, dow: 3, h: 0, min: 30 });
  assert.equal(dayKey(ms), '2026-11-04');
  assert.equal(kstMs(2026, 10, 4, 0, 30), ms);
  assert.equal(dayKey(weekStart(ms)), '2026-11-02'); // 월요일
});

test('transition — 사람 행동만', () => {
  assert.equal(transition('review', 'approve'), 'scheduled');
  assert.equal(transition('review', 'skip'), 'skipped');
  assert.equal(transition('scheduled', 'hold'), 'review');
  assert.equal(transition('failed', 'retry'), 'scheduled');
  assert.equal(transition('skipped', 'restore'), 'review');
  assert.equal(transition('posted', 'skip'), null);
  assert.equal(transition('publishing', 'hold'), null);
  assert.equal(transition('review', 'publish'), null);
});

const linked = { platform: 'ig', status: 'linked' };
const img = { kind: 'image', key: 'a/1.jpg' }; const vid = { kind: 'video', key: 'a/2.mp4' };

test('problems — 형식별 장 수·종류·글 길이·연결', () => {
  assert.deepEqual(problems({ format: 'image', caption: 'a', media: [img] }, linked), []);
  assert.ok(problems({ format: 'carousel', caption: '', media: [img] }, linked).some((p) => /2장/.test(p)));
  assert.ok(problems({ format: 'carousel', caption: '', media: Array(21).fill(img) }, linked).some((p) => /20장/.test(p)));
  assert.ok(problems({ format: 'reel', caption: '', media: [img] }, linked).some((p) => /영상/.test(p)));
  assert.ok(problems({ format: 'image', caption: '', media: [vid] }, linked).some((p) => /사진/.test(p)));
  assert.ok(problems({ format: 'image', caption: 'x'.repeat(2201), media: [img] }, linked).some((p) => /2200/.test(p)));
  assert.ok(problems({ format: 'text', caption: 'x'.repeat(501), media: [] }, { platform: 'th', status: 'linked' }).some((p) => /500/.test(p)));
  assert.ok(problems({ format: 'text', caption: '', media: [] }, { platform: 'th', status: 'linked' }).some((p) => /글/.test(p)));
  assert.ok(problems({ format: 'image', caption: 'a', media: [img] }, { platform: 'ig', status: 'planned' }).some((p) => /연결/.test(p)));
  assert.ok(problems({ format: 'story', caption: '', media: [img] }, { platform: 'th', status: 'linked' }).some((p) => /형식/.test(p)));
  assert.ok(problems({ format: 'image', caption: 'a', media: [img] }, null).some((p) => /계정/.test(p)));
  const now = Date.UTC(2026, 10, 4);
  assert.ok(problems({ state: 'review', scheduled_at: now - 3600e3, format: 'image', caption: 'a', media: [img] }, linked, now).some((p) => /시간이 지났/.test(p)));
  assert.deepEqual(problems({ state: 'scheduled', scheduled_at: now - 3600e3, format: 'image', caption: 'a', media: [img] }, linked, now), []); // 예약된 것은 크론이 올린다
  assert.deepEqual(problems({ state: 'review', scheduled_at: now + 3600e3, format: 'image', caption: 'a', media: [img] }, linked, now), []);
});

test('FORMATS — 플랫폼마다 허용 형식', () => {
  assert.deepEqual(Object.keys(FORMATS.ig), ['image', 'carousel', 'reel', 'story']);
  assert.deepEqual(Object.keys(FORMATS.th), ['text', 'image', 'video', 'carousel']);
});

test('suggestTimes — 계정마다 하루 하나, 그 계정 시간대, 이미 찬 날은 건너뜀', () => {
  const now = kstMs(2026, 10, 4, 16, 0); // 수 16:00
  const accounts = { a1: { platform: 'ig', slot: '20:00' }, a2: { platform: 'th', slot: '' } };
  const items = [{ account_id: 'a1' }, { account_id: 'a1' }, { account_id: 'a2' }, { account_id: 'a2' }];
  const existing = [{ account_id: 'a1', scheduled_at: kstMs(2026, 10, 5, 20, 0) }]; // 목요일은 이미 있음
  const t = suggestTimes(items, { accounts, existing, now });
  assert.equal(dayKey(t[0]), '2026-11-04'); // 오늘 20:00 은 아직 4시간 남음
  assert.equal(kstParts(t[0]).h, 20);
  assert.equal(dayKey(t[1]), '2026-11-06'); // 목요일은 차 있어 금요일
  assert.equal(dayKey(t[2]), '2026-11-05'); // Threads 기본 12:30 — 오늘은 지났다
  assert.equal(kstParts(t[2]).h * 60 + kstParts(t[2]).min, 12 * 60 + 30);
  assert.equal(dayKey(t[3]), '2026-11-06');
});

test('suggestTimes — 고정 게시물 셋은 같은 날 5분 간격으로 잇달아', () => {
  const now = kstMs(2026, 10, 4, 21, 0);
  const accounts = { a1: { platform: 'ig', slot: '20:00' } };
  const items = [{ account_id: 'a1', pinned: true }, { account_id: 'a1', pinned: true }, { account_id: 'a1', pinned: true }, { account_id: 'a1' }];
  const t = suggestTimes(items, { accounts, existing: [], now });
  assert.deepEqual(t.slice(0, 3).map((x) => dayKey(x)), ['2026-11-05', '2026-11-05', '2026-11-05']);
  assert.equal(t[1] - t[0], 5 * 60e3);
  assert.equal(t[2] - t[1], 5 * 60e3);
  assert.equal(dayKey(t[3]), '2026-11-06');
});

test('suggestTimes — 시간이 이미 정해진 항목은 그대로 두고 그 날을 찬 것으로', () => {
  const now = kstMs(2026, 10, 4, 9, 0);
  const at = kstMs(2026, 10, 4, 21, 0);
  const t = suggestTimes([{ account_id: 'a1', at }, { account_id: 'a1' }], { accounts: { a1: { platform: 'ig' } }, existing: [], now });
  assert.equal(t[0], at);
  assert.equal(dayKey(t[1]), '2026-11-05');
});

test('cleanTags · clip · composeCaption', () => {
  assert.deepEqual(cleanTags(['#르네', '르네', 'AI 펫', '', '#a#b']), ['르네', 'AI펫', 'ab']);
  assert.equal(cleanTags(Array.from({ length: 40 }, (_, i) => 't' + i)).length, 30);
  assert.equal(clip('가나다라', 3), '가나…');
  assert.equal(composeCaption({ caption: '본문', hashtags: '르네 AI펫' }, 'ig'), '본문\n\n#르네 #AI펫');
  assert.equal(composeCaption({ caption: '본문', hashtags: '르네' }, 'th'), '본문');
});

test('normalizeBrand — 손상 입력은 기본으로, 목록은 줄 단위', () => {
  const b = normalizeBrand({ facts: '하나\n\n둘', banned: ['품절'], kw: { ko: '르네' }, link: 'pensieve.kr/early' });
  assert.deepEqual(b.facts, ['하나', '둘']);
  assert.deepEqual(b.banned, ['품절']);
  assert.equal(b.kw.en, DEFAULT_BRAND.kw.en);
  assert.equal(b.link, 'https://pensieve.kr/early');
  assert.deepEqual(normalizeBrand(null).facts, DEFAULT_BRAND.facts);
});

test('하루 일 틱 — 00:00~00:04 UTC 만', async () => {
  const { isDailyTick } = await import('../src/index.js');
  assert.equal(isDailyTick(Date.UTC(2026, 10, 4, 0, 0)), true);
  assert.equal(isDailyTick(Date.UTC(2026, 10, 4, 0, 5)), false);
  assert.equal(isDailyTick(Date.UTC(2026, 10, 4, 12, 0)), false);
  assert.equal(DAY, 86400e3);
});
