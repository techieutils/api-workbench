import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { BrowserWindow, BaseWindow, WebContentsView } from 'electron';
import { createHarness, pause, type SmokeContext } from './harness';

/** UI smoke checks, part 3: panes and dev tools. */
export default async function panesAndDevTools(context: SmokeContext) {
  const { window, run, capture, rightClick, drag } = context;
  // The code panel docked beside the request, as a person would open it.
  await run(
    "view='Collections';render();if(!document.querySelector('.code-dock .codegen-panel'))action('code')",
  );
  await pause(200);
  // Narrow panes keep their content inside: long code lines scroll, and the request pane keeps its minimum width.
  await run(
    "window.narrowOriginalURL=current().url;current().url='https://api.example.com/v2/organizations/acme-international-holdings/projects/payments-platform/environments?include=members';requestPanels.layout='side';requestPanels.share=25;requestPanels.codeWidth=720;explorerWidth=480;render()",
  );
  await run('updateCodeGeneration()');
  assert.equal(
    await run(
      "(()=>{const preview=document.querySelector('.codegen-preview'),source=document.querySelector('.codegen-source');return source.scrollWidth<=source.clientWidth+1&&preview.scrollWidth>preview.clientWidth;})()",
    ),
    true,
    'long generated lines scroll inside the code preview',
  );
  assert.equal(
    await run("document.querySelector('.request-pane').getBoundingClientRect().width>=260"),
    true,
    'the request pane keeps its minimum width beside a wide explorer and code panel',
  );
  assert.equal(
    await run(
      "(()=>{const pane=document.querySelector('.request-pane').getBoundingClientRect();return [...document.querySelectorAll('.urlbar > *')].every(item=>{const box=item.getBoundingClientRect();return box.left>=pane.left&&box.right<=pane.right+1;});})()",
    ),
    true,
    'the URL bar stays inside the request pane',
  );
  assert.equal(
    await run(
      "(()=>{const parts=['.urlbar > .method-select','#url','.urlbar .send'].map(selector=>document.querySelector(selector).getBoundingClientRect());const middles=parts.map(box=>box.top+box.height/2);return Math.max(...middles)-Math.min(...middles)<4&&parts[0].right<=parts[1].left&&parts[1].right<=parts[2].left&&parts[1].width>=90;})()",
    ),
    true,
    'in a narrow request pane, method, URL, and Send stay on one row without overlapping',
  );
  await run(
    "current().url=window.narrowOriginalURL;requestPanels.layout='stacked';requestPanels.share=60;requestPanels.codeWidth=360;explorerWidth=undefined;render()",
  );
  await drag('.workspace-docks > .pane-resizer', -60, 0);
  // The pointer grabs the divider's centre, so the panel edge lands within a pixel of +60.
  assert.equal(
    await run('Math.abs(requestPanels.codeWidth-420)<=2'),
    true,
    'dragging the divider left widens the code panel',
  );
  assert.equal(
    await run(
      "JSON.parse(localStorage.getItem('api-workbench:panes')).codeWidth===requestPanels.codeWidth",
    ),
    true,
    'a drag is remembered when it ends',
  );
  await run(
    "document.querySelector('.workspace-docks > .pane-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  assert.equal(
    await run("Boolean(document.querySelector('.codegen-backdrop'))"),
    false,
    'docked code does not block the editor',
  );
  assert.equal(
    await run(
      "document.querySelector('.code-dock').getBoundingClientRect().left>=document.querySelector('.request-response-panes').getBoundingClientRect().right-1",
    ),
    true,
    'Code stays on the right when request and response are stacked',
  );
  await run(
    "document.querySelector('.status-layout-trigger').click();document.querySelector('[data-panel-layout=side]').click()",
  );
  assert.equal(
    await run(
      "document.querySelector('.code-dock').getBoundingClientRect().left>=document.querySelector('.request-response-panes').getBoundingClientRect().right-1",
    ),
    true,
    'Side by side layout places code alongside request and response',
  );
  await run(
    "document.querySelector('.status-layout-trigger').click();document.querySelector('[data-panel-layout=stacked]').click()",
  );

  await run(
    "document.querySelector('#url').value='https://example.com/live-code';document.querySelector('#url').dispatchEvent(new Event('input'))",
  );
  await pause(450);
  assert.equal(
    await run("codeDialog.result.code.includes('/live-code')"),
    true,
    'docked code updates while editing',
  );
  await run("document.querySelector('[data-toggle-panel=code]').click()");
  assert.equal(await run("Boolean(document.querySelector('.code-dock'))"), false);
  await run(
    "document.querySelector('[data-dev-tools-toggle]').click();window.consoleOriginalRequest=structuredClone(current())",
  );
  await pause(100);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-console-select]')].every(box=>{const value=box.querySelector('.ui-select-value');return box.getBoundingClientRect().width>=100&&value.getBoundingClientRect().width>40&&value.textContent.trim().length>0&&Boolean(box.querySelector('.ui-select-value-icon'));})",
    ),
    true,
    'the console select boxes show their label and icon at a readable width',
  );
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-console-select]')].map(box=>box.querySelector('.ui-select-value').textContent.trim()).join()",
    ),
    'Current request,All levels',
  );
  await run("document.querySelector('[data-console-select=level] .ui-select-trigger').click()");
  await pause(120);
  assert.equal(
    await run(
      "(()=>{const menu=document.querySelector('[data-console-select=level] .ui-select-menu');const options=[...menu.querySelectorAll('.ui-select-option')];return menu.matches(':popover-open')&&!menu.querySelector('.ui-select-search')&&options.length===4&&options.every(option=>option.querySelector('.ui-select-option-icon'))&&getComputedStyle(options[3].querySelector('.ui-select-option-icon')).color!==getComputedStyle(options[1].querySelector('.ui-select-option-icon')).color;})()",
    ),
    true,
    'the console level list shows each level with its icon and colour',
  );
  await capture('console-level-select.png');
  await run("document.querySelector('[data-console-select=level] .ui-select-menu').hidePopover()");
  await capture('panes-console.png');
  await run(
    "window.consoleHeightBefore=devTools.height;document.querySelector('.devtools-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))",
  );
  assert.equal(
    await run(
      "devTools.height===window.consoleHeightBefore+20&&Math.round(document.querySelector('.devtools').getBoundingClientRect().height)===devTools.height",
    ),
    true,
    'keyboard makes dev tools taller',
  );
  await run(
    "document.querySelector('.devtools-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  assert.equal(await run('devTools.height'), 260, 'double-click resets the dev tools height');
  await drag('.devtools-resizer', 0, -40);
  assert.equal(
    await run('Math.abs(devTools.height-300)<=2'),
    true,
    'dragging the divider up makes dev tools taller',
  );
  await run(
    "document.querySelector('.devtools-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  const consoleServer = createServer((request, response) => {
    response.statusCode = request.url?.startsWith('/failure') ? 503 : 200;
    response.setHeader('Content-Type', 'application/json');
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => consoleServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = consoleServer.address() as { port: number };
    await run(
      `current().url=${JSON.stringify(`http://127.0.0.1:${port}/ok?api_key=CONSOLE-QUERY-SECRET`)};current().auth='None';current().method='GET';current().bodyType='none';execute(current())`,
    );
    assert.equal(await run('requestConsoleEntries.at(-1).level'), 'success');
    await run("responseTab='Timeline';responseMode='Pretty';render()");
    assert.equal(
      await run("Boolean(document.querySelector('.network-timing .timing-track'))"),
      true,
      'timeline renders measured waterfall bars',
    );
    assert.equal(
      await run("current().response.timings.requests[0].phases.some(phase=>phase.id==='tcp')"),
      true,
      'Electron captures actual connection timing',
    );
    await run("document.querySelector('[data-mode=Raw]').click()");
    assert.equal(
      await run('JSON.parse(responseSourceEditor.getValue()).timings.requests[0].status'),
      200,
      'Raw timeline includes phase measurements',
    );
    // The raw Headers view's Capture value captures the header on the line.
    await run("responseTab='Headers';responseMode='Raw';render()");
    await pause(100);
    await run(
      "window.capturesBeforeRaw=structuredClone(current().captures||[]);(view=>{view.dispatch({selection:{anchor:view.state.doc.toString().toLowerCase().indexOf('content-type')+1}});view.focus();})(editorView('#response-source-editor'));document.querySelector('#response-source-editor .cm-content').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))",
    );
    await pause(30);
    await run(
      "document.querySelector('#response-source-editor [data-editor-menu] [data-menu-item=capture]').click()",
    );
    await pause(50);
    assert.match(
      await run('current().captures.at(-1).value'),
      /^header content-type$/i,
      'the raw Headers view captures the header on the line',
    );
    await run(
      "current().captures=window.capturesBeforeRaw;requestTab='Params';responseTab='Timeline';responseMode='Raw';render()",
    );
    await pause(50);
    // Response header rows: copy, or capture into a variable.
    await run("responseTab='Headers';responseMode='Pretty';render()");
    await pause(30);
    await rightClick('[data-response-header]');
    assert.equal(
      await run(
        "[...document.querySelectorAll('[data-response-header-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
      ),
      'name,value,header,capture',
      'right-clicking a response header lists its actions',
    );
    await run(
      "window.headerCaptured=document.querySelector('[data-response-header]').dataset.responseHeader;window.capturesBefore=structuredClone(current().captures||[]);document.querySelector('[data-response-header-menu] [data-menu-item=capture]').click()",
    );
    await pause(30);
    assert.equal(
      await run(
        "current().captures.at(-1).value==='header '+window.headerCaptured&&requestTab==='Vars'",
      ),
      true,
      'Capture into a variable adds a header capture and shows the Vars tab',
    );
    await run(
      "current().captures=window.capturesBefore;requestTab='Params';responseTab='Body';render()",
    );
    // A Set-Cookie row offers each cookie it sets; the Cookies tab captures one by its row.
    await run(
      "window.cookieResponseBefore=current().response;window.capturesBefore=structuredClone(current().captures||[]);current().response={...current().response,headers:{...current().response.headers,'set-cookie':'session=abc; Path=/, theme=dark'},setCookies:[{url:'http://127.0.0.1/',header:'session=abc; Path=/; HttpOnly'},{url:'http://127.0.0.1/',header:'theme=dark'}]};responseTab='Headers';render()",
    );
    await pause(30);
    await rightClick('[data-response-header="set-cookie"]');
    assert.equal(
      await run(
        "[...document.querySelectorAll('[data-response-header-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+':'+item.textContent.trim()).join()",
      ),
      'name:Copy name,value:Copy value,header:Copy as header,capture:Capture into a variable,cookie-0:session,cookie-1:theme',
      'a Set-Cookie header lists each cookie it sets to capture',
    );
    await run(
      "document.querySelector('[data-response-header-menu] [data-menu-item=cookie-0]').click()",
    );
    await pause(30);
    assert.deepEqual(
      await run('[JSON.stringify(current().captures.at(-1)),requestTab]'),
      [JSON.stringify({ enabled: true, key: 'session', value: 'cookie session' }), 'Vars'],
      'capturing a cookie from the Set-Cookie header adds a cookie capture named after it',
    );
    await run("responseTab='Cookies';render()");
    await pause(30);
    await rightClick('[data-response-cookie="1"]');
    await run(
      "document.querySelector('[data-response-cookie-menu] [data-menu-item=capture]').click()",
    );
    await pause(30);
    assert.equal(
      await run('current().captures.at(-1).value'),
      'cookie theme',
      'a cookie row in the Cookies tab captures that cookie',
    );
    await run(
      "current().response=window.cookieResponseBefore;current().captures=window.capturesBefore;requestTab='Params';responseTab='Body';render()",
    );
    // The response body editor's context menu: copy, select, find, fold, and format.
    await pause(50);
    await run(
      "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.editorCopied=value;}}})",
    );
    const editorMenu = "document.querySelector('#response-source-editor [data-editor-menu]')";
    const editorMenuIds = () =>
      run(
        `[...${editorMenu}.querySelectorAll('[data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()`,
      ) as Promise<string>;
    await rightClick('#response-source-editor .cm-content');
    assert.equal(
      await editorMenuIds(),
      'copy-,copy-all,select-all,capture,find,fold,unfold,format',
      'right-clicking the response body opens its editor menu, with Copy off until text is selected',
    );
    await run(`${editorMenu}.querySelector('[data-menu-item=copy-all]').click()`);
    await pause(30);
    assert.equal(
      await run('window.editorCopied===responseSourceEditor.getValue()'),
      true,
      'Copy all copies the whole response body',
    );
    // Capture value saves the JSON path of the value under the cursor into the Vars tab.
    await run(
      "(view=>{const at=view.state.doc.toString().indexOf('true');view.dispatch({selection:{anchor:at+1}});view.focus();})(editorView('#response-source-editor'))",
    );
    await run(
      "window.capturesBeforeBody=structuredClone(current().captures||[]);document.querySelector('#response-source-editor .cm-content').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))",
    );
    await pause(30);
    await run(`${editorMenu}.querySelector('[data-menu-item=capture]').click()`);
    await pause(50);
    assert.deepEqual(
      await run('[JSON.stringify(current().captures.at(-1)),requestTab]'),
      [JSON.stringify({ enabled: true, key: 'ok', value: '$.ok' }), 'Vars'],
      'Capture value adds the JSON path under the cursor to the Vars tab, named after its key',
    );
    await run(
      "current().captures=window.capturesBeforeBody;requestTab='Params';editorView('#response-source-editor').dispatch({selection:{anchor:0}});render()",
    );
    await pause(30);
    await run(
      "document.querySelector('#response-source-editor .cm-content').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))",
    );
    await pause(30);
    assert.equal(
      await run(`${editorMenu}.matches(':popover-open')`),
      true,
      'Shift+F10 in the response body opens its menu',
    );
    await run(`${editorMenu}.querySelector('[data-menu-item=select-all]').click()`);
    await pause(30);
    await rightClick('#response-source-editor .cm-content');
    assert.match(await editorMenuIds(), /^copy,/, 'Copy is offered once text is selected');
    await run(`${editorMenu}.querySelector('[data-menu-item=copy]').click()`);
    await pause(30);
    assert.equal(
      await run('window.editorCopied===responseSourceEditor.getValue()'),
      true,
      'Copy copies the selection',
    );
    await rightClick('#response-source-editor .cm-content');
    await run(`${editorMenu}.querySelector('[data-menu-item=fold]').click()`);
    await pause(30);
    assert.equal(
      await run("Boolean(document.querySelector('#response-source-editor .cm-foldPlaceholder'))"),
      true,
      'Fold all folds the response body',
    );
    await capture('editor-folded.png');
    await rightClick('#response-source-editor .cm-content');
    await run(`${editorMenu}.querySelector('[data-menu-item=unfold]').click()`);
    await pause(30);
    assert.equal(
      await run("Boolean(document.querySelector('#response-source-editor .cm-foldPlaceholder'))"),
      false,
      'Unfold all unfolds it again',
    );
    await rightClick('#response-source-editor .cm-content');
    await run(`${editorMenu}.querySelector('[data-menu-item=find]').click()`);
    await pause(30);
    assert.equal(
      await run("Boolean(document.querySelector('#response-source-editor .cm-search'))"),
      true,
      'Find opens the search field in the response body',
    );
    await capture('editor-find.png');
    await run(
      "document.querySelector('#response-source-editor .cm-search input[name=search]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',keyCode:27,bubbles:true}))",
    );

    assert.equal(
      await run("JSON.stringify(requestConsoleEntries).includes('CONSOLE-QUERY-SECRET')"),
      false,
      'console redacts query values',
    );
    assert.deepEqual(
      await run(
        "[state.history.find(entry=>entry.requestId===current().id&&entry.console)?.console.map(line=>line.kind).slice(0,2).join(),JSON.stringify(state.history.map(entry=>entry.console)).includes('CONSOLE-QUERY-SECRET')]",
      ),
      ['started,completed', false],
      'a send keeps its console lines with its History entry, query values redacted',
    );
    await run(
      `current().url=${JSON.stringify(`http://127.0.0.1:${port}/failure`)};execute(current())`,
    );
    assert.equal(await run('requestConsoleEntries.at(-1).level'), 'error');
    await run(
      "document.querySelector('#console-level').value='error';document.querySelector('#console-level').dispatchEvent(new Event('change'))",
    );
    assert.equal(
      await run("document.querySelectorAll('.console-entry').length"),
      1,
      'console filters by severity',
    );
    assert.equal(
      await run(
        "(()=>{const entry=document.querySelector('.console-entry');return Boolean(entry.querySelector('.console-level .mdi-icon')&&entry.querySelector('.console-message .method .method-icon'));})()",
      ),
      true,
      'console entries show their level and method icons',
    );
    // Console entries: right-click, or from the keyboard once the log has focus.
    await run(
      "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.consoleCopied=value;}}})",
    );
    await rightClick('.console-entry');
    assert.equal(
      await run(
        "[...document.querySelectorAll('[data-console-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
      ),
      'message,url,line,open,level-,remove',
      'right-clicking a console entry lists its actions',
    );
    await run("document.querySelector('[data-console-menu] [data-menu-item=url]').click()");
    await pause(30);
    assert.equal(
      await run(
        "window.consoleCopied===document.querySelector('.console-entry code').textContent&&!window.consoleCopied.includes('CONSOLE-QUERY-SECRET')",
      ),
      true,
      'Copy URL copies the redacted URL',
    );
    await run("consoleOptions.level='all';render()");
    await pause(30);
    await run(
      "(()=>{const log=document.querySelector('.console-events');log.focus();log.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));log.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))})()",
    );
    assert.equal(
      await run("document.activeElement===document.querySelectorAll('.console-entry')[1]"),
      true,
      'arrow keys move between console entries',
    );
    await run(
      "window.consoleLevel=requestConsoleEntries.find(entry=>entry.id===document.activeElement.dataset.consoleEntry).level;document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))",
    );
    await pause(30);
    await run("document.querySelector('[data-console-menu] [data-menu-item=level]').click()");
    await pause(30);
    assert.equal(
      await run('consoleOptions.level===window.consoleLevel'),
      true,
      "Shift+F10 opens the entry menu, which filters to the entry's level",
    );
    await run(
      "consoleOptions.level='all';render();window.consoleCount=requestConsoleEntries.length",
    );
    await pause(30);
    await run(
      "document.querySelector('.console-entry').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
    );
    await pause(30);
    await run("document.querySelector('[data-console-menu] [data-menu-item=remove]').click()");
    await pause(30);
    assert.equal(
      await run('requestConsoleEntries.length===window.consoleCount-1'),
      true,
      'Remove entry removes only that entry',
    );
    await run(
      "document.querySelector('#console-search').value='no matching event';document.querySelector('#console-search').dispatchEvent(new Event('input'))",
    );
    assert.equal(await run("Boolean(document.querySelector('.console-empty'))"), true);
    await run(
      "document.querySelector('#console-search').value='';document.querySelector('#console-search').dispatchEvent(new Event('input'));document.querySelector('[data-console-clear]').click()",
    );
    assert.equal(
      await run('requestConsoleEntries.length'),
      0,
      'console clears current request events',
    );
    await run("document.querySelector('[data-dev-tools-tab=Network]').click()");
    await pause(100);
    assert.equal(
      await run(
        "document.querySelectorAll('[data-network-entry]').length===networkEntries.length&&networkEntries.length>=2",
      ),
      true,
      'the network tab lists every sent request',
    );
    assert.equal(
      await run("JSON.stringify(networkEntries).includes('CONSOLE-QUERY-SECRET')"),
      false,
      'network entries redact query values',
    );
    assert.deepEqual(
      await run('networkEntries.slice(-2).map(entry=>entry.status)'),
      [200, 503],
      'network entries keep each status',
    );
    await run(
      "document.querySelector('#network-status').value='5';document.querySelector('#network-status').dispatchEvent(new Event('change'))",
    );
    assert.equal(
      await run("document.querySelectorAll('[data-network-entry]').length"),
      1,
      'the network tab filters by status class',
    );
    await run("document.querySelector('[data-network-entry]').click()");
    assert.equal(
      await run(
        "(()=>{const detail=document.querySelector('.network-detail');return Boolean(detail)&&detail.textContent.includes('503')&&detail.textContent.toLowerCase().includes('content-type')})()",
      ),
      true,
      'selecting a request shows its status and response headers',
    );
    await run(
      "document.querySelector('#network-status').value='all';document.querySelector('#network-status').dispatchEvent(new Event('change'))",
    );
    await pause(30);
    await rightClick('[data-network-entry]');
    assert.equal(
      await run(
        "[...document.querySelectorAll('[data-network-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
      ),
      'details,open,copy,filter',
      'right-clicking a network request lists its actions',
    );
    await run("document.querySelector('[data-network-menu] [data-menu-item=filter]').click()");
    await pause(30);
    assert.equal(
      await run(
        "document.querySelector('#network-status').value==='5'&&document.querySelectorAll('[data-network-entry]').length===1",
      ),
      true,
      "the network menu narrows the list to the request's status class",
    );
    await run("document.querySelector('[data-dev-tools-tab=Performance]').click()");
    await pause(100);
    assert.equal(
      await run(
        "document.querySelector('[data-stat=Requests] strong').textContent.trim()===String(networkEntries.length)&&document.querySelectorAll('.performance-chart rect').length===networkEntries.length",
      ),
      true,
      'the performance tab counts and charts the sent requests',
    );
    // The terminal runs in a window of its own (terminal-window.ts): this window cannot reach a
    // shell, only open that window or stage a command there.
    assert.equal(
      await run('Boolean(window.workbench.terminal)||!window.workbench.terminalWindow'),
      false,
      "the app's window has no terminal channels, only the means to place and stage the terminal",
    );
    // The Terminal tab shows the terminal docked: its own page in a view over the panel.
    await run("document.querySelector('[data-dev-tools-tab=Terminal]').click()");
    const terminalView = await (async () => {
      for (let attempt = 0; attempt < 100; attempt++) {
        const found = window.contentView.children.find(
          (child): child is WebContentsView =>
            child instanceof WebContentsView &&
            child.webContents.getURL().includes('terminal.html'),
        );
        if (found && !found.webContents.isLoading()) return found;
        await pause(100);
      }
      throw new Error('The Terminal tab did not dock the terminal.');
    })();
    // The harness hides the app's window (ui-smoke.ts), and the view with it: like the app's page,
    // it keeps drawing anyway.
    terminalView.webContents.setBackgroundThrottling(false);
    const terminalWindow = { webContents: terminalView.webContents } as unknown as BrowserWindow;
    const term = createHarness(terminalWindow);
    const dockRect = async () =>
      (await run(
        "(()=>{const r=document.querySelector('.terminal-dock').getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.top),width:Math.round(r.width),height:Math.round(r.height)}})()",
      )) as { x: number; y: number; width: number; height: number };
    const placedOverDock = async () => {
      for (let attempt = 0; attempt < 30; attempt++) {
        const want = await dockRect();
        const got = terminalView.getBounds();
        if (
          terminalView.getVisible() &&
          Math.abs(got.x - want.x) <= 1 &&
          Math.abs(got.y - want.y) <= 1 &&
          Math.abs(got.width - want.width) <= 1 &&
          Math.abs(got.height - want.height) <= 1
        )
          return true;
        await pause(50);
      }
      return false;
    };
    assert.equal(await placedOverDock(), true, 'the docked terminal fills the Terminal tab');
    // The terminal window's own page: any error it logs, such as a blocked style, fails the run.
    const terminalErrors: string[] = [];
    terminalWindow.webContents.on('console-message', ({ level, message }) => {
      if (level === 'error') terminalErrors.push(message);
    });
    // Waits for the shown terminal's shell, types a command into it, and waits for its output.
    const activeTerminal = "document.querySelector('.terminal-host.active')";
    const waitForTerminal = async () => {
      let running = false;
      for (let attempt = 0; attempt < 100 && !running; attempt++) {
        await pause(100);
        running = await term.run(
          // The shell is ready once it has printed its prompt.
          `!document.querySelector('[data-terminal-stop]').disabled&&Boolean(${activeTerminal}?.querySelector('.xterm-rows')?.textContent.trim())`,
        );
      }
      return running;
    };
    const terminalText = () =>
      term.run(`${activeTerminal}.querySelector('.xterm-rows').textContent`) as Promise<string>;
    // A fresh shell can drop keys typed while it is still starting, so typing retries once.
    const typeInTerminal = async (command: string, output: string) => {
      for (let tries = 0; tries < 2; tries++) {
        await term.run(`${activeTerminal}.querySelector('.xterm-helper-textarea').focus()`);
        terminalWindow.webContents.insertText(command);
        terminalWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
        terminalWindow.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
        terminalWindow.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
        for (let attempt = 0; attempt < 50; attempt++) {
          await pause(100);
          if ((await terminalText()).includes(output)) return true;
        }
      }
      return false;
    };
    assert.equal(await waitForTerminal(), true, 'the terminal starts a shell');
    assert.equal(
      await typeInTerminal('echo workbench-$((6*7))', 'workbench-42'),
      true,
      'the terminal runs commands in the shell',
    );
    await run("document.querySelector('[data-dev-tools-tab=Console]').click()");
    await run("document.querySelector('[data-dev-tools-tab=Terminal]').click()");
    assert.equal(
      (await terminalText()).includes('workbench-42'),
      true,
      'the terminal keeps its session while the app changes dev tools tabs',
    );
    await term.run("document.querySelector('[data-terminal-new]').click()");
    assert.equal(
      await term.run(
        "document.querySelectorAll('[data-terminal-tab]').length===2&&document.querySelectorAll('[data-terminal-tab]')[1].getAttribute('aria-selected')==='true'",
      ),
      true,
      'a new terminal opens in its own tab and is shown',
    );
    assert.equal(await waitForTerminal(), true, 'the second terminal starts its own shell');
    assert.equal(
      await typeInTerminal('echo second-$((7*6))', 'second-42'),
      true,
      'the second terminal runs commands',
    );
    assert.equal(
      (await terminalText()).includes('workbench-42'),
      false,
      'each terminal has its own output',
    );
    await term.run("document.querySelectorAll('[data-terminal-tab]')[0].click()");
    await pause(50);
    assert.equal(
      (await terminalText()).includes('workbench-42') &&
        !(await terminalText()).includes('second-42'),
      true,
      'switching terminal tabs shows that shell',
    );
    await term.run("document.querySelectorAll('[data-terminal-close]')[1].click()");
    assert.equal(
      await term.run("document.querySelectorAll('[data-terminal-tab]').length"),
      1,
      'closing a terminal tab removes it',
    );
    // The shell menu opens a terminal with any installed shell and sets the default one.
    const openShellMenu = async () => {
      await term.run("document.querySelector('[data-terminal-shells]').click()");
      await pause(100);
    };
    const shellMenuItems = (prefix: string) =>
      term.run(
        `[...document.querySelectorAll('.action-menu:popover-open [data-menu-item^="${prefix}:"]')].map(item=>[item.dataset.menuItem.slice(${prefix.length + 1}),item.querySelector('kbd')?.textContent.trim()??''])`,
      ) as Promise<[string, string][]>;
    await openShellMenu();
    const opens = await shellMenuItems('open');
    assert.ok(
      opens.some(([id]) => id === 'sh') &&
        opens.filter(([, mark]) => mark === 'Default').length === 1,
      `the shell menu lists the installed shells with one default (${JSON.stringify(opens)})`,
    );
    const originalDefault = opens.find(([, mark]) => mark === 'Default')![0];
    await term.capture('terminal-shells.png');
    await term.run(
      'document.querySelector(\'.action-menu:popover-open [data-menu-item="open:sh"]\').click()',
    );
    await pause(100);
    assert.equal(
      await term.run(
        "document.querySelectorAll('[data-terminal-tab]').length===2&&document.querySelector('[data-terminal-tab][aria-selected=true]').textContent.trim()==='sh 2'",
      ),
      true,
      'choosing sh opens a terminal tab running it',
    );
    assert.equal(await waitForTerminal(), true, 'the sh terminal starts');
    assert.equal(
      await typeInTerminal('echo shell-$((2*21))', 'shell-42'),
      true,
      'the sh terminal runs commands',
    );
    await openShellMenu();
    await term.run(
      'document.querySelector(\'.action-menu:popover-open [data-menu-item="default:sh"]\').click()',
    );
    await pause(50);
    await openShellMenu();
    assert.deepEqual(
      [
        (await shellMenuItems('open')).find(([, mark]) => mark === 'Default')?.[0],
        // Kept by the main process: the terminal window keeps no storage of its own.
        await term.run(
          'window.workbench.terminalHost.preferences().then((saved)=>saved.defaultShell)',
        ),
      ],
      ['sh', 'sh'],
      'the default shell can be changed and is remembered',
    );
    await term.run(
      `document.querySelector('.action-menu:popover-open [data-menu-item="default:${originalDefault}"]').click()`,
    );
    await pause(50);
    await term.run("document.querySelectorAll('[data-terminal-close]')[1].click()");
    await pause(50);
    await term.run("document.querySelector('[data-terminal-close]').click()");
    await term.run("document.querySelector('[data-terminal-empty-new]').click()");
    assert.equal(await waitForTerminal(), true, 'closing the last terminal offers a new one');
    assert.equal(
      await typeInTerminal('echo alive-$((40+2))', 'alive-42'),
      true,
      'the new terminal runs commands',
    );
    await run("document.querySelector('[data-dev-tools-close]').click()");
    await pause(300);
    assert.equal(
      await run(
        "!devTools.open&&getComputedStyle(document.querySelector('.devtools')).display==='none'&&Math.round(document.querySelector('footer').getBoundingClientRect().bottom)===innerHeight&&document.querySelector('[data-dev-tools-terminals]').textContent.trim()==='1'",
      ),
      true,
      "closing dev tools hides the panel and shows the terminal window's running shells",
    );
    await run("document.querySelector('[data-dev-tools-toggle]').click()");
    await pause(100);
    assert.equal(
      (await terminalText()).includes('alive-42') &&
        !(await run("Boolean(document.querySelector('[data-dev-tools-terminals]'))")),
      true,
      'the terminal window keeps its shell while the app closes and reopens dev tools',
    );
    // The terminal refits once shown again; wait for it before typing.
    assert.equal(await waitForTerminal(), true, 'the reopened terminal is ready');
    assert.equal(
      (await typeInTerminal('echo still-$((40+2))', 'still-42')) ||
        (await typeInTerminal('echo still-$((40+2))', 'still-42')),
      true,
      'the terminal shell kept running while dev tools were closed',
    );
    const panes =
      "document.querySelectorAll('.terminal-view:not([style*=none]) [data-terminal-pane]')";
    await term.run("document.querySelector('[data-terminal-split]').click()");
    assert.equal(
      await term.run(
        `${panes}.length===2&&${panes}[1].contains(document.querySelector('.terminal-host.active'))&&document.querySelector('[data-terminal-pane-count]').textContent.trim()==='2'`,
      ),
      true,
      'splitting adds a focused pane beside the first',
    );
    assert.equal(await waitForTerminal(), true, 'the split pane starts its own shell');
    assert.equal(
      await typeInTerminal('echo split-$((40+2))', 'split-42'),
      true,
      'the split pane runs commands',
    );
    assert.equal(
      (await terminalText()).includes('still-42'),
      false,
      'each pane has its own output',
    );
    assert.equal(
      await term.run(
        `(()=>{const [first,second]=${panes};const a=first.getBoundingClientRect(),b=second.getBoundingClientRect();return a.top===b.top&&a.right<=b.left&&Math.abs(a.width-b.width)<4})()`,
      ),
      true,
      'split panes sit side by side at equal widths',
    );
    await term.run(`${panes}[0].dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))`);
    await pause(50);
    assert.equal(
      (await terminalText()).includes('still-42'),
      true,
      'clicking a pane focuses it for the toolbar',
    );
    await term.run(
      "window.paneWidthBefore=document.querySelector('[data-terminal-pane]').getBoundingClientRect().width;document.querySelector('.terminal-divider').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))",
    );
    await pause(50);
    assert.equal(
      await term.run(
        "document.querySelector('[data-terminal-pane]').getBoundingClientRect().width>window.paneWidthBefore",
      ),
      true,
      'the pane divider resizes the panes',
    );
    await term.run(`${panes}[1].querySelector('[data-terminal-pane-close]').click()`);
    assert.equal(
      await term.run(
        `${panes}.length===1&&!document.querySelector('[data-terminal-pane-count]')&&!document.querySelector('[data-terminal-pane-close]')`,
      ),
      true,
      'closing a pane leaves the other',
    );
    assert.equal(
      (await terminalText()).includes('still-42'),
      true,
      'the remaining pane keeps its shell',
    );
    await term.run("document.querySelector('[data-terminal-split-down]').click()");
    assert.equal(
      await term.run(
        `(()=>{const list=${panes};if(list.length!==2||!list[1].contains(document.querySelector('.terminal-host.active')))return false;const a=list[0].getBoundingClientRect(),b=list[1].getBoundingClientRect();return Math.abs(a.left-b.left)<1&&a.bottom<=b.top&&Math.abs(a.height-b.height)<4})()`,
      ),
      true,
      'splitting down stacks a focused pane below the first at equal heights',
    );
    assert.equal(await waitForTerminal(), true, 'the lower pane starts its own shell');
    assert.equal(
      await typeInTerminal('echo below-$((40+2))', 'below-42'),
      true,
      'the lower pane runs commands',
    );
    await term.run("document.querySelector('[data-terminal-split]').click()");
    assert.equal(
      await term.run(
        `(()=>{const list=${panes};const [top,bottom,right]=[...list].map(pane=>pane.getBoundingClientRect());return list.length===3&&right.left>=bottom.right&&right.top<=top.top+1&&right.bottom>=bottom.bottom-1})()`,
      ),
      true,
      'splitting right beside stacked panes adds a full-height column',
    );
    await term.run(
      "window.paneHeightBefore=document.querySelector('[data-terminal-pane]').getBoundingClientRect().height;document.querySelector('.terminal-divider-row').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))",
    );
    await pause(50);
    assert.equal(
      await term.run(
        "document.querySelector('[data-terminal-pane]').getBoundingClientRect().height>window.paneHeightBefore",
      ),
      true,
      'the row divider resizes stacked panes',
    );
    await term.run(
      `[...${panes}].slice(1).reverse().forEach(pane=>pane.querySelector('[data-terminal-pane-close]').click())`,
    );
    await pause(50);
    assert.equal(
      await term.run(`${panes}.length===1&&!document.querySelector('.terminal-divider-row')`),
      true,
      'closing the stacked and side panes leaves one',
    );
    // Terminal shortcuts go to the focused terminal; Mod is Cmd on macOS and Ctrl elsewhere.
    const terminalKey = (key: string, code: string, modifiers: Record<string, boolean>) =>
      term.run(
        `${activeTerminal}.querySelector('.xterm-helper-textarea').dispatchEvent(new KeyboardEvent('keydown',${JSON.stringify({ key, code, bubbles: true, cancelable: true, ...modifiers })}))`,
      );
    const mod: Record<string, boolean> =
      process.platform === 'darwin' ? { metaKey: true } : { ctrlKey: true };
    const layoutBefore = await run('requestPanels.layout');
    await terminalKey('\\', 'Backslash', mod);
    await pause(50);
    assert.equal(
      await term.run(
        `${panes}.length===2&&${panes}[1].contains(document.querySelector('.terminal-host.active'))`,
      ),
      true,
      'Mod+\\ splits the focused terminal right',
    );
    assert.equal(
      await run('requestPanels.layout'),
      layoutBefore,
      'Mod+\\ in the terminal leaves the request layout alone',
    );
    await terminalKey('|', 'Backslash', { ...mod, shiftKey: true });
    await pause(50);
    assert.equal(
      await term.run(
        `(()=>{const list=${panes};const [left,top,bottom]=[...list].map(pane=>pane.getBoundingClientRect());return list.length===3&&list[2].contains(document.querySelector('.terminal-host.active'))&&top.bottom<=bottom.top&&bottom.left>=left.right})()`,
      ),
      true,
      'Mod+Shift+\\ splits the focused terminal down',
    );
    await terminalKey('ArrowUp', 'ArrowUp', { ...mod, altKey: true });
    await pause(50);
    assert.equal(
      await term.run(`${panes}[1].contains(document.querySelector('.terminal-host.active'))`),
      true,
      'Mod+Alt+Up focuses the pane above',
    );
    await terminalKey('ArrowLeft', 'ArrowLeft', { ...mod, altKey: true });
    await pause(50);
    assert.equal(
      await term.run(`${panes}[0].contains(document.querySelector('.terminal-host.active'))`),
      true,
      'Mod+Alt+Left focuses the pane to the left',
    );
    await terminalKey('ArrowRight', 'ArrowRight', { ...mod, altKey: true });
    await pause(50);
    assert.equal(
      await term.run(`!${panes}[0].contains(document.querySelector('.terminal-host.active'))`),
      true,
      'Mod+Alt+Right focuses a pane to the right',
    );
    const tabsBefore = await term.run("document.querySelectorAll('[data-terminal-tab]').length");
    await terminalKey('~', 'Backquote', { ctrlKey: true, shiftKey: true });
    await pause(50);
    assert.equal(
      await term.run("document.querySelectorAll('[data-terminal-tab]').length"),
      tabsBefore + 1,
      'Ctrl+Shift+` opens a new terminal',
    );
    assert.equal(await waitForTerminal(), true, 'the shortcut terminal starts its shell');
    await terminalKey('W', 'KeyW', { ...mod, shiftKey: true });
    await pause(50);
    assert.equal(
      await term.run("document.querySelectorAll('[data-terminal-tab]').length"),
      tabsBefore,
      'Mod+Shift+W on a lone pane closes its terminal tab',
    );
    await term.run("document.querySelectorAll('[data-terminal-tab]')[0].click()");
    await pause(50);
    await terminalKey('W', 'KeyW', { ...mod, shiftKey: true });
    await pause(50);
    assert.equal(await term.run(`${panes}.length`), 2, 'Mod+Shift+W closes the focused pane');
    await terminalKey('W', 'KeyW', { ...mod, shiftKey: true });
    await pause(50);
    assert.equal(
      (await term.run(`${panes}.length`)) === 1 && (await terminalText()).includes('still-42'),
      true,
      'closing panes by shortcut moves focus to a neighbour and keeps its shell',
    );
    const selectedTab = "document.querySelector('[data-terminal-tab][aria-selected=true]')";
    const renameTo = (value: string, key: 'Enter' | 'Escape' | 'blur') =>
      term.run(
        `(()=>{const input=document.querySelector('[data-terminal-rename]');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input'));${key === 'blur' ? "input.dispatchEvent(new FocusEvent('blur'))" : `input.dispatchEvent(new KeyboardEvent('keydown',{key:'${key}',bubbles:true}))`}})()`,
      );
    const defaultName = (await term.run(`${selectedTab}.textContent.trim()`)) as string;
    await term.run(`${selectedTab}.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
    await pause(50);
    assert.equal(
      await term.run(
        "(()=>{const input=document.querySelector('[data-terminal-rename]');return document.activeElement===input&&input.value===input.placeholder})()",
      ),
      true,
      'double-clicking a terminal tab edits its name in place',
    );
    await renameTo('API server', 'Enter');
    await pause(50);
    assert.equal(
      await term.run(
        `${selectedTab}.textContent.trim()==='API server'&&document.activeElement===${selectedTab}&&document.querySelector('.terminal-tab.active [data-terminal-close]').getAttribute('aria-label')==='Close API server'`,
      ),
      true,
      'Enter saves the terminal name',
    );
    await term.run(
      `${selectedTab}.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true}))`,
    );
    await pause(50);
    await renameTo('Discarded', 'Escape');
    await pause(50);
    assert.equal(
      await term.run(`${selectedTab}.textContent.trim()`),
      'API server',
      'F2 renames and Escape keeps the name',
    );
    await term.run(
      `${selectedTab}.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true}))`,
    );
    await pause(50);
    await renameTo('  ', 'blur');
    await pause(50);
    assert.equal(
      await term.run(`${selectedTab}.textContent.trim()`),
      defaultName,
      'an empty name returns the tab to its default name',
    );
    const tabOrder = () =>
      term.run(
        "[...document.querySelectorAll('[data-terminal-tab]')].map(tab=>tab.textContent.trim()).join('|')",
      ) as Promise<string>;
    await term.run("document.querySelector('[data-terminal-new]').click()");
    assert.equal(await waitForTerminal(), true, 'a second terminal starts for reordering');
    const [firstName, secondName] = (await tabOrder()).split('|');
    await term.run(
      `${selectedTab}.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',altKey:true,bubbles:true}))`,
    );
    await pause(30);
    assert.equal(
      (await tabOrder()) === `${secondName}|${firstName}` &&
        (await term.run(`document.activeElement===${selectedTab}`)),
      true,
      'Alt+Left moves the selected terminal tab left and keeps its focus',
    );
    // Drags the first tab onto the right half of the second, so it lands after it.
    await term.run(
      "(()=>{const items=document.querySelectorAll('[data-terminal-tab-item]');const data=new DataTransfer();const box=items[1].getBoundingClientRect();items[0].dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));items[1].dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data,clientX:box.right-4}));items[1].dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX:box.right-4}));items[0].dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}))})()",
    );
    await pause(30);
    assert.equal(
      (await tabOrder()) === `${firstName}|${secondName}` &&
        !(await term.run(
          "Boolean(document.querySelector('.terminal-tab.drop-before,.terminal-tab.drop-after,.terminal-tab.dragging'))",
        )),
      true,
      'dragging a terminal tab onto another reorders them',
    );
    // The terminal tab context menu: right-click, Shift+F10, or the context menu key.
    const terminalMenu = "document.querySelector('[data-terminal-tab-menu]')";
    const terminalMenuItem = (id: string) =>
      term.run(`${terminalMenu}.querySelector('[data-menu-item=${id}]').click()`);
    await term.run(
      "(()=>{const item=document.querySelectorAll('[data-terminal-tab-item]')[0];const box=item.getBoundingClientRect();item.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:box.left+10,clientY:box.top+8}))})()",
    );
    await pause(30);
    assert.equal(
      await term.run(
        `${terminalMenu}.matches(':popover-open')&&[...${terminalMenu}.querySelectorAll('[data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()==='rename,split-right,split-down,close,others,right'`,
      ),
      true,
      'right-clicking a terminal tab opens its menu',
    );
    await term.run(
      `${terminalMenu}.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
    );
    await pause(30);
    assert.equal(
      await term.run(
        `!${terminalMenu}.matches(':popover-open')&&document.activeElement===document.querySelectorAll('[data-terminal-tab]')[0]`,
      ),
      true,
      'Escape closes the terminal tab menu and returns focus to its tab',
    );
    await term.run(
      `${selectedTab}.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))`,
    );
    await pause(30);
    await terminalMenuItem('split-right');
    await pause(50);
    assert.equal(
      await term.run(
        `${selectedTab}.querySelector('[data-terminal-pane-count]')?.textContent.trim()`,
      ),
      '2',
      'Split right from the tab menu splits that terminal',
    );
    await term.run(
      `${selectedTab}.dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))`,
    );
    await pause(30);
    await terminalMenuItem('others');
    await pause(50);
    assert.equal(
      await term.run(
        `document.querySelectorAll('[data-terminal-tab]').length===1&&${selectedTab}.querySelector('[data-terminal-pane-count]')?.textContent.trim()==='2'`,
      ),
      true,
      'Close other terminals keeps only the chosen terminal',
    );
    await term.run(`${panes}[1].querySelector('[data-terminal-pane-close]').click()`);
    assert.equal(
      await run(
        "(()=>{const rail=document.querySelector('.rail').getBoundingClientRect(),tools=document.querySelector('.devtools').getBoundingClientRect(),footer=document.querySelector('footer').getBoundingClientRect();return tools.left>=rail.right-1&&Math.abs(rail.bottom-footer.top)<=1&&Math.abs(tools.bottom-footer.top)<=1})()",
      ),
      true,
      'dev tools sit beside the navigation rail, which keeps its full height',
    );
    // A native view draws over the page, so it steps aside while the page's dialogs overlap it.
    await run('devTools.height=Math.round(innerHeight*0.6);render()');
    assert.equal(await placedOverDock(), true, 'the docked terminal follows the panel’s size');
    await run('commandPalette.open=true;render()');
    let hidden = false;
    for (let attempt = 0; attempt < 30 && !hidden; attempt++) {
      await pause(50);
      hidden = !terminalView.getVisible();
    }
    assert.equal(hidden, true, 'the docked terminal steps aside for the command palette');
    await run('commandPalette.open=false;render()');
    assert.equal(await placedOverDock(), true, 'and comes back when it closes');
    // Open in new window moves the terminal, shells and all, into a window of its own.
    await term.run("document.querySelector('[data-terminal-expand]').click()");
    const popout = await (async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const found = BaseWindow.getAllWindows().find((item) =>
          item.contentView.children.includes(terminalView),
        );
        if (found) return found;
        await pause(100);
      }
      throw new Error('Open in new window did not move the terminal.');
    })();
    assert.equal(window.contentView.children.includes(terminalView), false);
    assert.equal(
      await run("document.querySelector('[data-terminal-dock]').dataset.terminalDock"),
      'window',
      'the Terminal tab says the terminal is in its own window',
    );
    assert.equal(
      await term.run("Boolean(document.querySelector('[data-terminal-return]'))"),
      true,
      'the expanded terminal offers to return to the panel',
    );
    assert.equal(
      await typeInTerminal('echo popped-$((40+2))', 'popped-42'),
      true,
      'the expanded terminal keeps its shell and runs commands',
    );
    // Return to panel puts it back, still running.
    await run("document.querySelector('[data-terminal-dock-back]').click()");
    for (let attempt = 0; attempt < 50 && !popout.isDestroyed(); attempt++) await pause(100);
    assert.equal(popout.isDestroyed(), true, 'Return to panel closes the terminal’s window');
    assert.equal(await placedOverDock(), true, 'the terminal is docked again');
    assert.equal(
      (await terminalText()).includes('popped-42'),
      true,
      'back in the panel, the terminal still has its shell and output',
    );
    assert.deepEqual(terminalErrors, [], 'the terminal page logs no errors');
    await run("document.querySelector('[data-dev-tools-tab=Console]').click()");
    let tucked = false;
    for (let attempt = 0; attempt < 30 && !tucked; attempt++) {
      await pause(50);
      tucked = !terminalView.getVisible();
    }
    assert.equal(tucked, true, 'another dev tools tab hides the docked terminal');
  } finally {
    consoleServer.closeAllConnections();
    await new Promise<void>((resolve) => consoleServer.close(() => resolve()));
  }
  await run(
    "Object.assign(current(),window.consoleOriginalRequest);requestPanels.share=55;consoleOptions.level='all';document.querySelector('[data-dev-tools-close]').click()",
  );
}
