import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pause, type SmokeContext } from './harness';

/** UI smoke checks, part 20: request scripts, and pausing scripts that came from elsewhere. */
export default async function requestScripts(context: SmokeContext) {
  const { run, capture, answerConfirm } = context;
  const seen: { url?: string; signature?: string }[] = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url, signature: request.headers['x-signature'] as string });
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ id: 7, name: 'Ada' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as { port: number };
    await run(
      `window.scriptsOriginal=structuredClone(state);view='Collections';current().url='http://127.0.0.1:${port}/users/{{script_user}}';current().method='GET';current().auth='None';current().bodyType='none';current().params=[];current().headers=[];current().tests='';current().captures=[];delete current().scripts;requestTab='Scripts';render()`,
    );
    await pause(200);
    assert.equal(
      await run("document.querySelectorAll('[data-script-phase]').length"),
      2,
      'the Scripts tab offers pre-request and post-response scripts',
    );
    // Typed in the app, a script runs at once.
    await run(
      "setEditorText('.scripts-editor', \"aw.vars.set('script_user', '7');\\naw.request.headers.set('X-Signature', aw.crypto.sha256('7').slice(0, 12));\\naw.log('signed');\")",
    );
    await run("document.querySelector('[data-script-phase=post]').click()");
    await pause(150);
    await run(
      "setEditorText('.scripts-editor', \"aw.test('is Ada', () => aw.expect(aw.response.json().name).toBe('Ada'));\\naw.vars.set('script_name', aw.response.json().name);\")",
    );
    await pause(300);
    await run('execute(current())');
    const sent = seen.at(-1)!;
    assert.equal(sent.url, '/users/7', 'the pre-request variable resolved in the URL');
    assert.match(sent.signature ?? '', /^[0-9a-f]{12}$/, 'the pre-request script added a header');
    assert.equal(
      await run(
        "state.environments[state.environment].variables.find(v=>v.key==='script_name')?.value",
      ),
      'Ada',
      'the post-response script set a variable',
    );
    await run("responseTab='Tests';render()");
    await pause(150);
    assert.equal(
      await run("document.querySelector('#response-panel').textContent.includes('is Ada')"),
      true,
      'script tests appear with the response tests',
    );
    assert.equal(
      await run('scriptsStore.lastRun(current().id).post[0].output.tests[0].pass'),
      true,
    );
    await capture('request-scripts.png');

    // A pre-request script may change the path, but not the host the request goes to.
    await run("requestTab='Scripts';document.querySelector('[data-script-phase=pre]').click()");
    await pause(150);
    await run(
      `setEditorText('.scripts-editor', "aw.request.url = 'http://localhost:${port}/users/7';")`,
    );
    await pause(300);
    const before = seen.length;
    await run('execute(current())');
    assert.equal(seen.length, before, 'the request was not sent to the other host');
    assert.match(
      String(await run('current().response?.error')),
      /changed where this request is sent, from http:\/\/127\.0\.0\.1:\d+ to http:\/\/localhost:\d+/,
    );

    // A script that arrives from elsewhere (an import, a teammate) is paused until allowed.
    await run(
      "current().scripts={post:\"aw.vars.set('from_import', 'ran');\"};requestTab='Scripts';render()",
    );
    await pause(400);
    assert.equal(
      await run("Boolean(document.querySelector('[data-scripts-paused]'))"),
      true,
      'a paused script says so',
    );
    assert.equal(
      await run(
        "document.querySelector('[data-request-tab=Scripts]')?.textContent.includes('Paused')",
      ),
      true,
      'the tab shows that its scripts are paused',
    );
    await run('execute(current())');
    assert.equal(
      await run("state.environments[state.environment].variables.some(v=>v.key==='from_import')"),
      false,
      'a paused script does not run',
    );
    assert.equal(await run('scriptsStore.lastRun(current().id).post[0].output.paused'), true);
    await capture('request-scripts-paused.png');
    await run("document.querySelector('[data-action=allow-scripts]').click()");
    await answerConfirm(true);
    await pause(300);
    await run('execute(current())');
    assert.equal(
      await run(
        "state.environments[state.environment].variables.find(v=>v.key==='from_import')?.value",
      ),
      'ran',
      'an allowed script runs',
    );
    assert.equal(await run("Boolean(document.querySelector('[data-scripts-paused]'))"), false);

    // A collection's script runs before the request's, for every request inside it.
    await run(
      "delete current().scripts;current().url=current().url.replace('{{script_user}}','{{collection_user}}');requestTab='Scripts';render()",
    );
    await pause(200);
    await run("document.querySelector('[data-script-level=collection]').click()");
    await run("document.querySelector('[data-script-phase=pre]').click()");
    await pause(200);
    await run("setEditorText('.scripts-editor', \"aw.vars.set('collection_user', '9');\")");
    await pause(300);
    assert.equal(
      await run("Boolean(state.collectionScripts?.[current().folder.split('/')[0]]?.pre)"),
      true,
      'the collection level edits the collection’s script',
    );
    assert.equal(
      await run(
        "document.querySelector('[data-scripts-chain]')?.textContent.includes(current().folder.split('/')[0])",
      ),
      true,
      'the run order names the collection',
    );
    await run('execute(current())');
    assert.equal(seen.at(-1)?.url, '/users/9', 'the collection script set the variable first');
    await capture('collection-scripts.png');

    // A collection script from elsewhere pauses the requests inside it, until allowed.
    await run(
      "state.collectionScripts[current().folder.split('/')[0]]={pre:\"aw.vars.set('collection_user', '8');\"};render()",
    );
    await pause(400);
    assert.equal(
      await run(
        "document.querySelector('[data-request-tab=Scripts]')?.textContent.includes('Paused')",
      ),
      true,
    );
    await run('execute(current())');
    assert.match(
      String(await run('current().response?.error')),
      /paused/,
      'a paused collection script stops the send',
    );
    await run("document.querySelector('[data-action=allow-scripts]').click()");
    await answerConfirm(true);
    await pause(300);
    await run('execute(current())');
    assert.equal(seen.at(-1)?.url, '/users/8', 'the allowed collection script ran');

    // The workspace's script runs before the collection's, for every request.
    await run("document.querySelector('[data-script-level=workspace]').click()");
    await run("document.querySelector('[data-script-phase=pre]').click()");
    await pause(200);
    await run(
      "setEditorText('.scripts-editor', \"aw.request.url = aw.request.url.replace('{{collection_user}}', '{{collection_user}}?from=workspace');\")",
    );
    await pause(300);
    assert.equal(await run('Boolean(state.workspaceScripts?.pre)'), true);
    assert.match(
      String(await run("document.querySelector('[data-scripts-chain]')?.textContent")),
      /Workspace.*→/,
      'the run order starts with the workspace',
    );
    await run('execute(current())');
    assert.equal(seen.at(-1)?.url, '/users/8?from=workspace', 'the workspace script ran first');
    await capture('workspace-scripts.png');

    // A library module, written in the app, shared with the request's script.
    await run(
      "delete state.workspaceScripts;delete state.collectionScripts;current().url=current().url.split('?')[0].replace('{{collection_user}}','{{library_user}}');render()",
    );
    await run("document.querySelector('[data-script-level=library]').click()");
    await pause(200);
    await run(
      "userInput('[data-new-module]','users');document.querySelector('.scripts-new-module').requestSubmit()",
    );
    await pause(300);
    assert.equal(
      await run("scriptsStore.library().map(module=>module.name).join(',')"),
      'users',
      'a module is added by name',
    );
    await run(
      "setEditorText('.scripts-editor', \"exports.pick = () => '5';\\naw.info('library loaded');\")",
    );
    await pause(300);
    await capture('script-library.png');
    await run("document.querySelector('[data-script-level=request]').click()");
    await run("document.querySelector('[data-script-phase=pre]').click()");
    await pause(200);
    await run(
      "setEditorText('.scripts-editor', \"aw.vars.set('library_user', aw.require('users').pick());\")",
    );
    await pause(300);
    await run('execute(current())');
    assert.equal(seen.at(-1)?.url, '/users/5', 'the script used the library module');
    assert.equal(
      await run("requestConsoleEntries.some(entry=>entry.message.includes('library loaded'))"),
      true,
      'aw.info from a module writes to the console',
    );

    // A module changed outside the app pauses the scripts that require it, until allowed.
    await run('scriptsStore.library()[0].source="exports.pick = () => \'6\';";render()');
    await pause(400);
    await run('execute(current())');
    assert.match(String(await run('current().response?.error')), /users came from outside/);
    await run("document.querySelector('[data-action=allow-scripts]').click()");
    await answerConfirm(true);
    await pause(300);
    await run('execute(current())');
    assert.equal(seen.at(-1)?.url, '/users/6', 'the allowed module ran');

    // The snippets panel lists code for the phase, searches it, and inserts at the cursor.
    await run("document.querySelector('[data-script-phase=post]').click()");
    await pause(200);
    await run("setEditorText('.scripts-editor', 'aw.log(1);')");
    assert.equal(
      await run("Boolean(document.querySelector('[data-snippet=status-200]'))"),
      true,
      'post-response snippets are listed',
    );
    assert.equal(
      await run("Boolean(document.querySelector('[data-snippet=set-header]'))"),
      false,
      'pre-request snippets are not',
    );
    await run("userInput('[data-snippet-search]','exactly 200')");
    await pause(150);
    assert.deepEqual(
      await run("[...document.querySelectorAll('[data-snippet]')].map(item=>item.dataset.snippet)"),
      ['status-200'],
    );
    await capture('script-snippets.png');
    await run("document.querySelector('[data-snippet=status-200]').click()");
    await pause(200);
    assert.equal(
      await run("editorView('.scripts-editor').state.doc.toString()"),
      "aw.log(1);\naw.test('status is 200', () => {\n  aw.expect(aw.response.status).toBe(200);\n});\n",
      'the snippet goes on its own line at the cursor',
    );
    assert.match(
      String(await run('current().scripts?.post')),
      /status is 200/,
      'an inserted snippet is saved like typing',
    );
    await run("document.querySelector('[data-action=toggle-snippets]').click()");
    await pause(100);
    assert.equal(await run("Boolean(document.querySelector('[data-script-snippets]'))"), false);
    await run("document.querySelector('[data-action=toggle-snippets]').click()");

    // Your own snippets: saved from the selection, listed first, inserted, edited, and deleted.
    await pause(150);
    await run("setEditorText('.scripts-editor', 'aw.log(1);\\naw.warn(2);')");
    await run("editorView('.scripts-editor').dispatch({selection:{anchor:11,head:22}})");
    await run("document.querySelector('[data-action=new-snippet]').click()");
    await pause(150);
    assert.equal(
      await run("document.querySelector('[data-snippet-code]').value"),
      'aw.warn(2);',
      'a new snippet starts from the selection',
    );
    await run("document.querySelector('[data-snippet-form]').requestSubmit()");
    await pause(100);
    assert.match(
      String(await run("document.querySelector('[data-snippet-form] [role=alert]')?.textContent")),
      /title/,
      'a snippet needs a title',
    );
    await run("userInput('[data-snippet-title]','Team warning')");
    await run("document.querySelector('[data-snippet-form]').requestSubmit()");
    await pause(200);
    const id = String(await run('scriptsStore.snippets()[0]?.id'));
    assert.deepEqual(await run('scriptsStore.snippets()[0].places'), ['post']);
    assert.equal(
      await run(
        "document.querySelector('.script-snippets-group h4')?.textContent+'|'+Boolean(document.querySelector('[data-snippet=\"'+scriptsStore.snippets()[0].id+'\"]'))",
      ),
      'My snippets|true',
      'saved snippets are listed first',
    );
    await capture('custom-snippets.png');
    await run("setEditorText('.scripts-editor', 'aw.log(1);')");
    await run(`document.querySelector('[data-snippet="${id}"]').click()`);
    await pause(150);
    assert.equal(
      await run("editorView('.scripts-editor').state.doc.toString()"),
      'aw.log(1);\naw.warn(2);\n',
    );
    await run(`document.querySelector('[data-edit-snippet="${id}"]').click()`);
    await pause(150);
    await run("userInput('[data-snippet-title]','Warn the team')");
    await run("document.querySelector('[data-snippet-place=pre]').click()");
    await run("document.querySelector('[data-snippet-form]').requestSubmit()");
    await pause(150);
    assert.equal(await run('scriptsStore.snippets()[0].title'), 'Warn the team');
    assert.deepEqual(await run('scriptsStore.snippets()[0].places'), ['pre', 'post']);
    await run(`document.querySelector('[data-delete-snippet="${id}"]').click()`);
    await answerConfirm(true);
    await pause(150);
    assert.equal(await run('scriptsStore.snippets().length'), 0, 'a snippet is deleted');
  } finally {
    server.close();
    await run(
      "if(window.scriptsOriginal){state.requests=window.scriptsOriginal.requests;state.environments=window.scriptsOriginal.environments;state.collectionScripts=window.scriptsOriginal.collectionScripts;state.workspaceScripts=window.scriptsOriginal.workspaceScripts;state.scriptLibrary=window.scriptsOriginal.scriptLibrary;state.scriptSnippets=window.scriptsOriginal.scriptSnippets;if(!state.scriptSnippets)delete state.scriptSnippets;if(!state.scriptLibrary)delete state.scriptLibrary;if(!state.workspaceScripts)delete state.workspaceScripts;if(!state.collectionScripts)delete state.collectionScripts;delete window.scriptsOriginal;requestTab='Params';responseTab='Body';persist();render()}",
    );
  }
}
