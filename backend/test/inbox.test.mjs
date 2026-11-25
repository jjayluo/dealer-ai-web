import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

test('inbox keeps edits, slow thread loads and AI results with the correct recipient', async () => {
  const elements = new Map();
  function element(selector) {
    if (!elements.has(selector)) {
      const control = Object.assign(new EventTarget(), {
        value: '', hidden: false, textContent: '', innerHTML: '',
        classList: { toggle() {} },
      });
      elements.set(selector, control);
    }
    return elements.get(selector);
  }
  const conversations = Object.fromEntries(['one', 'two'].map(id => [id, {
    id, version: 1, status: 'open', channel: 'web',
    messages: id === 'one' ? [{ direction: 'inbound', body: 'Is this available?' }] : [],
    inquiry_name: id === 'one' ? 'Cillian' : null,
    customer: { first_name: id }, vehicle: { id, make: 'Honda' },
  }]));
  const suggestion = Promise.withResolvers();
  let slowThread;
  const sent = [];
  const context = createContext({
    document: { querySelector: element, querySelectorAll: () => [] },
    window: new EventTarget(), location: { hash: '#conversations' }, sessionStorage: { getItem: () => null },
    URLSearchParams, setTimeout: () => 0, clearTimeout() {},
    fetch: async (path, init) => {
      if (path.endsWith('/ai-suggestion')) return Response.json({ data: await suggestion.promise });
      if (path.endsWith('/messages')) {
        sent.push([path, JSON.parse(init.body).body]);
        return Response.json({ data: {} });
      }
      if (path.includes('/conversations?')) return Response.json({ data: Object.values(conversations), meta: { total_pages: 1, total: 2 } });
      const id = path.split('/').pop();
      const row = id === 'one' && slowThread ? await slowThread.promise : conversations[id];
      return Response.json({ data: row });
    },
  });
  runInContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8'), context);
  const run = source => runInContext(source, context);
  run("actor = { id: 'rep', role: 'sales' }; kind = 'conversations'");
  const box = element('#message-input');
  function type(body) { box.value = body; box.dispatchEvent(new Event('input')); }

  await run("openConversation('one')");
  assert.equal(element('#conversation-title').textContent, 'Cillian');
  assert.match(element('#conversation-messages').innerHTML, /Cillian/);
  assert.equal(element('#ai-reply-btn').disabled, false);
  type('Reply for one');
  const pendingAi = run('requestAiSuggestion()');
  await run("openConversation('two')");
  assert.equal(box.value, '');
  assert.equal(element('#ai-reply-btn').disabled, true);
  suggestion.resolve({ draft: 'Suggestion for one' });
  await pendingAi;
  assert.equal(element('#ai-suggestion-panel').hidden, true);

  slowThread = Promise.withResolvers();
  const pendingThread = run("openConversation('one')");
  await run("openConversation('two')");
  slowThread.resolve(conversations.one);
  await pendingThread;
  slowThread = null;
  assert.equal(element('#conversation-title').textContent, 'two');

  type('Reply for two');
  await run('sendReply()');
  assert.deepEqual(sent, [['/api/v1/conversations/two/messages', 'Reply for two']]);
  await run("openConversation('one')");
  assert.equal(box.value, 'Reply for one');
});
