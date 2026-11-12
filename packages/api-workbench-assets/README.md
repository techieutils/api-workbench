# API Workbench brand assets

## Native Electron icons

Sourced from the user-supplied **API-Workbench-Electron-Icons** pack:

- `src/icons/source.svg`: supplied clean vector, used to rebuild all native PNG and ICO assets without the raster pack’s white fringe.
- `src/icons/icon.icns`: macOS icon rebuilt with the same padding as the runtime Dock icon.
- `src/icons/icon-mac.png`: original PNG inset with 80px transparent margins on a 1024px canvas for standard Dock sizing.
- `src/icons/installer.ico` and `src/icons/uninstaller.ico`: rebuilt multi-resolution icons from the same clean vector.
- `src/icons/light/` and `src/icons/dark/`: the same native app assets, so theme changes retain the requested Electron icon.

Scripts and the development main process resolve these by package name, such as `@techieutils/api-workbench-assets/icons/icon.png`; packaging copies the runtime icons into the app resources. The development launcher rebuilds its branded macOS bundle when the ICNS changes.

## Web and renderer artwork

Retained from **API-Workbench-Electron-Transparent-Icons**: transparent header and overview artwork, horizontal logos, startup artwork, favicons, and touch icon under `packages/api-workbench-app/src/assets/`. Light, dark, and system preferences continue to select the corresponding renderer artwork. Functional UI icons use locally bundled MDI SVGs.

Rebuild all native assets on macOS with `npm run compile` followed by `node_modules/.bin/electron dist/scripts/rebuild-native-icons.js`. The supplied SVG is the source of truth. `swift scripts/normalize-macos-icon.swift` can also regenerate padded macOS assets from the clean native PNG.

Native icon rendering uses an explicit transparent canvas, a small transparent gutter on Windows/Linux, and navy antialiased silhouette pixels to prevent a white matte during shell scaling. macOS retains its 80px Dock inset. The rebuild checks decoded PNG corners and rejects white translucent edges at every exported size. Web artwork is independent.
