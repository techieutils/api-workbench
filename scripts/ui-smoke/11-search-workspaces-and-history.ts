import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { keychain, pause, temporary, type SmokeContext } from './harness';

/** UI smoke checks, part 11: search workspaces and history. */
export default async function searchWorkspacesAndHistory(context: SmokeContext) {
  const { window, run, capture, tabsReachable, rightClick, answerConfirm, drag } = context;
  await run(
    "window.searchOriginalActive=state.active;window.searchOriginalView=view;window.searchOriginalEnvironment=state.environment;document.querySelector('.top-search').click()",
  );
  assert.equal(
    await run('document.activeElement.id'),
    'global-workspace-search',
    'top search opens focused workspace search',
  );
  assert.equal(
    await run(
      "workspaceSearchResults().some(item=>item.kind==='Requests')&&workspaceSearchResults().some(item=>item.kind==='Environments')",
    ),
    true,
    'global search includes requests and environment names',
  );
  await run(
    "document.querySelector('#global-workspace-search').value='no-result-unique-xyz';document.querySelector('#global-workspace-search').dispatchEvent(new Event('input'))",
  );
  assert.equal(
    await run("document.querySelectorAll('[data-search-result]').length"),
    0,
    'unmatched search shows no results',
  );
  assert.equal(
    await run(
      "document.querySelector('#global-workspace-search').hasAttribute('aria-activedescendant')",
    ),
    false,
    'empty search removes active result reference',
  );
  await run(
    "document.querySelector('#global-workspace-search').value='';document.querySelector('#global-workspace-search').dispatchEvent(new Event('input'));document.querySelector('[data-search-category=Requests]').click()",
  );
  assert.equal(
    await run("workspaceSearchResults().every(item=>item.kind==='Requests')"),
    true,
    'category filter restricts search results',
  );
  await run(
    "document.querySelector('#global-workspace-search').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))",
  );
  assert.equal(
    await run(
      "document.querySelector('#global-workspace-search').getAttribute('aria-activedescendant')",
    ),
    'workspace-search-result-1',
    'arrow keys move active search result',
  );
  await capture('workspace-global-search.png');
  await run(
    "document.querySelector('#global-workspace-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
  );
  assert.equal(
    await run("!workspaceSearch.open&&view==='Collections'&&state.tabs.includes(state.active)"),
    true,
    'Enter opens request result',
  );
  await run(
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}))",
  );
  await run(
    "document.querySelector('[data-search-category=Pages]').click();document.querySelector('#global-workspace-search').value='settings';document.querySelector('#global-workspace-search').dispatchEvent(new Event('input'));document.querySelector('[data-search-result]').click()",
  );
  assert.equal(await run('view'), 'Settings', 'search navigates to workspace pages');
  await run('openWorkspaceSearch()');
  await run(
    "document.querySelector('#global-workspace-search').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  assert.equal(
    await run("!workspaceSearch.open&&document.activeElement.classList.contains('top-search')"),
    true,
    'Escape returns focus to top search',
  );
  await run(
    'view=window.searchOriginalView;state.environment=window.searchOriginalEnvironment;state.active=window.searchOriginalActive;render()',
  );
  const keychainBeforeWorkspaceSwitch = keychain.checks;
  await run(
    "window.workspaceTestOriginal=structuredClone(state);window.workspaceTestOriginalId=workspaceUI.id;window.waitForWorkspace=async()=>{const deadline=Date.now()+8000;while(workspaceUI.busy&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));if(workspaceUI.busy)throw new Error('Workspace operation timed out');if(workspaceUI.error)throw new Error(workspaceUI.error);};void 0",
  );
  await run('openWorkspaceManager()');
  assert.equal(
    await run("Boolean(document.querySelector('.workspace-manager[role=dialog]'))"),
    true,
    'workspace switcher opens management dialog',
  );
  assert.equal(
    await run("document.querySelector('[data-workspace-delete=default]').disabled"),
    true,
    'active workspace cannot be deleted',
  );
  assert.equal(
    await run('document.activeElement.id'),
    'workspace-search',
    'workspace search receives initial focus',
  );
  await capture('workspaces-details.png');
  // Squeezed, the workspace metrics scroll with arrows.
  for (const row of ['.workspace-detail-stats']) {
    await run(`document.querySelector('${row}').closest('.ui-tabs-frame').style.width='260px'`);
    await pause(80);
    assert.equal(await tabsReachable(row), 'reachable', `${row} is reachable with the arrows`);
    await run(`document.querySelector('${row}').closest('.ui-tabs-frame').style.width=''`);
  }
  await run(
    "document.querySelector('#workspace-search').value='no matching workspace';document.querySelector('#workspace-search').dispatchEvent(new Event('input'))",
  );
  assert.equal(
    await run("document.querySelectorAll('[data-workspace-inspect]').length"),
    0,
    'search filters workspace list',
  );
  await run("document.querySelector('[data-workspace-clear-search]').click()");
  await run("document.querySelector('[data-workspace-new]').click()");
  await run(
    "document.querySelector('#workspace-create-name').value='   ';document.querySelector('#workspace-create-form').requestSubmit()",
  );
  assert.equal(
    await run('Boolean(workspaceUI.nameError)&&workspaceUI.index.workspaces.length===1'),
    true,
    'blank names are rejected without creating a workspace',
  );
  await run(
    "document.querySelector('#workspace-create-name').value='Platform Engineering';document.querySelector('#workspace-create-name').dispatchEvent(new Event('input'))",
  );
  assert.equal(
    await run("document.querySelector('#workspace-name-count').textContent"),
    '20/60',
    'workspace draft updates character count',
  );
  window.setSize(1050, 720);
  await pause(100);
  assert.equal(
    await run(
      "(()=>{const dialog=document.querySelector('.workspace-manager').getBoundingClientRect(),save=document.querySelector('[data-workspace-save]').getBoundingClientRect();return dialog.left>=0&&dialog.bottom<=innerHeight&&save.bottom<=dialog.bottom&&save.right<=dialog.right})()",
    ),
    true,
    'workspace form actions remain visible at minimum desktop size',
  );
  await capture('workspaces-create.png');
  window.setSize(1440, 960);
  await pause(100);
  await run(
    "document.querySelector('#workspace-create-name').value='Workspace UI Test';document.querySelector('#workspace-create-form').requestSubmit();window.waitForWorkspace()",
  );
  assert.equal(
    await run('settings().workspaceName'),
    'Workspace UI Test',
    'creating a workspace switches to it',
  );
  assert.equal(
    await run(
      'state.requests.length===1&&state.tabs.length===1&&state.history.length===0&&!state.requests.some(request=>request.id===window.workspaceTestOriginal.active)',
    ),
    true,
    'new workspace has independent requests, tabs, and history',
  );
  assert.equal(
    await run('!credentialsLoaded&&credentials.length===0'),
    true,
    'switching clears credential metadata',
  );
  assert.equal(
    await run('!runnerState.report&&runnerState.samples.length===0'),
    true,
    'switching clears previous runner reports',
  );
  await run(
    "window.workspaceTestNewId=workspaceUI.id;current().name='Isolated request';state.environments[0].variables.push({key:'workspace_marker',value:'NEW-WORKSPACE-ONLY',enabled:true});state.settings.timeoutMs=23000;state.history=[{requestId:current().id,method:'GET',url:'https://example.com/new-workspace',status:200,date:new Date().toISOString()}];persist();openWorkspaceManager()",
  );
  // Renaming goes through the workspace's context menu.
  const workspaceId = (await run('workspaceUI.id')) as string;
  await rightClick(`[data-workspace-row="${workspaceId}"]`);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-workspace-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
    ),
    'details,rename,switch-,delete-',
    'the current workspace menu offers details and rename only',
  );
  await run("document.querySelector('[data-workspace-menu] [data-menu-item=rename]').click()");
  assert.equal(
    await run("document.querySelector('[data-workspace-save]').disabled"),
    true,
    'unchanged workspace names cannot be saved',
  );
  await run(
    "document.querySelector('.workspace-manager').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  assert.equal(
    await run("workspaceUI.open&&workspaceUI.mode==='details'"),
    true,
    'Escape cancels editing before closing the dialog',
  );
  await run("document.querySelector('[data-workspace-rename=\"'+workspaceUI.id+'\"]').click()");
  await run(
    "document.querySelector('[data-workspace-rename-form] input').value='Renamed UI Workspace';document.querySelector('[data-workspace-rename-form]').requestSubmit();window.waitForWorkspace()",
  );
  assert.equal(
    await run('settings().workspaceName'),
    'Renamed UI Workspace',
    'renaming updates current workspace',
  );
  await run('busy=true;render()');
  assert.equal(
    await run("document.querySelector('[data-workspace-select=default]').disabled"),
    true,
    'switching is disabled during requests',
  );
  await run('busy=false;render()');
  await run(
    "document.querySelector('[data-workspace-select=default]').click();window.waitForWorkspace()",
  );
  assert.equal(await run('workspaceUI.id'), 'default', 'switch returns to original workspace');
  assert.equal(
    await run(
      "state.requests.length===window.workspaceTestOriginal.requests.length&&!state.environments.some(environment=>environment.variables.some(variable=>variable.key==='workspace_marker'))",
    ),
    true,
    'original collections and environments are preserved',
  );
  assert.equal(
    await run('settings().workspaceName===window.workspaceTestOriginal.settings.workspaceName'),
    true,
    'workspace settings are isolated',
  );
  const switchedLockedResponse = await run(
    "window.workbench.send({id:'workspace-vault-check',url:'https://example.com',method:'GET',headers:{},body:'',credentialId:'not-unlocked'})",
  );
  assert.match(
    switchedLockedResponse.error,
    /credential vault is locked/,
    'switching locks the workspace vault',
  );
  await run('openWorkspaceManager()');
  await run(
    "document.querySelector('[data-workspace-select=\"'+window.workspaceTestNewId+'\"]').click();window.waitForWorkspace()",
  );
  assert.equal(
    await run(
      "current().name==='Isolated request'&&settings().timeoutMs===23000&&state.history.length===1&&state.environments[0].variables.some(variable=>variable.key==='workspace_marker')",
    ),
    true,
    'returning restores saved workspace data',
  );
  assert.equal(
    await run('settings().workspaceName'),
    'Renamed UI Workspace',
    'workspace rename persists',
  );
  await run('openWorkspaceManager()');
  await run(
    "document.querySelector('[data-workspace-select=default]').click();window.waitForWorkspace()",
  );
  await run('openWorkspaceManager()');
  await run(
    "document.querySelector('[data-workspace-inspect=\"'+window.workspaceTestNewId+'\"]').click()",
  );
  await run(
    "document.querySelector('[data-workspace-delete=\"'+window.workspaceTestNewId+'\"]').click()",
  );
  assert.equal(await run('workspaceUI.mode'), 'delete', 'delete opens an inline confirmation');
  await capture('workspaces-delete.png');
  await run("document.querySelector('[data-workspace-edit-cancel]').click()");
  assert.equal(await run('workspaceUI.index.workspaces.length'), 2, 'cancel keeps the workspace');
  await run(
    "document.querySelector('[data-workspace-delete=\"'+window.workspaceTestNewId+'\"]').click()",
  );
  await run(
    "document.querySelector('[data-workspace-delete-confirm]').click();window.waitForWorkspace()",
  );
  assert.equal(
    await run('workspaceUI.index.workspaces.length'),
    1,
    'confirmed delete removes inactive workspace',
  );
  assert.equal(
    fs.existsSync(path.join(temporary, 'workspaces', await run('window.workspaceTestNewId'))),
    false,
    'deleted workspace files are removed',
  );
  assert.equal(
    keychain.checks,
    keychainBeforeWorkspaceSwitch,
    'workspace management never accesses the keychain',
  );
  await run('closeWorkspaceManager()');
  await run("view='Collections';render()");
  assert.equal(
    await run(
      "(()=>{const heading=document.querySelector('.side-heading').getBoundingClientRect(),actions=document.querySelector('.side-actions').getBoundingClientRect(),box=document.querySelector('.sidebar').getBoundingClientRect();return actions.top<heading.bottom&&actions.right<=box.right;})()",
    ),
    true,
    'at its default width the explorer heading and buttons share one row',
  );
  await run(
    "window.explorerBefore=Math.round(document.querySelector('.sidebar').getBoundingClientRect().width);document.querySelector('.sidebar > .pane-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))",
  );
  assert.equal(
    await run(
      "Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)===window.explorerBefore+20&&localStorage.getItem('api-workbench:explorer-width')===String(window.explorerBefore+20)",
    ),
    true,
    'keyboard widens the explorer and remembers it',
  );
  await run(
    "document.querySelector('.sidebar > .pane-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))",
  );
  assert.equal(
    await run("Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)"),
    200,
    'Home narrows the explorer to its minimum',
  );
  assert.deepEqual(
    await run(
      "(()=>{const box=document.querySelector('.sidebar').getBoundingClientRect(),title=document.querySelector('.side-title');return {inside:[...title.querySelectorAll('button,h2')].every(item=>{const rect=item.getBoundingClientRect();return rect.left>=box.left-0.5&&rect.right<=box.right+0.5;}),fits:title.scrollWidth<=title.clientWidth};})()",
    ),
    { inside: true, fits: true },
    'the explorer heading and its buttons stay inside a narrow explorer',
  );
  await capture('explorer-narrow.png');
  await drag('.sidebar > .pane-resizer', 50, 0);
  assert.equal(
    await run(
      "Math.abs(Math.round(document.querySelector('.sidebar').getBoundingClientRect().width)-250)<=2",
    ),
    true,
    'dragging the explorer edge widens it',
  );
  await run("explorerWidth=undefined;localStorage.removeItem('api-workbench:explorer-width')");
  await run(
    "window.polishOriginal=structuredClone(state);view='Collections';render();document.dispatchEvent(new KeyboardEvent('keydown',{key:'b',metaKey:true,bubbles:true}))",
  );
  assert.equal(
    await run(
      "explorerCollapsed&&getComputedStyle(document.querySelector('.sidebar')).display==='none'&&document.activeElement.classList.contains('explorer-expand')",
    ),
    true,
    'Cmd+B hides the explorer and focuses the expand button',
  );
  await run("document.querySelector('.explorer-expand').click()");
  assert.equal(
    await run(
      "!explorerCollapsed&&getComputedStyle(document.querySelector('.sidebar')).display!=='none'",
    ),
    true,
    'the expand button restores the explorer',
  );
  await run("document.querySelector('.rail [data-view=Collections]').click()");
  assert.equal(
    await run('explorerCollapsed'),
    true,
    'clicking the active Collections icon toggles the explorer',
  );
  await run('toggleExplorer()');
  assert.equal(
    await run(
      "(()=>{const bar=document.querySelector('.urlbar');return document.querySelector('.request-title-row').contains(document.querySelector('#request-name'))&&bar.firstElementChild.matches('.request-type-select')&&bar.children[1].matches('#url');})()",
    ),
    true,
    'the request name has the title row, and the method or protocol leads the URL bar',
  );
  await run(
    "state.environments=[{name:'Development',variables:[{enabled:true,key:'base_url',value:'https://dev.example'},{enabled:true,key:'api_token',value:'TOKEN-123'}]},{name:'Production',variables:[]}];state.environment=0;view='Environments';render()",
  );
  assert.equal(
    await run(
      "document.querySelectorAll('.environment-item').length===2&&document.querySelector('.environment-item.is-active').textContent.includes('Development')",
    ),
    true,
    'environments are listed with the active one marked',
  );
  assert.equal(
    await run(
      "(()=>{const items=[...document.querySelectorAll('.environment-item')];const icons=items.map(item=>item.querySelector('.environment-item-icon'));const active=document.querySelector('.environment-item.is-active .environment-item-icon');const other=icons.find(icon=>icon!==active);return icons.every(Boolean)&&getComputedStyle(active).color!==getComputedStyle(other).color;})()",
    ),
    true,
    'each environment has an icon, and the active one stands out',
  );
  await capture('environments-list.png');
  assert.equal(
    await run(
      "(()=>{const input=document.querySelector('[data-type=variables][data-row=\"1\"][data-field=value]');return input.type==='password'&&document.querySelector('[data-type=variables][data-row=\"0\"][data-field=value]').type==='text';})()",
    ),
    true,
    'secret-looking variables are masked',
  );
  await run("document.querySelector('[data-reveal-variable=api_token]').click()");
  assert.equal(
    await run(
      'document.querySelector(\'[data-type=variables][data-row="1"][data-field=value]\').type',
    ),
    'text',
    'masked variables can be revealed',
  );
  await run('render()');
  assert.equal(
    await run(
      'document.querySelector(\'[data-type=variables][data-row="1"][data-field=value]\').type',
    ),
    'text',
    'revealed variables stay revealed across renders',
  );
  await run('document.querySelector(\'[data-env-select="1"]\').click()');
  assert.equal(await run('state.environment'), 1, 'selecting an environment makes it active');
  await run(
    "document.querySelector('[data-env-select=\"0\"]').click();document.querySelector('[data-env-duplicate]').click()",
  );
  assert.equal(
    await run(
      "state.environments.length===3&&state.environment===2&&state.environments[2].name==='Development copy'&&state.environments[2].variables.length===2",
    ),
    true,
    'environments can be duplicated',
  );
  // Below 1100px wide the environments become one row, which scrolls with arrows.
  const environmentSize = window.getSize();
  window.setSize(1050, environmentSize[1]);
  await pause(150);
  assert.equal(
    await run("getComputedStyle(document.querySelector('.environment-items')).flexDirection"),
    'row',
    'a narrow window shows the environments as one row',
  );
  await run(
    "document.querySelector('.environment-items').closest('.ui-tabs-frame').style.width='240px'",
  );
  await pause(80);
  assert.equal(
    await tabsReachable('.environment-items'),
    'reachable',
    'environments that do not fit are reachable with the arrows',
  );
  await run(
    "(()=>{const row=document.querySelector('.environment-items');row.scrollLeft=0;row.closest('.ui-tabs-frame').style.width=''})()",
  );
  window.setSize(environmentSize[0], environmentSize[1]);
  await pause(150);
  // Environment rows: right-click, Shift+F10, or the context menu key.
  const environmentMenu = "document.querySelector('[data-environment-menu]')";
  const environmentMenuItem = (id: string) =>
    run(`${environmentMenu}.querySelector('[data-menu-item=${id}]').click()`);
  await run(
    "(()=>{const row=document.querySelector('[data-env-select=\"0\"]');const box=row.getBoundingClientRect();row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:box.left+20,clientY:box.top+10}))})()",
  );
  await pause(30);
  assert.equal(
    await run(
      `${environmentMenu}.matches(':popover-open')&&[...${environmentMenu}.querySelectorAll('[data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()`,
    ),
    'activate,rename,duplicate,delete',
    'right-clicking an environment opens its menu',
  );
  await environmentMenuItem('activate');
  await pause(30);
  assert.equal(await run('state.environment'), 0, 'Make active activates that environment');
  await run(
    "document.querySelector('[data-env-select=\"1\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))",
  );
  await pause(30);
  await environmentMenuItem('rename');
  await pause(50);
  assert.equal(
    await run(
      "(()=>{const input=document.querySelector('#environment-name');return state.environment===1&&document.activeElement===input&&input.selectionStart===0&&input.selectionEnd===input.value.length})()",
    ),
    true,
    'Rename selects the environment and its name for editing',
  );
  await run(
    "document.querySelector('[data-env-select=\"2\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  await environmentMenuItem('delete');
  assert.match(
    await answerConfirm(true),
    /Delete the Development copy environment\?/,
    'Delete from the environment menu asks first',
  );
  await pause(50);
  assert.equal(
    await run(
      "state.environments.length===2&&!state.environments.some(environment=>environment.name==='Development copy')",
    ),
    true,
    'Delete from the environment menu removes that environment',
  );
  await run(
    "state.history=[{requestId:current().id,method:'GET',url:'https://api.example.com/ok',status:200,date:new Date().toISOString(),time:42,response:{status:200,statusText:'OK',headers:{'content-type':'application/json','x-trace':'abc'},body:'{\"ok\":true,\"n\":[1,2]}',size:20}},{requestId:current().id,method:'POST',url:'https://api.example.com/missing',status:404,date:new Date(Date.now()-86400000).toISOString()},{requestId:'deleted',method:'GET',url:'https://api.example.com/down',date:new Date().toISOString()}];view='History';render()",
  );
  assert.equal(
    await run("[...document.querySelectorAll('.history-day')].map(day=>day.textContent).join('|')"),
    'Today|Yesterday|Today',
    'history groups entries by day',
  );
  assert.equal(
    await run(
      "document.querySelector('.history-entry').textContent.includes('42 ms')&&document.querySelectorAll('.history-entry[data-deleted=true]').length===1",
    ),
    true,
    'history shows durations and marks deleted requests',
  );
  // Selecting an entry shows its response; Format tidies the body.
  await run('document.querySelector(\'[data-history-entry="0"]\').click()');
  await pause(150);
  const historyEditor = "editorView('#history-response-editor')";
  assert.equal(
    await run(`${historyEditor}.state.doc.toString()`),
    '{"ok":true,"n":[1,2]}',
    'selecting a history entry shows its response body',
  );
  await run("document.querySelector('[data-history-format]').click()");
  await pause(300);
  assert.equal(
    await run(`${historyEditor}.state.doc.toString()`),
    '{\n  "ok": true,\n  "n": [\n    1,\n    2\n  ]\n}\n',
    'Format tidies the history response body',
  );
  // Capture value in the body menu adds the JSON path under the cursor to the entry's request.
  await run(
    `window.historyRequest=state.requests.find(item=>item.id===state.history[0].requestId);window.historyCapturesBefore=structuredClone(window.historyRequest.captures||[]);(view=>{view.dispatch({selection:{anchor:view.state.doc.toString().indexOf('true')+1}});view.focus();})(${historyEditor});document.querySelector('#history-response-editor .cm-content').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))`,
  );
  await pause(30);
  await run(
    "document.querySelector('#history-response-editor [data-editor-menu] [data-menu-item=capture]').click()",
  );
  await pause(50);
  assert.deepEqual(
    await run(
      '[JSON.stringify(window.historyRequest.captures.at(-1)),state.active===window.historyRequest.id,view,requestTab]',
    ),
    [JSON.stringify({ enabled: true, key: 'ok', value: '$.ok' }), true, 'Collections', 'Vars'],
    "Capture value in a history body adds the value's JSON path to the entry's request",
  );
  await run(
    "window.historyRequest.captures=window.historyCapturesBefore;requestTab='Params';view='History';render()",
  );
  await pause(100);
  await run("document.querySelector('[data-history-tab=Headers]').click()");
  await pause(50);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-history-header] th, [data-history-header] td')].map(node=>node.textContent).join(' ')",
    ),
    'content-type application/json x-trace abc',
    'the Headers tab lists the response headers',
  );
  // The Raw view lists header lines; Capture value takes the header, or the cookie, on the line.
  await run(
    "window.historyRequest=state.requests.find(item=>item.id===state.history[0].requestId);window.historyCapturesBefore=structuredClone(window.historyRequest.captures||[]);window.keptHeaders={...state.history[0].response.headers};state.history[0].response.headers['set-cookie']='session=abc; Path=/, theme=dark';render()",
  );
  await run("document.querySelector('[data-history-headers-view=Raw]').click()");
  await pause(100);
  const historyHeaders = "editorView('#history-headers-editor')";
  const captureAtRaw = async (marker: string) => {
    await run(
      `(view=>{view.dispatch({selection:{anchor:view.state.doc.toString().indexOf(${JSON.stringify(marker)})+1}});view.focus();})(${historyHeaders});document.querySelector('#history-headers-editor .cm-content').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))`,
    );
    await pause(30);
    await run(
      "document.querySelector('#history-headers-editor [data-editor-menu] [data-menu-item=capture]').click()",
    );
    await pause(50);
    const captured = await run('window.historyRequest.captures.at(-1).value');
    await run("view='History';render()");
    await pause(80);
    return captured;
  };
  assert.equal(
    await run(`${historyHeaders}.state.doc.toString().includes('x-trace: abc')`),
    true,
    'the Raw view shows the headers as lines',
  );
  assert.equal(
    await captureAtRaw('theme=dark'),
    'cookie theme',
    'a Set-Cookie line captures the cookie under the cursor',
  );
  assert.equal(
    await captureAtRaw('x-trace'),
    'header x-trace',
    'a header line captures that header',
  );
  await run(
    "window.historyRequest.captures=window.historyCapturesBefore;state.history[0].response.headers=window.keptHeaders;requestTab='Params';render()",
  );
  await run("document.querySelector('[data-history-headers-view=Table]').click()");
  await pause(50);
  // A header row's menu captures the header into the entry's request.
  await run(
    "window.historyRequest=state.requests.find(item=>item.id===state.history[0].requestId);window.historyCapturesBefore=structuredClone(window.historyRequest.captures||[]);document.querySelector('[data-history-header=\"x-trace\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-response-header-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
    ),
    'name,value,header,capture',
    'a history header offers copying and capturing',
  );
  await run(
    "document.querySelector('[data-response-header-menu] [data-menu-item=capture]').click()",
  );
  await pause(50);
  assert.deepEqual(
    await run(
      '[JSON.stringify(window.historyRequest.captures.at(-1)),state.active===window.historyRequest.id,view,requestTab]',
    ),
    [
      JSON.stringify({ enabled: true, key: 'x_trace', value: 'header x-trace' }),
      true,
      'Collections',
      'Vars',
    ],
    "capturing a history header adds it to the entry's request and opens its Vars tab",
  );
  await run(
    "window.historyRequest.captures=window.historyCapturesBefore;requestTab='Params';view='History';render()",
  );
  await pause(50);
  // The Preview tab renders a kept HTML body; an element captures into the entry's request.
  await run(
    'window.historyRequest=state.requests.find(item=>item.id===state.history[0].requestId);window.historyCapturesBefore=structuredClone(window.historyRequest.captures||[]);window.keptBefore=structuredClone(state.history[0].response);Object.assign(state.history[0].response,{headers:{\'content-type\':\'text/html\'},body:\'<title>Sign in</title><form><input type="hidden" name="csrf" value="tok-9"></form>\'});render()',
  );
  await run("document.querySelector('[data-history-tab=Preview]').click()");
  await pause(300);
  await run(
    "(()=>{const frame=document.querySelector('[data-history-detail] [data-html-preview]');const input=frame.contentDocument.querySelector('input[name=csrf]');input.dispatchEvent(new frame.contentWindow.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:5,clientY:5}));})()",
  );
  await pause(50);
  await run(
    "[...document.querySelectorAll('[data-history-detail] [data-preview-menu] [data-menu-item]')].find(item=>item.textContent.includes('value')).click()",
  );
  await pause(50);
  assert.deepEqual(
    await run(
      '[JSON.stringify(window.historyRequest.captures.at(-1)),state.active===window.historyRequest.id,view,requestTab]',
    ),
    [
      JSON.stringify({ enabled: true, key: 'csrf', value: 'html input[name="csrf"] @value' }),
      true,
      'Collections',
      'Vars',
    ],
    "capturing from a kept HTML preview adds the element's value to the entry's request",
  );
  // A body that cannot be previewed takes the Body view, not another tab's.
  await run(
    "window.historyRequest.captures=window.historyCapturesBefore;state.history[0].response=window.keptBefore;requestTab='Params';view='History';render()",
  );
  await pause(80);
  assert.equal(
    await run(
      "[Boolean(document.querySelector('[data-history-tab=Preview]')),document.querySelector('[data-history-tab=Body]').getAttribute('aria-selected')].join()",
    ),
    'false,true',
    'a JSON entry has no Preview, and shows its body when Preview was chosen',
  );
  // The Console tab lists the send's console lines; the outcome line captures what it reports.
  await run(
    "window.historyRequest=state.requests.find(item=>item.id===state.history[0].requestId);window.historyCapturesBefore=structuredClone(window.historyRequest.captures||[]);state.history[0].response.setCookies=[{url:'http://127.0.0.1/',header:'session=abc'}];state.history[0].console=[{at:Date.now(),level:'success',kind:'completed',message:'200 OK · 42 ms · 21 bytes · 0/0 assertions passed'},{at:Date.now(),level:'info',kind:'cookies',message:'Received 1 Set-Cookie header; cookie jar updated'}];render()",
  );
  await run("document.querySelector('[data-history-tab=Console]').click()");
  await pause(50);
  await run(
    "document.querySelector('[data-history-console=\"0\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-history-console-menu] [data-menu-item]')].map(item=>item.dataset.menuItem).join()",
    ),
    'copy,capture-status,capture-time,capture-size',
    'the outcome line offers to capture the status, time, and size it reports',
  );
  await run(
    "document.querySelector('[data-history-console-menu] [data-menu-item=capture-time]').click()",
  );
  await pause(50);
  assert.deepEqual(
    await run(
      '[JSON.stringify(window.historyRequest.captures.at(-1)),state.active===window.historyRequest.id,view,requestTab]',
    ),
    [JSON.stringify({ enabled: true, key: 'time_ms', value: 'time' }), true, 'Collections', 'Vars'],
    "capturing from a console line adds it to the entry's request",
  );
  await run("view='History';render()");
  await pause(50);
  await run(
    "document.querySelector('[data-history-console=\"1\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-history-console-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+':'+item.textContent.trim()).join()",
    ),
    'copy:Copy message,cookie-0:session',
    'the cookie line offers each cookie the response set',
  );
  await run(
    "document.querySelector('[data-history-console-menu]').hidePopover();window.historyRequest.captures=window.historyCapturesBefore;delete state.history[0].console;delete state.history[0].response.setCookies;requestTab='Params';view='History';render()",
  );
  await pause(50);
  // The Tests tab runs the request's tests on the kept response; a result captures its value.
  await run(
    "window.historyRequest=state.requests.find(item=>item.id===state.history[0].requestId);window.historyTestsBefore=window.historyRequest.tests;window.historyCapturesBefore=structuredClone(window.historyRequest.captures||[]);window.historyRequest.tests='status 200\\njson $.ok equals true\\njson-valid';render()",
  );
  await run("document.querySelector('[data-history-tab=Tests]').click()");
  await pause(50);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-test-result]')].map(row=>row.querySelector('strong').textContent).join()",
    ),
    'PASS,PASS,PASS',
    "the Tests tab runs the request's tests on the kept response",
  );
  await run(
    "document.querySelector('[data-test-result=\"2\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  assert.equal(
    await run(
      "document.querySelector('[data-test-result-menu] [data-menu-item=capture]').disabled",
    ),
    true,
    'a check with no single value has nothing to capture',
  );
  await run(
    "document.querySelector('[data-test-result-menu]').hidePopover();document.querySelector('[data-test-result=\"1\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  assert.equal(
    await run(
      "document.querySelector('[data-test-result-menu] [data-menu-item=capture]').textContent.trim()",
    ),
    'Capture $.ok',
    'a JSON assertion offers to capture its path',
  );
  await run("document.querySelector('[data-test-result-menu] [data-menu-item=capture]').click()");
  await pause(50);
  assert.deepEqual(
    await run(
      '[JSON.stringify(window.historyRequest.captures.at(-1)),state.active===window.historyRequest.id,view,requestTab]',
    ),
    [JSON.stringify({ enabled: true, key: 'ok', value: '$.ok' }), true, 'Collections', 'Vars'],
    "capturing from a test result adds the value it checks to the entry's request",
  );
  await run(
    "window.historyRequest.tests=window.historyTestsBefore;window.historyRequest.captures=window.historyCapturesBefore;requestTab='Params';view='History';render()",
  );
  await pause(50);
  // The Compare tab diffs the entry with an earlier response of its request; lines capture.
  await run(
    "window.compareEntry={...structuredClone(state.history[0]),date:new Date(Date.parse(state.history[0].date)-60000).toISOString(),response:{...structuredClone(state.history[0].response),body:'{\"ok\":false,\"n\":[1,2]}',headers:{...state.history[0].response.headers,'x-trace':'old'}}};state.history.splice(1,0,window.compareEntry);render()",
  );
  await run("document.querySelector('[data-history-tab=Compare]').click()");
  await pause(80);
  assert.deepEqual(
    await run(
      "[document.querySelector('.compare-summary').textContent.includes('−1 lines')||document.querySelector('.compare-summary').textContent.includes('+1'),[...document.querySelectorAll('[data-compare-header]')].map(row=>row.dataset.compareHeader).join()]",
    ),
    [true, 'x-trace'],
    'the Compare tab diffs the body and headers against the previous response of the request',
  );
  await run(
    "window.historyRequest=state.requests.find(item=>item.id===state.history[0].requestId);window.historyCapturesBefore=structuredClone(window.historyRequest.captures||[]);(()=>{const code=[...document.querySelectorAll('.compare-row .compare-right')].find(cell=>cell.textContent.includes('\"ok\"'));const box=code.getBoundingClientRect();code.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:box.left+10,clientY:box.top+5}));})()",
  );
  await pause(30);
  await run("document.querySelector('[data-compare-menu] [data-menu-item=capture]').click()");
  await pause(50);
  assert.deepEqual(
    await run(
      '[JSON.stringify(window.historyRequest.captures.at(-1)),state.active===window.historyRequest.id,view,requestTab]',
    ),
    [JSON.stringify({ enabled: true, key: 'ok', value: '$.ok' }), true, 'Collections', 'Vars'],
    "capturing a line of the comparison adds its JSON path to the entry's request",
  );
  await run("view='History';render()");
  await pause(50);
  await run(
    "document.querySelector('[data-compare-header=\"x-trace\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  await run("document.querySelector('[data-compare-menu] [data-menu-item=capture]').click()");
  await pause(50);
  assert.equal(
    await run('window.historyRequest.captures.at(-1).value'),
    'header x-trace',
    'a changed header of the comparison captures that header',
  );
  await run(
    "window.historyRequest.captures=window.historyCapturesBefore;state.history.splice(state.history.indexOf(window.compareEntry),1);requestTab='Params';view='History';render()",
  );
  await pause(50);
  // The Certificate tab shows the kept TLS details; a field can be captured into the request.
  await run(
    "(()=>{const certificate=cn=>({subject:'CN='+cn,issuer:'CN=Example CA',validFrom:'2026-01-01T00:00:00.000Z',validTo:'2027-01-01T00:00:00.000Z',serialNumber:'0A',subjectAltName:'DNS:'+cn,fingerprint:'AA',fingerprint256:'BB',fingerprint512:'CC',publicKeyType:'rsa',keyBits:2048,ca:cn!=='api.example.com',pem:'-----BEGIN CERTIFICATE-----'});state.history[0].response.tls={host:'api.example.com',port:443,capturedAt:new Date().toISOString(),authorized:true,protocol:'TLSv1.3',cipher:{name:'TLS_AES_128_GCM_SHA256',version:'TLSv1.3'},chain:[certificate('api.example.com'),certificate('Example CA')]};render();})()",
  );
  await run("document.querySelector('[data-history-tab=Certificate]').click()");
  await pause(50);
  assert.equal(
    await run(
      "['host','1:valid-to','2:valid-to','TLS session'].every(key=>document.querySelector(`[data-certificate-field=\"${key}\"]`))",
    ),
    true,
    'the Certificate tab shows the connection and each certificate of the chain',
  );
  await run(
    "document.querySelector('[data-certificate-field=\"TLS session\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-certificate-menu] [data-menu-item]')].map(item=>item.dataset.menuItem).join()",
    ),
    'copy',
    'a field no capture reads offers only copying',
  );
  await run(
    "document.querySelector('[data-certificate-menu]').hidePopover();window.historyRequest=state.requests.find(item=>item.id===state.history[0].requestId);window.historyCapturesBefore=structuredClone(window.historyRequest.captures||[]);document.querySelector('[data-certificate-field=\"2:valid-to\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  await run("document.querySelector('[data-certificate-menu] [data-menu-item=capture]').click()");
  await pause(50);
  assert.deepEqual(
    await run(
      '[JSON.stringify(window.historyRequest.captures.at(-1)),state.active===window.historyRequest.id,view,requestTab]',
    ),
    [
      JSON.stringify({ enabled: true, key: 'cert_valid_to_2', value: 'certificate valid-to 2' }),
      true,
      'Collections',
      'Vars',
    ],
    "capturing a certificate field of the chain adds it to the entry's request",
  );
  await run(
    "window.historyRequest.captures=window.historyCapturesBefore;delete state.history[0].response.tls;requestTab='Params';view='History';render()",
  );
  await pause(50);
  // The Timeline tab shows the kept network timing; a phase can be captured into the request.
  await run(
    "state.history[0].response.timings={startedAt:new Date().toISOString(),totalMs:60,preparationMs:1,requests:[{method:'GET',url:'http://127.0.0.1/old',status:301,startMs:0,durationMs:20,connectionReused:false,phases:[{id:'dns',label:'DNS lookup',startMs:0,durationMs:3},{id:'tcp',label:'TCP connection',startMs:3,durationMs:5}]},{method:'GET',url:'http://127.0.0.1/new',status:200,startMs:20,durationMs:40,connectionReused:true,phases:[{id:'waiting',label:'Waiting (TTFB)',startMs:20,durationMs:30}]}]};render()",
  );
  await run("document.querySelector('[data-history-tab=Timeline]').click()");
  await pause(50);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-timing-row]')].map(row=>row.dataset.timingRow).join()",
    ),
    'total,1:dns,1:tcp,2:waiting',
    'the Timeline tab shows each request of the exchange and its phases',
  );
  await run(
    "window.historyRequest=state.requests.find(item=>item.id===state.history[0].requestId);window.historyCapturesBefore=structuredClone(window.historyRequest.captures||[]);document.querySelector('[data-timing-row=\"1:dns\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  await run("document.querySelector('[data-timing-menu] [data-menu-item=capture]').click()");
  await pause(50);
  assert.deepEqual(
    await run(
      '[JSON.stringify(window.historyRequest.captures.at(-1)),state.active===window.historyRequest.id,view,requestTab]',
    ),
    [
      JSON.stringify({ enabled: true, key: 'dns_ms_1', value: 'timing dns 1' }),
      true,
      'Collections',
      'Vars',
    ],
    "capturing a phase of an earlier hop names that hop, in the entry's request",
  );
  await run(
    "window.historyRequest.captures=window.historyCapturesBefore;delete state.history[0].response.timings;requestTab='Params';view='History';render()",
  );
  await pause(50);
  // The Cookies tab lists the cookies the response set; one can be captured into its request.
  await run(
    "state.history[0].response.setCookies=[{url:'https://api.example.com/login',header:'session=abc; Path=/; HttpOnly'},{url:'https://api.example.com/login',header:'theme=dark; Domain=other.test'}];render()",
  );
  await run("document.querySelector('[data-history-tab=Cookies]').click()");
  await pause(50);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-history-cookie]')].map(row=>[...row.children].map(cell=>cell.textContent.trim()).join(' ')).join(' | ')",
    ),
    // A cookie for another domain is rejected by a browser, but its value can still be read.
    'session abc api.example.com/ | theme dark ',
    'the Cookies tab lists each cookie with its domain and path',
  );
  await run(
    "window.historyRequest=state.requests.find(item=>item.id===state.history[0].requestId);window.historyCapturesBefore=structuredClone(window.historyRequest.captures||[]);document.querySelector('[data-history-cookie=\"0\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  await run(
    "document.querySelector('[data-history-cookie-menu] [data-menu-item=capture]').click()",
  );
  await pause(50);
  assert.deepEqual(
    await run(
      '[JSON.stringify(window.historyRequest.captures.at(-1)),state.active===window.historyRequest.id,view,requestTab]',
    ),
    [
      JSON.stringify({ enabled: true, key: 'session', value: 'cookie session' }),
      true,
      'Collections',
      'Vars',
    ],
    "capturing a history cookie adds it to the entry's request and opens its Vars tab",
  );
  await run(
    "window.historyRequest.captures=window.historyCapturesBefore;delete state.history[0].response.setCookies;requestTab='Params';view='History';render()",
  );
  await pause(50);
  await run("document.querySelector('[data-history-tab=Body]').click()");
  assert.equal(
    await run(
      'persistedWorkspace().history[0].response===undefined&&Boolean(state.history[0].response)',
    ),
    true,
    'history responses stay in this session unless responses are saved',
  );
  // A failed entry shows its error and console; both capture into the entry's request.
  await run(
    "window.failedEntry={requestId:state.history[0].requestId,method:'GET',url:'http://127.0.0.1/timeout-check',date:new Date(Date.parse(state.history[0].date)-120000).toISOString(),failure:{error:'Request timed out after 2000 ms',timings:{startedAt:new Date().toISOString(),totalMs:2000,preparationMs:0,requests:[{method:'GET',url:'http://127.0.0.1/timeout-check',startMs:0,durationMs:2000,connectionReused:false,phases:[{id:'tcp',label:'TCP connection',startMs:0,durationMs:3}]}]}},console:[{at:Date.now(),level:'info',kind:'started',message:'Request started'},{at:Date.now(),level:'error',kind:'failed',message:'Request failed after 2000 ms: Request timed out after 2000 ms'}]};state.history.push(window.failedEntry);window.historyRequest=state.requests.find(item=>item.id===window.failedEntry.requestId);window.historyCapturesBefore=structuredClone(window.historyRequest.captures||[]);render()",
  );
  await run(
    "[...document.querySelectorAll('.history-entry')].find(row=>row.textContent.includes('timeout-check')).click()",
  );
  await pause(80);
  assert.deepEqual(
    await run(
      "[document.querySelector('[data-history-error]').textContent.includes('Request timed out after 2000 ms'),[...document.querySelectorAll('[data-history-detail] [data-history-tab]')].map(tab=>tab.dataset.historyTab).join()]",
    ),
    [true, 'Console,Timeline'],
    'a failed entry shows its error and the views it kept',
  );
  assert.equal(
    await run(
      "(()=>{const card=document.querySelector('[data-history-error]');const style=getComputedStyle(card);return card.offsetHeight>0&&style.display==='flex'&&style.borderTopStyle==='solid';})()",
    ),
    true,
    'the error card is shown as a framed row',
  );
  await run(
    "document.querySelector('[data-history-console=\"1\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-history-console-menu] [data-menu-item]')].map(item=>item.dataset.menuItem).join()",
    ),
    'copy,capture-error,capture-total',
    'the failure line offers its error and total time',
  );
  await run(
    "document.querySelector('[data-history-console-menu] [data-menu-item=capture-error]').click()",
  );
  await pause(50);
  assert.deepEqual(
    await run(
      '[JSON.stringify(window.historyRequest.captures.at(-1)),state.active===window.historyRequest.id,view,requestTab]',
    ),
    [JSON.stringify({ enabled: true, key: 'error', value: 'error' }), true, 'Collections', 'Vars'],
    "capturing a failure line adds an error capture to the entry's request",
  );
  await run("view='History';render()");
  await pause(50);
  await run(
    "document.querySelector('[data-history-error]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  await run("document.querySelector('[data-history-error-menu] [data-menu-item=capture]').click()");
  await pause(50);
  assert.equal(
    await run('window.historyRequest.captures.at(-1).key'),
    'error_2',
    'the error card captures the error too, under a free name',
  );
  await run(
    "window.historyRequest.captures=window.historyCapturesBefore;state.history.splice(state.history.indexOf(window.failedEntry),1);requestTab='Params';view='History';render()",
  );
  await pause(50);
  await run("document.querySelector('.history-entry[data-deleted=true]').click()");
  await pause(100);
  assert.equal(
    await run(
      "document.querySelector('[data-history-detail]').textContent.includes('there was no response')&&document.querySelector('[data-history-open]').disabled",
    ),
    true,
    'a failed request explains why there is no response, and cannot be opened once deleted',
  );
  await run("document.querySelector('[data-history-close]').click()");
  await pause(50);
  assert.equal(
    await run("Boolean(document.querySelector('[data-history-detail]'))"),
    false,
    'closing hides the response',
  );
  await run('document.querySelector(\'[data-history-status="4xx"]\').click()');
  assert.equal(
    await run(
      "document.querySelectorAll('.history-entry').length===1&&document.querySelector('.history-entry').textContent.includes('404')",
    ),
    true,
    'history filters by status class',
  );
  // Squeezed, the status filters scroll with arrows.
  await run(
    "document.querySelector('[aria-label=\"Filter by status\"]').closest('.ui-tabs-frame').style.width='220px'",
  );
  await pause(80);
  assert.equal(
    await tabsReachable('[aria-label="Filter by status"]'),
    'reachable',
    'history status filters that do not fit are reachable with the arrows',
  );
  await run(
    "(()=>{const row=document.querySelector('[aria-label=\"Filter by status\"]');row.scrollLeft=0;row.closest('.ui-tabs-frame').style.width=''})()",
  );
  await run(
    "document.querySelector('[data-history-status=All]').click();(()=>{const input=document.querySelector('#history-search');input.focus();input.value='down';input.dispatchEvent(new Event('input'));})()",
  );
  assert.equal(
    await run(
      "document.querySelectorAll('.history-entry').length===1&&document.querySelector('.history-entry').textContent.includes('Deleted request')&&document.activeElement.id==='history-search'",
    ),
    true,
    'history search filters while keeping focus',
  );
  assert.equal(
    await run(
      "(()=>{const entries=[...document.querySelectorAll('.history-entry')];return entries.length>0&&entries.every(entry=>entry.querySelector('.method .method-icon'));})()",
    ),
    true,
    'history entries show their method icon',
  );
  // History rows: right-click, Shift+F10, or the context menu key.
  const historyMenu = "document.querySelector('[data-history-menu]')";
  const historyMenuItem = (id: string) =>
    run(`${historyMenu}.querySelector('[data-menu-item=${id}]').click()`);
  await run(
    "(()=>{const row=document.querySelector('.history-entry');const box=row.getBoundingClientRect();row.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:box.left+40,clientY:box.top+10}))})()",
  );
  await pause(30);
  assert.equal(
    await run(
      `${historyMenu}.matches(':popover-open')&&[...${historyMenu}.querySelectorAll('[data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()`,
    ),
    'open-,send-,copy,filter,remove',
    'a deleted request row can be right-clicked, with only its URL actions enabled',
  );
  await run(
    "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.historyCopied=value;}}})",
  );
  await historyMenuItem('copy');
  await pause(80);
  assert.equal(
    await run('window.historyCopied'),
    'https://api.example.com/down',
    'Copy URL copies the history entry URL',
  );
  await run(
    "(()=>{const input=document.querySelector('#history-search');input.value='';input.dispatchEvent(new Event('input'));})()",
  );
  await pause(30);
  await run(
    "[...document.querySelectorAll('.history-entry')].find(row=>row.textContent.includes('404')).dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))",
  );
  await pause(30);
  assert.equal(
    await run(`${historyMenu}.querySelector('[data-menu-item=filter]').textContent.trim()`),
    'Show only 4xx',
    "the history menu offers the row's status filter",
  );
  await historyMenuItem('filter');
  await pause(30);
  assert.equal(
    await run(
      "document.querySelector('[data-history-status=\"4xx\"]').getAttribute('aria-pressed')==='true'&&document.querySelectorAll('.history-entry').length===1",
    ),
    true,
    'Show only filters the history by that status',
  );
  await run("document.querySelector('[data-history-status=All]').click()");
  await pause(30);
  await run(
    "window.removedHistory=state.history[2];document.querySelector('.history-entry[data-deleted=true]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  await historyMenuItem('remove');
  await pause(30);
  assert.equal(
    await run(
      "state.history.length===2&&!document.querySelector('.history-entry[data-deleted=true]')",
    ),
    true,
    'Remove from history removes only that entry',
  );
  await run('state.history.push(window.removedHistory);render()');
  await capture('history.png');
  // Clear history asks first, names how many entries go, and leaves them on Cancel.
  await run("document.querySelector('[data-action=clear-history]').click()");
  assert.match(
    await answerConfirm(false),
    /Clear request history\?/,
    'Clear history asks for confirmation',
  );
  assert.equal(await run('state.history.length'), 3, 'cancelling keeps the history');
  await run("document.querySelector('[data-action=clear-history]').click()");
  await pause(80);
  assert.match(
    (await run("document.querySelector('#confirm-dialog-message').textContent")) as string,
    /All 3 entries/,
    'the dialog says how many entries are removed',
  );
  await answerConfirm(true);
  assert.equal(await run('state.history.length'), 0, 'confirming clears the history');
  await run("action('clear-history')");
  await pause(80);
  assert.equal(
    await run("!document.querySelector('[data-confirm-dialog]').open"),
    true,
    'an empty history is not confirmed',
  );
  await run(
    "historyUI.query='';historyUI.status='All';state=window.polishOriginal;view='Collections';render()",
  );
  for (const screen of [
    'Overview',
    'Environments',
    'Credentials',
    'Runner',
    'Interceptor',
    'History',
    'Cookies',
    'Documentation',
    'Settings',
  ]) {
    await run(`view='${screen}';render()`);
    assert.equal(
      await run(
        "document.querySelector('.layout').classList.contains('management')&&getComputedStyle(document.querySelector('.sidebar')).display==='none'",
      ),
      true,
      `the collection explorer is hidden on ${screen}`,
    );
  }
  await run("view='Collections';render()");
  assert.equal(
    await run(
      "!document.querySelector('.layout').classList.contains('management')&&getComputedStyle(document.querySelector('.sidebar')).display!=='none'",
    ),
    true,
    'the collection explorer shows on Collections',
  );
}
