import { runScript } from '@techieutils/api-workbench-common/script-engine';
import type { ScriptInput } from '@techieutils/api-workbench-common/scripts';

/**
 * The utility process request scripts run in (scripts.ts starts it). It does one thing: runs each
 * script it is sent in the QuickJS engine and sends back what the script did.
 */
interface ParentPort {
  on(
    event: 'message',
    listener: (event: { data: { id: number; input: ScriptInput } }) => void,
  ): void;
  postMessage(message: unknown): void;
}
const port = (process as unknown as { parentPort?: ParentPort }).parentPort;
port?.on('message', async ({ data }) => {
  const output = await runScript(data.input);
  port.postMessage({ id: data.id, output });
});
