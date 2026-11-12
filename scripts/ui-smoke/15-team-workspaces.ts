import { dialog } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { type SmokeContext, pause } from './harness';

/** UI smoke checks, part 15: team workspaces in a shared folder. */
export default async function teamWorkspaces(context: SmokeContext) {
  const { run, capture } = context;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-team-ui-'));
  const wait = async (code: string, ms = 10000) => {
    const deadline = Date.now() + ms;
    while (!(await run(code))) {
      if (Date.now() > deadline) throw new Error(`Team workspace check timed out: ${code}`);
      await pause(50);
    }
  };
  // The system folder picker answers with the temporary team folder.
  const originalOpenDialog = dialog.showOpenDialog;
  dialog.showOpenDialog = (async () => ({
    canceled: false,
    filePaths: [folder],
  })) as typeof dialog.showOpenDialog;
  const original = (await run('workspaceUI.id')) as string;
  try {
    // A secret typed into a header stays on this device when the workspace is shared.
    await run(
      "current().headers.push({enabled:true,key:'X-Api-Key',value:'UI-TEAM-SECRET'});persist();render()",
    );
    await run('openWorkspaceManager()');
    await wait("Boolean(document.querySelector('[data-workspace-team]'))");
    await run("document.querySelector('[data-workspace-team]').click()");
    await wait("document.activeElement?.id==='team-member-name'");
    // A name is required before anything is shared.
    await run(
      "(()=>{const field=document.querySelector('#team-member-name');field.value='';field.dispatchEvent(new Event('input'));})()",
    );
    await run("document.querySelector('[data-workspace-share]').click()");
    await wait(
      "document.querySelector('#team-member-error')?.textContent.includes('Enter your name')",
    );
    await run(
      "(()=>{const field=document.querySelector('#team-member-name');field.value='Ada Tester';field.dispatchEvent(new Event('input'));})()",
    );
    await capture('team-workspace-form.png');
    await run("document.querySelector('[data-workspace-share]').click()");
    await wait(
      "!workspaceUI.open&&Boolean(document.querySelector('.topbar .workspace-team-icon'))&&teamUI.member?.name==='Ada Tester'",
    );
    await run('persist()');
    await wait("document.querySelector('#save-status').textContent==='Saved to the team folder'");
    const teamFile = JSON.parse(fs.readFileSync(path.join(folder, 'workspace.json'), 'utf8'));
    assert.equal(teamFile.storage, 'team');
    const sharedText = fs
      .readdirSync(folder, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => fs.readFileSync(path.join(entry.parentPath, entry.name), 'utf8'))
      .join('\n');
    assert.ok(!sharedText.includes('UI-TEAM-SECRET'), 'the secret header value is not shared');
    assert.equal(
      await run("current().headers.find(row=>row.key==='X-Api-Key').value"),
      'UI-TEAM-SECRET',
      'you keep your own secret',
    );

    // A teammate opens the workspace and the request you are on.
    const requestId = (await run('current().id')) as string;
    const presence = path.join(folder, '.workbench', 'presence');
    fs.mkdirSync(presence, { recursive: true });
    const sam = { id: randomUUID(), name: 'Sam Teammate' };
    fs.writeFileSync(
      path.join(presence, `${sam.id}.json`),
      JSON.stringify({
        member: sam,
        requestId,
        requestName: 'Their view',
        updatedAt: new Date().toISOString(),
      }),
    );
    await wait("Boolean(document.querySelector('[data-team-presence]'))");
    assert.match(
      (await run(
        "document.querySelector('[data-team-presence]').getAttribute('aria-label')",
      )) as string,
      /Sam Teammate \(on Their view\)/,
    );
    await wait(
      "document.querySelector('[data-request-presence]')?.textContent.includes('Sam Teammate')",
    );
    await capture('team-workspace-presence.png');
    // Your own presence file says where you are.
    const own = fs.readdirSync(presence).find((name) => !name.startsWith(sam.id));
    assert.ok(own, 'your presence file is written');
    for (let attempt = 0; attempt < 40; attempt++) {
      const value = JSON.parse(fs.readFileSync(path.join(presence, own!), 'utf8'));
      if (value.requestId === requestId) break;
      await pause(100);
    }
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(presence, own!), 'utf8')).member.name,
      'Ada Tester',
    );

    // The teammate renames the request; it updates here with a notice naming it.
    const requestFile = fs
      .readdirSync(path.join(folder, 'collections'), { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith('_'))
      .map((entry) => path.join(entry.parentPath, entry.name))
      .find((file) => fs.readFileSync(file, 'utf8').includes(`id: ${requestId}`))!;
    fs.writeFileSync(
      requestFile,
      fs.readFileSync(requestFile, 'utf8').replace(/^name: .*$/m, 'name: Renamed by Sam'),
    );
    await wait("current().name==='Renamed by Sam'");
    // The notice names only the request that changed.
    await wait(
      "[...document.querySelectorAll('.toast')].some(toast=>toast.textContent.includes('Teammates updated “Renamed by Sam”')&&!toast.textContent.includes('more'))",
    );
    assert.equal(
      await run("current().headers.find(row=>row.key==='X-Api-Key').value"),
      'UI-TEAM-SECRET',
      'your secret survives a teammate’s edit',
    );

    // The teammate's history appears with their name; only your own can be removed or cleared.
    fs.mkdirSync(path.join(folder, 'history'), { recursive: true });
    fs.writeFileSync(
      path.join(folder, 'history', `${sam.id}.json`),
      JSON.stringify({
        member: sam,
        entries: [
          {
            requestId,
            method: 'GET',
            url: 'https://api.example.com/from-sam',
            status: 200,
            date: new Date().toISOString(),
          },
        ],
      }),
    );
    await wait("state.history.some(entry=>entry.author?.name==='Sam Teammate')");
    await run("document.querySelector('[data-view=History]').click()");
    await wait(
      "document.querySelector('[data-history-author]')?.textContent.includes('Sam Teammate')",
    );
    assert.match(
      (await run("document.querySelector('.panel').textContent")) as string,
      /from teammates, in the team folder/,
    );
    assert.equal(
      await run("document.querySelector('[data-private-status]').textContent.trim()"),
      'Team workspace',
    );
    await capture('team-workspace-history.png');

    // Fresh presence stops after the teammate leaves.
    fs.rmSync(path.join(presence, `${sam.id}.json`));
    await wait("!document.querySelector('[data-team-presence]')");
  } finally {
    dialog.showOpenDialog = originalOpenDialog;
  }
  // Back to the original workspace; leaving the team workspace keeps the shared folder.
  const teamId = (await run('workspaceUI.id')) as string;
  await run(`selectWorkspace(${JSON.stringify(original)})`);
  await wait(`workspaceUI.id===${JSON.stringify(original)}&&!workspaceUI.busy`);
  await wait("!document.querySelector('.topbar .workspace-team-icon')");
  await run(`window.workbench.workspaces.delete(${JSON.stringify(teamId)})`);
  assert.ok(fs.existsSync(path.join(folder, 'workspace.json')), 'the shared folder stays');
  // The secret header added for this check is removed again.
  await run(
    "current().headers=current().headers.filter(row=>row.key!=='X-Api-Key');persist();render()",
  );
  fs.rmSync(folder, { recursive: true, force: true });
}
