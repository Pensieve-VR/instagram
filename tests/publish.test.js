import test from 'node:test';
import assert from 'node:assert/strict';
import { step, containerParams } from '../lib/publish.js';

// 가짜 Meta — 부른 순서를 적고, 컨테이너 상태는 표로 정한다
function fake({ status = {}, failComment = false, failReply = false } = {}) {
  const calls = []; let n = 0;
  const api = {
    async create(params) { calls.push(['create', params]); if (failReply && params.reply_to_id) throw new Error('no permission'); n++; return 'c' + n; },
    async status(id) { calls.push(['status', id]); const s = status[id]; return typeof s === 'function' ? s() : { status: s || 'FINISHED', error: s === 'ERROR' ? '형식이 맞지 않음' : '' }; },
    async publish(id) { calls.push(['publish', id]); return 'P' + id; },
    async comment(mediaId, text) { calls.push(['comment', mediaId, text]); if (failComment) throw new Error('no permission'); return 'cm1'; },
  };
  return { api, calls };
}
const img = (n) => ({ url: `https://x/media/a/${n}.jpg`, kind: 'image' });
const vid = (n) => ({ url: `https://x/media/a/${n}.mp4`, kind: 'video' });

test('IG 사진 — 만들기 → 상태 → 게시', async () => {
  const { api, calls } = fake();
  const r = await step({ format: 'image', caption: '안녕', media: [img(1)] }, { platform: 'ig', api });
  assert.equal(r.state, 'posted');
  assert.equal(r.platform_post_id, 'Pc1');
  assert.deepEqual(calls[0], ['create', { image_url: 'https://x/media/a/1.jpg', caption: '안녕' }]);
  assert.deepEqual(calls.map((c) => c[0]), ['create', 'status', 'publish']);
});

test('IG 캐러셀 — 장마다 자식, 부모는 children 으로', async () => {
  const { api, calls } = fake();
  const r = await step({ format: 'carousel', caption: 'c', media: [img(1), img(2), vid(3)] }, { platform: 'ig', api });
  assert.equal(r.state, 'posted');
  const creates = calls.filter((c) => c[0] === 'create').map((c) => c[1]);
  assert.deepEqual(creates[0], { is_carousel_item: true, image_url: 'https://x/media/a/1.jpg' });
  assert.deepEqual(creates[2], { is_carousel_item: true, media_type: 'VIDEO', video_url: 'https://x/media/a/3.mp4' });
  assert.deepEqual(creates[3], { media_type: 'CAROUSEL', children: 'c1,c2,c3', caption: 'c' });
});

test('영상 자식이 처리 중이면 기다리고, 다음엔 자식을 다시 만들지 않는다', async () => {
  let ready = false;
  const { api, calls } = fake({ status: { c2: () => ({ status: ready ? 'FINISHED' : 'IN_PROGRESS' }) } });
  const post = { format: 'carousel', caption: '', media: [img(1), vid(2)] };
  const r1 = await step(post, { platform: 'ig', api });
  assert.equal(r1.state, 'publishing');
  assert.equal(r1.progress.items.length, 2);
  ready = true;
  const before = calls.filter((c) => c[0] === 'create').length;
  const r2 = await step({ ...post, progress: r1.progress }, { platform: 'ig', api });
  assert.equal(r2.state, 'posted');
  assert.equal(calls.filter((c) => c[0] === 'create').length - before, 1); // 부모만 새로
});

test('한 번에 쓸 수 있는 호출(budget)을 넘으면 멈췄다가 이어 간다', async () => {
  const { api } = fake();
  const post = { format: 'carousel', caption: '', media: [1, 2, 3, 4, 5].map(img) };
  const r1 = await step(post, { platform: 'ig', api, budget: 4 });
  assert.equal(r1.state, 'publishing');
  assert.equal(r1.progress.items.length, 4);
  const r2 = await step({ ...post, progress: r1.progress }, { platform: 'ig', api, budget: 40 });
  assert.equal(r2.state, 'posted');
});

test('컨테이너 ERROR → 실패와 이유', async () => {
  const { api } = fake({ status: { c1: 'ERROR' } });
  const r = await step({ format: 'image', caption: '', media: [img(1)] }, { platform: 'ig', api });
  assert.equal(r.state, 'failed');
  assert.match(r.error, /형식이 맞지 않음/);
});

test('컨테이너 EXPIRED → 처음부터 다시(진행 비움)', async () => {
  const { api } = fake({ status: { c1: 'EXPIRED' } });
  const r = await step({ format: 'image', caption: '', media: [img(1)] }, { platform: 'ig', api });
  assert.equal(r.state, 'publishing');
  assert.deepEqual(r.progress, { items: [] });
});

test('Threads 글 + 첫 댓글(답글) — reply_to_id 로 만들고 게시', async () => {
  const { api, calls } = fake();
  const r = await step({ format: 'text', caption: '본문', first_reply: '링크는 여기', media: [] }, { platform: 'th', api });
  assert.equal(r.state, 'posted');
  assert.deepEqual(calls[0], ['create', { media_type: 'TEXT', text: '본문' }]);
  const reply = calls.filter((c) => c[0] === 'create')[1][1];
  assert.deepEqual(reply, { media_type: 'TEXT', text: '링크는 여기', reply_to_id: 'Pc1' });
  assert.equal(calls.filter((c) => c[0] === 'publish').length, 2);
});

test('Threads 캐러셀 — 자식 media_type 명시, 부모 text', async () => {
  const { api, calls } = fake();
  await step({ format: 'carousel', caption: 't', media: [img(1), img(2)] }, { platform: 'th', api });
  const creates = calls.filter((c) => c[0] === 'create').map((c) => c[1]);
  assert.deepEqual(creates[0], { is_carousel_item: true, media_type: 'IMAGE', image_url: 'https://x/media/a/1.jpg' });
  assert.deepEqual(creates[2], { media_type: 'CAROUSEL', children: 'c1,c2', text: 't' });
});

test('첫 댓글이 실패해도 게시는 됐다 — 경고로 남긴다', async () => {
  const { api } = fake({ failComment: true });
  const r = await step({ format: 'image', caption: '', first_reply: '첫 댓글', media: [img(1)] }, { platform: 'ig', api });
  assert.equal(r.state, 'posted');
  assert.match(r.warn, /첫 댓글/);
  const t = fake({ failReply: true });
  const r2 = await step({ format: 'text', caption: 'a', first_reply: 'b', media: [] }, { platform: 'th', api: t.api });
  assert.equal(r2.state, 'posted');
  assert.match(r2.warn, /첫 댓글/);
});

test('이미 게시된 글은 다시 만들지 않고 댓글만 잇는다', async () => {
  const { api, calls } = fake();
  const r = await step({ format: 'text', caption: 'a', first_reply: 'b', media: [], platform_post_id: 'P9' }, { platform: 'th', api });
  assert.equal(r.state, 'posted');
  assert.equal(calls[0][1].reply_to_id, 'P9');
});

test('containerParams — 릴스·스토리·시험 릴스', () => {
  assert.deepEqual(containerParams('ig', { format: 'reel', caption: 'r', media: [vid(1)], cover_url: 'https://x/c.jpg' }),
    { media_type: 'REELS', video_url: 'https://x/media/a/1.mp4', caption: 'r', share_to_feed: true, cover_url: 'https://x/c.jpg' });
  assert.deepEqual(containerParams('ig', { format: 'reel', caption: '', media: [vid(1)], trial: 1 }).trial_params, JSON.stringify({ graduation_strategy: 'MANUAL' }));
  assert.deepEqual(containerParams('ig', { format: 'story', caption: '무시', media: [img(1)] }), { media_type: 'STORIES', image_url: 'https://x/media/a/1.jpg' });
  assert.deepEqual(containerParams('ig', { format: 'story', media: [vid(2)] }), { media_type: 'STORIES', video_url: 'https://x/media/a/2.mp4' });
  assert.deepEqual(containerParams('th', { format: 'image', caption: 'x', media: [img(1)] }), { media_type: 'IMAGE', image_url: 'https://x/media/a/1.jpg', text: 'x' });
  assert.deepEqual(containerParams('th', { format: 'video', caption: 'x', media: [vid(1)] }), { media_type: 'VIDEO', video_url: 'https://x/media/a/1.mp4', text: 'x' });
});
