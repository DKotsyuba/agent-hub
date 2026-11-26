/** Renders the localized speed summary using the explicit fixture groups. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { fixtureModelGroups } from '../../../packages/client/fixtures/model-speed.ts';
import { LocaleProvider } from '../../i18n';

Object.defineProperty(globalThis, 'location', { value: { origin: 'http://hub.test' }, configurable: true });
const { ModelSpeedTable } = await import('../model-speed');

test('renders model rows in median order with accessible expansion and both distributions', () => {
  const html = renderToStaticMarkup(<LocaleProvider><ModelSpeedTable data={{
    window: '24h', group_by: 'provider+model', groups: fixtureModelGroups('provider+model'),
  }} /></LocaleProvider>);
  assert.ok(html.indexOf('claude-haiku-5-5') < html.indexOf('gpt-6.2-sol'));
  assert.match(html, /aria-sort="descending"/);
  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Первый токен, мс/);
  assert.match(html, /112,8/);
  assert.equal(html.match(/p10–p90/g)?.length, 8);
});
