import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pause, temporary, type SmokeContext } from './harness';

/** UI smoke checks, part 12: collections and files. */
export default async function collectionsAndFiles(context: SmokeContext) {
  const { window, run, capture, tabsReachable, rightClick, answerConfirm } = context;
  // Renaming a collection in the explorer: double-click or F2, Enter saves, Escape cancels.
  await run(
    "window.renameOriginal=structuredClone(state);state.collectionHttpSettings={...state.collectionHttpSettings,Posts:{timeoutMs:4321}};state.collectionAuth={...state.collectionAuth,Posts:{auth:'Bearer token',token:'posts-token',username:'',password:''}};render()",
  );
  await run(
    "document.querySelector('[data-folder-toggle=\"Posts\"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  await pause(50);
  assert.equal(
    await run(
      "document.activeElement?.matches('[data-folder-rename=\"Posts\"]')&&document.activeElement.value==='Posts'",
    ),
    true,
    'double-clicking a collection edits its name',
  );
  await run(
    "(()=>{const field=document.activeElement;field.value='GraphQL';field.dispatchEvent(new Event('input'));field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()",
  );
  assert.equal(
    await run(
      "document.querySelector('.folder-rename-error')?.textContent.includes('already exists')&&document.querySelector('[data-folder-rename=\"Posts\"]')?.value==='GraphQL'&&state.requests.some(request=>request.folder==='Posts')",
    ),
    true,
    'a name another collection uses is refused and editing continues',
  );
  await capture('collection-rename.png');
  await run(
    "document.querySelector('[data-folder-rename=\"Posts\"]').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  assert.equal(
    await run(
      "!document.querySelector('[data-folder-rename]')&&state.requests.some(request=>request.folder==='Posts')",
    ),
    true,
    'Escape cancels a collection rename',
  );
  await run(
    "(()=>{const toggle=document.querySelector('[data-folder-toggle=\"Posts\"]');toggle.focus();toggle.dispatchEvent(new KeyboardEvent('keydown',{key:'F2',bubbles:true}));})()",
  );
  await pause(50);
  await run(
    "(()=>{const field=document.querySelector('[data-folder-rename=\"Posts\"]');field.value='  Blog posts ';field.dispatchEvent(new Event('input'));field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()",
  );
  await pause(50);
  assert.equal(
    await run(
      "!state.requests.some(request=>request.folder==='Posts')&&state.requests.some(request=>request.folder==='Blog posts')&&state.collectionHttpSettings['Blog posts']?.timeoutMs===4321&&!('Posts' in state.collectionHttpSettings)&&state.collectionAuth['Blog posts']?.token==='posts-token'&&!('Posts' in state.collectionAuth)",
    ),
    true,
    'renaming moves requests, collection settings, and collection auth',
  );
  assert.equal(
    await run('document.activeElement?.matches(\'[data-folder-toggle="Blog posts"]\')'),
    true,
    'focus returns to the renamed collection',
  );
  await run('state=window.renameOriginal;render()');
  // Collection menu: new request here, duplicate, delete, and run.
  await run(
    "window.menuOriginal=structuredClone(state);state.collectionHttpSettings={...state.collectionHttpSettings,Posts:{timeoutMs:2222}};view='Collections';render()",
  );
  const menuAction = async (menuSelector: string, item: string) => {
    await run(`document.querySelector('${menuSelector}').click()`);
    await pause(60);
    await run(
      `document.querySelector('${menuSelector}').nextElementSibling.querySelector('[data-menu-item="${item}"]').click()`,
    );
    await pause(60);
  };
  const postsMenu = '[data-collection-menu="Posts"]';
  await run(`document.querySelector('${postsMenu}').click()`);
  await pause(60);
  assert.equal(
    await run(
      `(()=>{const menu=document.querySelector('${postsMenu}').nextElementSibling;return menu.matches(':popover-open')&&[...menu.querySelectorAll('[role=menuitem]')].map(item=>item.dataset.menuItem).join()==='new,new-folder,rename,duplicate,expand,collapse,run,export,spec,mock,tags,settings,reveal,delete';})()`,
    ),
    true,
    'each collection has an actions menu',
  );
  await run(
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));document.querySelector('[data-collection-menu=\"Posts\"]').nextElementSibling.hidePopover()",
  );
  const postsBefore = (await run(
    "state.requests.filter(request=>request.folder==='Posts').length",
  )) as number;
  await menuAction(postsMenu, 'new');
  assert.equal(
    await run(
      `current().folder==='Posts'&&current().name==='Untitled request'&&state.requests.filter(request=>request.folder==='Posts').length===${postsBefore + 1}&&state.requests.findIndex(request=>request.id===current().id)===Math.max(...state.requests.map((request,index)=>request.folder==='Posts'?index:-1))`,
    ),
    true,
    'New request here adds a request at the end of that collection and opens it',
  );
  await menuAction(postsMenu, 'duplicate');
  assert.equal(
    await run(
      `state.requests.filter(request=>request.folder==='Posts copy').length===${postsBefore + 1}&&state.collectionHttpSettings['Posts copy']?.timeoutMs===2222`,
    ),
    true,
    'duplicating a collection copies its requests and settings',
  );
  await menuAction('[data-collection-menu="Posts copy"]', 'delete');
  assert.match(
    await answerConfirm(true),
    /Delete the “Posts copy” collection\?/,
    'deleting a collection asks first',
  );
  assert.equal(
    await run(
      "!state.requests.some(request=>request.folder==='Posts copy')&&!('Posts copy' in state.collectionHttpSettings)",
    ),
    true,
    'deleting a collection removes its requests and settings',
  );
  await menuAction(postsMenu, 'run');
  assert.equal(
    await run("view==='Runner'&&runnerState.folder==='Posts'"),
    true,
    'Run in Runner opens the Runner on that collection',
  );
  await run("view='Collections';render()");
  // New collection: created with a blank request, its name ready to edit.
  await run("document.querySelector('[data-new-collection]').click()");
  await pause(80);
  assert.equal(
    await run(
      "document.activeElement?.matches('[data-folder-rename=\"New collection\"]')&&current().folder==='New collection'",
    ),
    true,
    'New collection starts one and edits its name',
  );
  await run(
    "(()=>{const field=document.activeElement;field.value='Payments';field.dispatchEvent(new Event('input'));field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()",
  );
  await pause(50);
  assert.equal(
    await run('current().folder'),
    'Payments',
    'the new collection takes the typed name',
  );
  // Moving requests: Move to, with Undo, and drag and drop.
  await run("window.movedId=state.requests.find(request=>request.folder==='Posts').id");
  await menuAction(
    `[data-request-row="${await run('window.movedId')}"] .request-menu-trigger`,
    'move:GraphQL',
  );
  assert.equal(
    await run('state.requests.find(request=>request.id===window.movedId).folder'),
    'GraphQL',
    'Move to puts a request in another collection',
  );
  await run(
    "[...document.querySelectorAll('.toast')].find(item=>item.textContent.includes('Moved'))?.querySelector('[data-toast-action]').click()",
  );
  await pause(50);
  assert.equal(
    await run('state.requests.find(request=>request.id===window.movedId).folder'),
    'Posts',
    'Undo puts the request back',
  );
  const dragRequest = async (
    fromId: string,
    toSelector: string,
    position: 'before' | 'after' | 'folder',
  ) =>
    run(
      `(()=>{const data=new DataTransfer();const row=document.querySelector('[data-request-row="${fromId}"]');row.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer:data}));const target=document.querySelector('${toSelector}');const box=target.getBoundingClientRect();const y=${position === 'before' ? 'box.top+2' : position === 'after' ? 'box.bottom-2' : 'box.top+box.height/2'};target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer:data,clientX:box.left+10,clientY:y}));target.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:data,clientX:box.left+10,clientY:y}));row.dispatchEvent(new DragEvent('dragend',{bubbles:true,dataTransfer:data}));})()`,
    );
  await dragRequest(
    (await run('window.movedId')) as string,
    '[data-collection="GraphQL"] .collection-folder-heading',
    'folder',
  );
  await pause(50);
  assert.equal(
    await run('state.requests.find(request=>request.id===window.movedId).folder'),
    'GraphQL',
    'dropping a request on a collection moves it there',
  );
  await run(
    "window.graphFirst=state.requests.find(request=>request.folder==='GraphQL'&&request.id!==window.movedId).id",
  );
  await dragRequest(
    (await run('window.movedId')) as string,
    `[data-request-row="${await run('window.graphFirst')}"]`,
    'before',
  );
  await pause(50);
  assert.equal(
    await run(
      "(()=>{const ids=state.requests.filter(request=>request.folder==='GraphQL').map(request=>request.id);return ids.indexOf(window.movedId)<ids.indexOf(window.graphFirst);})()",
    ),
    true,
    'dropping on the top half of a request places it before',
  );
  await run(
    "(()=>{const item=document.querySelector('.request-item[data-open=\"'+window.movedId+'\"]');item.focus();item.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',altKey:true,bubbles:true}));})()",
  );
  await pause(50);
  assert.equal(
    await run(
      "(()=>{const ids=state.requests.filter(request=>request.folder==='GraphQL').map(request=>request.id);return ids.indexOf(window.movedId)>ids.indexOf(window.graphFirst)&&document.activeElement?.dataset.open===window.movedId;})()",
    ),
    true,
    'Alt+ArrowDown moves a request down and keeps focus on it',
  );
  // Folders inside collections: New folder, nesting, rename rules, moving in, and inheritance.
  const typeFolderName = (name: string) =>
    run(
      `(()=>{const field=document.activeElement;field.value=${JSON.stringify(name)};field.dispatchEvent(new Event('input'));field.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`,
    );
  await menuAction(postsMenu, 'new-folder');
  await pause(80);
  assert.equal(
    await run(
      "document.activeElement?.matches('[data-folder-rename=\"Posts/New folder\"]')&&current().folder==='Posts/New folder'",
    ),
    true,
    'New folder starts a folder in the collection and edits its name',
  );
  await typeFolderName('Drafts');
  await pause(60);
  assert.equal(
    await run(
      'current().folder===\'Posts/Drafts\'&&Boolean(document.querySelector(\'[data-collection="Posts"] [data-folder-toggle="Posts/Drafts"]\'))',
    ),
    true,
    'the folder takes the typed name and shows inside its collection',
  );
  // Collections are saved as directories, and each request as a YAML file in its folder.
  const draftsDirectory = path.join(temporary, 'collections', 'Posts', 'Drafts');
  for (
    let attempt = 0;
    attempt < 40 && !fs.existsSync(path.join(draftsDirectory, '_folder.yaml'));
    attempt++
  )
    await pause(50);
  assert.equal(
    fs.readFileSync(path.join(draftsDirectory, '_folder.yaml'), 'utf8').includes('name: Drafts'),
    true,
    'a folder is saved as a directory with its metadata',
  );
  assert.equal(
    fs
      .readdirSync(draftsDirectory)
      .some(
        (file) =>
          file.endsWith('.yaml') &&
          file !== '_folder.yaml' &&
          /^name: Untitled request$/m.test(
            fs.readFileSync(path.join(draftsDirectory, file), 'utf8'),
          ),
      ),
    true,
    'the folder’s request is saved as a YAML file inside it',
  );
  // A request file edited outside the app reloads into the open window.
  const draftFile = path.join(
    draftsDirectory,
    fs
      .readdirSync(draftsDirectory)
      .find((file) => file.endsWith('.yaml') && file !== '_folder.yaml')!,
  );
  const draftId = (await run('current().id')) as string;
  fs.writeFileSync(
    draftFile,
    fs.readFileSync(draftFile, 'utf8').replace(/^name: .*$/m, 'name: Edited on disk'),
  );
  for (
    let attempt = 0;
    attempt < 80 && !(await run("state.requests.some(request=>request.name==='Edited on disk')"));
    attempt++
  )
    await pause(50);
  assert.equal(
    await run(
      `state.requests.find(request=>request.name==='Edited on disk')?.id===${JSON.stringify(draftId)}&&Boolean(document.querySelector('[data-open="${draftId}"]')?.textContent.includes('Edited on disk'))&&[...document.querySelectorAll('.toast')].some(item=>item.textContent.includes('Reloaded workspace files'))`,
    ),
    true,
    'editing a request file outside the app reloads it, keeping its id',
  );
  // workspace.json edited outside the app reloads too, such as an environment's name.
  const workspaceFile = path.join(temporary, 'workspace.json');
  const environmentIndex = (await run('state.environment')) as number;
  const savedWorkspace = JSON.parse(fs.readFileSync(workspaceFile, 'utf8'));
  savedWorkspace.environments[environmentIndex].name = 'Renamed on disk';
  fs.writeFileSync(workspaceFile, JSON.stringify(savedWorkspace, null, 2));
  for (
    let attempt = 0;
    attempt < 80 && (await run('state.environments[state.environment].name')) !== 'Renamed on disk';
    attempt++
  )
    await pause(50);
  assert.equal(
    await run('state.environments[state.environment].name'),
    'Renamed on disk',
    'editing workspace.json outside the app reloads it',
  );
  // workspaces.json edited outside the app reloads the list, and the open workspace's name.
  const indexFile = path.join(temporary, 'workspaces.json');
  const openId = (await run('workspaceUI.id')) as string;
  const savedIndex = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  savedIndex.workspaces.find((item: { id: string }) => item.id === openId).name = 'Renamed in list';
  fs.writeFileSync(indexFile, JSON.stringify(savedIndex, null, 2));
  for (
    let attempt = 0;
    attempt < 80 && (await run('settings().workspaceName')) !== 'Renamed in list';
    attempt++
  )
    await pause(50);
  assert.equal(
    await run(
      `workspaceUI.index.workspaces.find(item=>item.id===${JSON.stringify(openId)})?.name==='Renamed in list'&&settings().workspaceName==='Renamed in list'`,
    ),
    true,
    'editing workspaces.json outside the app reloads the list and the open workspace’s name',
  );
  assert.equal(
    await run(
      "(()=>{const trigger=document.querySelector('[data-folder-menu=\"Posts/Drafts\"]');trigger.click();const menu=trigger.nextElementSibling;const items=[...menu.querySelectorAll('[role=menuitem]')].map(item=>item.dataset.menuItem).join();menu.hidePopover();return items;})()",
    ),
    'new,new-folder,rename,expand,collapse,tags,settings,reveal,delete',
    'a folder has its own actions menu',
  );
  await menuAction('[data-folder-menu="Posts/Drafts"]', 'new-folder');
  await pause(80);
  await typeFolderName('Archive');
  await pause(60);
  assert.equal(
    await run(
      "(()=>{const outer=document.querySelector('[data-folder=\"Posts/Drafts\"]').getBoundingClientRect().left;const inner=document.querySelector('[data-folder=\"Posts/Drafts/Archive\"]').getBoundingClientRect().left;return current().folder==='Posts/Drafts/Archive'&&inner>outer;})()",
    ),
    true,
    'folders nest, each level indented further',
  );
  assert.equal(
    await run(
      "[...document.querySelectorAll('.request-heading .breadcrumb span')].map(item=>item.textContent).join(' > ')",
    ),
    'Collections > Posts > Drafts > Archive',
    'the breadcrumb shows each folder',
  );
  await run(
    "document.querySelector('[data-folder-toggle=\"Posts/Drafts/Archive\"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  await pause(60);
  await typeFolderName('a/b');
  await pause(60);
  assert.equal(
    await run(
      "document.querySelector('#folder-rename-error')?.textContent.includes('cannot contain')&&state.requests.some(request=>request.folder==='Posts/Drafts/Archive')",
    ),
    true,
    'a folder name cannot contain the path separator',
  );
  await run(
    "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  await pause(60);
  await dragRequest(
    (await run('window.movedId')) as string,
    '[data-folder="Posts/Drafts"]',
    'folder',
  );
  await pause(50);
  assert.equal(
    await run('state.requests.find(request=>request.id===window.movedId).folder'),
    'Posts/Drafts',
    'dropping a request on a folder moves it into the folder',
  );
  assert.equal(
    await run(
      'effectiveRequestHTTPSettings(state.requests.find(request=>request.id===window.movedId)).timeoutMs',
    ),
    2222,
    'a request in a folder uses its collection’s HTTP settings',
  );
  await run(
    "(()=>{const trigger=document.querySelector('[data-request-row=\"'+window.movedId+'\"] .request-menu-trigger');trigger.click();})()",
  );
  await pause(60);
  assert.equal(
    await run(
      "(()=>{const menu=document.querySelector('[data-request-row=\"'+window.movedId+'\"] .request-menu-trigger').nextElementSibling;const item=menu.querySelector('[data-menu-item=\"move:Posts/Drafts/Archive\"]');menu.hidePopover();return item?.textContent.includes('Posts / Drafts / Archive');})()",
    ),
    true,
    'Move to lists folders by their path',
  );
  // Folder-level defaults: HTTP settings and auth layer collection → folders → request.
  await run(
    "state.collectionHttpSettings={...state.collectionHttpSettings,'Posts/Drafts':{timeoutMs:3333}};window.archiveId=state.requests.find(request=>request.folder==='Posts/Drafts/Archive').id;window.postsDirectId=state.requests.find(request=>request.folder==='Posts').id;render()",
  );
  assert.deepEqual(
    await run(
      "['movedId','archiveId','postsDirectId'].map(key=>effectiveRequestHTTPSettings(state.requests.find(request=>request.id===window[key])).timeoutMs)",
    ),
    [3333, 3333, 2222],
    'a folder’s HTTP settings apply to its requests and the folders inside it, not the rest of the collection',
  );
  await run(
    "state.collectionAuth={...state.collectionAuth,Posts:{auth:'Bearer token',token:'collection-token',username:'',password:''},'Posts/Drafts':{auth:'Basic auth',token:'',username:'folder-user',password:'folder-pass'},'Posts/Drafts/Archive':{auth:'Inherit from collection',token:'',username:'',password:''}};for(const request of state.requests)if(request.folder.startsWith('Posts'))request.auth='Inherit from collection';render()",
  );
  assert.deepEqual(
    await run(
      "['archiveId','postsDirectId'].map(key=>{const auth=effectiveAuth(state.requests.find(request=>request.id===window[key]));return auth.auth+':'+(auth.username||auth.token);})",
    ),
    ['Basic auth:folder-user', 'Bearer token:collection-token'],
    'auth inherits from the nearest folder that sets it, through folders that inherit',
  );
  await run('document.querySelector(\'[data-folder-http-settings="Posts/Drafts"]\').click()');
  await pause(120);
  assert.equal(
    await run(
      "requestTab==='Settings'&&document.querySelector('[data-http-folder=\"Posts/Drafts\"]')?.getAttribute('aria-pressed')==='true'&&Boolean(document.querySelector('[data-http-scope=\"collection\"][data-http-folder=\"Posts\"]'))",
    ),
    true,
    'a folder’s settings button opens its own level of the HTTP settings',
  );
  await capture('folder-http-settings.png');
  // Squeezed, the HTTP settings levels scroll with arrows.
  await run("document.querySelector('.hs-scope').closest('.ui-tabs-frame').style.width='150px'");
  await pause(80);
  assert.equal(
    await tabsReachable('.hs-scope'),
    'reachable',
    'HTTP settings levels that do not fit are reachable with the arrows',
  );
  await run("document.querySelector('.hs-scope').closest('.ui-tabs-frame').style.width=''");
  await menuAction('[data-folder-menu="Posts/Drafts"]', 'rename');
  await pause(60);
  await typeFolderName('Ideas');
  await pause(60);
  assert.equal(
    await run(
      "state.collectionHttpSettings['Posts/Ideas']?.timeoutMs===3333&&state.collectionAuth['Posts/Ideas']?.username==='folder-user'&&state.collectionAuth['Posts/Ideas/Archive']?.auth==='Inherit from collection'&&!('Posts/Drafts' in state.collectionHttpSettings)",
    ),
    true,
    'renaming a folder moves its settings and auth, and those of the folders inside',
  );
  assert.equal(
    await run(
      "state.requests.some(request=>request.folder==='Posts/Ideas/Archive')&&state.requests.find(request=>request.id===window.movedId).folder==='Posts/Ideas'&&!state.requests.some(request=>request.folder.startsWith('Posts/Drafts'))",
    ),
    true,
    'renaming a folder moves everything inside it',
  );
  // Settings buttons show only while a heading is hovered or has keyboard focus.
  await run("document.activeElement?.blur();view='Collections';render()");
  await pause(250);
  assert.equal(
    await run(
      "getComputedStyle(document.querySelector('[data-collection-http-settings=\"Posts\"]')).opacity==='0'&&getComputedStyle(document.querySelector('[data-folder-http-settings=\"Posts/Ideas\"]')).opacity==='0'",
    ),
    true,
    'collection and folder settings buttons are hidden until hovered',
  );
  await run('document.querySelector(\'[data-folder-toggle="Posts/Ideas"]\').focus()');
  await pause(250);
  assert.equal(
    await run(
      'getComputedStyle(document.querySelector(\'[data-folder-http-settings="Posts/Ideas"]\')).opacity',
    ),
    '1',
    'a folder’s settings button appears when its heading has focus',
  );
  await menuAction(postsMenu, 'collapse');
  assert.equal(
    await run(
      "!document.querySelector('[data-folder-toggle=\"Posts/Ideas\"]')&&document.querySelector('[data-folder-toggle=\"Posts\"]').getAttribute('aria-expanded')==='false'",
    ),
    true,
    'Collapse all closes the collection and its folders',
  );
  await menuAction(postsMenu, 'expand');
  assert.equal(
    await run(
      "['Posts','Posts/Ideas','Posts/Ideas/Archive'].every(path=>document.querySelector('[data-folder-toggle=\"'+path+'\"]')?.getAttribute('aria-expanded')==='true')",
    ),
    true,
    'Expand all opens the collection and every folder inside it',
  );
  await menuAction('[data-folder-menu="Posts/Ideas"]', 'collapse');
  assert.equal(
    await run(
      "document.querySelector('[data-folder-toggle=\"Posts/Ideas\"]').getAttribute('aria-expanded')==='false'&&!document.querySelector('[data-folder-toggle=\"Posts/Ideas/Archive\"]')",
    ),
    true,
    'a folder’s Collapse all closes it and the folders inside',
  );
  await menuAction('[data-folder-menu="Posts/Ideas"]', 'expand');
  assert.equal(
    await run(
      '(()=>{const trigger=document.querySelector(\'[data-folder-menu="Posts/Ideas"]\');trigger.click();const label=trigger.nextElementSibling.querySelector(\'[data-menu-item="reveal"]\')?.textContent.trim();trigger.nextElementSibling.hidePopover();return label;})()',
    ),
    process.platform === 'darwin'
      ? 'Reveal in Finder'
      : process.platform === 'win32'
        ? 'Show in File Explorer'
        : 'Show in folder',
    'Reveal is named for the system’s file manager',
  );
  await capture('collection-folders.png');
  await menuAction('[data-folder-menu="Posts/Ideas"]', 'delete');
  assert.match(
    await answerConfirm(true),
    /Delete the “Ideas” folder\?/,
    'deleting a folder asks first',
  );
  assert.equal(
    await run(
      "!state.requests.some(request=>request.folder.startsWith('Posts/'))&&state.requests.some(request=>request.folder==='Posts')&&!Object.keys(state.collectionHttpSettings).some(path=>path.startsWith('Posts/'))&&!Object.keys(state.collectionAuth).some(path=>path.startsWith('Posts/'))&&state.collectionHttpSettings.Posts?.timeoutMs===2222",
    ),
    true,
    'deleting a folder removes it, its folders, and their settings, and keeps the collection',
  );
  await capture('collection-menu.png');
  // Tab overflow: tabs scroll, the active one stays in view, and a count opens the tab list.
  await run(
    "while(state.requests.length<20)state.requests.push(makeRequest(`Overflow ${state.requests.length}`,'GET','https://example.com','Posts'));state.tabs=[...new Set([...state.tabs,...state.requests.map(request=>request.id)])];state.active=state.tabs.at(-1);render()",
  );
  // The active tab scrolls into view smoothly; wait for it to arrive.
  for (
    let attempt = 0;
    attempt < 40 &&
    !(await run(
      "(()=>{const strip=document.querySelector('.request-tab-strip').getBoundingClientRect(),active=document.querySelector('.request-tab.active').getBoundingClientRect();return Number(document.querySelector('[data-tab-overflow]')?.textContent.trim().slice(1))>0&&Boolean(document.querySelector('[data-tab-scroll=left]'))&&active.right<=strip.right+1&&active.left>=strip.left-1;})()",
    ));
    attempt++
  )
    await pause(50);
  assert.equal(
    await run(
      "(()=>{const strip=document.querySelector('.request-tab-strip').getBoundingClientRect(),active=document.querySelector('.request-tab.active').getBoundingClientRect();return Number(document.querySelector('[data-tab-overflow]')?.textContent.trim().slice(1))>0&&Boolean(document.querySelector('[data-tab-scroll=left]'))&&active.right<=strip.right+1&&active.left>=strip.left-1;})()",
    ),
    true,
    'overflowing tabs scroll, keep the active tab in view, and show how many are hidden',
  );
  await capture('tab-overflow.png');
  await run("document.querySelector('[data-tab-overflow]').click()");
  await pause(60);
  assert.equal(
    await run("document.querySelector('#request-tab-menu').matches(':popover-open')"),
    true,
    'the hidden-tab count opens the tab list',
  );
  assert.equal(
    await run(
      "(()=>{const tabs=[...document.querySelectorAll('.request-tab')];const items=[...document.querySelectorAll('#request-tab-menu [data-tab-reopen]')];return tabs.length>0&&items.length>0&&[...tabs,...items].every(item=>item.querySelector('.method .method-icon'));})()",
    ),
    true,
    'request tabs and the tab menu’s requests show their method icon',
  );
  assert.equal(
    await run(
      "(()=>{const rows=[...document.querySelectorAll('.collection-request-row')];return rows.length>0&&rows.every(row=>row.querySelector('.method .method-icon'));})()",
    ),
    true,
    'explorer request rows show their method icon',
  );
  await capture('tab-menu.png');
  await run("document.querySelector('#request-tab-menu').hidePopover()");
  // Keyboard shortcuts sheet: ? opens it (not while typing), it filters, and Esc closes it.
  await run(
    "document.activeElement?.blur();document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true}))",
  );
  await pause(80);
  assert.equal(
    await run(
      "Boolean(document.querySelector('[data-shortcuts-dialog]')?.open)&&document.querySelectorAll('.shortcuts-groups dt').length>10",
    ),
    true,
    '? opens the keyboard shortcuts sheet',
  );
  await run(
    "(()=>{const input=document.querySelector('.shortcuts-search input');input.value='dev tools';input.dispatchEvent(new Event('input'));})()",
  );
  await pause(30);
  assert.equal(
    await run(
      "[...document.querySelectorAll('.shortcuts-groups dt')].map(item=>item.textContent).join()",
    ),
    'Show or hide dev tools',
    'the shortcuts sheet filters',
  );
  // In a modal dialog the text menu renders inside it, since everything outside is inert.
  await rightClick('.shortcuts-search input');
  assert.equal(
    await run(
      "(()=>{const menu=document.querySelector('[data-text-menu]');return menu.matches(':popover-open')&&Boolean(menu.closest('dialog[open]'))})()",
    ),
    true,
    'the text menu opens inside the modal shortcuts dialog',
  );
  const modalSelectAll = (await run(
    "(()=>{const box=document.querySelector('[data-text-menu] [data-menu-item=select-all]').getBoundingClientRect();return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)}})()",
  )) as { x: number; y: number };
  window.webContents.sendInputEvent({
    type: 'mouseDown',
    ...modalSelectAll,
    button: 'left',
    clickCount: 1,
  });
  window.webContents.sendInputEvent({
    type: 'mouseUp',
    ...modalSelectAll,
    button: 'left',
    clickCount: 1,
  });
  await pause(80);
  assert.equal(
    await run(
      "(()=>{const field=document.querySelector('.shortcuts-search input');return document.activeElement===field&&field.selectionStart===0&&field.selectionEnd===field.value.length&&field.value.length>0})()",
    ),
    true,
    'a real click on the text menu works inside the modal',
  );
  await capture('shortcuts.png');
  await run(
    "document.querySelector('[data-shortcuts-dialog]').dispatchEvent(new Event('cancel',{cancelable:true}))",
  );
  await pause(30);
  assert.equal(
    await run("!document.querySelector('[data-shortcuts-dialog]')"),
    true,
    'Escape closes the shortcuts sheet',
  );
  await run(
    "(()=>{const input=document.querySelector('#url');input.focus();input.dispatchEvent(new KeyboardEvent('keydown',{key:'?',bubbles:true}));})()",
  );
  await pause(30);
  assert.equal(
    await run("!document.querySelector('[data-shortcuts-dialog]')"),
    true,
    '? while typing does not open the sheet',
  );
  await run("clearToasts();state=window.menuOriginal;view='Collections';render()");
}
