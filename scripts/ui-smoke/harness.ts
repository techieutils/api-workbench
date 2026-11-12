import type { BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * What every part of the UI smoke checks shares: the app's disposable data folder, the count of
 * keychain checks, and helpers that drive the window the way a person would.
 */
export const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'api-workbench-ui-'));
/** How many times the app asked whether OS encryption is available (the keychain). */
export const keychain = { checks: 0 };
/**
 * The key the parts that turn on test encryption use, so a vault saved by one part opens in
 * another when they run together.
 */
export const providerTestKey = randomBytes(32);
export const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createHarness(window: BrowserWindow) {
  /** Runs code in the renderer, failing with the code's start if it throws or hangs. */
  const run = (code: string) =>
    Promise.race([
      window.webContents.executeJavaScript(code).catch((error: Error) => {
        throw new Error(`${error.message}\nWhile running: ${code.slice(0, 160)}`);
      }),
      new Promise<never>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('Renderer evaluation timed out: ' + code.slice(0, 90))),
          10000,
        ),
      ),
    ]);
  // Screenshots go to artifacts/ with --screenshots, until capturing turns out to be unavailable.
  const screenshots = path.join(process.cwd(), 'artifacts');
  if (process.argv.includes('--screenshots')) fs.mkdirSync(screenshots, { recursive: true });
  let screenshotsAvailable = process.argv.includes('--screenshots');
  const capture = async (name: string) => {
    if (!screenshotsAvailable) return;
    await pause(100);
    try {
      fs.writeFileSync(
        path.join(screenshots, name),
        (
          await Promise.race([
            window.webContents.capturePage(),
            new Promise<never>((_resolve, reject) =>
              setTimeout(() => reject(new Error('Screenshot capture timed out')), 3000),
            ),
          ])
        ).toPNG(),
      );
    } catch (error) {
      screenshotsAvailable = false;
      console.warn('Screenshot capture unavailable in this environment:', error);
    }
  };
  // Tabs that fit show no arrows; tabs that do not fit show a next arrow, which scrolls until the
  // last tab is in view and a previous arrow appears.
  // The window is hidden, so it may render no frames (none at all after a screenshot): resize
  // observers lag and smooth scrolling never advances. A scroll event makes the row measure its
  // arrows now, and the arrows scroll the row instantly; the check is what they reveal.
  const tabsReachable = (stripSelector: string) =>
    run(
      `(async()=>{const strip=document.querySelector(${JSON.stringify(stripSelector)});const frame=strip.closest('.ui-tabs-frame');const arrow=side=>frame.querySelector('[data-tabs-arrow='+side+']');if(strip.scrollWidth<=strip.clientWidth+1)return 'fits';strip.scrollBy=options=>Element.prototype.scrollBy.call(strip,{...options,behavior:'instant'});try{strip.scrollLeft=0;strip.dispatchEvent(new Event('scroll'));await new Promise(done=>setTimeout(done,80));if(!arrow('next')){const shown=[...strip.children].filter(item=>item.getClientRects().length).at(-1);return shown&&shown.getBoundingClientRect().right<=strip.getBoundingClientRect().right-strip.clientLeft+1?'fits':'no arrow';}for(let step=0;step<12&&arrow('next');step++){arrow('next').click();await new Promise(done=>setTimeout(done,350));}const items=[...strip.children].filter(item=>item.getClientRects().length);const last=items.at(-1).getBoundingClientRect();return last.right<=strip.getBoundingClientRect().right+1&&arrow('prev')?'reachable':'hidden';}finally{delete strip.scrollBy;}})()`,
    ) as Promise<string>;
  // A real right-click: the button goes down and comes back up, as with a mouse, so a menu
  // that the release would dismiss is caught.
  const rightClick = async (selector: string) => {
    const { x, y } = (await run(
      `(()=>{const element=document.querySelector(${JSON.stringify(selector)});element.scrollIntoView({block:'center',inline:'nearest'});const box=element.getBoundingClientRect();return {x:Math.round(box.left+Math.min(24,box.width/2)),y:Math.round(box.top+box.height/2)}})()`,
    )) as { x: number; y: number };
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      x,
      y,
      button: 'right',
      clickCount: 1,
    });
    await pause(30);
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      x,
      y,
      button: 'right',
      clickCount: 1,
    });
    await pause(150);
  };
  // Confirmations use the app's dialog: wait for it, then answer.
  const answerConfirm = async (accept: boolean) => {
    for (
      let attempt = 0;
      attempt < 40 &&
      !(await run("Boolean(document.querySelector('[data-confirm-dialog]')?.open)"));
      attempt++
    )
      await pause(50);
    const title = (await run(
      "document.querySelector('#confirm-dialog-title')?.textContent",
    )) as string;
    await run(
      `document.querySelector('${accept ? '[data-confirm-accept]' : '[data-confirm-cancel]'}').click()`,
    );
    for (
      let attempt = 0;
      attempt < 40 && (await run("Boolean(document.querySelector('[data-confirm-dialog]')?.open)"));
      attempt++
    )
      await pause(50);
    await pause(50);
    return title;
  };
  // Real pointer input, so a divider can capture the pointer as it would for a user's drag.
  const drag = async (selector: string, dx: number, dy: number) => {
    const point = (await run(
      `(()=>{const box=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:Math.round(box.left+box.width/2),y:Math.round(box.top+box.height/2)};})()`,
    )) as { x: number; y: number };
    window.webContents.sendInputEvent({
      type: 'mouseDown',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    for (let step = 1; step <= 4; step++)
      window.webContents.sendInputEvent({
        type: 'mouseMove',
        x: point.x + (dx * step) / 4,
        y: point.y + (dy * step) / 4,
        button: 'left',
        modifiers: ['leftbuttondown'],
      });
    window.webContents.sendInputEvent({
      type: 'mouseUp',
      x: point.x + dx,
      y: point.y + dy,
      button: 'left',
      clickCount: 1,
    });
    await pause(100);
  };
  /**
   * Waits for the app to boot and installs the page helpers every part may use, so any part can
   * run first.
   */
  async function prepare(): Promise<void> {
    for (let i = 0; i < 100; i++) {
      if (await run("Boolean(document.querySelector('.urlbar'))")) break;
      await pause(100);
    }
    // Runs a trigger and resolves with the file the app saved through a temporary object URL.
    await run(
      "window.captureDownload=trigger=>{const create=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;let blob,name;URL.createObjectURL=value=>{blob=value;return 'blob:capture';};HTMLAnchorElement.prototype.click=function(){name=this.download;};try{trigger();}finally{URL.createObjectURL=create;HTMLAnchorElement.prototype.click=click;}return blob?blob.text().then(text=>({name,text,mime:blob.type})):Promise.resolve(undefined);};void 0",
    );
    // Sets a control and fires the event a user's edit would, so Vue v-model forms see it.
    await run(
      "window.userInput=(selector,value)=>{const control=document.querySelector(selector);if(control.type==='checkbox')control.checked=value;else control.value=value;control.dispatchEvent(new Event(control.tagName==='SELECT'||control.type==='checkbox'?'change':'input',{bubbles:true}));};void 0",
    );
  }
  return {
    window,
    run,
    prepare,
    capture,
    screenshotsAvailable: () => screenshotsAvailable,
    tabsReachable,
    rightClick,
    answerConfirm,
    drag,
  };
}
export type SmokeContext = ReturnType<typeof createHarness>;
