/** Render the supplied clean vector without the raster pack's white edge. */
import { app, BrowserWindow, nativeImage } from 'electron';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

async function rebuild(): Promise<void> {
  await app.whenReady();
  const root = path.resolve(__dirname, '../..');
  const icons = path.dirname(require.resolve('@techieutils/api-workbench-assets/icons/source.svg'));
  const source = await readFile(path.join(icons, 'source.svg'), 'utf8');
  const window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 1024,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  await window.loadURL('data:text/html,<html><body></body></html>');
  async function render(size: number, padded = false): Promise<Buffer> {
    const png = Buffer.from(
      await window.webContents.executeJavaScript(`(async () => {
            const image = new Image();
            image.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(source).toString('base64'))};
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = canvas.height = ${size};
            // Leave a transparent gutter so shell scaling never samples a clipped edge.
            const inset = ${(size * (padded ? 80 : 8)) / 1024};
            const context = canvas.getContext('2d', { alpha: true });
            context.clearRect(0, 0, canvas.width, canvas.height);
            context.drawImage(image, inset, inset, ${size} - inset * 2, ${size} - inset * 2);
            // Only the navy silhouette reaches transparency. Give its antialiased
            // pixels the silhouette colour rather than a white matte.
            const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
            for (let i = 0; i < pixels.data.length; i += 4) {
                const alpha = pixels.data[i + 3];
                if (alpha > 0 && alpha < 255) {
                    pixels.data[i] = 7;
                    pixels.data[i + 1] = 25;
                    pixels.data[i + 2] = 78;
                }
            }
            context.putImageData(pixels, 0, 0);
            return Array.from(await (await new Promise(resolve => canvas.toBlob(resolve))).arrayBuffer().then(buffer => new Uint8Array(buffer)));
        })()`),
    );
    const decoded = nativeImage.createFromBuffer(png);
    const bitmap = decoded.toBitmap();
    if (decoded.isEmpty() || bitmap[3] !== 0)
      throw new Error(`Missing transparent corner at ${size}px`);
    for (let i = 0; i < bitmap.length; i += 4) {
      if (
        bitmap[i + 3] > 0 &&
        bitmap[i + 3] < 255 &&
        bitmap[i] > 120 &&
        bitmap[i + 1] > 120 &&
        bitmap[i + 2] > 120
      ) {
        throw new Error(`White fringe in native icon at ${size}px`);
      }
    }
    return png;
  }
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = await Promise.all(sizes.map((size) => render(size)));
  const header = Buffer.alloc(6 + 16 * frames.length);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    header[entry] = header[entry + 1] = sizes[index] === 256 ? 0 : sizes[index];
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(frame.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
  });
  const ico = Buffer.concat([header, ...frames]);
  const png = await render(1024);
  const dock = await render(1024, true);
  const iconset = path.join(root, 'dist/macos-icon/AppIcon.iconset');
  await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    await writeFile(path.join(iconset, `icon_${size}x${size}.png`), await render(size, true));
    await writeFile(
      path.join(iconset, `icon_${size}x${size}@2x.png`),
      await render(size * 2, true),
    );
  }
  execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconset, '-o', path.join(icons, 'icon.icns')]);
  const icns = await readFile(path.join(icons, 'icon.icns'));
  for (const theme of ['', 'light', 'dark']) {
    const directory = path.join(icons, theme);
    await writeFile(path.join(directory, 'icon.png'), png);
    await writeFile(path.join(directory, 'icon-mac.png'), dock);
    await writeFile(path.join(directory, 'icon.ico'), ico);
    await writeFile(path.join(directory, 'icon.icns'), icns);
  }
  for (const name of ['installer.ico', 'uninstaller.ico'])
    await writeFile(path.join(icons, name), ico);
  window.destroy();
  console.log('Rebuilt native PNG, ICO, and ICNS assets from clean SVG; retained macOS padding.');
  app.quit();
}
rebuild().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
