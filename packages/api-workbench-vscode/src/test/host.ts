import assert from 'node:assert/strict';
import * as vscode from 'vscode';
import type { ExtensionApi } from '../extension';

/**
 * Runs inside a real VS Code, started by scripts/test-in-vscode.mjs with the extension loaded from
 * source and a workspace holding a team folder, a local API, and app data. It uses the extension
 * through its commands, as a click in the view does.
 */
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<ExtensionApi>(
    'techieutils.api-workbench-vscode',
  );
  assert.ok(extension, 'the extension is installed');
  const api = await extension.activate();
  await api.ready();
  // The engine the settings chose: inside VS Code, or the command line's own process.
  const engine = await api.engine();
  if (vscode.workspace.getConfiguration('apiWorkbench').get('engine') === 'builtIn')
    assert.match(engine, /inside VS Code/, engine);
  else assert.match(engine, /with Node\.js/, engine);

  // The team folder in the workspace, and the app's workspaces from its data folder.
  const sources = api.sources();
  const team = sources.find((source) => source.kind === 'team');
  assert.ok(team, `a team folder is listed: ${JSON.stringify(sources)}`);
  assert.equal(team.error, undefined);
  assert.equal(team.requests, 4);
  assert.ok(
    sources.some((source) => source.kind === 'app' && source.name === 'Personal workspace'),
    'the app workspace is listed',
  );
  // The team folder is open in the app too, but listed once, as the folder here.
  assert.equal(sources.filter((source) => source.name === team.name).length, 1);

  // Send: the request editor opens with its response.
  await vscode.commands.executeCommand('apiWorkbench.sendRequest', api.item(team.name, 'list'));
  const response = api.lastResponse();
  assert.ok(response, 'a response is shown');
  assert.equal(response.status, '200 OK');
  assert.match(response.body, /"name": "Ada"/);
  assert.deepEqual(
    response.tests.map((test) => [test.label, test.pass]),
    [['status 200', true]],
  );
  assert.ok(
    vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .some((tab) => tab.label === 'List users' && tab.input instanceof vscode.TabInputWebview),
    'the request editor is open',
  );

  // A .http file: Send Request sends the request at the cursor, from the editor's text.
  const base = process.env.API_WORKBENCH_TEST_BASE;
  assert.ok(base, 'the local API is given');
  const document = await vscode.workspace.openTextDocument({
    language: 'http',
    content: `@base = ${base}\n\n### Users\nGET {{base}}/users\n`,
  });
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('apiWorkbench.sendRequest', {
    uri: document.uri.toString(),
    id: '1',
  });
  assert.equal(api.lastResponse()?.status, '200 OK');
  assert.ok(api.network().entries.length >= 2, 'both sends are in the network log');

  // Run Tests on the whole team folder: each request's result is in the Testing view.
  await vscode.commands.executeCommand('apiWorkbench.run', api.item(team.name));
  const results = api.results();
  const state = (id: string) =>
    Object.entries(results).find(([key]) => key.endsWith(`#${id}`))?.[1];
  assert.equal(state('list'), 'passed', JSON.stringify(results));
  assert.equal(state('one'), 'passed');
  assert.equal(state('miss'), 'failed');
  // The live protocol request is not a test.
  assert.equal(state('socket'), undefined);

  // Tools for language models: declared, registered, and the list answers without asking.
  const names = vscode.lm.tools.map((tool) => tool.name);
  for (const name of [
    'apiWorkbench_listRequests',
    'apiWorkbench_sendRequest',
    'apiWorkbench_runTests',
    'apiWorkbench_checkSpec',
  ])
    assert.ok(names.includes(name), `${name} is registered: ${names.join(', ')}`);
  const listed = await vscode.lm.invokeTool('apiWorkbench_listRequests', {
    input: { workspace: team.name },
    toolInvocationToken: undefined,
  });
  const text = listed.content
    .map((part) => (part instanceof vscode.LanguageModelTextPart ? part.value : ''))
    .join('');
  assert.match(text, /GET Users\/List users \(id list\)/);

  // Scripts in VS Code's own editor: read from the request, checked, suggested, and saved to it.
  const uri = api.scriptUri(team.name, 'one', 'post');
  assert.ok(uri, 'the script has a document');
  const script = await vscode.workspace.openTextDocument(uri);
  assert.equal(script.getText(), '');
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode('aw.test('));
  const opened = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(opened);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.ok(
    vscode.languages.getDiagnostics(uri).some((d) => d.source === 'API Workbench'),
    'a syntax error is underlined',
  );
  const edit = new vscode.WorkspaceEdit();
  edit.replace(uri, new vscode.Range(0, 0, opened.lineCount, 0), 'aw.');
  await vscode.workspace.applyEdit(edit);
  const suggested = await vscode.commands.executeCommand<vscode.CompletionList>(
    'vscode.executeCompletionItemProvider',
    uri,
    new vscode.Position(0, 3),
  );
  assert.ok(
    suggested.items.some(
      (item) => (typeof item.label === 'string' ? item.label : item.label.label) === 'response',
    ),
    'aw members are suggested',
  );
  await vscode.workspace.fs.writeFile(uri, new Uint8Array());

  // A live request opens its connection editor and connects; this one has no server to reach.
  await vscode.commands.executeCommand('apiWorkbench.sendRequest', api.item(team.name, 'socket'));
  let live = api.live(team.name, 'socket');
  for (let waited = 0; live?.state !== 'closed' && waited < 15000; waited += 100) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    live = api.live(team.name, 'socket');
  }
  assert.equal(live?.state, 'closed', JSON.stringify(live));
  assert.ok(
    live?.events.some((event) => event.type === 'error') || live?.error,
    'the failed connection says why',
  );
}
