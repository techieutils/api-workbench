import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pause, type SmokeContext } from './harness';

/** UI smoke checks, part 8: text menus and runner. */
export default async function textMenusAndRunner(context: SmokeContext) {
  const { run, capture, tabsReachable, rightClick } = context;
  await run(
    "window.assertionOriginal=structuredClone(current());requestTab='Tests';current().tests='';current().response={status:200,statusText:'OK',headers:{'content-type':'application/json'},body:'{\"id\":1,\"items\":[1,2]}',time:80,size:24,url:'https://example.com'};render()",
  );
  await run("document.querySelector('[data-test-mode=Text]').click()");
  assert.equal(
    await run("document.querySelectorAll('#test-example option').length>=25"),
    true,
    'Tests tab offers expanded assertion examples',
  );
  await run(
    "document.querySelector('#test-example-group').value='JSON';document.querySelector('#test-example-group').dispatchEvent(new Event('change'));document.querySelector('#test-example').value=String(WorkbenchAssertions.examples.findIndex(example=>example.syntax==='json-valid'));document.querySelector('#test-example').dispatchEvent(new Event('change'));document.querySelector('[data-add-test-example]').click()",
  );
  assert.equal(
    await run('current().tests'),
    'json-valid',
    'example picker inserts a working assertion',
  );
  // Text fields (here the test script) get the default text menu: undo, cut, copy, paste.
  await run(
    "window.clipboardBefore=navigator.clipboard;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.textCopied=value;},readText:async()=>'\\nstatus equals 200'}})",
  );
  await rightClick('#tests');
  assert.equal(
    await run(
      `document.querySelector('[data-text-menu]').matches(':popover-open')&&[...document.querySelectorAll('[data-text-menu] [data-menu-item]')].map(item=>item.dataset.menuItem).join()`,
    ),
    'undo,redo,cut,copy,paste,select-all',
    'right-clicking the test script offers text editing',
  );
  await run("document.querySelector('[data-text-menu] [data-menu-item=select-all]').click()");
  await pause(30);
  await rightClick('#tests');
  await run("document.querySelector('[data-text-menu] [data-menu-item=copy]').click()");
  await pause(30);
  assert.equal(await run('window.textCopied'), 'json-valid', 'Copy copies the selected script');
  await run(
    "(()=>{const field=document.querySelector('#tests');field.focus();field.setSelectionRange(field.value.length,field.value.length);field.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))})()",
  );
  await pause(30);
  await run("document.querySelector('[data-text-menu] [data-menu-item=paste]').click()");
  await pause(50);
  assert.equal(
    await run('current().tests'),
    'json-valid\nstatus equals 200',
    'Shift+F10 then Paste inserts the clipboard text into the script',
  );
  // Selected text anywhere else can be copied from the same menu.
  await run(
    "(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('.request-heading h1'));getSelection().removeAllRanges();getSelection().addRange(range)})()",
  );
  await rightClick('.request-heading h1');
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-text-menu] [data-menu-item]')].map(item=>item.dataset.menuItem).join()",
    ),
    'copy',
    'right-clicking selected page text offers Copy',
  );
  await run("document.querySelector('[data-text-menu] [data-menu-item=copy]').click()");
  await pause(30);
  assert.equal(
    await run('window.textCopied===current().name'),
    true,
    'Copy copies the selected page text',
  );
  await run(
    "getSelection().removeAllRanges();Object.defineProperty(navigator,'clipboard',{configurable:true,value:window.clipboardBefore});current().tests='json-valid';render()",
  );
  await run("document.querySelector('[data-add-basic-tests]').click()");
  await run(
    "document.querySelector('#tests').value+='\\njson $.id equals \"1\"';document.querySelector('#tests').dispatchEvent(new Event('input'));document.querySelector('[data-run-request-tests]').click()",
  );
  assert.equal(await run('responseTab'), 'Tests', 'Run tests opens latest response results');
  assert.equal(await run("document.querySelectorAll('.assertion-result.passed').length"), 5);
  assert.equal(await run("document.querySelectorAll('.assertion-result.failed').length"), 1);
  assert.equal(
    await run(
      "document.querySelector('.assertion-result.failed small').textContent.includes('Actual: 1')",
    ),
    true,
    'failed assertions show actual values and line information',
  );
  await run("document.querySelector('[data-mode=Raw]').click()");
  assert.equal(
    await run(
      "JSON.parse(responseSourceEditor.getValue()).assertions.every(result=>typeof result.line==='number'&&typeof result.message==='string')",
    ),
    true,
    'Raw test results include assertion diagnostics',
  );
  await run(
    "current().tests='// Keep this comment';document.querySelector('[data-test-mode=Builder]').click()",
  );
  assert.equal(
    await run("Boolean(document.querySelector('#test-case-form'))"),
    true,
    'visual test designer is available',
  );
  await run(
    "(()=>{const input=document.querySelector('[data-case-field=name]');input.value='Returns success';input.dispatchEvent(new Event('input'));document.querySelector('#test-case-form').requestSubmit();})()",
  );
  assert.equal(
    await run('WorkbenchTestBuilder.parseCases(current().tests)[0].name'),
    'Returns success',
    'designer creates a named case',
  );
  assert.equal(
    await run("current().tests.startsWith('// Keep this comment')"),
    true,
    'builder preserves existing comments',
  );
  await run(
    "document.querySelector('[data-case-field=kind]').value='json';document.querySelector('[data-case-field=kind]').dispatchEvent(new Event('change'));document.querySelector('[data-case-field=name]').value='User ID';document.querySelector('[data-case-field=name]').dispatchEvent(new Event('input'));document.querySelector('#test-case-form').requestSubmit()",
  );
  assert.equal(
    await run('WorkbenchTestBuilder.parseCases(current().tests)[1].assertion'),
    'json $.id equals 1',
    'designer generates a typed JSON assertion',
  );
  await run('document.querySelector(\'[data-test-enabled="1"]\').click()');
  assert.equal(
    await run('runTests(current(),current().response).length'),
    1,
    'disabled cases are excluded from execution',
  );
  await run('document.querySelector(\'[data-test-duplicate="1"]\').click()');
  assert.equal(
    await run('WorkbenchTestBuilder.parseCases(current().tests).length'),
    3,
    'designer duplicates cases',
  );
  await run('document.querySelector(\'[data-test-move="2"][data-direction="-1"]\').click()');
  assert.equal(
    await run('WorkbenchTestBuilder.parseCases(current().tests)[1].name'),
    'User ID (copy)',
    'designer reorders cases',
  );
  const firstCase = await run('WorkbenchTestBuilder.parseCases(current().tests)[0].name');
  await rightClick('[data-test-case="0"]');
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-test-case-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
    ),
    'toggle,edit,duplicate,up-,down,copy,delete',
    'right-clicking a test case lists its actions',
  );
  await run("document.querySelector('[data-test-case-menu] [data-menu-item=down]').click()");
  await pause(30);
  assert.equal(
    await run('WorkbenchTestBuilder.parseCases(current().tests)[1].name'),
    firstCase,
    'Move down from the test case menu reorders it',
  );
  await rightClick('[data-test-case="1"]');
  await run("document.querySelector('[data-test-case-menu] [data-menu-item=up]').click()");
  await pause(30);
  await run(
    "document.querySelector('[data-test-remove=\"1\"]').click();document.querySelector('[data-test-edit=\"1\"]').click();document.querySelector('[data-case-field=value]').value='2';document.querySelector('[data-case-field=value]').dispatchEvent(new Event('input'));document.querySelector('#test-case-enabled').checked=true;document.querySelector('#test-case-enabled').dispatchEvent(new Event('change'));document.querySelector('#test-case-form').requestSubmit()",
  );
  assert.equal(
    await run('WorkbenchTestBuilder.parseCases(current().tests)[1].assertion'),
    'json $.id equals 2',
    'designer updates existing cases',
  );
  await run("document.querySelector('[data-run-request-tests]').click()");
  assert.equal(
    await run(
      "document.querySelector('.assertion-result.failed .assertion-result-detail > span').textContent",
    ),
    'User ID',
    'response results display case names',
  );
  await run("document.querySelector('[data-test-mode=Text]').click()");
  await run(
    "document.querySelector('#tests').value+='\\nunknown-custom-test';document.querySelector('#tests').dispatchEvent(new Event('input'));document.querySelector('[data-test-mode=Builder]').click()",
  );
  assert.equal(
    await run('WorkbenchTestBuilder.parseCases(current().tests).at(-1).rule.kind'),
    'custom',
    'custom text assertions remain available in builder',
  );
  assert.equal(
    await run("current().tests.includes('// Keep this comment')"),
    true,
    'switching modes does not discard comments',
  );
  await run(
    "document.querySelector('[data-case-field=kind]').value='json-field';document.querySelector('[data-case-field=kind]').dispatchEvent(new Event('change'))",
  );
  await run(
    "document.querySelector('[data-case-field=target]').value='$.items[*]';document.querySelector('[data-case-field=target]').dispatchEvent(new Event('input'));document.querySelector('#test-case-form').requestSubmit()",
  );
  assert.equal(
    await run("document.querySelector('#test-case-error').hidden"),
    false,
    'invalid designer input shows validation',
  );
  // Newer checks: a network timing picks its phase from a list, and a format check needs no value.
  const pick = (field: string, value: string) =>
    run(
      `(()=>{const field=document.querySelector('[data-case-field=${field}]');field.value=${JSON.stringify(value)};field.dispatchEvent(new Event('change'));})()`,
    );
  await pick('kind', 'timing');
  await pause(100);
  assert.deepEqual(
    await run(
      "[...document.querySelectorAll('select[data-case-field=target] option')].slice(0,3).map(option=>option.value)",
    ),
    ['total', 'ttfb', 'preparation'],
    'a timing check lists the phases',
  );
  assert.equal(
    await run("document.querySelector('#test-case-preview').textContent"),
    'timing ttfb < 500',
  );
  await pick('kind', 'cookie');
  await pause(100);
  await pick('operator', 'is-uuid');
  await pause(100);
  assert.equal(
    await run("Boolean(document.querySelector('input[data-case-field=value]'))"),
    false,
    'a format check has no expected value',
  );
  assert.equal(
    await run("document.querySelector('#test-case-preview').textContent"),
    'cookie session is-uuid',
  );
  await run(
    "Object.assign(current(),window.assertionOriginal);requestTab='Params';responseTab='Body';responseMode='Pretty';render()",
  );
  let benchmarkCalls = 0,
    benchmarkActive = 0,
    benchmarkMaxActive = 0;
  const benchmarkServer = createServer((_request, response) => {
    benchmarkCalls++;
    benchmarkActive++;
    benchmarkMaxActive = Math.max(benchmarkMaxActive, benchmarkActive);
    setTimeout(() => {
      benchmarkActive--;
      response.setHeader('Content-Type', 'application/json');
      response.end('{"ok":true}');
    }, 20);
  });
  await new Promise<void>((resolve) => benchmarkServer.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = benchmarkServer.address() as { port: number };
    await run(
      `(async()=>{window.runnerOriginal=structuredClone(state);initializeRunner();state.requests.push(...['a','b'].map(suffix=>({...structuredClone(current()),id:'benchmark-'+suffix,name:'Benchmark '+suffix,folder:'Benchmark UI',url:'http://127.0.0.1:${port}/'+suffix,method:'GET',auth:'None',bodyType:'none',params:[],headers:[],tests:'status 200',response:null})));view='Runner';runnerState.folder='Benchmark UI';runnerState.selected=null;render();await new Promise(resolve=>WorkbenchShell.afterUpdate(resolve));document.querySelector('[data-runner-mode="API benchmark"]').click();await new Promise(resolve=>WorkbenchShell.afterUpdate(resolve));for(const [key,value] of Object.entries({iterations:3,concurrency:3,warmupIterations:1,delayMs:0})){const input=document.querySelector('[data-runner-field="'+key+'"]');input.value=value;input.dispatchEvent(new Event('input'));}window.waitForRunner=async()=>{const deadline=Date.now()+8000;while(runnerState.running&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,20));if(runnerState.running)throw new Error('Runner timed out');if(runnerState.error)throw new Error(runnerState.error);};document.querySelector('#runner-form').requestSubmit();await window.waitForRunner();})()`,
    );
    assert.equal(
      await run(
        "(()=>{const badges=[...document.querySelectorAll('.runner-request-list .method, table .method')];const list=document.querySelectorAll('.runner-request-list .method').length;return list>0&&badges.length>list&&badges.every(badge=>badge.querySelector('.method-icon'));})()",
      ),
      true,
      'the Runner’s request list and results show method icons',
    );
    assert.equal(benchmarkCalls, 8, 'benchmark executes six samples plus two excluded warmups');
    assert.ok(benchmarkMaxActive > 1, 'Electron dispatches concurrent requests');
    assert.equal(
      await run(
        "runnerState.report.metrics.completed===6&&runnerState.report.warmupCompleted===2&&runnerState.report.outcome==='passed'",
      ),
      true,
      'benchmark metrics exclude warmups',
    );
    assert.equal(
      await run(
        "runnerState.report.resources.samples.length>=2&&runnerState.report.resources.latestMemoryBytes>0&&runnerState.report.resources.averageCpuPercent>=0&&document.querySelector('.runner-resource-summary').textContent.includes('CPU average / peak')",
      ),
      true,
      'Electron records and displays app CPU and memory',
    );
    assert.equal(
      await run(
        "state.history.length===window.runnerOriginal.history.length&&state.requests.filter(request=>request.folder==='Benchmark UI').every(request=>request.response===null)",
      ),
      true,
      'benchmarks preserve normal request history and responses',
    );
    assert.equal(
      await run(
        "document.querySelectorAll('.runner-metrics>div').length===5&&document.querySelector('[data-runner-verdict]').classList.contains('is-passed')&&document.querySelectorAll('[data-runner-export]').length===3",
      ),
      true,
      'runner shows metric cards and report exports',
    );
    await run(
      "Promise.all(['json','csv','resources'].map(kind=>window.captureDownload(()=>document.querySelector(`[data-runner-export=${kind}]`).click()))).then(files=>{window.runnerDownloads=files.map(file=>[file.name,file.text,file.mime]);})",
    );
    assert.equal(
      await run(
        "JSON.parse(window.runnerDownloads[0][1]).samples.length===6&&window.runnerDownloads[1][1].split('\\r\\n').length===7",
      ),
      true,
      'JSON and CSV export every measured sample',
    );
    assert.equal(
      await run(
        "JSON.parse(window.runnerDownloads[0][1]).resources.samples.length>=2&&window.runnerDownloads[2][1].includes('cpu_percent,memory_bytes')",
      ),
      true,
      'resource samples included in JSON and dedicated CSV export',
    );
    assert.equal(
      await run(
        'runnerState.report.samples.every(sample=>sample.networkMs>0&&sample.networkMs<=sample.durationMs&&sample.ttfbMs>0&&sample.ttfbMs<=sample.networkMs)&&runnerState.report.metrics.networkP95>0',
      ),
      true,
      'Electron samples record network time and time to first byte apart from client latency',
    );
    assert.equal(
      await run(
        "document.querySelectorAll('.runner-activity .runner-small-chart').length===3&&document.querySelectorAll('.runner-activity .mark').length>0&&Boolean(document.querySelector('.runner-distribution .marker'))&&document.querySelectorAll('.runner-table-view').length===2",
      ),
      true,
      'runner charts activity over time and the latency distribution, each with a table view',
    );
    await run("document.querySelector('[data-runner-baseline=save]').click()");
    assert.equal(
      await run(
        "Boolean(runnerState.baseline)&&document.querySelectorAll('[data-baseline-metric]').length>=6&&Object.keys(localStorage).some(key=>key.startsWith('api-workbench:runner-baseline:'))",
      ),
      true,
      'a run can be saved as the baseline and is compared with it',
    );
    await run('runnerState.baseline=undefined;initializeRunner()');
    assert.equal(
      await run('runnerState.baseline?.mode'),
      'benchmark',
      'the baseline is restored for the collection and mode',
    );
    await run(
      "Object.assign(runnerState.config,{mode:'performance',concurrency:2,warmupIterations:0,durationSeconds:10,rampUpSeconds:0,maxRequests:4});startRunner()",
    );
    assert.equal(
      await run(
        "runnerState.report.reason==='request-limit'&&runnerState.report.samples.length===4",
      ),
      true,
      'performance respects request cap',
    );
    await run(
      "Object.assign(runnerState.config,{loadModel:'rate',targetRps:40,durationSeconds:0.5,concurrency:5,maxRequests:1000});startRunner()",
    );
    assert.equal(
      await run(
        "(()=>{const report=runnerState.report;return report.config.loadModel==='rate'&&report.reason==='completed'&&report.dropped===0&&report.samples.length>=12&&report.samples.length<=21;})()",
      ),
      true,
      'a target rate starts requests on schedule',
    );
    await run("Object.assign(runnerState.config,{loadModel:'workers'})");
    await run(
      'Object.assign(runnerState.config,{maxRequests:1000});window.runnerPending=startRunner();void 0',
    );
    await pause(60);
    await run('stopRunner();window.runnerPending');
    assert.equal(
      await run(
        "runnerState.report.reason==='cancelled'&&runnerState.report.samples.length<1000&&!busy&&runnerState.active.size===0",
      ),
      true,
      'stop cancels concurrent Electron requests',
    );
    await run(
      "Object.assign(runnerState.config,{mode:'collection',iterations:1,concurrency:1});startRunner()",
    );
    assert.equal(
      await run(
        "state.requests.filter(request=>request.folder==='Benchmark UI').every(request=>request.response.status===200)",
      ),
      true,
      'collection mode retains latest response',
    );
    // A filter that matches no samples says so, with a way back to every sample.
    await run("view='Runner';render()");
    await pause(50);
    await run("document.querySelector('[data-runner-result-tab=Samples]').click()");
    await pause(50);
    await run(
      "(()=>{const select=document.querySelector('#runner-result-filter');select.value='failed';select.dispatchEvent(new Event('change'));})()",
    );
    await pause(50);
    assert.equal(
      await run(
        "document.querySelector('[data-runner-samples-empty]')?.textContent.includes('No failed samples in this run.')&&document.querySelector('[data-runner-samples-empty] td').colSpan===document.querySelectorAll('.runner-samples-heading ~ .table-scroll thead th').length",
      ),
      true,
      'an empty sample filter says so across the whole table',
    );
    await run(
      "clearToasts();document.querySelector('[data-runner-samples-empty]').scrollIntoView({block:'center'})",
    );
    await capture('runner-empty-filter.png');
    await run("document.querySelector('[data-runner-show-all]').click()");
    await pause(50);
    assert.equal(
      await run(
        "!document.querySelector('[data-runner-samples-empty]')&&document.querySelector('#runner-result-filter').value==='all'",
      ),
      true,
      'Show all samples clears the filter',
    );
    // Run modes are tabs; squeezed, they scroll with arrows.
    assert.equal(
      await run("document.querySelector('[data-runner-mode].active').textContent.trim()"),
      'Collection run',
      'the current run mode is the active tab',
    );
    await run("document.querySelector('#runner-form').style.width='300px'");
    await pause(80);
    assert.equal(
      await tabsReachable('.runner-mode-tabs'),
      'reachable',
      'run modes that do not fit are reachable with the arrows',
    );
    await run("document.querySelector('#runner-form').style.width=''");
    await pause(50);
    // Run result rows have context menus: samples and per-request statistics.
    await run(
      "window.clipboardBefore=navigator.clipboard;Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{window.runnerCopied=value;}}})",
    );
    const runnerMenuIds = () =>
      run(
        "[...document.querySelectorAll('[data-runner-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
      ) as Promise<string>;
    await rightClick('[data-runner-sample]');
    assert.equal(
      await runnerMenuIds(),
      'open,filter,copy,copy-error-',
      'right-clicking a run sample lists its actions',
    );
    await run("document.querySelector('[data-runner-menu] [data-menu-item=filter]').click()");
    await pause(50);
    assert.equal(
      await run("document.querySelector('#runner-result-filter').value"),
      'passed',
      'Show only passed samples filters the samples',
    );
    await run("runnerState.filter='all';render()");
    await pause(30);
    await run("document.querySelector('[data-runner-result-tab=Requests]').click()");
    await pause(50);
    await rightClick('[data-runner-endpoint]');
    assert.equal(
      await runnerMenuIds(),
      'open,only,copy',
      'right-clicking a per-request row lists its actions',
    );
    await run("document.querySelector('[data-runner-menu] [data-menu-item=copy]').click()");
    await pause(30);
    assert.match(
      await run('window.runnerCopied'),
      /^Request\tCompleted\t.*\n(GET|POST) /,
      'Copy statistics copies a header and the request row, tab-separated',
    );
    await rightClick('[data-runner-endpoint]');
    await run("document.querySelector('[data-runner-menu] [data-menu-item=only]').click()");
    await pause(30);
    assert.equal(
      await run(
        "JSON.stringify(runnerState.selected)===JSON.stringify([document.querySelector('[data-runner-endpoint]').dataset.runnerEndpoint])",
      ),
      true,
      'Run only this request next selects just that request',
    );
    // The runner's request list: include or exclude a request, only it, or everything.
    await run("document.querySelector('.runner-request-picker').open=true");
    await pause(30);
    const requestMenuIds = () =>
      run(
        "[...document.querySelectorAll('[data-runner-request-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+(item.disabled?'-':'')).join()",
      ) as Promise<string>;
    await rightClick('.runner-request-list label');
    assert.equal(
      await requestMenuIds(),
      'toggle,only,all,open',
      'right-clicking a run request lists its actions',
    );
    await run("document.querySelector('[data-runner-request-menu] [data-menu-item=all]').click()");
    await pause(30);
    assert.equal(
      await run('runnerState.selected'),
      null,
      'Include all requests selects every request',
    );
    await rightClick('.runner-request-list label');
    assert.equal(
      await run(
        "document.querySelector('[data-runner-request-menu] [data-menu-item=toggle]').textContent.trim()",
      ),
      'Exclude from run',
      'an included request offers Exclude from run',
    );
    await run(
      "document.querySelector('[data-runner-request-menu] [data-menu-item=toggle]').click()",
    );
    await pause(30);
    assert.equal(
      await run(
        "!runnerState.selected.includes(document.querySelector('[data-runner-request]').dataset.runnerRequest)&&!document.querySelector('[data-runner-request]').checked",
      ),
      true,
      'Exclude from run unticks the request',
    );
    await run(
      "(()=>{const box=document.querySelectorAll('[data-runner-request]')[1];box.focus();box.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true}))})()",
    );
    await pause(30);
    await run("document.querySelector('[data-runner-request-menu] [data-menu-item=only]').click()");
    await pause(30);
    assert.equal(
      await run(
        "JSON.stringify(runnerState.selected)===JSON.stringify([document.querySelectorAll('[data-runner-request]')[1].dataset.runnerRequest])",
      ),
      true,
      'Shift+F10 then Include only this request selects just that one',
    );
    await run('runnerState.selected=null;render()');
    await run(
      "Object.defineProperty(navigator,'clipboard',{configurable:true,value:window.clipboardBefore})",
    );
  } finally {
    benchmarkServer.closeAllConnections();
    await new Promise<void>((resolve) => benchmarkServer.close(() => resolve()));
    await run("state=window.runnerOriginal;view='Collections';render()");
  }
}
