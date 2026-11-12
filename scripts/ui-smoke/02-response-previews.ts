import assert from 'node:assert/strict';
import { pause, type SmokeContext } from './harness';

/** UI smoke checks, part 2: response previews. */
export default async function responsePreviews(context: SmokeContext) {
  const { run, capture, answerConfirm } = context;
  // Pretty previews of non-text bodies; octet-stream stays in the editor.
  const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
  const pdfBase64 = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
  ).toString('base64');
  const showResponse = (contentType: string, body: string, bodyBase64?: string) =>
    run(
      `window.previewOriginal??=structuredClone(current());current().response={status:200,statusText:'OK',headers:{'content-type':${JSON.stringify(contentType)}},body:${JSON.stringify(body)},${bodyBase64 ? `bodyBase64:${JSON.stringify(bodyBase64)},` : ''}time:12,size:${bodyBase64 ? Buffer.from(bodyBase64, 'base64').length : body.length},url:'http://127.0.0.1/'};responseTab='Body';responseMode='Pretty';requestTab='Params';view='Collections';render()`,
    );
  await showResponse('image/png', '', pngBase64);
  for (
    let attempt = 0;
    attempt < 30 && !(await run("document.querySelector('[data-image-preview]')?.complete"));
    attempt++
  )
    await pause(50);
  assert.equal(
    await run(
      "(()=>{const image=document.querySelector('[data-image-preview]');return image.naturalWidth===1&&image.src.startsWith('blob:')&&document.querySelector('.response-preview-bar').textContent.includes('1 × 1')&&!document.querySelector('#response-editor-language');})()",
    ),
    true,
    'PNG bodies show as images with their size, without the text tools',
  );
  await showResponse('application/pdf', '', pdfBase64);
  await pause(300);
  assert.equal(
    await run("document.querySelector('[data-pdf-preview]')?.src.startsWith('blob:')"),
    true,
    'PDF bodies open in the PDF viewer',
  );
  await capture('response-pdf-preview.png');
  await showResponse(
    'text/html; charset=utf-8',
    '<title>Sign in</title><meta name="csrf-token" content="meta-123"><h1>Hello preview</h1><form><input type="hidden" name="csrf" value="tok-123"></form><script>window.parent.previewHacked=true</script>',
  );
  await pause(300);
  // Same origin lets the app read the page for capture; without allow-scripts nothing runs.
  assert.equal(
    await run(
      "(()=>{const frame=document.querySelector('[data-html-preview]');return frame.getAttribute('sandbox')==='allow-same-origin'&&frame.srcdoc.includes('Hello preview')&&!window.previewHacked;})()",
    ),
    true,
    'HTML renders in a sandbox where its scripts do not run',
  );
  // Right-clicking an element offers its attributes, and what the page carries but hides.
  await run(
    "window.previewCapturesBefore=structuredClone(current().captures||[]);(()=>{const frame=document.querySelector('[data-html-preview]');const input=frame.contentDocument.querySelector('input[name=csrf]');input.dispatchEvent(new frame.contentWindow.MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:5,clientY:5}));})()",
  );
  await pause(50);
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-preview-menu] [data-menu-item]')].map(item=>item.dataset.menuItem+':'+item.textContent.trim()).join(' | ')",
    ),
    'copy:Copy | element-0:type · "hidden" | element-1:name · "csrf" | element-2:value · "tok-123" | page-0:Title · "Sign in" | page-1:csrf-token · "meta-123"',
    "an element's menu offers its attributes, the page's title, and its meta content",
  );
  await run("document.querySelector('[data-preview-menu] [data-menu-item=element-2]').click()");
  await pause(50);
  assert.deepEqual(
    await run(
      '(()=>{const row=current().captures.at(-1);return [row.key,row.value,WorkbenchCaptures.captureValue(row.value,current().response)];})()',
    ),
    ['csrf', 'html input[name="csrf"] @value', 'tok-123'],
    "capturing an attribute adds an html capture that reads the element's value",
  );
  assert.equal(
    await run(
      'WorkbenchCaptures.captureValue(\'html meta[name="csrf-token"] @content\',current().response)+"|"+WorkbenchCaptures.captureValue("html h1",current().response)',
    ),
    'meta-123|Hello preview',
    'html captures read meta content and element text',
  );
  await run("current().captures=window.previewCapturesBefore;requestTab='Params';render()");
  await pause(50);
  await run("document.querySelector('[data-html-view=source]').click()");
  await pause(100);
  assert.equal(
    await run(
      "!document.querySelector('[data-html-preview]')&&Boolean(document.querySelector('#response-editor-language'))",
    ),
    true,
    'Source shows the HTML in the editor',
  );
  await run("document.querySelector('[data-html-view=rendered]').click()");
  await showResponse(
    'text/markdown; charset=utf-8',
    '# Hello markdown\n\n- one\n- two\n\n<script>window.markdownHacked=true</script>\n\n[unsafe](javascript:window.markdownHacked=true) [docs](https://example.com/docs/reference/authentication/oauth2/client-credentials?tenant=00000000-0000-0000-0000-000000000000&scope=read.write.admin)',
  );
  await pause(300);
  assert.equal(
    await run(
      "(()=>{const view=document.querySelector('[data-markdown-preview]');return view?.querySelector('h1')?.textContent==='Hello markdown'&&view.querySelectorAll('li').length===2&&!view.querySelector('script')&&view.textContent.includes('<script>')&&view.querySelectorAll('a').length===1&&!window.markdownHacked;})()",
    ),
    true,
    'Markdown renders with embedded HTML as text and only safe links',
  );
  await capture('response-markdown-preview.png');
  const location = await run('location.href');
  await run("document.querySelector('[data-markdown-preview] a').click()");
  for (
    let attempt = 0;
    attempt < 40 && !(await run("Boolean(document.querySelector('[data-confirm-dialog]')?.open)"));
    attempt++
  )
    await pause(50);
  assert.equal(
    await run(
      "document.querySelector('[data-confirm-dialog]').textContent.includes('https://example.com/docs/reference/authentication/oauth2/client-credentials?tenant=00000000-0000-0000-0000-000000000000&scope=read.write.admin')&&(()=>{const dialog=document.querySelector('[data-confirm-dialog]');return dialog.scrollWidth<=dialog.clientWidth;})()",
    ),
    true,
    'a Markdown link asks first, showing its full address',
  );
  await capture('markdown-link-confirm.png');
  // Cancel, so the smoke test never opens a real browser.
  assert.equal(await answerConfirm(false), 'Open this link in your browser?');
  assert.equal(await run('location.href'), location, 'a Markdown link never navigates the app');
  assert.equal(
    await run(
      "Promise.all(['javascript:alert(1)','file:///etc/hosts','data:text/html,x'].map(url=>window.workbench.openExternal(url).then(()=>false,()=>true))).then(refused=>refused.every(Boolean))",
    ),
    true,
    'the main process refuses to open anything but web and mail links',
  );
  await run("document.querySelector('[data-html-view=source]').click()");
  await pause(100);
  assert.equal(
    await run(
      "!document.querySelector('[data-markdown-preview]')&&Boolean(document.querySelector('#response-editor-language'))",
    ),
    true,
    'Source shows the Markdown in the editor',
  );
  await run("document.querySelector('[data-html-view=rendered]').click()");
  await showResponse(
    'application/zip',
    'PK',
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]).toString('base64'),
  );
  await pause(100);
  assert.match(
    (await run("document.querySelector('[data-hex-preview]')?.textContent")) as string,
    /^00000000 {2}50 4b 03 04 14 00/,
    'other binary bodies show their first bytes',
  );
  await showResponse(
    'application/octet-stream',
    'stream',
    Buffer.from('stream').toString('base64'),
  );
  await pause(100);
  assert.equal(
    await run(
      "!document.querySelector('.response-preview')&&Boolean(document.querySelector('#response-editor-language'))",
    ),
    true,
    'octet-stream bodies stay in the editor',
  );
  const languageSelect = "document.querySelector('#response-editor-language')";
  const languageBox = `${languageSelect}.closest('.ui-select')`;
  const chooseLanguage = async (value: string) => {
    await run(
      `${languageSelect}.value=${JSON.stringify(value)};${languageSelect}.dispatchEvent(new Event('change',{bubbles:true}))`,
    );
    await pause(150);
  };
  assert.equal(
    await run(`${languageBox}.querySelector('.ui-select-value').textContent.trim()`),
    'Auto detect · Raw',
    'Auto detect shows Raw for a body it cannot recognise',
  );
  assert.equal(
    await run(`[...${languageSelect}.options].map(option=>option.value).slice(0,4).join()`),
    'auto,raw,hex,base64',
    'the language select offers Raw, Hex, and Base64 after Auto detect',
  );
  assert.equal(
    await run(
      `${languageBox}.querySelectorAll('.ui-select-option').length===${languageBox}.querySelectorAll('.ui-select-option .ui-select-option-icon').length&&Boolean(${languageBox}.querySelector('.ui-select-value-icon'))`,
    ),
    true,
    'every content type in the select has an icon',
  );
  await chooseLanguage('hex');
  assert.match(
    (await run('responseSourceEditor.getValue()')) as string,
    /^00000000 {2}73 74 72 65 61 6d {2}/,
    'Hex shows the body bytes as a hex dump',
  );
  assert.equal(
    await run("!document.querySelector('.response-filter')"),
    true,
    'the JSON filter is hidden in a byte view',
  );
  await run(`${languageBox}.querySelector('.ui-select-trigger').click()`);
  await pause(150);
  await capture('response-language-select.png');
  await run(`${languageBox}.querySelector('.ui-select-menu').hidePopover()`);
  await chooseLanguage('base64');
  assert.equal(
    await run('responseSourceEditor.getValue()'),
    Buffer.from('stream').toString('base64'),
    'Base64 shows the body bytes encoded',
  );
  await chooseLanguage('auto');
  await showResponse('image/png', '', pngBase64);
  await pause(150);
  await capture('response-image-preview.png');
  await run(
    'Object.assign(current(),window.previewOriginal);window.previewOriginal=undefined;render()',
  );
  await run('openRequest(window.deleteOriginalActive)');

  assert.equal(
    await run("document.querySelectorAll('.bottom-layout-bar').length"),
    0,
    'there is no extra status bar',
  );
  assert.equal(
    await run(
      "document.querySelector('.status-layout-control').previousElementSibling.matches('.footer-divider')&&document.querySelector('.status-layout-control').nextElementSibling.matches('.panel-toggles')",
    ),
    true,
    'layout control appears after divider and before Panes',
  );
  assert.equal(
    await run("document.querySelector('.status-layout-trigger').textContent"),
    'Stacked',
    'status bar layout control shows selected layout',
  );
  assert.equal(
    await run("document.querySelector('#status-layout-menu').matches(':popover-open')"),
    false,
    'layout menu starts closed',
  );
  await run("document.querySelector('.status-layout-trigger').click()");
  assert.equal(
    await run(
      "document.querySelector('#status-layout-menu').matches(':popover-open')&&document.querySelectorAll('#status-layout-menu [data-panel-layout] .mdi-icon').length>=2",
    ),
    true,
    'click opens layout choices with icons',
  );
  await run(
    "document.querySelector('#status-layout-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  assert.equal(
    await run(
      "!document.querySelector('#status-layout-menu').matches(':popover-open')&&document.activeElement.matches('.status-layout-trigger')",
    ),
    true,
    'Escape closes menu and restores focus',
  );
  await run(
    "document.querySelector('.status-layout-trigger').click();document.querySelector('#status-layout-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))",
  );
  assert.equal(
    await run('document.activeElement.dataset.panelLayout'),
    'side',
    'arrow keys navigate layout options',
  );
  assert.equal(
    await run("document.querySelectorAll('.panel-toolbar [data-panel-layout]').length"),
    0,
    'layout controls are removed from top toolbar',
  );
  await run("document.querySelector('[data-panel-layout=side]').click()");
  assert.equal(
    await run(
      "!document.querySelector('#status-layout-menu').matches(':popover-open')&&document.activeElement.matches('.status-layout-trigger')",
    ),
    true,
    'choosing a layout dismisses the menu',
  );
  assert.equal(
    await run(
      "document.querySelector('.request-response-panes > .pane-resizer').getAttribute('aria-orientation')",
    ),
    'vertical',
  );
  await run(
    "document.querySelector('.request-response-panes > .pane-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))",
  );
  assert.equal(await run('requestPanels.share'), 60, 'keyboard resizes split panels');
  await run("document.querySelector('[data-toggle-panel=response]').click()");
  assert.equal(await run("Boolean(document.querySelector('.response'))"), false);
  await run(
    "document.querySelector('[data-toggle-panel=response]').click();document.querySelector('.status-layout-trigger').click();document.querySelector('[data-panel-layout=stacked]').click()",
  );
  await run("action('code')");
  assert.equal(
    await run("Boolean(document.querySelector('.code-dock .codegen-panel'))"),
    true,
    'code generator docks in the request page',
  );
  await capture('panes-code-dock.png');
  await run(
    "window.codeWidthBefore=requestPanels.codeWidth;window.codeDockBefore=document.querySelector('.code-dock').getBoundingClientRect().width;document.querySelector('.workspace-docks > .pane-resizer').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))",
  );
  assert.equal(
    await run(
      "requestPanels.codeWidth===window.codeWidthBefore+20&&JSON.parse(localStorage.getItem('api-workbench:panes')).codeWidth===requestPanels.codeWidth",
    ),
    true,
    'keyboard widens the docked code panel and remembers it',
  );
  assert.equal(
    await run(
      "Math.round(document.querySelector('.code-dock').getBoundingClientRect().width-window.codeDockBefore)",
    ),
    20,
    'the code panel follows its divider',
  );
  await run(
    "document.querySelector('.workspace-docks > .pane-resizer').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
  );
  assert.equal(
    await run('requestPanels.codeWidth'),
    360,
    'double-click resets the code panel width',
  );
}
