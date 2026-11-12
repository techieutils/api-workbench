# API Workbench renderer

The renderer is Vue 3 with Pinia. Vite compiles it ahead of time into `vue-shell.js`, a classic script, so the content security policy still allows only `script-src 'self'`. Electron and secrets stay behind the preload bridge (`window.workbench`).

`public/index.html` loads three runtimes before the Vue bundle. They are built by esbuild in `scripts/copy-assets.ts` and declared in `src/globals.d.ts`:

- `mdiPaths`, the bundled MDI icon paths.
- `WorkbenchEditor`, CodeMirror (`src/editor/runtime.ts`), kept out of the Vue bundle.
- `WorkbenchTransfer`, collection import/export. Its Bruno parser's grammar library does not survive bundling with Vite, so stores call it at run time instead of importing it.

Everything else in `shared/` is imported directly.

## Layout

| Path                  | Contents                                                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `main.ts`             | Boots the app: loads the saved workspace, then renders.                                                                     |
| `shell.ts`            | The Pinia instance, mounting, and `render()`.                                                                               |
| `actions.ts`          | The named commands behind `data-action` buttons, the palette, and keyboard shortcuts.                                       |
| `stores/`             | State and logic, one store per concern (see below).                                                                         |
| `components/`         | `App.vue` and the shell, `ui/` primitives, `editor/`, `response/`, `table/`, `settings/`, `screens/`, `dialogs/`, `tools/`. |
| `commands/palette.ts` | The command palette's command list.                                                                                         |
| `composables/`        | `useRendered()` and `useLiveProtocol()`, popover menus.                                                                     |
| `utils.ts`            | `toast`, `download`, `errorMessage`, `uid`, `objectId`.                                                                     |
| `test-globals.ts`     | The globals the Electron smoke tests drive the app through. The app never reads them.                                       |

The stores:

- **Workspace document.** `workspace` holds the document, settings, variable resolution, saving, and import. `workspaces` handles storage, switching, and the manager dialog.
- **Requests.** `requests` opens, edits, and sends them; `request-tabs` keeps tab history. `request-rows`, `request-body` and `request-tests` back the editor tabs. `http-settings` and `authentication` cover transport settings and auth.
- **Responses.** `response` holds the viewer's state; `source-editors` handles formatting.
- **Live protocols.** `protocols`.
- **Everything else.** `cookies`, `vault`, `runner`, `tools` (console and code generator), `dialogs`, `screens`, `settings`, and `ui`.

## Conventions

- **The workspace document stays plain.** It is held in a `shallowRef` so saving and IPC can use `structuredClone`. Code mutates it in place, then calls `render()` (or `persist()`); both trigger the workspace store's `refresh()`, which re-renders everything that reads it.
- **Read mutated objects through getters.** Because workspace objects are mutated in place, components read them through getters (`const request = () => workspace.current()`), not through a `computed` or a prop. A computed that returns the same object does not notify its dependents.
- **Non-reactive state goes through `useRendered()`.** This covers raw caches, live sessions, and the window size; the value re-evaluates on each `render()`. Live protocol views use `useLiveProtocol()`, which also follows the protocols store as events stream in.
- **Mark identity-sensitive objects raw.** A setup store's returned values are wrapped in `reactive()` when read through the store. Mark caches whose objects must keep their identity (response snapshots, capture results, live sessions) with `markRaw`.
- **Resolve stores at call time outside components.** In stores and modules, call `useXStore()` when needed, never at module top level: modules evaluate before Pinia is active.
- **Use `v-checked` for undoable checkboxes.** Bind checkboxes whose state can be undone before Vue re-renders (a toggle followed by Discard, say) with `v-checked` from `directives/checked.ts`. Vue skips `:checked` and checkbox `v-model` DOM writes when the value equals the previous render's, which would leave the box showing the undone state.
- **Updates are asynchronous.** To focus an element after `render()`, wait for `nextTick()`.

## Styling

`src/styles/styles.css` is Tailwind source, not a browser-ready stylesheet. Build it with `npm run compile` or `npm run compile:prod`. Keep utility classes as complete static strings so Tailwind can discover them. Define shared tokens in `@theme`; style repeated components in `@layer components`. Theme, density, and response-font preferences use the root data attributes. MDI SVGs and Geist/Inter fonts remain bundled locally.
