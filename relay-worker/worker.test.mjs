/**
 * 中转 Worker 的单元测试（只跑纯逻辑，不部署、不联网）。
 *
 *   node --test relay-worker/
 *
 * 重点在写入侧的格式校验：Worker 是唯一写入口，校验漏掉一条，代理侧只会表现成
 * 「订阅能拉到、节点全连不上」。这里把「什么该收、什么该拒」逐条钉住。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './worker.mjs';

const BASE = 'https://relay.example.com';
const TOKEN = 'test-token-value';

class FakeKV {
  constructor() {
    this.store = new Map();
    this.failOn = null; // 'get' | 'put' | 'delete'
  }

  async get(key) {
    if (this.failOn === 'get') throw new Error('kv get boom');
    return this.store.has(key) ? this.store.get(key) : null;
  }

  async put(key, value) {
    if (this.failOn === 'put') throw new Error('kv put boom');
    this.store.set(key, value);
  }

  async delete(key) {
    if (this.failOn === 'delete') throw new Error('kv delete boom');
    this.store.delete(key);
  }
}

function makeEnv(overrides = {}) {
  return { IP_KV: new FakeKV(), RELAY_TOKEN: TOKEN, ...overrides };
}

function call(env, method, path, { body, token } = {}) {
  const headers = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const init = { method, headers };
  if (body !== undefined) init.body = body;
  return worker.fetch(new Request(BASE + path, init), env);
}

const SLUG = 'abc123';

// ======================================================================
// 公开读：行为必须与改造前一模一样
// ======================================================================
test('公开读返回推送上去的内容并带缓存', async () => {
  const env = makeEnv();
  await env.IP_KV.put(SLUG, '1.2.3.4:443\n');

  const resp = await call(env, 'GET', `/ips/${SLUG}`);

  assert.equal(resp.status, 200);
  assert.equal(await resp.text(), '1.2.3.4:443\n');
  assert.equal(resp.headers.get('x-ipick-count'), '1');
  assert.match(resp.headers.get('cache-control'), /max-age=300/);
  assert.equal(resp.headers.get('access-control-allow-origin'), '*');
});

test('不存在的 slug 返回 404', async () => {
  const resp = await call(makeEnv(), 'GET', `/ips/${SLUG}`);
  assert.equal(resp.status, 404);
});

test('空列表是合法结果：200 且条数为 0', async () => {
  const env = makeEnv();
  await env.IP_KV.put(SLUG, '');

  const resp = await call(env, 'GET', `/ips/${SLUG}`);
  assert.equal(resp.status, 200);
  assert.equal(await resp.text(), '');
  assert.equal(resp.headers.get('x-ipick-count'), '0');
});

test('根路径不暴露服务信息', async () => {
  const resp = await call(makeEnv(), 'GET', '/');
  assert.equal(resp.status, 403);
});

test('KV 读失败是 502，不是 404', async () => {
  const env = makeEnv();
  env.IP_KV.failOn = 'get';

  const resp = await call(env, 'GET', `/ips/${SLUG}`);
  assert.equal(resp.status, 502);
});

// ======================================================================
// 鉴权
// ======================================================================
test('没带 token 拒绝写入，且一个字都不落 KV', async () => {
  const env = makeEnv();
  const resp = await call(env, 'PUT', `/_push/ips/${SLUG}`, { body: '1.2.3.4:443\n' });

  assert.equal(resp.status, 401);
  assert.equal(env.IP_KV.store.size, 0);
});

test('token 不对拒绝写入', async () => {
  const env = makeEnv();
  const resp = await call(env, 'PUT', `/_push/ips/${SLUG}`, {
    body: '1.2.3.4:443\n',
    token: 'wrong-token',
  });

  assert.equal(resp.status, 401);
  assert.equal(env.IP_KV.store.size, 0);
});

test('未配置 RELAY_TOKEN 时要报 503 而不是 401', async () => {
  // 两种情况处置完全不同：一个要去 wrangler secret put，一个是两边的值不一致
  const env = makeEnv({ RELAY_TOKEN: '' });
  const resp = await call(env, 'PUT', `/_push/ips/${SLUG}`, {
    body: '1.2.3.4:443\n',
    token: TOKEN,
  });

  assert.equal(resp.status, 503);
  assert.equal(env.IP_KV.store.size, 0);
});

test('写端点的响应不缓存', async () => {
  const env = makeEnv();
  const resp = await call(env, 'PUT', `/_push/ips/${SLUG}`, {
    body: '1.2.3.4:443\n',
    token: TOKEN,
  });

  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('cache-control'), 'no-store');
});

// ======================================================================
// 写入格式校验
// ======================================================================
test('合法列表写入成功', async () => {
  const env = makeEnv();
  const resp = await call(env, 'PUT', `/_push/ips/${SLUG}`, {
    body: '1.2.3.4:443\n5.6.7.8:8443\n',
    token: TOKEN,
  });

  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('x-ipick-count'), '2');
  assert.equal(env.IP_KV.store.get(SLUG), '1.2.3.4:443\n5.6.7.8:8443\n');
});

test('空 body 允许写入（本轮一条都没过筛）', async () => {
  const env = makeEnv();
  const resp = await call(env, 'PUT', `/_push/ips/${SLUG}`, { body: '', token: TOKEN });

  assert.equal(resp.status, 204);
  assert.equal(resp.headers.get('x-ipick-count'), '0');
  assert.equal(env.IP_KV.store.get(SLUG), '');
});

test('结尾没有换行也接受（最后一行的内容仍要校验）', async () => {
  const env = makeEnv();
  const resp = await call(env, 'PUT', `/_push/ips/${SLUG}`, {
    body: '1.2.3.4:443',
    token: TOKEN,
  });

  assert.equal(resp.status, 204);
  assert.equal(env.IP_KV.store.get(SLUG), '1.2.3.4:443');
});

const BAD_BODIES = [
  ['缺端口', '1.2.3.4\n'],
  ['端口为 0', '1.2.3.4:0\n'],
  ['端口越界', '1.2.3.4:65536\n'],
  ['端口前导 0', '1.2.3.4:0443\n'],
  ['段越界', '1.2.3.256:443\n'],
  ['段前导 0', '1.02.3.4:443\n'],
  ['段数不对', '1.2.3:443\n'],
  ['空行', '1.2.3.4:443\n\n5.6.7.8:443\n'],
  ['只有空行', '\n'],
  ['带协议前缀', 'https://1.2.3.4:443\n'],
  ['IPv6 不在此阶段支持', '[2606:4700::1]:443\n'],
  ['端口里混字符', '1.2.3.4:44a\n'],
  ['首尾空格', ' 1.2.3.4:443\n'],
];

for (const [name, body] of BAD_BODIES) {
  test(`拒绝非法内容：${name}`, async () => {
    const env = makeEnv();
    const resp = await call(env, 'PUT', `/_push/ips/${SLUG}`, { body, token: TOKEN });

    assert.equal(resp.status, 400, `${name} 应该被拒绝`);
    assert.equal(env.IP_KV.store.size, 0, `${name} 不该落 KV`);
  });
}

test('400 响应指明第几行出错', async () => {
  const env = makeEnv();
  const resp = await call(env, 'PUT', `/_push/ips/${SLUG}`, {
    body: '1.2.3.4:443\nbadline\n',
    token: TOKEN,
  });

  const detail = await resp.text();
  assert.equal(resp.status, 400);
  assert.match(detail, /第 2 行/);
  assert.match(detail, /badline/);
});

test('超过上限的 body 被拒绝', async () => {
  const env = makeEnv();
  const huge = '1.2.3.4:443\n'.repeat(30000); // ≈ 360KB > 256KB

  const resp = await call(env, 'PUT', `/_push/ips/${SLUG}`, { body: huge, token: TOKEN });

  assert.equal(resp.status, 413);
  assert.equal(env.IP_KV.store.size, 0);
});

test('非法 slug 被拒绝', async () => {
  const env = makeEnv();
  const resp = await call(env, 'PUT', '/_push/ips/..%2Fetc', {
    body: '1.2.3.4:443\n',
    token: TOKEN,
  });

  assert.equal(resp.status, 400);
  assert.equal(env.IP_KV.store.size, 0);
});

test('KV 写失败是 502', async () => {
  const env = makeEnv();
  env.IP_KV.failOn = 'put';

  const resp = await call(env, 'PUT', `/_push/ips/${SLUG}`, {
    body: '1.2.3.4:443\n',
    token: TOKEN,
  });

  assert.equal(resp.status, 502);
});

// ======================================================================
// 删除与探针
// ======================================================================
test('删除要求鉴权', async () => {
  const env = makeEnv();
  await env.IP_KV.put(SLUG, '1.2.3.4:443\n');

  const resp = await call(env, 'DELETE', `/_push/ips/${SLUG}`);

  assert.equal(resp.status, 401);
  assert.equal(env.IP_KV.store.has(SLUG), true);
});

test('删除是幂等的：key 本来就不存在也返回 204', async () => {
  const env = makeEnv();
  const resp = await call(env, 'DELETE', `/_push/ips/${SLUG}`, { token: TOKEN });

  assert.equal(resp.status, 204);
});

test('删除后公开读回到 404', async () => {
  const env = makeEnv();
  await env.IP_KV.put(SLUG, '1.2.3.4:443\n');

  await call(env, 'DELETE', `/_push/ips/${SLUG}`, { token: TOKEN });
  const resp = await call(env, 'GET', `/ips/${SLUG}`);

  assert.equal(resp.status, 404);
});

test('探针写→读回→删，且不留下垃圾 key', async () => {
  const env = makeEnv();
  const resp = await call(env, 'POST', '/_push/probe', { token: TOKEN });

  assert.equal(resp.status, 200);
  assert.equal((await resp.text()).trim(), 'ok');
  assert.equal(env.IP_KV.store.size, 0, '探针 key 必须被清掉');
});

test('探针读回不一致时报 502（binding 指错 namespace）', async () => {
  const env = makeEnv();
  env.IP_KV.get = async () => 'probe from another namespace';

  const resp = await call(env, 'POST', '/_push/probe', { token: TOKEN });

  assert.equal(resp.status, 502);
});

test('探针要求鉴权', async () => {
  const resp = await call(makeEnv(), 'POST', '/_push/probe');
  assert.equal(resp.status, 401);
});

// ======================================================================
// 方法与预检
// ======================================================================
test('公开读路径不接受 PUT', async () => {
  const resp = await call(makeEnv(), 'PUT', `/ips/${SLUG}`, { body: 'x' });
  assert.equal(resp.status, 405);
});

test('写路径不接受 GET', async () => {
  const resp = await call(makeEnv(), 'GET', `/_push/ips/${SLUG}`, { token: TOKEN });
  assert.equal(resp.status, 405);
});

test('预检请求直接放行', async () => {
  const resp = await call(makeEnv(), 'OPTIONS', `/_push/ips/${SLUG}`);
  assert.equal(resp.status, 204);
});
