import assert from 'node:assert/strict';
import { keychain, pause, type SmokeContext } from './harness';

/** UI smoke checks, part 5: settings and authentication. */
export default async function settingsAndAuthentication(context: SmokeContext) {
  const { run, capture, tabsReachable, window } = context;
  /** A real mouse click at a point, as a person makes one (not a script's click()). */
  const mouseClick = async (x: number, y: number) => {
    window.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
    await pause(150);
  };
  const centre = async (selector: string) =>
    (await run(
      `(()=>{const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)}})()`,
    )) as { x: number; y: number };
  const panelOpen = () => run("document.querySelector('#privacy-panel').matches(':popover-open')");
  // "Private workspace" opens a panel saying what stays private, from live state.
  await run("document.querySelector('[data-private-status]').click()");
  await pause(200);
  assert.deepEqual(
    await run(
      "(()=>{const panel=document.querySelector('#privacy-panel');const row=(key)=>{const item=panel.querySelector(`[data-privacy-row=${key}]`);return [item.dataset.tone,item.querySelector('strong').textContent.trim(),item.querySelector('span').textContent.trim()]};return {open:panel.matches(':popover-open'),expanded:document.querySelector('[data-private-status]').getAttribute('aria-expanded'),rows:[...panel.querySelectorAll('[data-privacy-row]')].map((item)=>item.dataset.privacyRow),secrets:row('secrets'),history:row('history'),network:row('network')[2],actions:[...panel.querySelectorAll('.privacy-panel-actions button')].map((button)=>button.textContent.trim())}})()",
    ),
    {
      open: true,
      expanded: 'true',
      rows: ['storage', 'secrets', 'history', 'network'],
      // Until Credentials checks the keychain, the panel names the platform's store without asking it.
      secrets: [
        'success',
        `Secrets encrypted with ${
          process.platform === 'darwin'
            ? 'macOS Keychain'
            : process.platform === 'win32'
              ? 'Windows DPAPI'
              : 'your system keyring'
        }`,
        'Saved credentials never leave the app’s main process; the interface only sees their names.',
      ],
      history: [
        'success',
        'History on, up to 100 entries',
        'Responses stay in memory and are gone when you quit.',
      ],
      // A build run from source never checks for updates.
      network: 'Only the requests you send leave this device.',
      actions: ['Workspace folder', 'Privacy settings', 'Credentials'],
    },
    'the Private workspace panel describes storage, secrets, history, and network use',
  );
  assert.equal(
    await run(
      "new Set([...document.querySelectorAll('#privacy-panel .privacy-panel-actions button')].map((button)=>Math.round(button.getBoundingClientRect().top))).size",
    ),
    1,
    'the panel actions fit on one row',
  );
  await capture('privacy-panel.png');
  await run(
    "document.querySelector('#privacy-panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
  );
  await pause(80);
  assert.deepEqual(
    await run(
      "[document.querySelector('#privacy-panel').matches(':popover-open'),document.activeElement?.dataset.privateStatus!==undefined]",
    ),
    [false, true],
    'Escape closes the panel and returns focus to Private workspace',
  );
  // With the mouse: Private workspace opens and closes it again, and a click outside closes it.
  const button = await centre('[data-private-status]');
  await mouseClick(button.x, button.y);
  assert.equal(await panelOpen(), true, 'clicking Private workspace opens the panel');
  await mouseClick(button.x, button.y);
  assert.equal(await panelOpen(), false, 'clicking Private workspace again closes it');
  await mouseClick(button.x, button.y);
  assert.equal(await panelOpen(), true);
  await mouseClick(40, 600);
  assert.equal(await panelOpen(), false, 'a click outside the panel closes it');
  // On macOS a drag area takes clicks for the window, so the bar must not drag while it is open.
  const region = (selector: string) =>
    run(
      `(()=>{const style=getComputedStyle(document.querySelector(${JSON.stringify(selector)}));return style.getPropertyValue('app-region')||style.getPropertyValue('-webkit-app-region');})()`,
    );
  assert.equal(await region('.topbar'), 'drag', 'the top bar drags the window');
  await mouseClick(button.x, button.y);
  assert.deepEqual(
    [await region('.topbar'), await region('#privacy-panel')],
    ['no-drag', 'no-drag'],
    'while the panel is open, neither it nor the top bar is a drag area',
  );
  const brand = await centre('.brand');
  await mouseClick(brand.x, brand.y);
  assert.equal(await panelOpen(), false, 'a click on the top bar closes it');
  assert.equal(await region('.topbar'), 'drag');
  await run(
    "document.querySelector('[data-private-status]').click();document.querySelector('[data-privacy-settings]').click()",
  );
  await pause(120);
  assert.deepEqual(
    await run(
      "[view,document.querySelector('.settings-nav button.active')?.dataset.settingsSection,document.querySelector('#privacy-panel').matches(':popover-open')]",
    ),
    ['Settings', 'Privacy', false],
    'Privacy settings opens Settings → Privacy and closes the panel',
  );
  await run("document.querySelector('[data-view=Settings]').click()");
  await pause(100);
  // In a narrow settings area the sections become a tab row with scroll arrows.
  await run("document.querySelector('.settings-panel').style.width='560px'");
  await pause(80);
  assert.equal(
    await run("getComputedStyle(document.querySelector('.settings-nav')).flexDirection"),
    'row',
    'a narrow settings area shows the sections as a tab row',
  );
  assert.equal(
    await tabsReachable('.settings-nav'),
    'reachable',
    'settings sections that do not fit are reachable with the arrows',
  );
  await run("document.querySelector('[data-settings-section=Shortcuts]').click()");
  await pause(50);
  assert.equal(
    await run("Boolean(document.querySelector('[data-settings-section=Shortcuts].active'))"),
    true,
    'a section reached with the arrows can be opened',
  );
  // Updates: a build run from source cannot update itself, and says so instead of checking.
  await run("document.querySelector('[data-settings-section=Updates]').click()");
  await pause(80);
  await capture('settings-updates.png');
  assert.deepEqual(
    await run(
      "({state:document.querySelector('[data-testid=update-status]')?.dataset.state,text:document.querySelector('[data-testid=update-status] p')?.textContent,check:Boolean([...document.querySelectorAll('.update-actions button')].length),disabled:[document.querySelector('#setting-updateMode').disabled,document.querySelector('#setting-updatePrerelease').disabled],notes:['updateMode','updatePrerelease'].map((name)=>document.querySelector(`#setting-${name}-description`).textContent.trim().endsWith('Takes effect in installed builds.')),save:Boolean(document.querySelector('.settings-save'))})",
    ),
    {
      state: 'unsupported',
      text: 'Updates are installed by released builds; this one was run from source.',
      check: false,
      disabled: [false, false],
      notes: [true, true],
      save: false,
    },
    'Settings → Updates explains that a source build does not update, but its choices can still be set',
  );
  // Changed here, the choices are saved at once for installed copies to use.
  await run(
    "userInput('[name=updateMode]','auto');document.querySelector('#setting-updatePrerelease').click()",
  );
  await pause(150);
  assert.deepEqual(
    await run(
      "window.workbench.updates.info().then((info)=>[info.preferences,document.querySelector('#setting-updatePrerelease').checked,document.querySelector('#setting-updateMode-description').textContent.trim()])",
    ),
    [
      { mode: 'auto', prerelease: true },
      true,
      'Downloads new versions in the background and installs them when you quit. Takes effect in installed builds.',
    ],
    'the update mode and pre-releases can be changed from a source build',
  );
  assert.deepEqual(
    await run(
      "window.workbench.updates.setPreferences({mode:'off',prerelease:true}).then(async(set)=>{const again=await window.workbench.updates.info();await window.workbench.updates.setPreferences({mode:'sometimes'});return [set.preferences,again.preferences,(await window.workbench.updates.info()).preferences,again.currentVersion]})",
    ),
    [
      { mode: 'off', prerelease: true },
      { mode: 'off', prerelease: true },
      { mode: 'notify', prerelease: false },
      '1.0.0',
    ],
    'update preferences are saved in the main process, and invalid ones fall back to the defaults',
  );
  // The status bar's version answers "is there an update?" when clicked, and a pending update
  // puts a dot on its top-right corner.
  const clickVersion = async () => {
    await run(
      "document.querySelectorAll('[data-toast-dismiss]').forEach((button)=>button.click());document.querySelector('[data-version-button]').click()",
    );
    await pause(250);
    return run(
      "[...document.querySelectorAll('.toast')].map((toast)=>[toast.querySelector('.toast-message').textContent.trim(),toast.querySelector('[data-toast-action]')?.textContent.trim()??''])",
    );
  };
  assert.deepEqual(
    await run(
      "[Boolean(document.querySelector('[data-update-pending]')),document.querySelector('[data-version-button]')?.title]",
    ),
    [false, 'Check for updates'],
    'with no update, the version has no dot and offers a check',
  );
  assert.deepEqual(
    await clickVersion(),
    [
      [
        'UpdatesUpdates are installed by released builds; this one was run from source.',
        'Settings',
      ],
    ],
    'clicking the version says why a source build does not update',
  );
  await run("document.querySelector('[data-settings-section=General]').click()");
  await run("document.querySelector('.toast [data-toast-action]').click()");
  await pause(80);
  assert.equal(
    await run("document.querySelector('[data-settings-section=Updates].active')!==null"),
    true,
    'the notice opens Settings → Updates',
  );
  await run("updatesStore.info={...updatesStore.info,status:{state:'available',version:'1.1.0'}}");
  await pause(80);
  assert.deepEqual(
    await run(
      "(()=>{const button=document.querySelector('[data-update-pending]');const dot=button?.querySelector('.update-dot');const box=button?.getBoundingClientRect(),spot=dot?.getBoundingClientRect();return {text:button?.textContent.trim(),title:button?.title,corner:Boolean(spot&&spot.width>0&&spot.top<=box.top+2&&spot.right>=box.right-2)}})()",
    ),
    { text: 'v1.0.0', title: 'Version 1.1.0 is available', corner: true },
    'a pending update shows a dot on the top-right corner of the version',
  );
  await capture('status-bar-update.png');
  assert.deepEqual(
    await clickVersion(),
    [['Update availableAPI Workbench 1.1.0 is available.', 'Download']],
    'clicking the version shows the available update, ready to download',
  );
  // The download bar is drawn in the app's accent, not the operating system's progress style.
  await run(
    "document.querySelectorAll('[data-toast-dismiss]').forEach((button)=>button.click());view='Settings';render();document.querySelector('[data-settings-section=Updates]').click();updatesStore.info={...updatesStore.info,status:{state:'downloading',version:'1.1.0',percent:64}}",
  );
  await pause(120);
  assert.deepEqual(
    await run(
      "(()=>{const bar=document.querySelector('.update-status progress');const rule=[...document.styleSheets].flatMap((sheet)=>[...sheet.cssRules]).flatMap((rule)=>rule.cssRules?[...rule.cssRules]:[rule]).find((rule)=>rule.selectorText==='.update-status progress::-webkit-progress-value');return [bar?.value,getComputedStyle(bar).appearance,rule?.style.backgroundColor]})()",
    ),
    [64, 'none', 'var(--accent)'],
    'the download progress bar uses the accent colour',
  );
  await capture('update-downloading.png');
  await run("updatesStore.info={...updatesStore.info,status:{state:'downloaded',version:'1.1.0'}}");
  await pause(50);
  assert.match(
    await run("document.querySelector('[data-update-pending]')?.title"),
    /ready to install/,
    'a downloaded update keeps the dot until it installs',
  );
  assert.deepEqual(
    await clickVersion(),
    [['Update readyVersion 1.1.0 installs when you quit, or restart now.', 'Restart now']],
    'clicking the version offers to restart into a downloaded update',
  );
  await run("updatesStore.info={...updatesStore.info,status:{state:'current'}}");
  await pause(50);
  assert.equal(
    await run("Boolean(document.querySelector('[data-update-pending]'))"),
    false,
    'the dot goes once the app is up to date',
  );
  assert.deepEqual(
    (await clickVersion())[0]?.[1],
    'Settings',
    'clicking the version checks again and reports the answer',
  );
  await run("document.querySelectorAll('[data-toast-dismiss]').forEach((button)=>button.click())");
  await run(
    "document.querySelector('[data-settings-section=Appearance]').click();document.querySelector('.settings-panel').style.width=''",
  );
  await pause(50);
  await capture('settings-appearance.png');
  await run("userInput('[name=theme]','light')");
  assert.equal(
    await run(
      "document.documentElement.dataset.theme==='light'&&getComputedStyle(document.querySelector('.settings-version .wordmark-dark')).display==='none'&&getComputedStyle(document.querySelector('.settings-version .wordmark-light')).display!=='none'",
    ),
    true,
    'Settings logo previews light theme immediately',
  );
  assert.equal(await run('settings().theme'), 'dark', 'preview does not save the theme');
  await run(
    "document.querySelector('[name=theme]').value='system';document.querySelector('[name=theme]').dispatchEvent(new Event('change'))",
  );
  assert.equal(
    await run(
      "document.documentElement.dataset.theme===(matchMedia('(prefers-color-scheme: light)').matches?'light':'dark')",
    ),
    true,
    'System preview follows the operating system theme',
  );
  await run(
    "document.querySelector('[name=theme]').value='dark';document.querySelector('[name=theme]').dispatchEvent(new Event('change'))",
  );
  assert.equal(
    await run(
      "getComputedStyle(document.querySelector('.settings-version .wordmark-light')).display==='none'&&getComputedStyle(document.querySelector('.settings-version .wordmark-dark')).display!=='none'",
    ),
    true,
    'Settings logo previews dark theme',
  );
  await run(
    "document.querySelector('[name=theme]').value='light';document.querySelector('[name=theme]').dispatchEvent(new Event('change'));document.querySelector('[data-settings-section=General]').click()",
  );
  assert.equal(
    await run('document.documentElement.dataset.theme'),
    'dark',
    'leaving Appearance restores the saved theme',
  );
  await run("document.querySelector('[data-settings-section=Appearance]').click()");
  await run(
    "userInput('[name=theme]','light');userInput('[name=density]','compact');document.querySelector('#settings-form').requestSubmit()",
  );
  assert.equal(await run('document.documentElement.dataset.theme'), 'light');
  assert.equal(await run('document.documentElement.dataset.density'), 'compact');
  assert.equal(
    await run("getComputedStyle(document.querySelector('.wordmark-dark')).display"),
    'none',
    'light theme uses its matching wordmark',
  );
  await capture('settings-light.png');
  await run("document.querySelector('[data-settings-section=Requests]').click()");
  await run(
    "userInput('[name=timeoutMs]','2000');userInput('[name=followRedirects]',false);document.querySelector('#settings-form').requestSubmit()",
  );
  assert.equal(await run('prepare(current()).timeoutMs'), 2000);
  assert.equal(await run('prepare(current()).followRedirects'), false);
  assert.equal(keychain.checks, 0, 'settings navigation does not access the keychain');
  await run(
    "window.httpSettingsOriginal=structuredClone(state);view='Collections';requestTab='Settings';httpSettingsScope='request';current().httpSettings={};state.collectionHttpSettings={};render()",
  );
  assert.equal(
    await run(
      "Boolean(document.querySelector('[data-request-tab=Settings]'))&&document.querySelector('[data-http-field=timeoutMs]').disabled&&document.querySelector('[data-http-field=timeoutMs]').value==='2000'",
    ),
    true,
    'request settings inherit workspace timeout',
  );
  await run(
    "for(const [key,value] of Object.entries({timeoutMs:1500,followRedirects:true})){const toggle=document.querySelector('[data-http-override='+key+']');toggle.checked=true;toggle.dispatchEvent(new Event('change'));userInput('[data-http-field='+key+']',value);}document.querySelector('#http-settings-form').requestSubmit()",
  );
  assert.equal(
    await run('prepare(current()).timeoutMs===1500&&prepare(current()).followRedirects===true'),
    true,
    'request overrides affect prepared HTTP payload',
  );
  assert.equal(
    await run(
      "document.querySelector('.hs-summary').textContent.includes('1.5 s')&&document.querySelector('[data-hs-count=Modified]').textContent==='2'&&document.querySelectorAll('.hs-row.is-overridden').length===2",
    ),
    true,
    'settings summarize effective values and count overrides',
  );
  await run("document.querySelector('[data-hs-filter=Modified]').click()");
  assert.equal(
    await run(
      "document.querySelectorAll('[data-hs-row]:not([hidden])').length===2&&document.querySelector('[data-hs-section=TLS]').hidden",
    ),
    true,
    'overridden filter shows only customized settings',
  );
  await run(
    "document.querySelector('[data-hs-filter=All]').click();(()=>{const input=document.querySelector('#hs-search');input.value='certificate';input.dispatchEvent(new Event('input'));})()",
  );
  assert.equal(
    await run(
      "[...document.querySelectorAll('[data-hs-row]:not([hidden])')].every(row=>row.dataset.hsSearch.includes('certificate'))&&document.querySelectorAll('[data-hs-row]:not([hidden])').length>0",
    ),
    true,
    'settings search filters rows',
  );
  await run(
    "(()=>{const input=document.querySelector('#hs-search');input.value='zzz-no-setting';input.dispatchEvent(new Event('input'));})()",
  );
  assert.equal(
    await run("!document.querySelector('.hs-empty').hidden"),
    true,
    'settings search shows an empty state',
  );
  await run(
    "httpSettingsFilter.query='';render();const toggle=document.querySelector('[data-http-override=maxRedirects]');toggle.click()",
  );
  assert.equal(
    await run(
      "document.querySelector('#http-settings-form').classList.contains('is-dirty')&&document.querySelector('#hs-status').textContent.includes('Unsaved')&&!document.querySelector('[data-http-field=maxRedirects]').disabled&&document.querySelector('[data-hs-count=Execution]').textContent==='3'",
    ),
    true,
    'enabling an override marks the form dirty and updates counts',
  );
  await run(
    "(()=>{const control=document.querySelector('[data-http-field=maxRedirects]');control.value='4';control.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  await run('requestPanels.share=75;render()');
  assert.equal(
    await run(
      "document.querySelector('[data-http-override=maxRedirects]').checked&&document.querySelector('[data-http-field=maxRedirects]').value==='4'&&document.querySelector('#http-settings-form').classList.contains('is-dirty')&&document.querySelector('#hs-status').textContent.includes('Unsaved')",
    ),
    true,
    'unsaved settings survive re-rendering',
  );
  await capture('request-settings.png');
  await run("requestPanels.share=55;requestTab='Params';render()");
  assert.equal(
    await run("document.querySelector('[data-request-tab=Settings] .count')?.textContent"),
    'Unsaved',
    'Settings tab marks unsaved edits while another tab is open',
  );
  await run("requestTab='Settings';render()");
  assert.equal(
    await run(
      "document.querySelector('[data-http-field=maxRedirects]').value==='4'&&current().httpSettings.maxRedirects===undefined",
    ),
    true,
    'drafts are restored without being saved',
  );
  await run("document.querySelector('[data-http-override=maxRedirects]').click()");
  assert.equal(
    await run(
      "!document.querySelector('#http-settings-form').classList.contains('is-dirty')&&document.querySelector('#hs-status').textContent.includes('2 overrides saved')&&!document.querySelector('[data-request-tab=Settings] .count')",
    ),
    true,
    'reverting to saved values clears the draft',
  );
  await run(
    "document.querySelector('[data-http-override=keepAlive]').click();document.querySelector('[data-http-discard]').click()",
  );
  assert.equal(
    await run(
      "!document.querySelector('[data-http-override=keepAlive]').checked&&!document.querySelector('#http-settings-form').classList.contains('is-dirty')&&!httpSettingsDrafts.size",
    ),
    true,
    'discard drops unsaved edits',
  );
  await run(
    "Array.from(document.querySelectorAll('[data-collection-http-settings]')).find(button=>button.dataset.collectionHttpSettings===current().folder).click()",
  );
  assert.equal(await run('httpSettingsScope'), 'collection', 'collection gear opens HTTP defaults');
  await run(
    "for(const [key,value] of Object.entries({timeoutMs:1800,verifyTLS:false,tlsMinVersion:'TLSv1.3'})){const toggle=document.querySelector('[data-http-override='+key+']');toggle.checked=true;toggle.dispatchEvent(new Event('change'));userInput('[data-http-field='+key+']',value);}document.querySelector('#http-settings-form').requestSubmit()",
  );
  assert.equal(
    await run(
      'prepare(state.requests.find(request=>request.id===window.httpSettingsOriginal.active)).timeoutMs',
    ),
    1500,
    'request override wins over collection defaults',
  );
  assert.equal(
    await run(
      "collectionHTTPSettings(current().folder).verifyTLS===false&&Boolean(document.querySelector('.http-verification-status'))",
    ),
    true,
    'collection saves TLS settings and shows verification status',
  );
  await run(
    "document.querySelector('[data-http-scope=request]').click();document.querySelector('[data-http-reset]').click()",
  );
  assert.equal(
    await run(
      "prepare(current()).timeoutMs===1800&&prepare(current()).httpSettings.verifyTLS===false&&document.querySelector('[data-http-source=timeoutMs]').textContent.includes('Collection')",
    ),
    true,
    'resetting request overrides restores collection inheritance',
  );
  await run("document.querySelector('[data-http-workspace]').click()");
  await run(
    "userInput('[data-http-field=timeoutMs]','2500');userInput('[data-http-field=followRedirects]',true);document.querySelector('#settings-form').requestSubmit()",
  );
  assert.equal(
    await run('settings().timeoutMs===2500&&settings().httpSettings.timeoutMs===2500'),
    true,
    'workspace HTTP settings save alongside legacy defaults',
  );
  await run("view='Collections';requestTab='Settings';httpSettingsScope='collection';render()");
  await run(
    "document.querySelector('[data-http-reset]').click();document.querySelector('[data-http-scope=request]').click()",
  );
  assert.equal(
    await run(
      'prepare(current()).timeoutMs===2500&&prepare(current()).httpSettings.verifyTLS===true',
    ),
    true,
    'resetting collection restores workspace HTTP defaults',
  );
  await run(
    "for(const [key,value] of Object.entries({tlsMinVersion:'TLSv1.3',tlsMaxVersion:'TLSv1.2'})){const toggle=document.querySelector('[data-http-override='+key+']');toggle.checked=true;toggle.dispatchEvent(new Event('change'));userInput('[data-http-field='+key+']',value);}document.querySelector('#http-settings-form').requestSubmit()",
  );
  assert.equal(
    await run(
      "document.querySelector('#http-settings-error').textContent.includes('Minimum TLS')&&Object.keys(current().httpSettings).length===0",
    ),
    true,
    'invalid TLS range is rejected without changing saved settings',
  );
  // The rejected values stay as an unsaved draft for this request until discarded.
  await run("document.querySelector('[data-http-discard]').click()");

  await run("document.querySelector('[data-http-workspace]').click()");
  await run(
    "for(const [key,value] of Object.entries({proxyMode:'custom',proxyUrl:'http://127.0.0.1:8080',proxyUsername:'ui-proxy',proxyPassword:'UI-PROXY-SECRET',proxyBypass:'localhost,.internal.example'}))userInput('[data-http-field='+key+']',value);document.querySelector('#settings-form').requestSubmit()",
  );
  assert.equal(
    await run(
      "settings().httpSettings.proxyMode==='custom'&&settings().httpSettings.proxyPassword==='UI-PROXY-SECRET'&&document.querySelector('[data-http-field=proxyPassword]').type==='password'",
    ),
    true,
    'workspace proxy route and masked credentials save',
  );
  await run("view='Collections';requestTab='Settings';httpSettingsScope='collection';render()");
  await run(
    "const collectionProxyToggle=document.querySelector('[data-http-override=proxyUrl]');collectionProxyToggle.checked=true;collectionProxyToggle.dispatchEvent(new Event('change'));userInput('[data-http-field=proxyUrl]','http://127.0.0.1:9090');document.querySelector('#http-settings-form').requestSubmit();document.querySelector('[data-http-scope=request]').click()",
  );
  assert.equal(
    await run(
      "prepare(current()).httpSettings.proxyUrl==='http://127.0.0.1:9090'&&document.querySelector('[data-http-source=proxyUrl]').textContent.includes('Collection')",
    ),
    true,
    'collection proxy overrides inherit into prepared requests',
  );
  await run(
    "const requestProxyToggle=document.querySelector('[data-http-override=proxyMode]');requestProxyToggle.checked=true;requestProxyToggle.dispatchEvent(new Event('change'));userInput('[data-http-field=proxyMode]','direct');document.querySelector('#http-settings-form').requestSubmit()",
  );
  assert.equal(
    await run("prepare(current()).httpSettings.proxyMode==='direct'"),
    true,
    'request can explicitly bypass inherited proxy',
  );
  await capture('proxy-request-settings.png');
  assert.equal(
    await run("!JSON.stringify(backupWorkspace()).includes('UI-PROXY-SECRET')"),
    true,
    'workspace export excludes proxy credentials',
  );
  await run("document.querySelector('[data-http-reset]').click()");
  assert.equal(
    await run(
      "prepare(current()).httpSettings.proxyMode==='custom'&&prepare(current()).httpSettings.proxyUrl==='http://127.0.0.1:9090'",
    ),
    true,
    'reset restores collection proxy',
  );
  await run(
    "current().protocol='sse';current().httpSettings={timeoutMs:3600000,proxyMode:'direct'};requestTab='Settings';protocolUIState(current()).tab='Settings';render()",
  );
  assert.equal(
    await run(
      "document.querySelector('#http-settings-form').dataset.httpProxyOnly==='true'&&document.querySelector('[data-http-field=proxyUrl]')!==null",
    ),
    true,
    'live protocols expose scoped proxy controls',
  );
  await run("document.querySelector('[data-http-reset]').click()");
  assert.equal(
    await run(
      "current().httpSettings.timeoutMs===3600000&&effectiveProtocolHTTPSettings(current()).proxyUrl==='http://127.0.0.1:9090'",
    ),
    true,
    'resetting live proxy overrides preserves session timeout',
  );
  await run(
    "state=window.httpSettingsOriginal;view='Settings';settingsSection='Requests';httpSettingsScope='request';render()",
  );
  await run(
    "state.settings.theme='dark';state.settings.density='comfortable';openCredentialsPage()",
  );
  assert.ok(keychain.checks > 0, 'opening Credentials starts keychain access');
  // Without a system credential store, the API Workbench vault is offered instead of a restart.
  for (
    let attempt = 0;
    attempt < 30 && !(await run("Boolean(document.querySelector('[data-workbench-vault]'))"));
    attempt++
  )
    await pause(100);
  assert.deepEqual(
    await run(
      "[document.querySelector('[data-workbench-vault]')?.dataset.workbenchVaultState,Boolean(document.querySelector('[data-vault-restart]')),document.querySelector('.credentials-panel').textContent.includes('Not set up')]",
    ),
    ['setup', false, true],
    'without OS encryption, the API Workbench vault is offered for setup',
  );
  await capture('credentials.png');
  await run(
    "credentialDraft={name:'Production identity',kind:'oauth2',allowedOrigin:'https://api.example.com',oauth:defaultOAuth()};render()",
  );
  assert.equal(await run("document.querySelector('[name=clientSecret]').type"), 'password');
  await run(
    "document.querySelector('#oauth-grant').value='client_credentials';document.querySelector('#oauth-grant').dispatchEvent(new Event('change'))",
  );
  assert.equal(await run("document.querySelector('#authorization-url-row').hidden"), true);
  await run(
    "document.querySelector('#oauth-grant').value='authorization_code';document.querySelector('#oauth-grant').dispatchEvent(new Event('change'))",
  );
  await capture('oauth-profile.png');
}
