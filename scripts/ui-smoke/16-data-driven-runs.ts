import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { type SmokeContext, pause } from './harness';

/** UI smoke checks, part 16: data-driven collection runs from CSV, JSON, YAML, and XML files. */
export default async function dataDrivenRuns(context: SmokeContext) {
  const { run, capture } = context;
  // Users 1 and 2 exist; anything else is not found. Each request is recorded.
  const received: { path: string; name?: string }[] = [];
  const server = createServer((request, response) => {
    received.push({
      path: request.url ?? '',
      name: request.headers['x-name'] as string | undefined,
    });
    const id = request.url?.match(/^\/users\/(\w+)$/)?.[1];
    const found = id === '1' || id === '2';
    response.writeHead(found ? 200 : 404, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify(found ? { id, name: request.headers['x-name'] } : { error: 'not found' }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const wait = async (code: string, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (!(await run(code))) {
      if (Date.now() > deadline) throw new Error(`Data-driven run check timed out: ${code}`);
      await pause(40);
    }
  };
  /** Chooses a file in the runner's data file input, as the system file picker would. */
  const choose = (name: string, text: string) =>
    run(
      `(()=>{const input=document.querySelector('[data-runner-data-input]');const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(text)}],${JSON.stringify(name)}));input.files=transfer.files;input.dispatchEvent(new Event('change'));})()`,
    );
  try {
    // A request whose path, header, and test come from the data; the environment also has an id,
    // which the data row's value overrides.
    await run(
      `(()=>{window.dataOriginal=structuredClone(state);const request={...structuredClone(current()),id:'data-run',name:'Get user',folder:'Data UI',method:'GET',url:'http://127.0.0.1:${port}/users/{{id}}',auth:'None',bodyType:'none',params:[],headers:[{enabled:true,key:'X-Name',value:'{{name}}'}],tests:'status {{expected}}',captures:[],response:null};state.requests.push(request);state.environments[state.environment].variables.push({enabled:true,key:'id',value:'ENV-ID'});initializeRunner();runnerState.folder='Data UI';runnerState.selected=null;view='Runner';render();})()`,
    );
    await wait("Boolean(document.querySelector('[data-runner-data-choose]'))");
    await run(
      "document.querySelector('.runner-data summary, .runner-data [aria-expanded]')?.click()",
    );
    // Before a file, a place to drop one, saying what it can be.
    await wait("Boolean(document.querySelector('[data-runner-data-drop]'))");
    assert.deepEqual(
      await run(
        "[...document.querySelectorAll('.runner-data-formats li')].map(item=>item.textContent.trim())",
      ),
      ['CSV', 'JSON', 'YAML', 'XML'],
      'the drop zone lists the formats a data file can be',
    );
    await run("document.querySelector('[data-runner-data-drop]').scrollIntoView({block:'center'})");
    await capture('runner-data-drop.png');
    await choose('users.csv', 'id,name,expected\n1,Ada,200\n2,"Sam, Jr",200\n3,Eve,200\n');
    await wait(
      "document.querySelector('[data-runner-data-summary]')?.textContent.includes('3 rows')",
    );
    assert.equal(
      await run(
        "(()=>{const input=document.querySelector('[data-runner-field=iterations]');return input.disabled&&input.value==='3';})()",
      ),
      true,
      'the iteration count follows the rows, and cannot be changed',
    );
    assert.match(
      (await run("document.querySelector('.runner-data-preview').textContent")) as string,
      /\{\{id\}\}[\s\S]*Sam, Jr/,
      'the preview shows each column as a variable, and the rows',
    );
    // Each column says whether the selected requests use it; a column no request uses says so.
    assert.deepEqual(
      await run(
        "[...document.querySelectorAll('[data-runner-data-column]')].map(item=>item.dataset.runnerDataColumn+' '+item.querySelector('span').textContent.trim())",
      ),
      ['id Used ×1', 'name Used ×1', 'expected Used ×1'],
      'the columns the requests use are marked',
    );
    assert.match(
      (await run("document.querySelector('[data-runner-data-summary]').textContent")) as string,
      /CSV · 3 rows · 3 columns · \d+ B/,
      'the file card gives the format, rows, columns, and size',
    );
    await capture('runner-data-file.png');
    // The run plan says what will be sent before it starts: one request per data row here.
    assert.deepEqual(
      await run(
        "[document.querySelector('[data-runner-plan-total]').textContent.trim(),document.querySelector('[data-runner-plan-fact=iterations] dt').textContent.trim(),document.querySelector('[data-runner-plan-fact=iterations] dd').textContent.trim(),document.querySelectorAll('.runner-plan-criteria li').length>=2]",
      ),
      ['3 requests', 'Data rows', '3', true],
      'the run plan counts a request per data row and lists the pass criteria',
    );

    await run("document.querySelector('#runner-form').requestSubmit()");
    await wait('!runnerState.running&&Boolean(runnerState.report)');
    assert.equal(await run('runnerState.error'), '');
    assert.deepEqual(
      received.map((item) => [item.path, item.name]),
      [
        ['/users/1', 'Ada'],
        ['/users/2', 'Sam, Jr'],
        ['/users/3', 'Eve'],
      ],
      'each row runs once, in order, with its values before the environment’s',
    );
    await wait("Boolean(document.querySelector('[data-runner-iterations]'))");
    assert.deepEqual(
      await run(
        "[...document.querySelectorAll('[data-runner-iteration]')].map(row=>row.lastElementChild.textContent.trim())",
      ),
      ['Passed', 'Passed', 'Failed'],
      'the row whose user does not exist fails its test',
    );
    assert.deepEqual(
      await run('runnerState.report.samples.map(sample=>sample.iteration)'),
      [1, 2, 3],
    );
    // Data rows get their own results tab, counted.
    await run('document.querySelector(\'[data-runner-result-tab="Data rows"]\').click()');
    await wait(
      "document.querySelector('[data-runner-result-tab=\"Data rows\"]').getAttribute('aria-selected')==='true'&&document.querySelector('[data-runner-iterations]').offsetParent!==null",
    );
    await run("document.querySelector('[data-runner-verdict]').scrollIntoView({block:'start'})");
    await capture('runner-data-results.png');

    // Expected values come from the data too: with 404 expected for user 3, every row passes.
    received.length = 0;
    await choose(
      'users.json',
      JSON.stringify([
        { id: 1, name: 'Ada', expected: 200 },
        { id: 3, name: 'Eve', expected: 404 },
      ]),
    );
    await wait(
      "document.querySelector('[data-runner-data-summary]')?.textContent.includes('JSON · 2 rows')",
    );
    await run("document.querySelector('#runner-form').requestSubmit()");
    await wait('!runnerState.running&&runnerState.report?.samples.length===2');
    // Both rows pass on their tests, though 404 is outside the run's successful status range.
    await wait(
      "[...document.querySelectorAll('[data-runner-iteration]')].map(row=>row.lastElementChild.textContent.trim()).join()==='Passed,Passed'",
    );
    assert.deepEqual(
      received.map((item) => item.path),
      ['/users/1', '/users/3'],
    );

    // YAML and XML read the same way; a broken file says why and keeps the last good one.
    await choose('users.yaml', '- id: 2\n  name: Sam\n  expected: 200\n');
    await wait(
      "document.querySelector('[data-runner-data-summary]')?.textContent.includes('YAML · 1 row')",
    );
    await choose(
      'users.xml',
      '<users><user id="1" expected="200"><name>Ada</name></user><user id="2" expected="200"><name>Sam</name></user></users>',
    );
    await wait(
      "document.querySelector('[data-runner-data-summary]')?.textContent.includes('XML · 2 rows')",
    );
    await choose('broken.csv', 'id,id\n1,2\n');
    await wait(
      "document.querySelector('[data-runner-data-error]')?.textContent.includes('more than once')",
    );
    assert.match(
      (await run("document.querySelector('[data-runner-data-summary]').textContent")) as string,
      /users\.xml/,
    );

    // Data files apply to collection runs only; benchmarks keep their own iteration count.
    await run('document.querySelector(\'[data-runner-mode="API benchmark"]\').click()');
    await wait("!document.querySelector('[data-runner-data-choose]')");
    assert.equal(
      await run("document.querySelector('[data-runner-field=iterations]').disabled"),
      false,
    );
    await run('document.querySelector(\'[data-runner-mode="Collection run"]\').click()');
    await wait("document.querySelector('[data-runner-field=iterations]')?.value==='2'");
    await run("document.querySelector('[data-runner-data-remove]').click()");
    await wait(
      "!document.querySelector('[data-runner-data-summary]')&&document.querySelector('[data-runner-field=iterations]').value==='1'&&!document.querySelector('[data-runner-field=iterations]').disabled",
    );
    // A file dropped on the zone is read like a chosen one; a column no request uses is marked.
    await run(
      "window.dropTransfer=new DataTransfer();dropTransfer.items.add(new File(['id,unused\\n1,x\\n'],'dropped.csv'));document.querySelector('[data-runner-data-drop]').dispatchEvent(new DragEvent('dragover',{dataTransfer:dropTransfer,bubbles:true,cancelable:true}))",
    );
    await wait(
      "document.querySelector('[data-runner-data-drop]').classList.contains('is-dragging')",
    );
    await run(
      "document.querySelector('[data-runner-data-drop]').dispatchEvent(new DragEvent('drop',{dataTransfer:dropTransfer,bubbles:true,cancelable:true}))",
    );
    await wait(
      "document.querySelector('[data-runner-data-summary]')?.textContent.includes('1 row')",
    );
    assert.equal(
      await run(
        "document.querySelector('[data-runner-data-column=unused]').classList.contains('is-unused')",
      ),
      true,
      'a dropped file loads, and a column no request uses is marked',
    );
    await run("document.querySelector('[data-runner-data-remove]').click()");
    await wait("!document.querySelector('[data-runner-data-summary]')");
  } finally {
    await run(
      'if(window.dataOriginal){state.requests=dataOriginal.requests;state.environments=dataOriginal.environments;runnerState.data=undefined;runnerState.report=undefined;persist();initializeRunner();render();}',
    );
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
