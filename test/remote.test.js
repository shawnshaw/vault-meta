'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRemoteUrl, checkRemote } = require('../src/core/remote');

const CALLS = {
  repo: 'https://api.github.com/repos/example/demo',
  commits: 'https://api.github.com/repos/example/demo/commits/',
  release: 'https://api.github.com/repos/example/demo/releases/latest',
  manifest: 'https://api.github.com/repos/example/demo/contents/manifest.json?ref=',
};

function ok(data) {
  return { status: 200, text: JSON.stringify(data) };
}

function makeRequest(routes) {
  const calls = [];
  const request = async (options) => {
    calls.push(options);
    for (const route of routes) {
      if (route.match(options.url)) {
        if (typeof route.reply === 'function') return route.reply(options);
        return route.reply;
      }
    }
    return { status: 404, text: '{"message":"Not Found"}' };
  };
  request.calls = calls;
  return request;
}

function defaultRoutes(overrides) {
  const routes = [
    { match: (url) => url === CALLS.repo, reply: ok({ default_branch: 'main' }) },
    { match: (url) => url.startsWith(CALLS.commits), reply: ok({ sha: 'a'.repeat(40) }) },
    { match: (url) => url === CALLS.release, reply: ok({ tag_name: 'v0.4.0', draft: false, prerelease: false }) },
    { match: (url) => url.startsWith(CALLS.manifest), reply: ok({ version: '0.4.1' }) },
  ];
  return overrides ? overrides(routes) : routes;
}

test('解析 GitHub 远端地址的四种写法', () => {
  const expected = { provider: 'github', owner: 'example', repo: 'demo', webUrl: 'https://github.com/example/demo' };
  assert.deepEqual(parseRemoteUrl('https://github.com/example/demo'), expected);
  assert.deepEqual(parseRemoteUrl('https://github.com/example/demo.git'), expected);
  assert.deepEqual(parseRemoteUrl('https://github.com/example/demo/'), expected);
  assert.deepEqual(parseRemoteUrl('git@github.com:example/demo.git'), expected);
  assert.deepEqual(parseRemoteUrl('ssh://git@github.com/example/demo.git'), expected);
});

test('非 github.com 或非 https 地址被拒绝', () => {
  for (const url of [
    'https://gitlab.com/example/demo',
    'http://github.com/example/demo',
    'https://github.com/example',
    'file:///tmp/repo',
    '',
  ]) {
    assert.throws(() => parseRemoteUrl(url), (err) => err.code === 'E_REMOTE_UNSUPPORTED', url);
  }
});

test('成功检查返回发布版、分支、提交与开发线版本', async () => {
  const request = makeRequest(defaultRoutes());
  const result = await checkRemote({ url: 'https://github.com/example/demo', branch: '' }, { request });
  assert.equal(result.ok, true);
  assert.equal(result.branch, 'main');
  assert.equal(result.commit, 'a'.repeat(40));
  assert.equal(result.developmentVersion, '0.4.1');
  assert.deepEqual(result.release, { tag: 'v0.4.0', version: '0.4.0' });
  assert.equal(request.calls.length, 4);
});

test('指定分支优先于仓库默认分支，并做 URL 编码', async () => {
  const request = makeRequest(defaultRoutes());
  const result = await checkRemote({ url: 'https://github.com/example/demo', branch: 'feat/x' }, { request });
  assert.equal(result.branch, 'feat/x');
  assert.equal(request.calls.some((call) => call.url.includes('/commits/feat%2Fx')), true);
});

test('没有正式 release 时仍返回成功，但 release 为 null', async () => {
  const request = makeRequest(defaultRoutes((routes) => routes.map((route) => (
    route.match(CALLS.release) ? { ...route, reply: { status: 404, text: '{}' } } : route
  ))));
  const result = await checkRemote({ url: 'https://github.com/example/demo' }, { request });
  assert.equal(result.ok, true);
  assert.equal(result.release, null);
  assert.equal(result.developmentVersion, '0.4.1');
});

test('预发布版本不会被当作最新可用版', async () => {
  const request = makeRequest(defaultRoutes((routes) => routes.map((route) => (
    route.match(CALLS.release)
      ? { ...route, reply: ok({ tag_name: 'v0.5.0-beta.1', prerelease: true }) }
      : route
  ))));
  const result = await checkRemote({ url: 'https://github.com/example/demo' }, { request });
  assert.equal(result.release, null);
});

test('GitHub 限流返回 E_REMOTE_RATE_LIMIT', async () => {
  const request = makeRequest([{ match: (url) => url === CALLS.repo, reply: { status: 403, text: '{}' } }]);
  const result = await checkRemote({ url: 'https://github.com/example/demo' }, { request });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_REMOTE_RATE_LIMIT');
  assert.equal(result.at.length, 24);
});

test('仓库不存在返回 E_NOT_FOUND', async () => {
  const request = makeRequest([{ match: (url) => url === CALLS.repo, reply: { status: 404, text: '{}' } }]);
  const result = await checkRemote({ url: 'https://github.com/example/demo' }, { request });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_NOT_FOUND');
});

test('分支不存在返回 E_NOT_FOUND', async () => {
  const request = makeRequest(defaultRoutes((routes) => routes.map((route) => (
    route.match(`${CALLS.commits}main`) ? { ...route, reply: { status: 404, text: '{}' } } : route
  ))));
  const result = await checkRemote({ url: 'https://github.com/example/demo' }, { request });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_NOT_FOUND');
  assert.match(result.error, /分支不存在/);
});

test('断网时返回 E_NETWORK 且不误报成功', async () => {
  const request = async () => {
    const err = new Error('getaddrinfo ENOTFOUND');
    err.code = 'ENOTFOUND';
    throw err;
  };
  const result = await checkRemote({ url: 'https://github.com/example/demo' }, { request });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_NETWORK');
  assert.match(result.error, /网络请求失败/);
});

test('返回内容不是 JSON 时按失败处理', async () => {
  const request = makeRequest([{ match: (url) => url === CALLS.repo, reply: { status: 200, text: '<html>' } }]);
  const result = await checkRemote({ url: 'https://github.com/example/demo' }, { request });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_NETWORK');
});

test('发布接口 5xx 时返回失败，不误报“无正式发布”', async () => {
  const request = makeRequest(defaultRoutes((routes) => routes.map((route) => (
    route.match(CALLS.release) ? { ...route, reply: { status: 500, text: '{}' } } : route
  ))));
  const result = await checkRemote({ url: 'https://github.com/example/demo' }, { request });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_NETWORK');
  assert.equal(result.release, undefined);
});

test('开发线版本接口 5xx 时返回失败，不静默降级', async () => {
  const request = makeRequest(defaultRoutes((routes) => routes.map((route) => (
    route.match(`${CALLS.manifest}main`) ? { ...route, reply: { status: 500, text: '{}' } } : route
  ))));
  const result = await checkRemote({ url: 'https://github.com/example/demo' }, { request });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_NETWORK');
});

test('请求超时后放弃等待并返回 E_NETWORK', async () => {
  const request = () => new Promise(() => {});
  const started = Date.now();
  const result = await checkRemote({ url: 'https://github.com/example/demo' }, { request, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'E_NETWORK');
  assert.ok(Date.now() - started < 1000);
});

test('请求携带 User-Agent 与 Accept 头', async () => {
  const request = makeRequest(defaultRoutes());
  await checkRemote({ url: 'https://github.com/example/demo' }, { request });
  for (const call of request.calls) {
    assert.equal(call.headers['User-Agent'], 'vault-meta');
    assert.ok(call.headers.Accept);
    assert.equal(call.throw, false);
  }
});
