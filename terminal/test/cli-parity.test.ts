/** Exercises remote endpoint parsing without consulting producer configuration. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { hubServer } from '../src/endpoint.ts';

test('Hub endpoint accepts HTTPS and explicitly isolated fixture HTTP origins', () => {
  assert.equal(hubServer('https://hub.example.test').origin, 'https://hub.example.test');
  assert.equal(hubServer('http://127.0.0.1:4180').origin, 'http://127.0.0.1:4180');
  for (const invalid of ['http://hub.example.test', 'https://hub.example.test/api', 'https://token@hub.example.test', 'https://hub.example.test?q=1', 'file:///service']) {
    assert.throws(() => hubServer(invalid));
  }
});
