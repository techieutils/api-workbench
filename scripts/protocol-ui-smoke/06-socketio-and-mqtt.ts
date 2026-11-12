import assert from 'node:assert/strict';
import { type ProtocolContext } from './harness';

/** Protocol UI checks, part 6: Socket.IO events and MQTT topics. */
export default async function socketIOAndMQTT(context: ProtocolContext) {
  const { run, wait, select, url, message, connect, done, socketIOBase, mqttURL, authentication } =
    context;
  const type = (selector: string, value: string, event = 'input') =>
    run(
      `(()=>{const field=document.querySelector(${JSON.stringify(selector)});field.value=${JSON.stringify(value)};field.dispatchEvent(new Event(${JSON.stringify(event)}));})()`,
    );
  const received = (predicate: string) =>
    wait(`(liveProtocols.get(current().id)?.events||[]).some(event=>${predicate})`);
  const send = () => run("document.querySelector('[data-protocol-send]').click()");

  // Socket.IO: every event arrives with its name, and messages are emitted as the chosen event.
  await select('socketio');
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-protocol-tab]')].map(tab=>tab.dataset.protocolTab).join()",
    ),
    'Message,Headers,Auth,Settings',
  );
  await url(`${socketIOBase}/`);
  await type('#socketio-event', 'echo');
  await message('{"n":1}');
  assert.equal(
    await run("document.querySelector('[data-protocol-send]').textContent.trim()"),
    'Emit',
  );
  await connect();
  await wait("liveProtocols.get(current().id)?.phase==='open'");
  await received("event.type==='message'&&event.event==='welcome'&&event.data==='hello'");
  await wait("!document.querySelector('[data-protocol-send]').disabled");
  await send();
  await received("event.type==='message'&&event.event==='echo'&&event.data==='{\"n\":1}'");
  await run("document.querySelector('#socketio-ack').click()");
  assert.equal(await run('current().socketio.ack'), true, 'the acknowledgement choice is saved');
  await send();
  await received("event.type==='message'&&event.event==='echo (ack)'");
  assert.ok(
    authentication.some((entry) => entry.protocol === 'socketio'),
    'the Socket.IO server saw the connection',
  );
  await run("document.querySelector('[data-protocol-tab=Settings]').click()");
  assert.equal(await run("document.querySelector('#socketio-path').value"), '/socket.io');
  await run("document.querySelector('[data-protocol-tab=Message]').click()");
  await connect();
  await done();

  // Code for Socket.IO uses its own clients and the chosen event.
  await run("document.querySelector('[data-action=code]').click()");
  await wait('codeDialog?.result?.code');
  assert.equal(
    await run('codeDialog.targets.map(target=>target.id).sort().join()'),
    'javascript,node,python',
  );
  assert.match((await run('codeDialog.result.code')) as string, /emit\("echo"/);
  await run("document.querySelector('[data-action=code]').click()");

  // MQTT: subscriptions are set in Topics, and messages publish to the topic with QoS and retain.
  await select('mqtt');
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-protocol-tab]')].map(tab=>tab.dataset.protocolTab).join()",
    ),
    'Message,Topics,Headers,Auth,Settings',
  );
  await url(mqttURL);
  await run("document.querySelector('[data-protocol-tab=Topics]').click()");
  await wait('Boolean(document.querySelector(\'[data-mqtt-topic="0"]\'))');
  await type('[data-mqtt-topic="0"]', 'ui/+/bad#');
  await run('render()');
  await wait(
    "document.querySelector('.mqtt-topics-footer [role=alert]')?.textContent.includes('#')",
  );
  // Typing updates the filter; leaving the field (change) shows whether it is valid.
  await type('[data-mqtt-topic="0"]', 'ui/#');
  await type('[data-mqtt-topic="0"]', 'ui/#', 'change');
  await wait("!document.querySelector('.mqtt-topics-footer [role=alert]')");
  await run("document.querySelector('[data-mqtt-add]').click()");
  await wait(
    "current().mqtt.subscriptions.length===2&&document.activeElement?.dataset.mqttTopic==='1'",
  );
  await run(
    "document.querySelector('[data-mqtt-topic=\"1\"]').closest('tr').querySelector('.deletecell button').click()",
  );
  await wait('current().mqtt.subscriptions.length===1');
  await run("document.querySelector('[data-protocol-tab=Message]').click()");
  await type('#mqtt-topic', 'ui/echo');
  await run("document.querySelector('#mqtt-retain').click()");
  await message('hello broker');
  await connect();
  await wait("liveProtocols.get(current().id)?.phase==='open'");
  await received("event.type==='status'&&event.data.includes('Subscribed to ui/#')");
  await send();
  await received("event.type==='message'&&event.event==='ui/echo'&&event.data==='hello broker'");
  assert.equal(
    await run(
      'JSON.stringify({topic:current().mqtt.topic,retain:current().mqtt.retain,subscriptions:current().mqtt.subscriptions.map(row=>row.topic)})',
    ),
    JSON.stringify({ topic: 'ui/echo', retain: true, subscriptions: ['ui/#'] }),
    'MQTT settings are saved with the request',
  );
  await connect();
  await done();

  // A retained message reaches the next connection without publishing again.
  await connect();
  await received("event.type==='message'&&event.event==='ui/echo'");
  await connect();
  await done();
  assert.ok(
    authentication.some((entry) => entry.protocol === 'mqtt'),
    'the broker saw the client',
  );
}
