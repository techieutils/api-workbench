import assert from 'node:assert/strict';
import { keychain, pause, type SmokeContext } from './harness';

/** UI smoke checks, part 4: rows bodies and code. */
export default async function rowsBodiesAndCode(context: SmokeContext) {
  const { run, capture, tabsReachable, rightClick } = context;
  // Query parameters edited in the table keep the URL in step.
  await run(
    "view='Collections';window.queryOriginal=structuredClone(current());current().url='https://example.com/items?existing=keep#section';current().params=[];requestTab='Params';render()",
  );
  await run(
    "(()=>{const key=document.querySelector('[data-type=params][data-field=key]');key.value='search';key.dispatchEvent(new Event('input'));const value=document.querySelector('[data-type=params][data-field=value]');value.value='a & b';value.dispatchEvent(new Event('input'));})()",
  );
  assert.equal(
    await run("document.querySelector('#url').value"),
    'https://example.com/items?existing=keep&search=a+%26+b#section',
    'parameter editing updates URL with encoded values',
  );
  assert.equal(
    await run("new URL(prepare(current()).url).searchParams.getAll('search').length"),
    1,
    'sending does not duplicate synchronized params',
  );
  await run(
    "(()=>{const key=document.querySelector('[data-type=params][data-field=key]');key.value='q';key.dispatchEvent(new Event('input'));})()",
  );
  assert.equal(
    await run("current().url.includes('search=')"),
    false,
    'renaming removes the old query key',
  );
  // Key-value rows: the row menu copies, duplicates, and deletes, keeping the URL in step.
  await run(
    "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.rowCopied=value;}}})",
  );
  const paramRow = (index: number) => `[data-order-index="${index}"][data-order-type="params"]`;
  await rightClick(paramRow(0));
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-row-menu=params] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
    ),
    'toggle,above,below,duplicate,up-,down-,copy-key,copy-value,copy-row,delete',
    'right-clicking a parameter row lists its actions',
  );
  await run("document.querySelector('[data-row-menu=params] [data-menu-item=copy-row]').click()");
  await pause(30);
  assert.equal(await run('window.rowCopied'), 'q=a & b', 'Copy as key=value copies the row');
  await rightClick(paramRow(0));
  await run("document.querySelector('[data-row-menu=params] [data-menu-item=duplicate]').click()");
  await pause(50);
  assert.deepEqual(
    await run(
      "({params:current().params.length,inUrl:new URL(current().url).searchParams.getAll('q').length,focus:document.activeElement.classList.contains('kv-field-label')&&document.activeElement.closest('tr').dataset.orderIndex==='1'&&document.activeElement.parentElement.querySelector('input').dataset.field==='key'})",
    ),
    { params: 2, inUrl: 2, focus: true },
    'Duplicate row adds a copy below, updates the URL, and focuses its key',
  );
  await rightClick(paramRow(1));
  await run("document.querySelector('[data-row-menu=params] [data-menu-item=delete]').click()");
  await pause(50);
  assert.equal(
    await run(
      "current().params.length===1&&new URL(current().url).searchParams.getAll('q').length===1",
    ),
    true,
    'Delete row from the menu removes it from the URL too',
  );
  await run(
    'document.querySelector(\'[data-type=params][data-row="0"][data-field=enabled]\').click()',
  );
  assert.equal(
    await run("new URL(current().url).searchParams.has('q')"),
    false,
    'disabling removes a query parameter from URL',
  );
  await run(
    'document.querySelector(\'[data-type=params][data-row="0"][data-field=enabled]\').click();document.querySelector(\'[data-delete="0"][data-type=params]\').click()',
  );
  assert.equal(
    await run('current().url'),
    'https://example.com/items?existing=keep#section',
    'deleting preserves unrelated query entries and fragment',
  );
  await run(
    "current().params=[{key:'tag',value:'one',enabled:true},{key:'tag',value:'two',enabled:true},{key:'env',value:'{{base_url}}',enabled:true}];render()",
  );
  assert.equal(
    await run("new URL(prepare(current()).url).searchParams.getAll('tag').join(',')"),
    'one,two',
    'duplicate query keys survive synchronization',
  );
  assert.equal(
    await run("current().url.includes('{{base_url}}')"),
    true,
    'URL retains readable variable references',
  );
  await run('Object.assign(current(),window.queryOriginal);render()');
  for (const type of ['params', 'headers']) {
    await run(
      `window.scrollSavedRequest=structuredClone(current());requestTab='${type === 'params' ? 'Params' : 'Headers'}';current().${type}=Array.from({length:40},(_,index)=>({key:'row'+index,value:'value',enabled:true}));render()`,
    );
    await run(
      `document.querySelector('#request-panel').scrollTop=400;window.beforeRowDeleteScroll=document.querySelector('#request-panel').scrollTop;document.querySelector('[data-type=${type}][data-delete="15"]').click()`,
    );
    assert.equal(
      await run('window.beforeRowDeleteScroll>0'),
      true,
      `${type}: regression uses a scrolled panel`,
    );
    assert.equal(
      await run("document.querySelector('#request-panel').scrollTop"),
      await run('window.beforeRowDeleteScroll'),
      `${type}: row deletion preserves panel scroll`,
    );
    assert.equal(await run(`current().${type}.length`), 39, `${type}: row is removed`);
    await run(
      `document.querySelector('#request-panel').scrollTop=400;window.beforeRowMoveScroll=document.querySelector('#request-panel').scrollTop;document.querySelector('[data-row-order="15"][data-order-type=${type}]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true}))`,
    );
    assert.equal(
      await run("document.querySelector('#request-panel').scrollTop"),
      await run('window.beforeRowMoveScroll'),
      `${type}: reordering preserves panel scroll`,
    );
    assert.equal(
      await run(`current().${type}[14].key`),
      'row16',
      `${type}: Arrow Up moves the intended saved row`,
    );
    await run('Object.assign(current(),window.scrollSavedRequest);render()');
  }
  for (const type of ['params', 'headers', 'variables']) {
    await run(
      `window.checkboxSavedRows=structuredClone(${type === 'variables' ? 'state.environments[state.environment].variables' : `current().${type}`});${type === 'variables' ? "view='Environments';state.environments[state.environment].variables=[]" : `view='Collections';requestTab='${type === 'params' ? 'Params' : 'Headers'}';current().${type}=[]`};render()`,
    );
    const rowsExpression =
      type === 'variables'
        ? 'state.environments[state.environment].variables'
        : `current().${type}`;
    await run(`document.querySelector('[data-type=${type}][data-field=enabled]').click()`);
    assert.equal(
      await run(`${rowsExpression}.length`),
      0,
      `${type}: toggling the trailing checkbox does not create a stored row`,
    );
    assert.equal(
      await run(`document.querySelectorAll('[data-type=${type}][data-field=key]').length`),
      1,
      `${type}: checkbox does not append a row`,
    );
    await run(
      `(()=>{const input=document.querySelector('[data-type=${type}][data-field=key]');input.value='checkbox-test';input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    assert.equal(
      await run(`${rowsExpression}[0].enabled`),
      false,
      `${type}: typing retains the draft checkbox state`,
    );
    assert.equal(
      await run(`document.querySelectorAll('[data-type=${type}][data-field=key]').length`),
      2,
      `${type}: text entry creates a single trailing row`,
    );
    await run(
      `document.querySelector('[data-type=${type}][data-row="0"][data-field=enabled]').click()`,
    );
    assert.equal(
      await run(`${rowsExpression}[0].enabled`),
      true,
      `${type}: existing checkbox updates normally`,
    );
    assert.equal(
      await run(`${rowsExpression}.length`),
      1,
      `${type}: existing checkbox does not create rows`,
    );
    await run(`${rowsExpression}=window.checkboxSavedRows;view='Collections';render()`);
  }
  for (const type of ['params', 'headers']) {
    await run(
      `requestTab=${JSON.stringify(type === 'params' ? 'Params' : 'Headers')};current()[${JSON.stringify(type)}]=[];render()`,
    );
    await run(
      `(()=>{const input=document.querySelector('[data-type="${type}"][data-row="0"][data-field="key"]');input.parentElement.querySelector('.kv-field-label').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));input.value='X-Test';input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    assert.equal(
      await run(`document.querySelectorAll('[data-type="${type}"][data-field="key"]').length`),
      2,
      'typing creates a trailing row',
    );
    assert.equal(await run('document.activeElement.dataset.row'), '0', 'typing retains focus');
    await run(
      `(()=>{const input=document.querySelector('[data-type="${type}"][data-row="0"][data-field="description"]');input.value='Request metadata';input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await run("document.querySelector('[data-action=bulk-open]').click()");
    await run(
      `document.querySelector('#bulk-rows').value=${JSON.stringify('X-Test: https://example.com:8443/path\n// X-Disabled: no\nX-Test: second')};document.querySelector('#bulk-rows').dispatchEvent(new Event('input'));document.querySelector('[data-action=bulk-apply]').click()`,
    );
    assert.equal(
      await run(`current()[${JSON.stringify(type)}][0].value`),
      'https://example.com:8443/path',
    );
    assert.equal(
      await run(`current()[${JSON.stringify(type)}][0].description`),
      'Request metadata',
    );
    assert.equal(await run(`current()[${JSON.stringify(type)}][1].enabled`), false);
    assert.equal(await run(`current()[${JSON.stringify(type)}].length`), 3);
    await run("document.querySelector('[data-action=bulk-open]').click()");
    await run(
      "document.querySelector('#bulk-rows').value='invalid line';document.querySelector('#bulk-rows').dispatchEvent(new Event('input'));document.querySelector('[data-action=bulk-apply]').click()",
    );
    assert.equal(
      await run(`current()[${JSON.stringify(type)}].length`),
      3,
      'invalid bulk draft preserves existing rows',
    );
    assert.equal(await run("Boolean(document.querySelector('[role=alert]'))"), true);
    await run("document.querySelector('[data-action=bulk-cancel]').click()");
  }
  for (const type of ['headers', 'params']) {
    await run(
      `window.orderSaved=structuredClone(current());window.orderAutoHeaders=automaticHeaderVisibility.expanded;view='Collections';requestTab=${JSON.stringify(type === 'headers' ? 'Headers' : 'Params')};current().url='https://example.com/ordered?keep=yes#fragment';current().params=[];current()[${JSON.stringify(type)}]=[{key:'item',value:'first',enabled:true,description:'First description'},{key:'disabled',value:'skip',enabled:false,description:'Disabled description'},{key:'item',value:'last',enabled:true,description:'Last description'}];automaticHeaderVisibility.expanded=true;render()`,
    );
    assert.equal(
      await run("document.querySelectorAll('[data-row-order]').length"),
      3,
      `${type}: saved rows have handles; trailing draft and automatic headers do not`,
    );
    await run(
      `document.querySelector('[data-row-order="0"][data-order-type=${type}]').focus();document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))`,
    );
    assert.equal(
      await run(`current()[${JSON.stringify(type)}].map(row=>row.value).join(',')`),
      'skip,last,first',
      `${type}: keyboard moves a row to the end`,
    );
    assert.equal(
      await run('document.activeElement.dataset.rowOrder'),
      '2',
      'focus follows the moved row',
    );
    assert.equal(
      await run(
        `current()[${JSON.stringify(type)}][0].enabled===false&&current()[${JSON.stringify(type)}][2].description==='First description'`,
      ),
      true,
      'reordering preserves descriptions and enabled state',
    );
    if (type === 'params')
      assert.equal(
        await run('current().url'),
        'https://example.com/ordered?keep=yes&item=last&item=first#fragment',
        'query order follows row order with duplicate keys, disabled values, existing query and fragment',
      );
    await run(
      `(()=>{const handle=document.querySelector('[data-row-order="2"]');window.rowDragTransfer=new DataTransfer();handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:window.rowDragTransfer}));const row=document.querySelector('[data-order-index="0"][data-order-type=${type}]');const y=row.getBoundingClientRect().top+1;row.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:window.rowDragTransfer,clientY:y}));row.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:window.rowDragTransfer,clientY:y}));})()`,
    );
    assert.equal(
      await run(`current()[${JSON.stringify(type)}].map(row=>row.value).join(',')`),
      'first,skip,last',
      `${type}: drag and drop moves the last row before the first`,
    );
    assert.equal(
      await run(
        "window.rowDragTransfer.types.includes('text/plain')||window.rowDragTransfer.getData('application/x-api-workbench-row')!=='move'",
      ),
      false,
      'drag payload excludes header and parameter values',
    );
    assert.equal(
      await run(
        "document.querySelectorAll('.row-dragging,.row-drop-before,.row-drop-after').length",
      ),
      0,
      'drop clears all indicators',
    );
    if (type === 'headers')
      assert.equal(
        await run(
          "document.querySelector('#request-header-rows').firstElementChild.classList.contains('automatic-header-row')",
        ),
        true,
        'automatic headers stay pinned above reordered custom headers',
      );
    await run(
      `(()=>{const handle=document.querySelector('[data-row-order="0"]');handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:new DataTransfer()}));handle.dispatchEvent(new DragEvent('dragend',{bubbles:true}));})()`,
    );
    assert.equal(
      await run(`current()[${JSON.stringify(type)}][0].value`),
      'first',
      'cancelled drag leaves order unchanged',
    );
    await run(
      `(()=>{const handle=document.querySelector('[data-row-order="0"]'), transfer=new DataTransfer();handle.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:transfer}));const row=document.querySelector('[data-order-index="3"]');row.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:transfer,clientY:row.getBoundingClientRect().bottom-1}));})()`,
    );
    assert.equal(
      await run(`current()[${JSON.stringify(type)}].map(row=>row.value).join(',')`),
      'skip,last,first',
      `${type}: dropping on the trailing draft moves to the end without creating rows`,
    );
    await run(
      `(()=>{const input=document.querySelector('[data-type=${type}][data-row="3"][data-field=key]');input.value='new-row';input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    assert.equal(
      await run("document.querySelectorAll('[data-row-order]').length"),
      4,
      'typing into the draft creates a working reorder handle',
    );
    await run(
      "document.querySelector('[data-row-order=\"3\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}))",
    );
    assert.equal(
      await run(`current()[${JSON.stringify(type)}][0].key`),
      'new-row',
      'newly added rows can move immediately',
    );
    await run(
      `document.querySelector('[data-type=${type}][data-row="0"][data-field=value]').value='updated';document.querySelector('[data-type=${type}][data-row="0"][data-field=value]').dispatchEvent(new Event('input',{bubbles:true}))`,
    );
    assert.equal(
      await run(`current()[${JSON.stringify(type)}][0].value`),
      'updated',
      'editing uses updated indices after a move',
    );
    assert.equal(
      await run(
        `persistedWorkspace().requests.find(request=>request.id===state.active)[${JSON.stringify(type)}][0].key`,
      ),
      'new-row',
      'saved workspace retains row order',
    );
    await run(
      'Object.assign(current(),window.orderSaved);automaticHeaderVisibility.expanded=window.orderAutoHeaders;render()',
    );
  }
  const yamlDocument = await run(
    `window.workbench.parseImportDocument(${JSON.stringify('swagger: "2.0"\ninfo:\n  title: Imported YAML\npaths:\n  /health:\n    get:\n      summary: Health')})`,
  );
  assert.equal(yamlDocument.swagger, '2.0', 'YAML specifications parse through the desktop bridge');
  await run(`importCollection(${JSON.stringify(yamlDocument)})`);
  assert.equal(await run('state.requests.at(-1).url'), 'https://{{host}}/health');
  assert.equal(
    await run(
      "(async()=>{const count=state.requests.length;try{await importCollection({openapi:'3.0.0',paths:{'/ok':{get:{}},'/broken':{get:{parameters:[{$ref:'#/missing'}]}}}});return false;}catch{return count===state.requests.length;}})()",
    ),
    true,
    'invalid specification imports are atomic',
  );
  await run("requestTab='Body';current().method='POST';render()");
  assert.equal(
    await run("document.querySelectorAll('[data-body-type]').length"),
    5,
    'all request body modes are available',
  );
  await run("document.querySelector('[data-body-type=raw]').click()");
  await run(
    "document.querySelector('#raw-content-type').value='application/xml';document.querySelector('#raw-content-type').dispatchEvent(new Event('change'));document.querySelector('#body').value='<message>Hello</message>';document.querySelector('#body').dispatchEvent(new Event('input'));document.querySelector('#body').focus()",
  );
  assert.equal(await run("prepare(current()).headers['Content-Type']"), 'application/xml');
  assert.equal(await run('prepare(current()).body'), '<message>Hello</message>');
  // Squeezed, the body types and the raw editor's tools scroll with arrows.
  for (const row of ['.body-modes', '.body-format-row']) {
    await run(`document.querySelector('${row}').closest('.ui-tabs-frame').style.width='180px'`);
    await pause(80);
    assert.equal(await tabsReachable(row), 'reachable', `${row} is reachable with the arrows`);
    await run(`document.querySelector('${row}').closest('.ui-tabs-frame').style.width=''`);
  }
  assert.equal(
    await run("getComputedStyle(document.querySelector('#body')).outlineStyle"),
    'none',
    'body focus uses an inset indicator',
  );
  await run("document.querySelector('[data-body-type=none]').click()");
  assert.equal(await run('prepare(current()).body'), '', 'none omits the saved raw body');
  await run(
    "document.querySelector('[data-body-type=x-www-form-urlencoded]').click();current().bodyFields=[{key:'tag',value:'a & b',enabled:true},{key:'tag',value:'two',enabled:true},{key:'skip',value:'ignored',enabled:false}];render()",
  );
  assert.equal(await run('prepare(current()).body'), 'tag=a+%26+b&tag=two');
  assert.equal(
    await run("prepare(current()).headers['Content-Type']"),
    'application/x-www-form-urlencoded',
  );
  await run(
    "document.querySelector('[data-body-type=form-data]').click();current().bodyFields=[{key:'attachment',value:'',kind:'file',enabled:true}];render()",
  );
  await run(
    "(async()=>{const input=document.querySelector('[data-body-file]');const transfer=new DataTransfer();transfer.items.add(new File(['UPLOAD-CONTENT'], 'sample.txt', {type:'text/plain'}));input.files=transfer.files;input.dispatchEvent(new Event('change'));while(!current().bodyFields[0].fileName)await new Promise(resolve=>setTimeout(resolve,10));})()",
  );
  assert.equal(await run('prepare(current()).multipart[0].file.name'), 'sample.txt');
  assert.equal(
    await run(
      "Object.keys(prepare(current()).headers).some(key=>key.toLowerCase()==='content-type')",
    ),
    false,
    'multipart header boundary is generated by the HTTP client',
  );
  assert.equal(
    await run("JSON.stringify(persistedWorkspace()).includes('VVBMT0FELUNPTlRFTlQ=')"),
    false,
    'upload bytes are never persisted',
  );
  await run("document.querySelector('[data-body-type=binary]').click()");
  await run(
    "(async()=>{const input=document.querySelector('#binary-file');const transfer=new DataTransfer();transfer.items.add(new File([new Uint8Array([0,255,128])], 'sample.bin', {type:'application/octet-stream'}));input.files=transfer.files;input.dispatchEvent(new Event('change'));while(!uploadFiles.has(current().id))await new Promise(resolve=>setTimeout(resolve,10));})()",
  );
  assert.equal(await run('prepare(current()).binary.base64'), 'AP+A');
  await run("requestTab='Headers';current().headers=[];render()");
  assert.equal(
    await run("Boolean(document.querySelector('.automatic-header-row'))"),
    false,
    'automatic headers are hidden initially',
  );
  assert.equal(await run("prepare(current()).headers['User-Agent']"), 'API-Workbench/1.0');
  assert.equal(await run('prepare(current()).headers.Connection'), 'keep-alive');
  // Squeezed, the headers actions scroll with arrows.
  await run(
    "document.querySelector('.table-actions').closest('.ui-tabs-frame').style.width='160px'",
  );
  await pause(80);
  assert.equal(
    await tabsReachable('.table-actions'),
    'reachable',
    'header actions that do not fit are reachable with the arrows',
  );
  await run("document.querySelector('.table-actions').closest('.ui-tabs-frame').style.width=''");
  await run("document.querySelector('[data-action=toggle-automatic-headers]').click()");
  assert.equal(
    await run(
      "Array.from(document.querySelectorAll('.automatic-header-row')).some(row=>row.textContent.includes('Accept-Encoding'))",
    ),
    true,
    'visibility control reveals automatic headers',
  );
  assert.equal(
    await run("document.querySelectorAll('#request-panel .kv-table').length"),
    1,
    'custom and automatic headers share a single table',
  );
  assert.equal(
    await run(
      "(async()=>{const previousDensity=state.settings.density;const previousHeaders=current().headers;const previousParams=current().params;try{for(const density of ['comfortable','compact']){state.settings.density=density;current().headers=[{key:'X-Row',value:'custom value',enabled:true}];requestTab='Headers';render();await new Promise(resolve=>WorkbenchShell.afterUpdate(resolve));const heights=Array.from(document.querySelectorAll('#request-header-rows > tr')).map(row=>row.getBoundingClientRect().height);if(heights.some(height=>Math.abs(height-heights[0])>1))return false;const height=heights[0];const key=document.querySelector('[data-type=headers][data-field=key]');key.parentElement.querySelector('.kv-field-label').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));await new Promise(resolve=>WorkbenchShell.afterUpdate(resolve));if(Math.abs(key.closest('tr').getBoundingClientRect().height-height)>1)return false;current().params=[{key:'page',value:'1',enabled:true}];requestTab='Params';render();await new Promise(resolve=>WorkbenchShell.afterUpdate(resolve));if(Math.abs(document.querySelector('#request-panel tbody tr').getBoundingClientRect().height-height)>1)return false;}return true;}finally{state.settings.density=previousDensity;current().headers=previousHeaders;current().params=previousParams;requestTab='Headers';render();}})()",
    ),
    true,
    'automatic headers, custom headers, params, and editors share row heights in both densities',
  );

  assert.equal(
    await run(
      "document.querySelector('.automatic-header-row').closest('tbody')===document.querySelector('[data-type=headers][data-field=key]').closest('tbody')",
    ),
    true,
    'automatic rows share the custom header table body',
  );
  assert.equal(
    await run(
      "document.querySelector('#request-header-rows').firstElementChild.classList.contains('automatic-header-row')",
    ),
    true,
    'automatic headers appear first',
  );
  await run(
    "document.querySelector('[data-auto-header-value=Accept]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  await run(
    "document.querySelector('.automatic-header-value-input').value='application/edited';document.querySelector('.automatic-header-value-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
  );
  assert.equal(
    await run('prepare(current()).headers.Accept'),
    'application/edited',
    'double-click edits create a custom override',
  );
  await run(
    "document.querySelector('[data-auto-header-value=Connection]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  await run(
    "document.querySelector('.automatic-header-value-input').value='close';document.querySelector('.automatic-header-value-input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  assert.equal(
    await run('prepare(current()).headers.Connection'),
    'keep-alive',
    'Escape cancels automatic header editing',
  );
  await run("current().headers=[{key:'aCcEpT',value:'application/custom',enabled:true}];render()");
  assert.equal(
    await run(
      "Object.entries(prepare(current()).headers).filter(([key])=>key.toLowerCase()==='accept').length",
    ),
    1,
    'custom header overrides automatic header without case duplicates',
  );
  assert.equal(await run('prepare(current()).headers.aCcEpT'), 'application/custom');
  assert.equal(
    await run(
      "Array.from(document.querySelectorAll('.automatic-header-row code')).some(node=>node.textContent==='Accept')",
    ),
    false,
    'overridden defaults disappear from automatic list',
  );
  await run("document.querySelector('[data-action=toggle-automatic-headers]').click()");
  await run("requestTab='Headers';render()");
  await run(
    "document.querySelector('[data-field=key]').parentElement.querySelector('.kv-field-label').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  assert.equal(
    await run("document.querySelectorAll('#kv-suggestion-list [role=option]').length>50"),
    true,
    'header names have extensive suggestions',
  );
  await run(
    "(()=>{const input=document.querySelector('[data-field=key]');input.value='Content-Type';input.dispatchEvent(new Event('input'));})()",
  );
  await run(
    "document.querySelector('[data-field=value]').parentElement.querySelector('.kv-field-label').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  assert.equal(
    await run(
      "Array.from(document.querySelectorAll('#kv-suggestion-list strong')).some(option=>option.textContent==='application/json')",
    ),
    true,
    'header value suggestions follow the header name',
  );
  await run(
    "(()=>{const input=document.querySelector('[data-field=value]');input.value='application/custom';input.dispatchEvent(new Event('input'));})()",
  );
  assert.equal(
    await run('current().headers[0].value'),
    'application/custom',
    'header inputs accept custom text',
  );
  await run("requestTab='Headers';render()");
  assert.equal(
    await run("getComputedStyle(document.querySelector('[data-field=key]')).display"),
    'none',
    'headers display labels until double-clicked',
  );
  await run(
    "document.querySelector('[data-field=key]').parentElement.querySelector('.kv-field-label').click()",
  );
  assert.equal(
    await run("getComputedStyle(document.querySelector('[data-field=key]')).display"),
    'none',
    'single click keeps the label view',
  );
  for (const field of ['key', 'value']) {
    await run(
      `(()=>{const label=document.querySelector('[data-field=${field}]').parentElement.querySelector('.kv-field-label');label.click();label.focus();label.dispatchEvent(new KeyboardEvent('keydown',{key:'a',bubbles:true}));})()`,
    );
    assert.equal(
      await run(
        `(()=>{const input=document.querySelector('[data-field=${field}]');const style=getComputedStyle(input.parentElement.querySelector('.kv-field-label'));return !input.parentElement.classList.contains('is-editing')&&style.boxShadow==='none'&&style.outlineStyle==='none';})()`,
      ),
      true,
      `${field}: letter keys keep label view without a focus border`,
    );
  }

  await run(
    "document.querySelector('[data-field=key]').parentElement.querySelector('.kv-field-label').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  assert.equal(
    await run(
      "document.activeElement.matches('[data-field=key]')&&Boolean(document.querySelector('#kv-suggestion-list'))",
    ),
    true,
    'double-clicking label opens focused text field and selector',
  );
  assert.equal(
    await run(
      "(()=>{const input=document.querySelector('[data-field=key]');return getComputedStyle(input.parentElement).boxShadow==='none'&&getComputedStyle(input).outlineStyle==='none'&&getComputedStyle(input).borderTopWidth==='0px'&&getComputedStyle(input.closest('td')).boxShadow!=='none';})()",
    ),
    true,
    'editing uses one cell focus border without nested outlines',
  );

  await run("document.querySelector('[data-field=key]').dispatchEvent(new FocusEvent('blur'))");
  assert.equal(
    await run("getComputedStyle(document.querySelector('[data-field=key]')).display"),
    'none',
    'blur returns to label view',
  );
  await run(
    "document.querySelector('[data-field=key]').parentElement.querySelector('.kv-field-label').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));document.querySelector('[data-field=value]').parentElement.querySelector('.kv-field-label').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  assert.equal(
    await run("document.querySelectorAll('.kv-combobox.is-editing').length"),
    1,
    'only the clicked cell shows an editor',
  );
  await run(
    "document.querySelector('.table-label').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))",
  );
  assert.equal(
    await run("document.querySelectorAll('.kv-combobox.is-editing').length"),
    0,
    'clicking outside restores label view',
  );

  await run("requestTab='Params';current().params=[];render()");
  await run(
    "document.querySelector('[data-field=key]').parentElement.querySelector('.kv-field-label').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));document.querySelector('[data-field=key]').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));document.querySelector('[data-field=key]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
  );
  assert.equal(
    await run('current().params[0].key'),
    'page',
    'keyboard selects a parameter suggestion',
  );
  assert.equal(
    await run("document.querySelectorAll('[data-type=params][data-field=key]').length"),
    2,
    'selecting a suggestion adds an empty trailing row',
  );
  assert.equal(
    await run("document.activeElement.classList.contains('kv-field-label')"),
    true,
    'selection returns focus to the value label',
  );
  await run(
    "document.querySelector('[data-field=value]').parentElement.querySelector('.kv-field-label').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  assert.equal(
    await run(
      "Array.from(document.querySelectorAll('#kv-suggestion-list strong')).some(option=>option.textContent==='1')",
    ),
    true,
    'parameter values follow the selected name',
  );
  assert.equal(
    await run(
      "(()=>{const popup=document.querySelector('#kv-suggestion-list');const rect=popup.getBoundingClientRect();return popup.matches(':popover-open')&&popup.parentElement===document.body&&rect.left>=0&&rect.right<=innerWidth;})()",
    ),
    true,
    'suggestions use an unclipped, viewport constrained popover',
  );
  await run("document.querySelector('#kv-suggestion-list [role=option]').click()");
  assert.equal(
    await run('current().params[0].value'),
    '1',
    'pointer selection updates the request value',
  );
  for (const theme of ['light', 'dark']) {
    await run(
      `applyTheme(${JSON.stringify(theme)});Promise.all(Array.from(document.images, image => image.decode()))`,
    );
    assert.equal(
      await run(
        `getComputedStyle(document.querySelector('.brand-lockup .theme-art-${theme}')).display !== 'none' && getComputedStyle(document.querySelector('.brand-lockup .theme-art-${theme === 'light' ? 'dark' : 'light'}')).display === 'none'`,
      ),
      true,
      `${theme} header shows matching artwork`,
    );
    assert.equal(
      await run(
        `Array.from(document.querySelectorAll('link[rel="icon"]')).every(link => link.href.includes('favicon-${theme}-'))`,
      ),
      true,
      `${theme} favicons follow appearance`,
    );

    await run(
      `state.settings.theme=${JSON.stringify(theme)};render();document.querySelector('[data-field=value]').parentElement.querySelector('.kv-field-label').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`,
    );
    assert.equal(
      await run(
        "(()=>{const input=document.querySelector('[data-field=value]');const option=document.querySelector('.kv-suggestion-option.is-current strong');const a=getComputedStyle(input),b=getComputedStyle(option);return a.color===b.color&&a.webkitTextFillColor===a.color&&a.opacity==='1';})()",
      ),
      true,
      `${theme} selected values keep the same readable text color`,
    );
  }
  await run(
    "document.querySelector('[data-field=value]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  assert.equal(
    await run("Boolean(document.querySelector('#kv-suggestion-list'))"),
    false,
    'Escape dismisses suggestions',
  );
  await run("requestTab='Auth';render()");
  await run("document.querySelector('#auth').focus()");
  assert.equal(
    await run("getComputedStyle(document.querySelector('#auth')).outlineStyle"),
    'none',
    'authentication field focus uses an inset indicator',
  );
  await run("current().method='GET';current().bodyType='none';render()");
  await run(
    "requestTab='Body';current().bodyType='raw';current().method='POST';current().body='{\"password\":\"BODY-CODEGEN-SECRET\",\"name\":\"Example\"}';current().headers=[{key:'Authorization',value:'Basic INLINE-CODEGEN-SECRET',enabled:true}];render();openCodeGenerator()",
  );
  assert.equal(
    await run(
      "Boolean(document.querySelector('.code-dock .codegen-panel[role=region]'))&&!document.querySelector('.codegen-modal')",
    ),
    true,
    'Code opens as a panel by default',
  );
  assert.equal(await run("document.querySelectorAll('#code-language option').length>=25"), true);
  assert.equal(await run("codeDialog.result.code.startsWith('curl')"), true);
  assert.equal(
    await run(
      "JSON.stringify(codeDialog.result).includes('INLINE-CODEGEN-SECRET')||JSON.stringify(codeDialog.result).includes('BODY-CODEGEN-SECRET')",
    ),
    false,
    'codegen redacts common secrets',
  );
  assert.equal(
    await run("codeDialog.result.code.includes('Basic <REDACTED>')"),
    true,
    'redaction preserves the auth scheme',
  );
  await run(
    "document.querySelector('#code-language').value='node';document.querySelector('#code-language').dispatchEvent(new Event('change'));updateCodeGeneration()",
  );
  assert.equal(
    await run("document.querySelectorAll('#code-library option').length>=8"),
    true,
    'Node offers multiple libraries',
  );
  await run(
    "document.querySelector('#code-library').value='native-fetch';document.querySelector('#code-library').dispatchEvent(new Event('change'));updateCodeGeneration()",
  );
  assert.equal(await run("codeDialog.result.code.includes('await fetch')"), true);
  await run(
    "Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.codegenCopied=value;}}});document.querySelector('[data-code-copy]').click()",
  );
  assert.equal(
    await run('window.codegenCopied===codeDialog.result.code'),
    true,
    'copy uses the displayed snippet',
  );
  // Format tidies JavaScript snippets; Copy then takes the formatted code.
  await pause(600);
  for (let attempt = 0; attempt < 40 && (await run('codeDialog.loading')); attempt++)
    await pause(50);
  await run(
    "window.codegenRaw=codeDialog.result.code;document.querySelector('[data-code-format]').click()",
  );
  await pause(400);
  await run("document.querySelector('[data-code-copy]').click()");
  await pause(50);
  assert.deepEqual(
    await run(
      "[window.codegenCopied===document.querySelector('.codegen-source').textContent,window.codegenCopied!==window.codegenRaw,window.codegenCopied.includes('await fetch')]",
    ),
    [true, true, true],
    'Format tidies the generated code, and Copy takes the formatted code',
  );
  // The generated code's context menu: copy it, select it, download it, or toggle redaction.
  // The docked panel regenerates shortly after edits; let any pending update land first.
  await pause(600);
  for (let attempt = 0; attempt < 40 && (await run('codeDialog.loading')); attempt++)
    await pause(50);
  const codeMenuIds = () =>
    run(
      "[...document.querySelectorAll('[data-code-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
    ) as Promise<string>;
  await rightClick('.codegen-source');
  assert.equal(
    await codeMenuIds(),
    'copy,copy-selection-,select-all,format,download,redact',
    'right-clicking generated code lists its actions',
  );
  await run("document.querySelector('[data-code-menu] [data-menu-item=select-all]').click()");
  await pause(30);
  assert.equal(
    await run(
      "getSelection().toString().trim()===document.querySelector('.codegen-source').textContent.trim()",
    ),
    true,
    'Select all selects the generated code',
  );
  // The live panel can regenerate (and replace) the code at any time, so the selection is made
  // just before the menu opens; Shift+F10 keeps it, where a right-click could move it.
  await run(
    "(()=>{const code=document.querySelector('.codegen-source');const range=document.createRange();range.selectNodeContents(code);getSelection().removeAllRanges();getSelection().addRange(range)})()",
  );
  await run(
    "(()=>{const code=document.querySelector('.codegen-source');code.focus();code.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))})()",
  );
  await pause(30);
  assert.match(
    await codeMenuIds(),
    /copy-selection,/,
    'Copy selection is offered once code is selected',
  );
  await run(
    "window.codegenCopied='';document.querySelector('[data-code-menu] [data-menu-item=copy-selection]').click()",
  );
  await pause(30);
  assert.equal(
    await run(
      "window.codegenCopied.trim()===document.querySelector('.codegen-source').textContent.trim()",
    ),
    true,
    'Copy selection copies the selected code',
  );
  await run('getSelection().removeAllRanges()');
  await run(
    "window.captureDownload(()=>document.querySelector('[data-code-download]').click()).then(file=>{window.codegenDownload=file;})",
  );
  assert.equal(await run('window.codegenDownload.name'), 'request.js');
  assert.equal(
    await run(
      "window.codegenDownload.text===document.querySelector('.codegen-source').textContent",
    ),
    true,
  );
  await run(
    "document.querySelector('#code-redact').checked=false;document.querySelector('#code-redact').dispatchEvent(new Event('change'));updateCodeGeneration()",
  );
  assert.equal(
    await run("codeDialog.result.code.includes('INLINE-CODEGEN-SECRET')"),
    true,
    'inline credential inclusion is explicit',
  );
  await run("document.querySelector('[data-code-close]').click()");
  assert.equal(
    await run("Boolean(document.querySelector('.code-dock'))"),
    false,
    'Close hides the docked code generator',
  );
  assert.equal(
    await run('document.activeElement.dataset.action'),
    'code',
    'focus returns to the trigger',
  );
  await run(
    "current().auth='Saved credential';current().credentialId='not-loaded';openCodeGenerator()",
  );
  assert.equal(
    await run("codeDialog.result.code.includes('<SAVED_CREDENTIAL>')"),
    false,
    'redaction replaces unknown saved references with placeholders',
  );
  assert.equal(keychain.checks, 0, 'code generation does not unlock the vault');
  await run(
    "closeCodeGenerator();current().auth='None';current().credentialId=undefined;current().method='GET';current().bodyType='none';render()",
  );
  await run("document.querySelector('[data-view=Settings]').click()");
  assert.equal(
    await run("document.querySelector('.settings-content h2').textContent"),
    'Workspace preferences',
  );
  await run(
    "userInput('[name=workspaceName]','Platform Engineering');document.querySelector('#settings-form').requestSubmit()",
  );
  assert.equal(await run('settings().workspaceName'), 'Platform Engineering');
  await run('Promise.all(Array.from(document.images, image => image.decode()))');
  assert.equal(
    await run("getComputedStyle(document.querySelector('.wordmark-light')).display"),
    'none',
    'dark theme uses its matching wordmark',
  );
  await capture('settings-dark.png');
  await run("document.querySelector('[data-settings-section=Appearance]').click()");
  await pause(80);
  assert.equal(
    await run(
      "(()=>{const rows=[...document.querySelectorAll('.settings-content .setting-row')];const icons=rows.map(row=>row.querySelector('.setting-icon .mdi-icon'));const row=rows[0].getBoundingClientRect(),icon=rows[0].querySelector('.setting-icon').getBoundingClientRect(),control=rows[0].querySelector('.setting-control').getBoundingClientRect();return rows.length>=4&&icons.every(Boolean)&&icon.left-row.left<8&&row.right-control.right<8;})()",
    ),
    true,
    'each setting has an icon at the start of its row, with its control at the end',
  );
  assert.equal(
    await run(
      "document.querySelector('[data-settings-section=Certificates] .mdi-icon').innerHTML!==document.querySelector('[data-settings-section=Privacy] .mdi-icon').innerHTML",
    ),
    true,
    'Certificates and Privacy have their own icons in the settings navigation',
  );
}
