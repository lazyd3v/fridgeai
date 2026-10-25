import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDoorAnnouncements } from './door-announcements.ts';
const settle = () => new Promise(resolve => setTimeout(resolve, 420));

test('door greeting waits for browser readiness; results wait for speaking and tool turns', async () => {
  const sent: any[] = [];
  const announcements = createDoorAnnouncements(event => sent.push(event));
  try {
    announcements.add('door-1', 'door', 'Door opened; recognition pending.');
    await settle(); assert.equal(sent.length, 0);
    announcements.ready(); await settle();
    assert.equal(sent.length, 2); assert.equal(sent[1].response.tool_choice, 'none');
    assert.match(sent[1].response.instructions, /Give me a minute/);
    announcements.event({ type: 'output_audio_buffer.started' });
    announcements.add('result-1', 'analysis', 'Added 2 apples.');
    announcements.add('result-1', 'analysis', 'Added 2 apples.');
    announcements.event({ type: 'response.done' });
    await settle(); assert.equal(sent.length, 2);
    announcements.event({ type: 'output_audio_buffer.stopped' });
    announcements.event({ type: 'input_audio_buffer.speech_started' });
    await settle(); assert.equal(sent.length, 2);
    announcements.event({ type: 'input_audio_buffer.speech_stopped' });
    announcements.event({ type: 'response.created' });
    announcements.tools(true); announcements.event({ type: 'response.done' });
    await settle(); assert.equal(sent.length, 2);
    announcements.responseRequested(); announcements.tools(false);
    await settle(); assert.equal(sent.length, 2);
    announcements.event({ type: 'response.done' }); await settle();
    assert.equal(sent.length, 4); assert.equal(sent[3].response.tool_choice, 'none');
    assert.match(sent[3].response.instructions, /ALREADY SAVED/);
    assert.match(sent[2].item.content[0].text, /Added 2 apples/);
    announcements.event({ type: 'response.done' }); await settle(); assert.equal(sent.length, 4);
    announcements.add('later', 'door', 'Another opening'); announcements.close(); await settle(); assert.equal(sent.length, 4);
  } finally { announcements.close(); }
});


test('analysis response is grounded in the latest products and asks for a natural paraphrase', async () => {
  const sent: any[] = [];
  const announcements = createDoorAnnouncements(event => sent.push(event));
  const result = 'I analyzed the door recording.\nSaved changes:\n- Removed 1 × Milk.\n- Added 2 × Apples.\nIf I got anything wrong, reply here.';
  try {
    announcements.add('mixed-result', 'analysis', result);
    announcements.ready(); await settle();
    const response = sent.find(event => event.type === 'response.create').response;
    assert.equal(response.tool_choice, 'none');
    assert.ok(response.instructions.includes(JSON.stringify({ kind: 'analysis', text: result })));
    assert.match(response.instructions, /Paraphrase the saved result naturally/);
    assert.match(response.instructions, /do not read the notification verbatim/);
    assert.match(response.instructions, /Name the actual products/);
    assert.doesNotMatch(response.instructions, /Never repeat the analysis changes|Wait for the user to speak/);
  } finally { announcements.close(); }
});
