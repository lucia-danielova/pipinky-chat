import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mediatorErrorMessage } from '../src/mediator-error.js';

test('uses server error and gateway message instead of the generic SDK error', async () => {
  for (const [body, expected] of [
    [{ error: 'Overenie relácie zlyhalo.' }, 'Overenie relácie zlyhalo.'],
    [{ message: 'Invalid JWT', code: 401 }, 'Invalid JWT'],
    [{ error: { message: 'Detailed reason' } }, 'Detailed reason'],
  ]) {
    const error = { message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify(body)) };
    assert.equal(await mediatorErrorMessage(error), expected);
  }
});

test('preserves plain text, status, and network error details', async () => {
  assert.equal(await mediatorErrorMessage({ message: 'generic', context: new Response('Service unavailable') }), 'Service unavailable');
  assert.equal(await mediatorErrorMessage({ message: 'generic', context: new Response(null, { status: 503 }) }), 'generic (HTTP 503)');
  assert.equal(await mediatorErrorMessage({ message: 'Network failed' }), 'Network failed');
});
