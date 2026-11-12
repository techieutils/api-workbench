import assert from 'node:assert/strict';
import { pause, type SmokeContext } from './harness';

/** UI smoke checks, part 7: overview import and editors. */
export default async function overviewImportAndEditors(context: SmokeContext) {
  const { window, run, capture, tabsReachable, rightClick } = context;
  await run("view='Overview';render()");
  await run('Promise.all(Array.from(document.images, image => image.decode()))');
  // Squeezed, the overview stat cards and quick actions scroll with arrows.
  for (const row of ['.overview-stats', '.quick-actions']) {
    await run(`document.querySelector('${row}').closest('.ui-tabs-frame').style.width='260px'`);
    await pause(80);
    assert.equal(await tabsReachable(row), 'reachable', `${row} is reachable with the arrows`);
    await run(`document.querySelector('${row}').closest('.ui-tabs-frame').style.width=''`);
  }
  await run("document.querySelector('[data-overview-banner=hide]').click()");
  assert.equal(
    await run(
      "overviewBannerHidden&&!document.querySelector('.overview-hero')&&document.activeElement.dataset.overviewBanner==='show'",
    ),
    true,
    'the welcome banner can be dismissed',
  );
  assert.equal(
    await run(
      "(()=>{const order=[...document.querySelector('.overview-panel').children].map(node=>node.className);return order.findIndex(name=>name.includes('overview-columns'))<order.findIndex(name=>name.includes('quick-actions'));})()",
    ),
    true,
    'recent activity moves above quick actions without the banner',
  );
  await run('render()');
  assert.equal(
    await run("!document.querySelector('.overview-hero')"),
    true,
    'the dismissal persists across renders',
  );
  await capture('overview-compact.png');
  await run("document.querySelector('[data-overview-banner=show]').click()");
  assert.equal(
    await run("!overviewBannerHidden&&Boolean(document.querySelector('.overview-hero'))"),
    true,
    'the welcome banner can be restored',
  );
  // Every overview link goes where it says.
  const overview = async () => {
    await run("view='Overview';render()");
    await pause(60);
  };
  await run(
    "if(!state.history.length){state.history.unshift({requestId:state.requests[0].id,method:'GET',url:state.requests[0].url,status:200,time:120,date:new Date().toISOString()});render()}",
  );
  await overview();
  assert.deepEqual(
    await run(
      "[...document.querySelectorAll('[data-essential]')].map((row)=>[row.dataset.essential,row.tagName,Boolean(row.querySelector('.essentials-go'))])",
    ),
    [
      ['environment', 'BUTTON', true],
      ['vault', 'BUTTON', true],
      ['history', 'BUTTON', true],
      ['responses', 'BUTTON', true],
      ['updates', 'BUTTON', true],
    ],
    'each workspace essential is a link, including History and Updates',
  );
  await run("document.querySelector('[data-essential=history]').click()");
  assert.equal(await run('view'), 'History', 'the History essential opens History');
  await overview();
  await run("document.querySelector('[data-overview-history]').click()");
  assert.equal(await run('view'), 'History', 'View all opens History');
  // Responses open Settings at Privacy, whichever section was open before.
  await run("view='Settings';render()");
  await pause(60);
  await run("document.querySelector('[data-settings-section=Appearance]').click()");
  await overview();
  await run("document.querySelector('[data-essential=responses]').click()");
  await pause(60);
  assert.deepEqual(
    await run(
      "[view,document.querySelector('.settings-nav button.active')?.dataset.settingsSection,Boolean(document.querySelector('#setting-persistResponses'))]",
    ),
    ['Settings', 'Privacy', true],
    'Responses stay in memory opens Settings → Privacy',
  );
  await overview();
  await run("document.querySelector('[data-essential=updates]').click()");
  await pause(60);
  assert.equal(
    await run("document.querySelector('.settings-nav button.active')?.dataset.settingsSection"),
    'Updates',
    'the Updates essential opens Settings → Updates',
  );
  // A recent send opens in History with its response showing; its icon opens the request.
  await overview();
  await run("historyUI.status='Client errors';historyUI.query='no match'");
  await run("document.querySelector('[data-recent-entry]').click()");
  await pause(120);
  assert.deepEqual(
    await run(
      "[view,historyUI.query,historyUI.status,historyUI.selected===`${state.history[0].date}|${state.history[0].requestId}`,Boolean(document.querySelector('[data-history-detail]'))]",
    ),
    ['History', '', 'All', true, true],
    'a recent send opens in History, selected, with filters cleared',
  );
  await overview();
  const recentRequest = await run("document.querySelector('.recent-open')?.dataset.open");
  await run("document.querySelector('.recent-open').click()");
  assert.deepEqual(
    await run('[view,state.active]'),
    ['Collections', recentRequest],
    'the open icon on a recent send opens its request',
  );
  await overview();
  await run("document.querySelector('[data-overview-stat=Environments]').click()");
  assert.equal(await run('view'), 'Environments', 'a stat card opens its screen');
  await overview();
  await capture('overview-links.png');
  // The stat tiles summarise the workspace and today's sends, and History beyond the shown rows.
  assert.deepEqual(
    await run(
      "(()=>{const tiles=[...document.querySelectorAll('[data-overview-stat]')].map((tile)=>tile.dataset.overviewStat);const sent=document.querySelector('[data-overview-stat=\"Sent today\"]');const median=document.querySelector('[data-overview-stat=\"Median response\"]');return {tiles,sent:sent.querySelector('strong').textContent.trim()===String(state.history.filter((entry)=>new Date(entry.date)>=new Date(new Date().setHours(0,0,0,0))).length),median:/^\\d+(\\.\\d)? m?s$/.test(median.querySelector('strong').textContent.trim()),p95:median.querySelector('small').textContent.startsWith('p95 ')}})()",
    ),
    {
      tiles: ['Saved requests', 'Environments', 'Sent today', 'Median response'],
      sent: true,
      median: true,
      p95: true,
    },
    'the stat tiles show saved requests, environments, today’s sends, and the median response time',
  );
  // Hovering a stat tile or an essentials row highlights it without hiding any border.
  const hover = async (selector: string) => {
    const { x, y } = await run(
      `(()=>{const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)}})()`,
    );
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y });
    await pause(250);
  };
  await run("document.querySelector('.overview-stats').scrollIntoView({block:'center'})");
  await hover('[data-overview-stat="Saved requests"]');
  assert.deepEqual(
    await run(
      "(()=>{const tile=document.querySelector('[data-overview-stat=\"Saved requests\"]');const frame=tile.closest('.ui-tabs-frame')??tile.parentElement;const style=getComputedStyle(tile);return {hovered:tile.matches(':hover'),moved:style.transform!=='none',borderInside:tile.getBoundingClientRect().top>=frame.getBoundingClientRect().top,border:style.borderTopWidth!=='0px'&&style.borderTopColor!=='rgba(0, 0, 0, 0)'}})()",
    ),
    { hovered: true, moved: false, borderInside: true, border: true },
    'a hovered stat tile keeps its whole border in view',
  );
  await capture('overview-tile-hover.png');
  await run("document.querySelector('[data-essential=history]').scrollIntoView({block:'center'})");
  await hover('[data-essential=history]');
  assert.deepEqual(
    await run(
      "(()=>{const row=document.querySelector('[data-essential=history]');const next=row.nextElementSibling;const visible=(item)=>{const style=getComputedStyle(item);return style.borderTopWidth!=='0px'&&style.borderTopColor!=='rgba(0, 0, 0, 0)'};return {hovered:row.matches(':hover'),own:visible(row),below:visible(next)}})()",
    ),
    { hovered: true, own: true, below: true },
    'a hovered essentials row keeps the dividers above and below it',
  );
  await capture('overview-essential-hover.png');
  window.webContents.sendInputEvent({ type: 'mouseMove', x: 1, y: 1 });
  assert.equal(
    await run(
      "(async()=>{const count=state.requests.length;try{await importCollection({requests:[{name:'Valid',method:'GET',url:'https://example.com',params:[],headers:[]},{name:'Invalid',method:'GET',url:'https://example.com',params:[{key:1,value:'bad'}],headers:[]}]});return false;}catch{return state.requests.length===count;}})()",
    ),
    true,
    'invalid imports leave the workspace unchanged',
  );
  await run(
    "importCollection({info:{name:'Imported APIs'},item:[{name:'Health',request:{method:'GET',url:'https://example.com/health'}}]})",
  );
  assert.equal(await run('state.requests.at(-1).name'), 'Health');
  await run("window.transferCount=state.requests.length;openCollectionTransfer('import');void 0");
  assert.equal(
    await run(
      "Boolean(document.querySelector('.collection-transfer[role=dialog]'))&&document.querySelector('[data-transfer-confirm]').disabled",
    ),
    true,
    'import starts with a disabled commit button',
  );
  await run(
    `document.querySelector('[data-transfer-tab=Paste]').click();transferUI.pasted=${JSON.stringify(JSON.stringify({ info: { name: 'UI import' }, item: [{ name: 'Previewed request', request: { method: 'GET', url: 'https://example.com/preview' } }] }))};render();document.querySelector('[data-transfer-parse]').click();void 0`,
  );
  assert.equal(
    await run(
      "transferUI.preview.data.requests.length===1&&state.requests.length===window.transferCount&&!document.querySelector('[data-transfer-confirm]').disabled",
    ),
    true,
    'import preview does not modify the workspace',
  );
  assert.equal(
    await run(
      "(()=>{const badges=[...document.querySelectorAll('.transfer-preview .method')];return badges.length===1&&badges.every(badge=>badge.querySelector('.method-icon'));})()",
    ),
    true,
    'the import preview shows method icons',
  );
  await capture('collection-import-preview.png');
  await run(
    "document.querySelector('#transfer-source').value='broken';document.querySelector('#transfer-source').dispatchEvent(new Event('input',{bubbles:true}));void 0",
  );
  assert.equal(
    await run("!transferUI.preview&&document.querySelector('[data-transfer-confirm]').disabled"),
    true,
    'editing a paste invalidates its old preview',
  );
  // The import panel's paste box has the text menu, and a real click on an item works.
  await rightClick('#transfer-source');
  assert.equal(
    await run("document.querySelector('[data-text-menu]').matches(':popover-open')"),
    true,
    'the text menu opens on the import paste box',
  );
  const selectAllPoint = (await run(
    "(()=>{const box=document.querySelector('[data-text-menu] [data-menu-item=select-all]').getBoundingClientRect();return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)}})()",
  )) as { x: number; y: number };
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    ...selectAllPoint,
    button: 'left',
    clickCount: 1,
  });
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    ...selectAllPoint,
    button: 'left',
    clickCount: 1,
  });
  await pause(80);
  assert.equal(
    await run(
      "(()=>{const field=document.querySelector('#transfer-source');return document.activeElement===field&&field.selectionStart===0&&field.selectionEnd===field.value.length})()",
    ),
    true,
    'clicking Select all in the dialog selects the pasted text',
  );
  await run(
    "transferUI.pasted=JSON.stringify({requests:[{name:'Previewed request',method:'GET',url:'https://example.com/preview'}]});render();document.querySelector('[data-transfer-parse]').click();void 0",
  );
  await run("document.querySelector('[data-transfer-confirm]').click();void 0");
  await pause(50);
  assert.equal(
    await run(
      "!transferUI.mode&&state.requests.length===window.transferCount+1&&state.requests.at(-1).name==='Previewed request'",
    ),
    true,
    'confirmation commits the preview once',
  );
  await run("openCollectionTransfer('export');void 0");
  assert.equal(
    await run(
      "document.querySelector('#transfer-format').options.length>=12&&transferUI.exported.name==='api-workbench.json'",
    ),
    true,
    'export offers all supported formats',
  );
  await run(
    "document.querySelector('#transfer-format').value='bruno';document.querySelector('#transfer-format').dispatchEvent(new Event('change'));void 0",
  );
  assert.equal(
    await run(
      "transferUI.exported.type==='application/zip'&&document.querySelector('#transfer-archive').checked&&document.querySelector('#transfer-archive').disabled",
    ),
    true,
    'Bruno exports native files as ZIP',
  );
  await capture('collection-export-formats.png');
  await run(
    "document.querySelector('#transfer-format').value='postman';document.querySelector('#transfer-format').dispatchEvent(new Event('change'));void 0",
  );
  await run(
    "document.querySelector('#transfer-archive').checked=true;document.querySelector('#transfer-archive').dispatchEvent(new Event('change'));void 0",
  );
  assert.equal(
    await run("transferUI.exported.name==='api-workbench-postman.zip'"),
    true,
    'any export can be packaged as ZIP',
  );
  await run('closeCollectionTransfer();void 0');

  assert.equal(
    await run('document.documentElement.scrollWidth>window.innerWidth'),
    false,
    'no horizontal viewport overflow',
  );
  window.setSize(1050, 720);
  await pause(150);
  for (const page of ['Collections', 'Settings', 'Credentials', 'Overview']) {
    await run(`view=${JSON.stringify(page)};requestTab='Params';render()`);
    assert.equal(
      await run('document.documentElement.scrollWidth>window.innerWidth'),
      false,
      `${page} fits the minimum window width`,
    );
  }
  await run("view='Collections';render()");
  assert.equal(
    await run(
      "document.querySelector('.response').getBoundingClientRect().bottom<=document.querySelector('footer').getBoundingClientRect().top+1",
    ),
    true,
    'response inspector fits above the status bar at the minimum window height',
  );
  await run('openCodeGenerator(true)');
  await run('devTools.open=true;render()');
  for (const layout of ['stacked', 'side']) {
    await run(`requestPanels.layout=${JSON.stringify(layout)};render()`);
    assert.equal(
      await run('document.documentElement.scrollWidth<=innerWidth'),
      true,
      'all panels fit the minimum window width',
    );
    assert.equal(
      await run(
        "document.querySelector('.code-dock').getBoundingClientRect().left>=document.querySelector('.request-response-panes').getBoundingClientRect().right-1",
      ),
      true,
      'Code remains on the right at minimum window width',
    );
    assert.equal(
      await run(
        "document.querySelector('.devtools').getBoundingClientRect().bottom<=document.querySelector('footer').getBoundingClientRect().top+1",
      ),
      true,
      'dev tools stay above the status bar',
    );
    assert.equal(
      await run("document.querySelector('.code-dock').getBoundingClientRect().width>0"),
      true,
    );
  }
  await run("closeCodeGenerator();devTools.open=false;requestPanels.layout='stacked';render()");
  await run(
    "window.responsiveOriginalName=current().name;current().name='Enterprise production identity authorization and token management API request';current().bodyType='raw';requestPanels.layout='side';render()",
  );
  for (const [width, height] of [
    [1440, 960],
    [1050, 720],
  ]) {
    window.setSize(width, height);
    await pause(100);
    for (const share of [25, 50, 75]) {
      for (const tab of ['Body', 'Auth', 'Settings']) {
        await run(`requestPanels.share=${share};requestTab=${JSON.stringify(tab)};render()`);
        assert.equal(
          await run(
            "(()=>{const title=document.querySelector('.request-heading-title');const heading=title.querySelector('h1').getBoundingClientRect();const crumb=title.querySelector('.breadcrumb').getBoundingClientRect();const actions=document.querySelector('.actions').getBoundingClientRect();return heading.top>=crumb.bottom-1&&(actions.top>=title.getBoundingClientRect().bottom-1||actions.left>=title.getBoundingClientRect().right-1);})()",
          ),
          true,
          `breadcrumb, title and actions do not overlap at ${width}px / ${share}% / ${tab}`,
        );
        assert.equal(
          await run(
            "(()=>{const pane=document.querySelector('.request-pane');return pane.scrollWidth<=pane.clientWidth+1;})()",
          ),
          true,
          `request controls fit their panel at ${width}px / ${share}% / ${tab}`,
        );
      }
    }
  }
  await run(
    "current().name=window.responsiveOriginalName;requestPanels.share=55;requestPanels.layout='stacked';render()",
  );
  await run(
    "window.editorOriginal=structuredClone(current());current().bodyType='raw';requestTab='Body';responseTab='Body';current().method='POST';current().editorLanguage='json';current().body='{\"items\":[1,2],\"n\":9007199254740993}';render();action('format')",
  );
  assert.equal(
    await run("Boolean(document.querySelector('#request-source-editor .cm-editor'))"),
    true,
    'request has a syntax editor',
  );
  assert.equal(
    await run("requestSourceEditor.getValue().includes('\\n    1,\\n    2')"),
    true,
    'JSON arrays format on separate lines',
  );
  assert.equal(
    await run("requestSourceEditor.getValue().includes('9007199254740993')"),
    true,
    'request formatting preserves large numbers',
  );
  await capture('editor-json.png');
  // The request body editor's context menu adds editing: undo, cut, and paste.
  await run(
    "window.clipboardBefore=navigator.clipboard;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.bodyCopied=value;},readText:async()=>'{\"pasted\":true}'}})",
  );
  const bodyMenu = "document.querySelector('#request-source-editor [data-editor-menu]')";
  const bodyMenuItem = (id: string) =>
    run(`${bodyMenu}.querySelector('[data-menu-item=${id}]').click()`);
  await rightClick('#request-source-editor .cm-content');
  assert.match(
    await run(
      `[...${bodyMenu}.querySelectorAll('[data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()`,
    ),
    /^undo-?,redo-?,cut-,copy-,paste,select-all,find,fold,unfold,format$/,
    'the request body menu offers editing commands, with Cut and Copy off until text is selected',
  );
  await bodyMenuItem('select-all');
  await pause(30);
  await run('window.bodyBeforeCut=current().body');
  await rightClick('#request-source-editor .cm-content');
  await bodyMenuItem('cut');
  await pause(50);
  assert.equal(
    await run("current().body===''&&window.bodyCopied===window.bodyBeforeCut"),
    true,
    'Cut copies the selection and removes it from the body',
  );
  await rightClick('#request-source-editor .cm-content');
  await bodyMenuItem('undo');
  await pause(50);
  assert.equal(
    await run('current().body===window.bodyBeforeCut'),
    true,
    'Undo restores the cut text',
  );
  await rightClick('#request-source-editor .cm-content');
  await bodyMenuItem('select-all');
  await pause(30);
  await rightClick('#request-source-editor .cm-content');
  await bodyMenuItem('paste');
  await pause(50);
  assert.equal(
    await run('current().body'),
    '{"pasted":true}',
    'Paste replaces the selection with the clipboard text',
  );
  await run(
    "Object.defineProperty(navigator,'clipboard',{configurable:true,value:window.clipboardBefore})",
  );
  await run("requestSourceEditor.setValue('not valid json');action('format')");
  assert.equal(
    await run('current().body'),
    'not valid json',
    'invalid formatting preserves the request body',
  );
  assert.equal(
    await run(
      "[...document.querySelectorAll('.toast')].some(item=>item.dataset.toastTone==='error'&&item.textContent.startsWith('Format failed:'))",
    ),
    true,
  );
  for (const [language, source] of [
    ['xml', '<root><item>one</item></root>'],
    ['html', '<div><p>one</p><p>two</p></div>'],
    ['javascript', 'function example(){return {ok:true};}'],
    ['css', 'body{color:red;margin:0}'],
  ]) {
    await run(
      `current().editorLanguage=${JSON.stringify(language)};current().body=${JSON.stringify(source)};render();action('format')`,
    );
    assert.equal(
      await run('requestSourceEditor.getValue()===current().body'),
      true,
      `${language} formatting stays synced with request state`,
    );
    assert.equal(
      await run("current().body.includes('\\n')"),
      true,
      `${language} formats in Electron`,
    );
  }
  await run(
    "current().editorLanguage='xml';current().body='<p>Hello <b>world</b> !</p>';render();action('format')",
  );
  assert.equal(
    await run("current().body.includes('Hello <b>world</b> !')"),
    true,
    'XML mixed content preserves significant whitespace',
  );
  await run(
    "current().response={status:200,statusText:'OK',headers:{'Content-Type':'application/json; charset=utf-8'},body:'{\"values\":[1,2]}',time:1,size:16,url:'https://example.com'};responseEditorLanguage='auto';responseMode='Pretty';render();formatResponseSource(true)",
  );
  assert.equal(
    await run("Boolean(document.querySelector('#response-source-editor .cm-editor'))"),
    true,
    'response has a syntax editor',
  );
  assert.equal(await run("editorView('#response-source-editor').state.readOnly"), true);
  assert.equal(
    await run("responseSourceEditor.getValue().includes('\\n    1,\\n    2')"),
    true,
    'Pretty response formats JSON consistently',
  );
  assert.equal(
    await run('current().response.body'),
    '{"values":[1,2]}',
    'response formatting preserves original payload',
  );
  await run("document.querySelector('[data-mode=Raw]').click()");
  assert.equal(
    await run('responseSourceEditor.getValue()'),
    '{"values":[1,2]}',
    'Raw response displays original text',
  );
  await run(
    "current().response.headers={'Content-Type':'text/html'};current().response.body='<div><p>hello</p><script>window.UNSAFE_EDITOR_CONTENT=true;</script></div>';responseMode='Pretty';render();formatResponseSource(true)",
  );
  assert.equal(await run("responseSourceEditor.getValue().includes('\\n')"), true);
  assert.equal(
    await run('window.UNSAFE_EDITOR_CONTENT'),
    undefined,
    'response HTML and JavaScript are displayed without execution',
  );
  await run(
    "current().response.headers={'Content-Type':'application/json'};current().response.body='invalid JSON';render();formatResponseSource(true)",
  );
  assert.equal(await run('responseSourceEditor.getValue()'), 'invalid JSON');
  assert.equal(
    await run("document.querySelector('#response-format-status').hidden"),
    false,
    'invalid response formatting shows an explanation',
  );
  await run('Object.assign(current(),window.editorOriginal);render()');
  await run(
    "window.inspectorOriginal=structuredClone(current());current().tests='status 200\\nstatus 404';current().response={status:200,statusText:'OK',headers:{'content-type':'application/json','x-trace-id':'trace-123'},body:'ORIGINAL-PAYLOAD',time:25,size:16,url:'https://example.com/final'};responseMode='Pretty';render()",
  );
  // Copies land in window.codegenCopied, so they can be checked.
  await run(
    "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.codegenCopied=value;}}})",
  );
  for (const tab of ['Headers', 'Tests', 'Timeline']) {
    await run(`responseTab=${JSON.stringify(tab)};responseMode='Pretty';render()`);
    assert.equal(
      await run(
        `Boolean(document.querySelector(${JSON.stringify(tab === 'Headers' ? '.response-headers-table' : tab === 'Tests' ? '.assertion-result' : '.response-timeline')}))`,
      ),
      true,
      `${tab} has a Pretty view`,
    );
    await run("document.querySelector('[data-mode=Raw]').click()");
    assert.equal(
      await run("Boolean(document.querySelector('#response-source-editor .cm-editor'))"),
      true,
      `${tab} has a read-only Raw editor`,
    );
    if (tab === 'Headers')
      assert.equal(
        await run('responseSourceEditor.getValue()'),
        'content-type: application/json\n' + 'x-trace-id: trace-123',
      );
    if (tab === 'Tests') {
      assert.equal(await run('JSON.parse(responseSourceEditor.getValue()).passed'), 1);
      assert.equal(await run('JSON.parse(responseSourceEditor.getValue()).failed'), 1);
    }
    if (tab === 'Timeline')
      assert.equal(await run('JSON.parse(responseSourceEditor.getValue()).totalDurationMs'), 25);
    await run("document.querySelector('[data-action=copy]').click()");
    assert.equal(
      await run('window.codegenCopied===responseSourceEditor.getValue()'),
      true,
      `${tab} copies its own data`,
    );
    await run(
      "window.captureDownload(()=>document.querySelector('[data-action=download]').click()).then(file=>{window.inspectorDownload=file;})",
    );
    assert.equal(
      await run('window.inspectorDownload.text===responseSourceEditor.getValue()'),
      true,
      `${tab} downloads its own data`,
    );
    await run("document.querySelector('[data-mode=Pretty]').click()");
    assert.equal(
      await run('current().response.body'),
      'ORIGINAL-PAYLOAD',
      'inspector modes preserve the response body',
    );
  }
  await run("current().tests='';responseTab='Tests';responseMode='Raw';render()");
  assert.equal(
    await run('JSON.parse(responseSourceEditor.getValue()).total'),
    0,
    'empty tests have valid Raw JSON',
  );
  await run(
    "Object.assign(current(),window.inspectorOriginal);responseTab='Body';responseMode='Pretty';render()",
  );
  await run(
    "window.failedTimelineOriginal=structuredClone(current());current().response={error:'Request cancelled or timed out.',timings:{startedAt:new Date().toISOString(),totalMs:20,preparationMs:1,requests:[{method:'GET',url:'https://example.com',startMs:1,durationMs:19,connectionReused:true,phases:[{id:'waiting',label:'Waiting for response',startMs:1,durationMs:19}]}]}};responseTab='Timeline';responseMode='Pretty';render()",
  );
  assert.equal(
    await run("Boolean(document.querySelector('.network-timing'))"),
    true,
    'failed requests retain a timing view',
  );
  await run("document.querySelector('[data-mode=Raw]').click()");
  assert.equal(await run('JSON.parse(responseSourceEditor.getValue()).timings.totalMs'), 20);
  await run(
    "Object.assign(current(),window.failedTimelineOriginal);responseTab='Body';responseMode='Pretty';render()",
  );
  assert.equal(
    await run("Boolean(document.querySelector('.initialization-screen'))"),
    false,
    'loading screen is removed when the workspace initializes',
  );
  await run("view='Documentation';render()");
  assert.equal(
    await run(
      "document.querySelectorAll('select[data-docs-collection] option').length===new Set(state.requests.map(request=>request.folder)).size",
    ),
    true,
    'documentation groups requests by collection',
  );
  assert.equal(
    await run(
      "document.querySelectorAll('.docs-endpoint').length===documentationRequests().length",
    ),
    true,
    'reference shows only selected collection',
  );
  assert.equal(
    await run(
      "[...document.querySelectorAll('.docs-endpoint summary .method')].every(badge=>badge.querySelector('.method-icon'))&&document.querySelectorAll('.docs-endpoint summary .method-icon').length===documentationRequests().length",
    ),
    true,
    'the docs request list shows method icons',
  );
  await run(
    "document.querySelector('select[data-docs-collection]').closest('.ui-select').querySelector('.ui-select-trigger').click()",
  );
  await run(
    "document.querySelector('select[data-docs-collection]').closest('.ui-select').querySelectorAll('[role=option]')[1].click()",
  );
  assert.equal(
    await run(
      "document.querySelector('.docs-heading h2').textContent===documentationState.collection",
    ),
    true,
    'collection selection updates documentation',
  );
  for (const mode of ['YAML', 'JSON', 'OpenAPI JSON', 'Swagger JSON']) {
    await run(`document.querySelector('[data-docs-mode="${mode}"]').click()`);
    assert.equal(
      await run("editorView('#documentation-source').state.readOnly"),
      true,
      `${mode} source is read-only`,
    );
    const source = await run('documentationEditor.getValue()');
    if (mode === 'YAML') assert.match(source, /openapi: 3.0.3/);
    else if (mode === 'JSON')
      assert.equal(JSON.parse(source).requests.length, await run('documentationRequests().length'));
    else
      assert.equal(
        JSON.parse(source)[mode === 'Swagger JSON' ? 'swagger' : 'openapi'],
        mode === 'Swagger JSON' ? '2.0' : '3.0.3',
      );
  }
  // Format tidies the generated source; Copy and Download then take the formatted text.
  await run('window.docsBeforeFormat=documentationEditor.getValue()');
  await run("document.querySelector('[data-docs-format]').click()");
  await pause(400);
  assert.equal(
    await run(
      'JSON.stringify(JSON.parse(documentationEditor.getValue()))===JSON.stringify(JSON.parse(window.docsBeforeFormat))',
    ),
    true,
    'formatting the documentation source keeps the same document',
  );
  await run("document.querySelector('[data-docs-copy]').click()");
  assert.equal(
    await run('window.codegenCopied===documentationEditor.getValue()'),
    true,
    'documentation copy matches selected source',
  );
  await run(
    "window.captureDownload(()=>document.querySelector('[data-docs-download]').click()).then(file=>{window.docsDownloaded=file;})",
  );
  assert.equal(
    await run(
      "window.docsDownloaded.name.endsWith('.swagger.json')&&window.docsDownloaded.text===documentationEditor.getValue()",
    ),
    true,
    'documentation downloads selected format',
  );
  assert.equal(
    await run(
      "(()=>{const actions=document.querySelector('.docs-actions');const select=document.querySelector('#docs-collection').closest('.ui-select').querySelector('.ui-select-trigger').getBoundingClientRect();const box=actions.getBoundingClientRect();return getComputedStyle(actions).borderBottomWidth==='0px'&&Math.abs(box.top+box.height/2-(select.top+select.height/2))<=4;})()",
    ),
    true,
    'the documentation actions line up with the collection select, without a divider',
  );
  await run("document.querySelector('[data-docs-mode=Swagger]').click()");
  assert.equal(
    await run("Boolean(document.querySelector('[data-docs-format]'))"),
    false,
    'the endpoint reference has nothing to format',
  );
  // Squeezed, the documentation formats scroll with arrows.
  await run(
    "document.querySelector('.docs-formats').closest('.ui-tabs-frame').style.width='200px'",
  );
  await pause(80);
  assert.equal(
    await tabsReachable('.docs-formats'),
    'reachable',
    'documentation formats that do not fit are reachable with the arrows',
  );
  await run("document.querySelector('.docs-formats').closest('.ui-tabs-frame').style.width=''");
  await run("document.querySelector('.docs-endpoint summary').click()");
  assert.equal(
    await run("document.querySelector('.docs-endpoint').open"),
    true,
    'reference operations expand',
  );
  await run("document.querySelector('.docs-endpoint [data-open]').click()");
  assert.equal(await run('view'), 'Collections', 'documented requests open in the API client');
  assert.equal(
    await run('documentationEditor'),
    undefined,
    'documentation editor is disposed when navigating away',
  );
  await run(
    "window.tabTestOriginal={tabs:[...state.tabs],active:state.active,recentTabs:state.recentTabs,closedTabs:state.closedTabs,view};window.tabTestRequests=state.requests.length;window.tabTestIds=state.requests.slice(0,4).map(request=>request.id);state.tabs=[...window.tabTestIds];state.active=window.tabTestIds[1];state.recentTabs=[];state.closedTabs=[];view='Collections';render()",
  );
  assert.equal(
    await run("document.querySelector('.add-tab').nextElementSibling.matches('.tab-menu-trigger')"),
    true,
    'three-dot menu follows the tab plus button',
  );
  await run("document.querySelector('.tab-menu-trigger').click()");
  assert.equal(
    await run("document.querySelector('#request-tab-menu').matches(':popover-open')"),
    true,
    'tab menu opens',
  );
  await run("document.querySelector('[data-tab-command=right]').click()");
  assert.equal(
    await run('JSON.stringify(state.tabs)===JSON.stringify(window.tabTestIds.slice(0,2))'),
    true,
    'close right keeps active and preceding tabs',
  );
  assert.equal(
    await run('state.requests.length===window.tabTestRequests'),
    true,
    'closing tabs keeps collection requests',
  );
  await run(
    "document.querySelector('.tab-menu-trigger').click();document.querySelector('[data-tab-command=left]').click()",
  );
  assert.equal(
    await run('state.tabs.length===1&&state.active===window.tabTestIds[1]'),
    true,
    'close left preserves active tab',
  );
  await run('openRequest(window.tabTestIds[0]);openRequest(window.tabTestIds[2])');
  await run(
    "document.querySelector('.tab-menu-trigger').click();document.querySelector('[data-tab-command=others]').click()",
  );
  assert.equal(
    await run('state.tabs.length===1&&state.tabs[0]===window.tabTestIds[2]'),
    true,
    'close others keeps active tab',
  );
  await run(
    "document.querySelector('.tab-menu-trigger').click();document.querySelector('[data-tab-command=all]').click()",
  );
  assert.equal(await run('state.tabs.length'), 0, 'close all clears tabs');
  assert.equal(await run('view'), 'Overview', 'close all displays Overview');
  assert.equal(
    await run("document.querySelector('.tabbar')===null"),
    true,
    'the request tab bar shows only in Collections',
  );
  await run("view='Collections';render()");
  await pause(80);
  assert.equal(
    await run('state.tabs.length===1&&state.tabs[0]===state.active'),
    true,
    'returning to Collections reopens the active request as a tab',
  );
  await run("document.querySelector('.tab-menu-trigger').click()");
  assert.equal(
    await run("document.querySelectorAll('[data-tab-reopen]').length>0"),
    true,
    'recent tabs remain available after closing all',
  );
  await run("document.querySelector('[data-tab-command=reopen]').click()");
  assert.equal(
    await run('state.tabs.length===2&&state.active===window.tabTestIds[2]'),
    true,
    'reopen restores most recently closed active tab',
  );
  await run(
    "document.querySelectorAll('[data-close]').forEach(button=>button.dataset.close===window.tabTestIds[2]&&button.click());document.dispatchEvent(new KeyboardEvent('keydown',{key:'T',ctrlKey:true,shiftKey:true,bubbles:true}))",
  );
  assert.equal(
    await run('state.active===window.tabTestIds[2]&&state.tabs.includes(window.tabTestIds[2])'),
    true,
    'Ctrl Shift T reopens a closed tab',
  );
  await run('openRequest(window.tabTestIds[0])');
  await run(
    "document.querySelector('.tab-menu-trigger').click();document.querySelector('[data-tab-command=previous]').click()",
  );
  assert.equal(
    await run('state.active===window.tabTestIds[2]'),
    true,
    'previous tab changes the active request',
  );
  await run(
    "document.querySelector('.tab-menu-trigger').click();document.querySelector('#request-tab-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  assert.equal(
    await run(
      "!document.querySelector('#request-tab-menu').matches(':popover-open')&&document.activeElement.matches('.tab-menu-trigger')",
    ),
    true,
    'Escape dismisses tab menu and restores focus',
  );
  await run(
    'Object.assign(state,{tabs:window.tabTestOriginal.tabs,active:window.tabTestOriginal.active,recentTabs:window.tabTestOriginal.recentTabs,closedTabs:window.tabTestOriginal.closedTabs});view=window.tabTestOriginal.view;render()',
  );
}
