import test from 'node:test';
import assert from 'node:assert/strict';
import { kstParts, kstMs, dayStart, dayKey, weekStart, nextSlots, pickAngle, transition, isDue, validHandle, cleanHandle, cleanTags, clip, mergeSettings, DEFAULT_SETTINGS, ANGLE_KEYS, signals, DAY } from '../lib/plan.js';

test('KST 변환 — 자정 경계', () => {
  // 2026-11-02 00:30 KST = 2026-11-01 15:30 UTC
  const ms = Date.UTC(2026, 10, 1, 15, 30);
  const p = kstParts(ms);
  assert.equal(p.y, 2026); assert.equal(p.m, 10); assert.equal(p.d, 2); assert.equal(p.h, 0); assert.equal(p.min, 30); assert.equal(p.dow, 1);
  assert.equal(dayKey(ms), '2026-11-02');
  assert.equal(dayStart(ms), kstMs(2026, 10, 2));
  assert.equal(weekStart(ms), kstMs(2026, 10, 2)); // 월요일
  assert.equal(weekStart(kstMs(2026, 10, 8, 23)), kstMs(2026, 10, 2)); // 일요일 밤도 같은 주
});

test('nextSlots — 범위·중복·정렬', () => {
  const from = kstMs(2026, 10, 2, 9); // 월 09:00
  const until = from + 7 * DAY;
  const slots = DEFAULT_SETTINGS.ig.slots; // 화·금 20:00
  const out = nextSlots(slots, from, until);
  assert.deepEqual(out, [kstMs(2026, 10, 3, 20), kstMs(2026, 10, 6, 20)]);
  const taken = new Set([kstMs(2026, 10, 3, 20)]);
  assert.deepEqual(nextSlots(slots, from, until, taken), [kstMs(2026, 10, 6, 20)]);
  assert.deepEqual(nextSlots(slots, from, from), []);
  assert.deepEqual(nextSlots([], from, until), []);
  // from 과 같은 시각은 제외(열린 구간), until 은 포함 — 월 09:00 슬롯은 from 그 자체라 빠지고, 화 09:00 슬롯은 until 에 걸려 들어온다
  assert.deepEqual(nextSlots([{ dow: 1, hm: '09:00' }], from, from + DAY), []);
  assert.deepEqual(nextSlots([{ dow: 2, hm: '09:00' }], from, from + DAY), [from + DAY]);
});

test('pickAngle — 가장 오래 안 쓴 각도', () => {
  assert.equal(pickAngle([], ANGLE_KEYS), 'feature');
  assert.equal(pickAngle(['feature'], ANGLE_KEYS), 'problem');
  assert.equal(pickAngle(ANGLE_KEYS, ANGLE_KEYS), 'feature');
  assert.equal(pickAngle(['feature', 'problem', 'feature'], ['feature', 'problem']), 'problem');
  assert.equal(pickAngle(['x'], ['nope']), 'feature'); // 허용 목록이 비정상이면 기본
});

test('transition — 허용·거부', () => {
  assert.equal(transition('review', 'approve'), 'scheduled');
  assert.equal(transition('draft', 'approve'), 'scheduled');
  assert.equal(transition('posted', 'approve'), null);
  assert.equal(transition('scheduled', 'hold'), 'review');
  assert.equal(transition('scheduled', 'start'), 'publishing');
  assert.equal(transition('publishing', 'posted'), 'posted');
  assert.equal(transition('publishing', 'fail', { attempts: 1 }), 'scheduled');
  assert.equal(transition('publishing', 'fail', { attempts: 3 }), 'failed');
  assert.equal(transition('failed', 'retry'), 'scheduled');
  assert.equal(transition('posted', 'skip'), null);
  assert.equal(transition('review', 'nonsense'), null);
  assert.equal(isDue({ state: 'scheduled', scheduled_at: 10 }, 10), true);
  assert.equal(isDue({ state: 'scheduled', scheduled_at: 11 }, 10), false);
  assert.equal(isDue({ state: 'review', scheduled_at: 1 }, 10), false);
});

test('handle 규칙', () => {
  for (const good of ['delka.kr', 'a', 'pensieve_vr', 'x.y_z9', '@Upper.Case']) assert.equal(validHandle(good), true, good);
  for (const bad of ['', '.start', 'end.', 'dou..ble', 'has space', 'ko한글', 'a'.repeat(31), '-dash']) assert.equal(validHandle(bad), false, bad);
  assert.equal(cleanHandle(' @Delka.KR '), 'delka.kr');
});

test('cleanTags · clip', () => {
  assert.deepEqual(cleanTags(['#펜시브', '펜시브', 'a b', '#VR!', '', 'x', 'y', 'z']), ['펜시브', 'ab', 'VR', 'x', 'y']);
  assert.deepEqual(cleanTags('#a #b, c'), ['a', 'b', 'c']);
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('abc', 4), 'abc');
  assert.equal(clip('', 4), '');
});

test('mergeSettings — 손상 입력을 기본으로', () => {
  const s = mergeSettings({ approval: 'weird', ig: { slots: [{ dow: 9, hm: '20:00' }, { dow: 2, hm: '25:00' }, { dow: 2, hm: '20:00' }, { dow: 2, hm: '20:00' }] }, th: { slots: 'nope' }, angles: ['feature', 'bogus'], boost: { daily: -5 }, tone: 'x'.repeat(500) });
  assert.equal(s.approval, 'review');
  assert.deepEqual(s.ig.slots, [{ dow: 2, hm: '20:00' }]);
  assert.deepEqual(s.th.slots, DEFAULT_SETTINGS.th.slots);
  assert.deepEqual(s.angles, ['feature']);
  assert.equal(s.boost.daily, 0);
  assert.equal(s.tone.length, 400);
  assert.deepEqual(mergeSettings(null).ig.slots, DEFAULT_SETTINGS.ig.slots);
  assert.deepEqual(mergeSettings({ ig: { slots: [] } }).ig.slots, []); // 빈 배열은 "안 올림"이라는 뜻 — 기본으로 되돌리지 않는다
  // 프로필은 있을 때만 들고 간다(설정 저장이 프로필을 지우던 버그의 회귀 방어)
  assert.equal('profile' in mergeSettings({}), false);
  assert.deepEqual(mergeSettings({ profile: { bio: 'b', palette: 'bad', monogram: 'ABC' } }).profile, { bio: 'b', link_text: '', monogram: 'AB', palette: 'rose' });
  assert.deepEqual(mergeSettings({ ...mergeSettings({ profile: { bio: 'x', palette: 'teal' } }), approval: 'auto' }).profile, { bio: 'x', link_text: '', monogram: '', palette: 'teal' });
});

test('signals', () => {
  const now = 1000 * DAY;
  const ok = signals({ channels: [{ kind: 'ig', hasToken: true, status: 'linked', token_exp: now + 30 * DAY }], posts: [], nowMs: now });
  assert.deepEqual(ok.map((s) => s.level), ['ok']);
  const warn = signals({ channels: [{ kind: 'th', hasToken: true, status: 'linked', token_exp: now + 3 * DAY }], posts: [{ state: 'review' }], nowMs: now });
  assert.deepEqual(warn.map((s) => s.kind), ['token', 'review']);
  const bad = signals({ channels: [{ kind: 'ig', hasToken: false }, { kind: 'th', hasToken: true, status: 'expired' }], posts: [{ state: 'failed' }], nowMs: now });
  assert.deepEqual(bad.map((s) => s.kind), ['unlinked', 'expired', 'failed']);
});
