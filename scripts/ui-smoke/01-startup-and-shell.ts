import { BrowserWindow, nativeImage, session } from 'electron';
import path from 'node:path';
import assert from 'node:assert/strict';
import { keychain, pause, type SmokeContext } from './harness';

/** UI smoke checks, part 1: startup and shell. */
export default async function startupAndShell(context: SmokeContext) {
  const { window, run, capture, rightClick, answerConfirm } = context;
  console.log('Checking desktop renderer…');
  const startupSession = session.fromPartition('startup-ui-test');
  startupSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: details.resourceType === 'script' }),
  );
  const startupWindow = new BrowserWindow({
    show: false,
    width: 520,
    height: 360,
    webPreferences: {
      session: startupSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  try {
    await startupWindow.loadFile(
      path.join(__dirname, '../../../packages/api-workbench-app/dist/index.html'),
    );
    assert.equal(
      await startupWindow.webContents.executeJavaScript(
        "Boolean(document.querySelector('.initialization-screen[role=status]'))",
      ),
      true,
      'startup has a branded loading screen before scripts run',
    );
    assert.equal(
      await startupWindow.webContents.executeJavaScript(
        "(()=>{const image=document.querySelector('.initialization-mark img');return image.complete&&image.naturalWidth>0;})()",
      ),
      true,
      'startup logo loads locally',
    );
    assert.equal(
      await startupWindow.webContents.executeJavaScript(
        "getComputedStyle(document.querySelector('.initialization-ring')).animationName",
      ),
      'initialization-spin',
    );
    assert.equal(
      await startupWindow.webContents.executeJavaScript(
        "(()=>{const rect=document.querySelector('.initialization-mark').getBoundingClientRect();return Math.abs(rect.x+rect.width/2-innerWidth/2)<2&&Math.abs(rect.y+rect.height/2-innerHeight/2)<55;})()",
      ),
      true,
      'startup logo and ring are centered',
    );
  } finally {
    startupWindow.destroy();
  }

  assert.equal(
    await run("Boolean(document.querySelector('.urlbar'))"),
    true,
    'request editor booted',
  );
  assert.equal(
    await run(
      "Array.from(document.querySelectorAll('svg')).every(icon=>icon.classList.contains('mdi-icon')&&icon.getAttribute('aria-hidden')==='true'&&icon.getAttribute('focusable')==='false'&&Boolean(icon.querySelector('path')?.getAttribute('d')))",
    ),
    true,
    'all visible icon assets are accessible MDI SVGs',
  );

  assert.equal(
    nativeImage
      .createFromPath(require.resolve('@techieutils/api-workbench-assets/icons/icon.png'))
      .isEmpty(),
    false,
    'native application icon decodes',
  );
  await run('Promise.all(Array.from(document.images, image => image.decode()))');
  assert.equal(keychain.checks, 0, 'startup does not access the keychain');
  const lockedResponse = await run(
    "window.workbench.send({id:'locked-vault-check',url:'https://example.com',method:'GET',headers:{},body:'',credentialId:'not-unlocked'})",
  );
  assert.match(lockedResponse.error, /credential vault is locked/);
  assert.equal(keychain.checks, 0, 'locked requests do not trigger keychain access');
  assert.equal(
    await run(
      `Promise.all([document.fonts.load('13px Inter'), document.fonts.load('600 24px Geist'), document.fonts.load('12px "Geist Mono"')]).then(families => families.every(faces => faces.length > 0))`,
    ),
    true,
    'all bundled font families load in Electron',
  );
  await run("document.querySelector('#url').focus()");
  assert.equal(
    await run("getComputedStyle(document.querySelector('#url')).borderTopWidth"),
    '0px',
    'URL input has no nested border',
  );
  assert.equal(
    await run("getComputedStyle(document.querySelector('#url')).outlineStyle"),
    'none',
    'URL focus stays on the composer instead of clipping the input outline',
  );
  await pause(200);
  assert.equal(
    await run(
      "getComputedStyle(document.querySelector('.request-composer')).borderTopColor===getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || getComputedStyle(document.querySelector('.request-composer')).boxShadow!=='none'",
    ),
    true,
    'URL composer retains a visible keyboard focus indicator',
  );
  await capture('request-editor.png');
  assert.equal(
    await run("getComputedStyle(document.querySelector('.ui-button-primary')).display"),
    'flex',
    'Tailwind button layout is compiled inside the action toolbar',
  );
  await run(
    "document.querySelector('[data-request-tab=Params]').focus();document.querySelector('[data-request-tab=Params]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))",
  );
  assert.equal(await run('requestTab'), 'Headers', 'request tabs support arrow-key navigation');
  assert.equal(await run('document.activeElement.id'), 'request-tab-headers');
  await run("document.querySelector('[data-folder-toggle]').click()");
  assert.equal(
    await run("document.querySelector('[data-folder-toggle]').getAttribute('aria-expanded')"),
    'false',
    'collection folders collapse',
  );
  await run("document.querySelector('[data-folder-toggle]').click()");
  assert.equal(
    await run("document.querySelector('[data-folder-toggle]').getAttribute('aria-expanded')"),
    'true',
    'collection folders expand',
  );

  assert.equal(
    await run(
      "(()=>{const row=document.querySelector('.request-item[data-open]');window.renameId=row.dataset.open;row.click();const preserved=document.querySelector(`.request-item[data-open=\"${window.renameId}\"]`)===row;row.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return preserved;})()",
    ),
    true,
    'single click preserves the row for double click',
  );
  assert.equal(await run("Boolean(document.querySelector('[data-request-rename]'))"), true);
  await run(
    "document.querySelector('[data-request-rename]').value='Renamed collection request';document.querySelector('[data-request-rename]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
  );
  assert.equal(
    await run('state.requests.find(request=>request.id===window.renameId).name'),
    'Renamed collection request',
  );
  await run(
    "document.querySelector(`.request-item[data-open=\"${window.renameId}\"]`).dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true}))",
  );
  await run(
    "document.querySelector('[data-request-rename]').value='Discard this';document.querySelector('[data-request-rename]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  assert.equal(await run('current().name'), 'Renamed collection request', 'Escape cancels rename');
  const requestTab = 'document.querySelector(`.request-tab-label[data-open="${window.renameId}"]`)';
  const tabRename = (value: string, finish: string) =>
    run(
      `(()=>{const input=document.querySelector('[data-tab-rename]');input.value=${JSON.stringify(value)};${finish}})()`,
    );
  await run(`${requestTab}.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await pause(30);
  assert.equal(
    await run(
      "(()=>{const input=document.querySelector('[data-tab-rename]');return Boolean(input)&&document.activeElement===input&&input.value==='Renamed collection request'})()",
    ),
    true,
    'double-clicking a request tab edits its name in place',
  );
  await tabRename(
    'Renamed from tab',
    "input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
  );
  await pause(30);
  assert.equal(
    await run(
      `current().name==='Renamed from tab'&&${requestTab}.textContent.includes('Renamed from tab')&&document.querySelector(\`.request-item[data-open="\${window.renameId}"]\`).textContent.includes('Renamed from tab')&&document.activeElement===${requestTab}`,
    ),
    true,
    'Enter renames the request everywhere and returns focus to its tab',
  );
  await run(`${requestTab}.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true}))`);
  await pause(30);
  await tabRename(
    'Discard this',
    "input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  await pause(30);
  assert.equal(await run('current().name'), 'Renamed from tab', 'F2 then Escape keeps the name');
  await run(`${requestTab}.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);
  await pause(30);
  await tabRename('   ', "input.dispatchEvent(new FocusEvent('blur'))");
  await pause(30);
  assert.equal(
    await run("current().name+'|'+Boolean(document.querySelector('[data-tab-rename]'))"),
    'Renamed from tab|false',
    'an empty tab name keeps the request name',
  );
  await run("current().name='Renamed collection request';render()");
  // Request tabs reorder by Alt+Left/Right and by dragging; the order is saved.
  if ((await run('state.tabs.length')) < 2)
    await run(
      'openRequest(state.requests.find(request=>!state.tabs.includes(request.id)).id);openRequest(window.renameId)',
    );
  await pause(30);
  const tabsOrder = () => run("state.tabs.slice(0,2).join('|')") as Promise<string>;
  const [firstTab, secondTab] = (await tabsOrder()).split('|');
  await run(
    `document.querySelector('.request-tab-label[data-open="${firstTab}"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,bubbles:true}))`,
  );
  await pause(30);
  assert.equal(
    (await tabsOrder()) === `${secondTab}|${firstTab}` &&
      (await run(
        `[...document.querySelectorAll('.request-tab-label')].slice(0,2).map(tab=>tab.dataset.open).join('|')==='${secondTab}|${firstTab}'&&document.activeElement.dataset.open==='${firstTab}'`,
      )),
    true,
    'Alt+Right moves the focused request tab right and keeps its focus',
  );
  await run(
    `(()=>{const from=document.querySelector('[data-request-tab-item="${firstTab}"]');const onto=document.querySelector('[data-request-tab-item="${secondTab}"]');const data=new DataTransfer();const box=onto.getBoundingClientRect();from.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));onto.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data,clientX:box.left+4}));onto.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX:box.left+4}));from.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}))})()`,
  );
  await pause(30);
  assert.equal(
    (await tabsOrder()) === `${firstTab}|${secondTab}` &&
      !(await run(
        "Boolean(document.querySelector('.request-tab.drop-before,.request-tab.drop-after,.request-tab.dragging'))",
      )),
    true,
    'dragging a request tab onto the left half of another moves it before',
  );
  // The request tab context menu: right-click or Shift+F10.
  const tabMenuItems = "[...document.querySelectorAll('[data-request-tab-menu] [data-menu-item]')]";
  await rightClick(`[data-request-tab-item="${secondTab}"]`);
  assert.equal(
    await run(
      `document.querySelector('[data-request-tab-menu]').matches(':popover-open')&&${tabMenuItems}.map(item=>item.dataset.menuItem).join()==='rename,close,others,right,all'&&document.activeElement===${tabMenuItems}[0]`,
    ),
    true,
    'right-clicking a request tab opens its menu at the pointer',
  );
  await run(
    "document.querySelector('[data-request-tab-menu]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  await pause(30);
  assert.equal(
    await run(
      `!document.querySelector('[data-request-tab-menu]').matches(':popover-open')&&document.activeElement.dataset.open==='${secondTab}'`,
    ),
    true,
    'Escape closes the tab menu and returns focus to the tab',
  );
  await rightClick(`[data-request-tab-item="${secondTab}"]`);
  const outsidePoint = (await run(
    "(()=>{const box=document.querySelector('.request-heading').getBoundingClientRect();return {x:Math.round(box.left+40),y:Math.round(box.top+box.height/2)}})()",
  )) as { x: number; y: number };
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    ...outsidePoint,
    button: 'left',
    clickCount: 1,
  });
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    ...outsidePoint,
    button: 'left',
    clickCount: 1,
  });
  await pause(80);
  assert.equal(
    await run("document.querySelector('[data-request-tab-menu]').matches(':popover-open')"),
    false,
    'clicking elsewhere closes the tab menu',
  );
  await run(
    `document.querySelector('.request-tab-label[data-open="${secondTab}"]').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))`,
  );
  await pause(30);
  await run("document.querySelector('[data-request-tab-menu] [data-menu-item=rename]').click()");
  await pause(30);
  assert.equal(
    await run(
      `(()=>{const input=document.querySelector('[data-tab-rename]');return Boolean(input)&&document.activeElement===input&&input.value===state.requests.find(request=>request.id==='${secondTab}').name})()`,
    ),
    true,
    'Shift+F10 opens the tab menu and Rename edits that tab',
  );
  await run(
    "document.querySelector('[data-tab-rename]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  await run('window.tabsBeforeMenu=[...state.tabs];window.activeBeforeMenu=state.active');
  await run(
    `document.querySelector('.request-tab-label[data-open="${secondTab}"]').dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))`,
  );
  await pause(30);
  await run("document.querySelector('[data-request-tab-menu] [data-menu-item=others]').click()");
  await pause(30);
  assert.equal(
    await run("state.tabs.join('|')"),
    secondTab,
    'Close other tabs keeps only the chosen tab',
  );
  await run('state.tabs=window.tabsBeforeMenu;openRequest(window.activeBeforeMenu);render()');
  // Explorer rows: right-click, Shift+F10, or the context menu key opens the row's ⋯ actions.
  const explorerMenu = "document.querySelector('[data-explorer-context-menu]')";
  const explorerMenuIds = () =>
    run(
      `[...${explorerMenu}.querySelectorAll('[data-menu-item]')].map(item=>item.dataset.menuItem).join()`,
    ) as Promise<string>;
  await rightClick(`.request-item[data-open="${await run('window.renameId')}"]`);
  await pause(30);
  assert.equal(
    await run(
      `${explorerMenu}.matches(':popover-open')&&document.activeElement===${explorerMenu}.querySelector('[data-menu-item]')`,
    ),
    true,
    'right-clicking a request row opens its context menu',
  );
  assert.equal(
    await explorerMenuIds(),
    await run(
      '[...document.querySelector(`[data-request-row="${window.renameId}"] .action-menu`).querySelectorAll(\'[data-menu-item]\')].map(item=>item.dataset.menuItem).join()',
    ),
    "a request row's context menu lists its ⋯ actions",
  );
  await run(
    `${explorerMenu}.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`,
  );
  await pause(30);
  assert.equal(
    await run(
      "!document.querySelector('[data-explorer-context-menu]').matches(':popover-open')&&document.activeElement.dataset.open===window.renameId",
    ),
    true,
    'Escape closes the row menu and returns focus to the row',
  );
  await run(
    "document.querySelector('.collection-folder-heading > .folder').dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))",
  );
  await pause(30);
  assert.equal(
    await explorerMenuIds(),
    await run(
      "[...document.querySelector('.collection-folder-heading [data-collection-menu]').closest('.collection-folder-heading').querySelector('.action-menu').querySelectorAll('[data-menu-item]')].map(item=>item.dataset.menuItem).join()",
    ),
    "Shift+F10 on a collection opens the collection's actions",
  );
  await run(`${explorerMenu}.querySelector('[data-menu-item=rename]').click()`);
  await pause(30);
  assert.equal(
    await run("document.activeElement===document.querySelector('[data-folder-rename]')"),
    true,
    'Rename from the collection context menu edits its name',
  );
  await run(
    "document.querySelector('[data-folder-rename]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  await pause(30);
  await run(
    "document.querySelector(`.request-item[data-open=\"${window.renameId}\"]`).dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true}))",
  );
  await pause(30);
  await run(`${explorerMenu}.querySelector('[data-menu-item=rename]').click()`);
  await pause(30);
  assert.equal(
    await run(
      'document.activeElement===document.querySelector(`[data-request-rename="${window.renameId}"]`)',
    ),
    true,
    'the context menu key on a request row offers Rename',
  );
  // Empty space in the explorer opens the explorer's own menu.
  const treePoint = (await run(
    "(()=>{const tree=document.querySelector('[data-explorer-tree]');const box=tree.getBoundingClientRect();const point={x:Math.round(box.left+12),y:Math.round(box.bottom-6)};return {...point,empty:document.elementFromPoint(point.x,point.y)===tree}})()",
  )) as { x: number; y: number; empty: boolean };
  assert.equal(treePoint.empty, true, 'the explorer has empty space below its rows');
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    x: treePoint.x,
    y: treePoint.y,
    button: 'right',
    clickCount: 1,
  });
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    x: treePoint.x,
    y: treePoint.y,
    button: 'right',
    clickCount: 1,
  });
  await pause(150);
  assert.equal(
    await run(`${explorerMenu}.matches(':popover-open')`),
    true,
    'right-clicking empty explorer space opens the explorer menu',
  );
  assert.equal(
    await explorerMenuIds(),
    'new,new-collection,import,expand,collapse,hide',
    'the explorer menu offers new, import, and expand or collapse all',
  );
  await run(`${explorerMenu}.querySelector('[data-menu-item=collapse]').click()`);
  await pause(30);
  assert.equal(
    await run("!document.querySelector('.collection-requests')"),
    true,
    'Collapse all collapses every collection',
  );
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    x: treePoint.x,
    y: treePoint.y,
    button: 'right',
    clickCount: 1,
  });
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    x: treePoint.x,
    y: treePoint.y,
    button: 'right',
    clickCount: 1,
  });
  await pause(150);
  await run(`${explorerMenu}.querySelector('[data-menu-item=expand]').click()`);
  await pause(30);
  assert.equal(
    await run(
      "document.querySelectorAll('.collection-requests').length===document.querySelectorAll('[data-collection]').length",
    ),
    true,
    'Expand all expands them again',
  );
  await run(
    "document.querySelector('[data-request-rename]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  await run(
    "window.deleteOriginalActive=state.active;window.deleteTestRequest=structuredClone(current());window.deleteTestRequest.id='delete-ui-request';window.deleteTestRequest.name='Delete UI request';state.requests.push(window.deleteTestRequest);state.tabs.push(window.deleteTestRequest.id);render()",
  );
  await run(
    "(()=>{const button=document.querySelector('[data-delete-collection-request=delete-ui-request]');button.focus();button.click();})()",
  );
  await pause(100);
  assert.equal(
    await run("document.activeElement?.matches('[data-confirm-cancel]')"),
    true,
    'a destructive confirmation starts on Cancel',
  );
  await capture('confirm-dialog.png');
  assert.match(
    await answerConfirm(false),
    /Delete “Delete UI request”\?/,
    'deleting a request asks first, by name',
  );
  assert.equal(
    await run(
      "document.activeElement?.matches('[data-delete-collection-request=delete-ui-request]')",
    ),
    true,
    'focus returns to the button after the dialog',
  );
  assert.equal(
    await run("state.requests.some(request=>request.id==='delete-ui-request')"),
    true,
    'cancel preserves collection request',
  );
  await run(
    "document.querySelector('#filter').value='Delete UI request';document.querySelector('#filter').dispatchEvent(new Event('input'));document.querySelector('[data-delete-collection-request=delete-ui-request]').click()",
  );
  await answerConfirm(true);
  assert.equal(
    await run(
      "state.requests.some(request=>request.id==='delete-ui-request')||state.tabs.includes('delete-ui-request')",
    ),
    false,
    'filtered collection delete removes request and its tab',
  );
  assert.equal(
    await run('state.active===window.deleteOriginalActive'),
    true,
    'deleting another request preserves active request',
  );
  await run(
    "filter='';state.requests.push(window.deleteTestRequest);openRequest('delete-ui-request')",
  );
  await run("document.querySelector('[data-delete-collection-request=delete-ui-request]').click()");
  await run(
    "document.querySelector('[data-confirm-dialog]').dispatchEvent(new Event('cancel',{cancelable:true}))",
  );
  assert.equal(
    await run(
      "state.requests.some(request=>request.id==='delete-ui-request')&&!document.querySelector('[data-confirm-dialog]').open",
    ),
    true,
    'Escape cancels a confirmation',
  );
  await run("document.querySelector('[data-delete-collection-request=delete-ui-request]').click()");
  await answerConfirm(true);
  assert.equal(
    await run(
      "state.requests.some(request=>request.id===state.active)&&state.active!=='delete-ui-request'",
    ),
    true,
    'deleting active request selects a remaining request',
  );
  // Toasts: bottom right, toned, stacked up to four, dismissible, and announced.
  await run(
    "clearToasts();toast('Request saved','success');toast('Could not reach the server','error');toast('Send a request first','warning')",
  );
  await pause(250);
  assert.equal(
    await run(
      "[...document.querySelectorAll('.toast')].map(item=>item.dataset.toastTone+':'+item.getAttribute('role')).join()",
    ),
    'success:status,error:alert,warning:status',
    'toasts carry their tone, and errors are announced as alerts',
  );
  await capture('toast-tones.png');
  assert.equal(
    await run(
      "(()=>{const box=document.querySelector('.toast').getBoundingClientRect();return box.right>innerWidth-40&&box.bottom<innerHeight-30;})()",
    ),
    true,
    'toasts sit in the bottom-right corner above the status bar',
  );
  await run("toast('Request saved','success')");
  assert.equal(
    await run("document.querySelectorAll('.toast').length"),
    3,
    'repeating a message refreshes it instead of stacking a copy',
  );
  await run("toast('One','info');toast('Two','info')");
  await pause(350);
  assert.equal(
    await run(
      "document.querySelectorAll('.toast').length===4&&!document.querySelector('.toast').textContent.includes('Request saved')",
    ),
    true,
    'at most four toasts show, oldest first to go',
  );
  await run(
    "window.toastActed=0;clearToasts();toast('Saved 2 requests',{tone:'success',action:{label:'Open',run:()=>{window.toastActed++;}}})",
  );
  await pause(50);
  await capture('toasts.png');
  await run("document.querySelector('[data-toast-action]').click()");
  await pause(250);
  assert.equal(
    await run("window.toastActed===1&&!document.querySelector('.toast')"),
    true,
    'a toast action runs and dismisses it',
  );
  await run("toast('Dismiss me','info')");
  await pause(50);
  await run("document.querySelector('[data-toast-dismiss]').click()");
  await pause(250);
  assert.equal(
    await run("document.querySelectorAll('.toast').length"),
    0,
    'the close button dismisses a toast',
  );
  await run("toast('Short-lived',{duration:200})");
  await pause(700);
  assert.equal(
    await run("document.querySelectorAll('.toast').length"),
    0,
    'toasts leave when their time runs out',
  );
  await run("toast('Paused while pointed at',{duration:300})");
  await pause(30);
  await run("document.querySelector('.toast .toast-progress').style.animationPlayState='paused'");
  await pause(700);
  assert.equal(
    await run("document.querySelectorAll('.toast').length"),
    1,
    'a paused countdown keeps the toast',
  );
  await run('clearToasts()');
  // The select box: a combobox with a listbox in the top layer, driven by mouse and keyboard.
  await run(
    "window.selectOriginal=structuredClone(current());current().method='GET';current().auth='None';requestTab='Params';render()",
  );
  const selectKey = (selector: string, value: string, extra = '') =>
    run(
      `document.querySelector('${selector}').dispatchEvent(new KeyboardEvent('keydown',{key:'${value}',bubbles:true${extra}}))`,
    );
  const methodTrigger = '.urlbar > .method-select .ui-select-trigger';
  await run(`document.querySelector('${methodTrigger}').click()`);
  assert.equal(
    await run(
      `(()=>{const box=document.querySelector('.urlbar > .method-select'),menu=box.querySelector('.ui-select-menu');return menu.matches(':popover-open')&&box.querySelector('[role=combobox]').getAttribute('aria-expanded')==='true'&&menu.querySelectorAll('[role=option]').length===15&&menu.querySelector('[aria-selected=true]').dataset.httpMethod==='GET';})()`,
    ),
    true,
    'clicking the select opens its listbox with the current choice selected',
  );
  await selectKey(methodTrigger, 'ArrowDown');
  assert.match(
    await run(`document.querySelector('${methodTrigger}').getAttribute('aria-activedescendant')`),
    /option-1$/,
    'arrow keys move the active option',
  );
  await selectKey(methodTrigger, 'Enter');
  assert.equal(
    await run(
      `current().method==='POST'&&!document.querySelector('.urlbar > .method-select .ui-select-menu').matches(':popover-open')&&document.activeElement===document.querySelector('${methodTrigger}')`,
    ),
    true,
    'Enter chooses the option, closes the list, and keeps focus',
  );
  assert.equal(await run('current().method'), 'POST', 'the native select follows the choice');
  await run(`document.querySelector('${methodTrigger}').click()`);
  await pause(150);
  assert.equal(
    await run(
      "(()=>{const options=[...document.querySelectorAll('.urlbar .ui-select-option[data-method]:not([data-request-protocol])')];const colours=options.map(option=>getComputedStyle(option.querySelector('.ui-select-option-icon')).color);const value=getComputedStyle(document.querySelector('.urlbar > .method-select .ui-select-value-icon')).color;const chosen=options.find(option=>option.dataset.method===current().method);return options.length===9&&new Set(colours).size>=7&&value===getComputedStyle(chosen.querySelector('.ui-select-option-icon')).color;})()",
    ),
    true,
    'every method has an icon in its colour, and the box shows the chosen one',
  );
  await capture('method-select.png');
  await run("document.querySelector('.urlbar > .method-select .ui-select-menu').hidePopover()");
  await selectKey(methodTrigger, 'd');
  assert.equal(
    await run('current().method'),
    'DELETE',
    'typing a letter selects the matching option',
  );
  await selectKey(methodTrigger, 'ArrowDown');
  await selectKey(methodTrigger, 'Escape');
  assert.equal(
    await run(
      "current().method==='DELETE'&&!document.querySelector('.urlbar > .method-select .ui-select-menu').matches(':popover-open')",
    ),
    true,
    'Escape closes without changing the choice',
  );
  // Long lists can be filtered.
  await run("requestTab='Auth';render()");
  await pause(100);
  await run("document.querySelector('.auth-type .ui-select-trigger').click()");
  await pause(100);
  assert.equal(
    await run(
      "document.activeElement?.matches('.ui-select-search input')&&document.querySelectorAll('.auth-type .ui-select-group').length===5",
    ),
    true,
    'long lists open with a filter and show their groups',
  );
  await capture('select-open.png');
  await run(
    "const filterInput=document.activeElement;filterInput.value='digest';filterInput.dispatchEvent(new Event('input'))",
  );
  await pause(50);
  await capture('select-filtered.png');
  assert.equal(
    await run(
      "[...document.querySelectorAll('.auth-type [role=option]')].map(option=>option.textContent.trim()).join()",
    ),
    'Digest auth',
    'the filter narrows the options',
  );
  await selectKey('.ui-select-search input', 'Enter');
  assert.equal(await run('current().auth'), 'Digest auth', 'Enter in the filter chooses the match');
  // A select inside a label: clicking an option closes the list (it must not reopen through the label).
  await run("document.querySelector('.auth-type .ui-select-trigger').click()");
  await pause(80);
  await run(
    'document.querySelector(\'.auth-type [role=option][data-value="Bearer token"]\').click()',
  );
  await pause(80);
  assert.equal(
    await run(
      "current().auth==='Bearer token'&&!document.querySelector('.auth-type .ui-select-menu').matches(':popover-open')&&!document.querySelector('.auth-type .ui-select').classList.contains('open')",
    ),
    true,
    'choosing an option in a select inside a label closes the list',
  );
  await run("Object.assign(current(),window.selectOriginal);requestTab='Params';render()");
  // Stacked, the divider stops below the request tabs, so it never cuts across the URL bar.
  await run(
    "window.shareOriginal={share:requestPanels.share,layout:requestPanels.layout};view='Collections';requestTab='Params';requestPanels.layout='stacked';render()",
  );
  await pause(200);
  await run(
    "document.querySelector('.request-response-panes > .pane-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))",
  );
  await pause(200);
  assert.equal(
    await run(
      "(()=>{const pane=document.querySelector('.request-pane').getBoundingClientRect(),url=document.querySelector('.urlbar').getBoundingClientRect(),tabs=document.querySelector('.request-pane [role=tablist]').getBoundingClientRect(),resizer=document.querySelector('.request-response-panes > .pane-resizer');return url.bottom<=pane.bottom&&tabs.bottom<=pane.bottom&&Number(resizer.getAttribute('aria-valuemin'))>=25&&Number(resizer.getAttribute('aria-valuenow'))===Number(resizer.getAttribute('aria-valuemin'));})()",
    ),
    true,
    'at its smallest, the stacked request pane still shows the URL bar and tabs',
  );
  await run('Object.assign(requestPanels,window.shareOriginal);render()');
  // The desktop window's page cannot reach the network itself: requests go through the main
  // process, and a second content policy forbids connections from the page.
  assert.deepEqual(
    await run(
      "new Promise((resolve)=>{let violation='';document.addEventListener('securitypolicyviolation',(event)=>{violation=event.effectiveDirective},{once:true});fetch('https://csp-probe.invalid/').then(()=>resolve({fetched:true,violation}),()=>setTimeout(()=>resolve({fetched:false,violation,policy:document.querySelector('meta[data-desktop-policy]')?.content}),50))})",
    ),
    { fetched: false, violation: 'connect-src', policy: "connect-src 'none'" },
    'the desktop page cannot open network connections of its own',
  );
}
