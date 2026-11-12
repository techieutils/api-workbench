import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { pause, type SmokeContext } from './harness';

/** UI smoke checks, part 21: tagging requests, finding them by tag, and running by tag. */
export default async function requestTags(context: SmokeContext) {
  const { run, capture } = context;
  const seen: string[] = [];
  const server = createServer((request, response) => {
    seen.push(request.url ?? '');
    response.setHeader('Content-Type', 'application/json');
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address() as { port: number };
    // Three requests in a collection of their own, the first open.
    await run(
      `window.tagsOriginal=structuredClone(state);view='Collections';
      const make=(id,name,path)=>({...structuredClone(current()),id,name,folder:'Tagged',method:'GET',url:'http://127.0.0.1:${port}/'+path,params:[],headers:[],body:'',bodyType:'none',auth:'None',tests:'',captures:[],response:null,tags:undefined,scripts:undefined});
      state.requests.push(make('tag-a','Sign in','a'),make('tag-b','List orders','b'),make('tag-c','Report','c'));
      openRequest('tag-a');render()`,
    );
    await pause(200);

    // Tags are added under the request's name, several at once, and removed with ×.
    await run("document.querySelector('[data-action=add-tag]').click()");
    await pause(100);
    await run(
      "userInput('[data-tag-input]','smoke, auth');document.querySelector('[data-tag-input]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
    );
    await pause(100);
    assert.deepEqual(await run('current().tags'), ['smoke', 'auth']);
    await run(
      "userInput('[data-tag-input]','Smoke');document.querySelector('[data-tag-input]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
    );
    await pause(100);
    assert.match(
      String(await run("document.querySelector('[data-request-tags] [role=alert]')?.textContent")),
      /already tagged/,
      'a tag is not added twice, whatever its case',
    );
    await run("userInput('[data-tag-input]','');document.querySelector('[data-tag-input]').blur()");
    await capture('request-tags.png');
    await run(
      "state.requests.find(r=>r.id==='tag-b').tags=['smoke'];state.requests.find(r=>r.id==='tag-c').tags=['slow'];persist();render()",
    );
    await run("document.querySelector('[data-tag=auth] button').click()");
    await pause(100);
    assert.deepEqual(await run('current().tags'), ['smoke']);

    // The explorer finds requests by tag; #tag matches the tag exactly.
    await run("userInput('#filter','#smoke')");
    await pause(150);
    assert.deepEqual(
      await run(
        "[...document.querySelectorAll('.request-item')].map(item=>item.dataset.open).filter(id=>id?.startsWith('tag-'))",
      ),
      ['tag-a', 'tag-b'],
    );
    await run("userInput('#filter','')");

    // The explorer's tag bar narrows the tree, together with the search.
    const shownTagged = () =>
      run(
        "[...document.querySelectorAll('.request-item')].map(item=>item.dataset.open).filter(id=>id?.startsWith('tag-'))",
      );
    await run("document.querySelector('[data-explorer-tags] [data-runner-tag=smoke]').click()");
    await pause(150);
    assert.deepEqual(await shownTagged(), ['tag-a', 'tag-b']);
    assert.equal(
      await run(
        "[...document.querySelectorAll('.request-item')].every(item=>item.dataset.open?.startsWith('tag-'))",
      ),
      true,
      'only tagged requests are shown',
    );
    await run("userInput('#filter','orders')");
    await pause(150);
    assert.deepEqual(await shownTagged(), ['tag-b'], 'the search narrows it further');
    await run("userInput('#filter','')");
    await capture('explorer-tags.png');
    await run("document.querySelector('[data-explorer-tags] [data-runner-tag=smoke]').click()");
    await pause(150);
    assert.deepEqual(await shownTagged(), ['tag-c'], 'clicking again leaves them out');
    await run("document.querySelector('[data-explorer-tags] [data-runner-tag=slow]').click()");
    await pause(150);
    assert.deepEqual(await shownTagged(), ['tag-c'], 'tagged slow, not smoke');
    await run("userInput('#filter','nothing like this')");
    await pause(150);
    assert.equal(
      await run(
        "document.querySelector('.tree-empty')?.textContent.includes('No request matching your search is tagged slow, not smoke')",
      ),
      true,
      'an empty tree says which tags and search hide everything',
    );
    await run("userInput('#filter','')");
    await run(
      "document.querySelector('[data-explorer-tags] [data-action=clear-tag-filter]').click()",
    );
    await pause(150);
    assert.deepEqual(await shownTagged(), ['tag-a', 'tag-b', 'tag-c']);

    // A collection's tags, from its menu: every request inside has them too.
    await run('document.querySelector(\'[data-collection-menu="Tagged"]\').click()');
    await pause(100);
    await run(
      "document.querySelector('[data-collection-menu=\"Tagged\"]').nextElementSibling.querySelector('[data-menu-item=tags]').click()",
    );
    await pause(200);
    assert.equal(
      await run("Boolean(document.querySelector('[data-folder-tags-dialog]')?.open)"),
      true,
    );
    await run(
      "userInput('[data-folder-tags-dialog] [data-tag-input]','suite');document.querySelector('[data-folder-tags-dialog] [data-tag-input]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
    );
    await pause(100);
    assert.deepEqual(await run('state.collectionTags?.Tagged'), ['suite']);
    await capture('folder-tags.png');
    await run("document.querySelector('[data-folder-tags-done]').click()");
    await pause(150);
    assert.equal(await run("Boolean(document.querySelector('[data-folder-tags-dialog]'))"), false);
    assert.equal(
      await run(
        "document.querySelector('[data-folder-toggle=\"Tagged\"]').textContent.includes('#suite')",
      ),
      true,
      'the explorer shows a collection’s tags',
    );
    assert.equal(
      await run(
        "Boolean(document.querySelector('[data-request-tags] [data-inherited-tag=suite]'))",
      ),
      true,
      'a request shows the tags it has from its collection',
    );
    // A tag the collection already gives is not added to the request again.
    await run("document.querySelector('[data-request-tags] [data-action=add-tag]')?.click()");
    await pause(100);
    await run(
      "userInput('[data-request-tags] [data-tag-input]','Suite');document.querySelector('[data-request-tags] [data-tag-input]').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}))",
    );
    await pause(100);
    assert.match(
      String(await run("document.querySelector('[data-request-tags] [role=alert]')?.textContent")),
      /already has suite from Tagged/,
    );
    await run(
      "userInput('[data-request-tags] [data-tag-input]','');document.querySelector('[data-request-tags] [data-tag-input]').blur()",
    );

    // History filters what was sent by the requests' tags.
    await run("execute(state.requests.find(r=>r.id==='tag-a'))");
    await run("execute(state.requests.find(r=>r.id==='tag-c'))");
    await run("view='History';render()");
    await pause(300);
    const historyNames = () =>
      run(
        "[...document.querySelectorAll('.history-entry')].map(item=>item.textContent).filter(text=>/Sign in|Report/.test(text)).map(text=>text.includes('Sign in')?'Sign in':'Report')",
      );
    await run("document.querySelector('[data-history-tags] [data-runner-tag=smoke]').click()");
    await pause(200);
    assert.deepEqual([...new Set((await historyNames()) as string[])], ['Sign in']);
    assert.equal(
      await run(
        "[...document.querySelectorAll('.history-entry')].every(item=>item.textContent.includes('Sign in'))",
      ),
      true,
      'History shows only what was sent from requests tagged smoke',
    );
    await capture('history-tags.png');
    await run(
      "document.querySelector('[data-history-tags] [data-action=clear-tag-filter]').click()",
    );
    await pause(150);
    await run("userInput('#history-search','#slow')");
    await pause(150);
    assert.deepEqual([...new Set((await historyNames()) as string[])], ['Report'], '#tag search');
    await run("userInput('#history-search','')");

    // The command palette: tag commands and tagged requests, once something is typed.
    const paletteTitles = () =>
      run(
        "[...document.querySelectorAll('[data-command-result]')].map(item=>item.textContent.trim())",
      ) as Promise<string[]>;
    await run("commandPalette.open=true;commandPalette.query='';render()");
    await pause(200);
    assert.equal(
      (await paletteTitles()).some((title) => title.includes('tagged')),
      false,
      'tag commands wait for a search',
    );
    await run("userInput('#command-palette-input','#smoke')");
    await pause(200);
    const titles = await paletteTitles();
    for (const expected of [
      'Show requests tagged smoke',
      'Run requests tagged smoke',
      'Show history tagged smoke',
      'Open “Sign in”',
      'Open “List orders”',
    ])
      assert.ok(
        titles.some((title) => title.includes(expected)),
        `${expected} in ${titles}`,
      );
    assert.equal(
      titles.some((title) => title.includes('Report')),
      false,
      'only #smoke requests',
    );
    await capture('palette-tags.png');
    await run(
      "[...document.querySelectorAll('[data-command-result]')].find(item=>item.textContent.includes('Show requests tagged smoke')).click()",
    );
    await pause(200);
    assert.equal(await run('view'), 'Collections');
    assert.equal(
      await run(
        "document.querySelector('[data-explorer-tags] [data-runner-tag=smoke]').dataset.state",
      ),
      'include',
      'the palette set the explorer’s tag filter',
    );
    await run(
      "document.querySelector('[data-explorer-tags] [data-action=clear-tag-filter]').click()",
    );
    await pause(100);

    // Workspace search: requests and collections by tag; environments and pages have none.
    const searchResults = () =>
      run(
        "[...document.querySelectorAll('[data-search-result]')].map(item=>item.querySelector('strong')?.textContent.trim())",
      ) as Promise<string[]>;
    await run(
      "workspaceSearch.open=true;workspaceSearch.query='';workspaceSearch.category='All';render()",
    );
    await pause(200);
    await run("document.querySelector('[data-search-tags] [data-runner-tag=smoke]').click()");
    await pause(200);
    assert.deepEqual((await searchResults()).sort(), ['List orders', 'Sign in', 'Tagged'].sort());
    await capture('search-tags.png');
    await run(
      "document.querySelector('[data-search-tags] [data-action=clear-tag-filter]').click()",
    );
    await run("userInput('#global-workspace-search','#slow')");
    await pause(200);
    assert.deepEqual((await searchResults()).sort(), ['Report', 'Tagged'].sort(), '#tag search');
    await run("userInput('#global-workspace-search','#slow collection')");
    await pause(150);
    assert.deepEqual(await searchResults(), ['Tagged'], 'words narrow it further');
    await run("workspaceSearch.open=false;workspaceSearch.query='';render()");
    await pause(100);

    // The Docs screen documents the endpoints the tags choose, and tags each operation.
    await run(
      "view='Documentation';documentationState.collection='Tagged';documentationState.mode='Swagger';render()",
    );
    await pause(300);
    assert.equal(await run("document.querySelectorAll('.docs-endpoint').length"), 3);
    await run("document.querySelector('[data-docs-tags] [data-runner-tag=smoke]').click()");
    await pause(200);
    assert.equal(await run("document.querySelectorAll('.docs-endpoint').length"), 2);
    assert.match(
      String(await run("document.querySelector('.docs-collection-picker p').textContent")),
      /2 of 3 requests · tagged smoke/,
    );
    await capture('docs-tags.png');
    await run("documentationState.mode='YAML';render()");
    await pause(300);
    const yaml = String(await run("documentationEditor?.getValue() ?? ''"));
    assert.match(yaml, /tags:\n\s+- Tagged\n\s+- suite\n\s+- smoke/, 'operations carry their tags');
    assert.doesNotMatch(yaml, /summary: Report/, 'Report is not tagged smoke');
    await run("documentationState.mode='Swagger';documentationState.collection='';render()");
    await pause(150);

    // The Runner sends only the requests the tag filter chooses.
    await run(
      "initializeRunner();view='Runner';runnerState.folder='Tagged';runnerState.selected=null;render()",
    );
    await pause(300);
    assert.deepEqual(
      await run(
        "[...document.querySelectorAll('[data-runner-tags] [data-runner-tag]')].map(item=>item.dataset.runnerTag+':'+item.dataset.state)",
      ),
      ['slow:off', 'smoke:off', 'suite:off'],
    );
    await run("document.querySelector('[data-runner-tags] [data-runner-tag=smoke]').click()");
    await pause(150);
    assert.equal(
      await run("document.querySelector('[data-runner-plan-fact=tags] dd')?.textContent"),
      'smoke',
    );
    assert.equal(
      await run("document.querySelector('[data-runner-plan-fact=requests] dd')?.textContent"),
      '2 of 3',
    );
    assert.equal(
      await run("document.querySelectorAll('.runner-request-list label.is-filtered').length"),
      1,
      'a request the filter leaves out is dimmed',
    );
    await capture('runner-tags.png');
    const before = seen.length;
    await run('startRunner()');
    for (let wait = 0; wait < 50 && (await run('runnerState.running')); wait++) await pause(100);
    assert.deepEqual(seen.slice(before).sort(), ['/a', '/b']);
    assert.equal(await run('runnerState.metadata.tags'), 'smoke');

    // The collection's tag is on every request in it.
    assert.equal(
      await run(
        "document.querySelector('[data-runner-tags] [data-runner-tag=suite] .runner-tag-count').textContent",
      ),
      '3',
    );
    // Clicking again leaves those requests out instead.
    await run("document.querySelector('[data-runner-tags] [data-runner-tag=smoke]').click()");
    await pause(150);
    assert.equal(
      await run(
        "document.querySelector('[data-runner-tags] [data-runner-tag=smoke]').dataset.state",
      ),
      'exclude',
    );
    assert.equal(
      await run("document.querySelector('[data-runner-plan-fact=requests] dd')?.textContent"),
      '1 of 3',
    );
    await run(
      "document.querySelector('[data-runner-tags] [data-action=clear-tag-filter]').click()",
    );
    await pause(100);
    assert.equal(
      await run("Boolean(document.querySelector('[data-runner-plan-fact=tags]'))"),
      false,
    );
  } finally {
    server.close();
    await run(
      "if(window.tagsOriginal){state.requests=window.tagsOriginal.requests;state.active=window.tagsOriginal.active;state.tabs=window.tagsOriginal.tabs;state.collectionTags=window.tagsOriginal.collectionTags;if(!state.collectionTags)delete state.collectionTags;delete window.tagsOriginal;runnerState.tags={include:[],mode:'any',exclude:[]};view='Collections';persist();render()}",
    );
  }
}
