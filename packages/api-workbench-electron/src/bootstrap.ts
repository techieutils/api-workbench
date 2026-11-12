import { app } from 'electron';
import path from 'node:path';

// Apply the runtime fallback before loading HTTP/OAuth/code-generation modules.
// npm start uses a branded native bundle so the icon is also correct before JS runs.
if (process.platform === 'darwin') {
  const directory = app.isPackaged
    ? path.join(process.resourcesPath, 'icons')
    : path.dirname(require.resolve('@techieutils/api-workbench-assets/icons/icon.png'));
  app.dock?.setIcon(path.join(directory, 'icon-mac.png'));
}
import './main';
