const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdtemp, unlink, rmdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { isPrivateIp, localHttp, localUdp, sqlite, readOlt, readRouter } = require('./probes.cjs');

test('accepts private management IPv4 only', async () => {
  for (const ip of ['10.0.1.2', '172.16.0.1', '172.31.0.1', '192.168.0.99']) assert(isPrivateIp(ip));
  for (const ip of ['127.0.0.1', '172.32.0.1', '8.8.8.8', '192.168.0.999', 'example.com']) assert(!isPrivateIp(ip));
  await assert.rejects(readOlt('8.8.8.8', 'test'), /IPv4 privat/);
  await assert.rejects(readRouter('http://8.8.8.8', 'user', 'test'), /IPv4 privat/);
});

test('performs HTTP and UDP loopback without exposing the endpoint', async () => {
  assert.equal(await localHttp(), '127.0.0.1');
  assert.equal(await localUdp(), 'Datagram diterima');
});

test('writes and reopens a private SQLite file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momo-nms-probe-'));
  try {
    assert.equal(sqlite(directory), 'SQLite aktif');
  } finally {
    await unlink(join(directory, 'runtime-probe.sqlite'));
    await rmdir(directory);
  }
});
