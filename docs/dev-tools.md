---
description: The request console, network log, performance summary, and a real terminal, in a panel above the status bar.
icon: tools
---

# Dev tools

Click **Dev tools** in the status bar — or press <kbd>⌘/Ctrl</kbd>+<kbd>J</kbd> — to open a panel that rises from the status bar, beside the navigation rail. It has four tabs: **Console**, **Network**, **Performance**, and **Terminal**.

- Drag the panel's top edge to resize it, or focus it and use the arrow keys; double-click resets it. The maximize button grows it to most of the window.
- The panel remembers its tab and height.
- The command palette can open each tab directly.

## Console

Every request's log: the request that went out, the response, redirects, authentication steps, and script output. Show the current request or all of them, and filter by level — info, success, or error. Right-click an entry to **Copy message**, **Copy URL**, **Copy entry**, or **Open request**.

## Network

Every HTTP request sent from the app, newest first, with its name, method, status, type, size, time, and a waterfall of where the time went.

- Filter by text, or by status: 2xx, 3xx, 4xx, 5xx, or failed.
- Click a row for its details. Right-click it to **Show details**, **Open request**, or **Copy URL**.
- **Clear** empties the log.

## Performance

A summary of the requests in the network log: the count, average, median, p95, slowest, how many were not 2xx, and how much was received. A chart shows the recent response times, and a bar shows the average time spent in each phase — DNS, TCP, TLS, sending, waiting, and download.

## Terminal

A real shell that starts in your home folder — your login shell on macOS and Linux, PowerShell on Windows, or another you choose. It shows on the **Terminal** tab of dev tools. **Open in new window** in its toolbar moves it, with its shells and output, into a window of its own; **Return to panel** — in that window's toolbar or on the Terminal tab — or closing the window puts it back. While a menu, dialog, or the command palette is open over the panel, the terminal steps aside until it closes.

- The arrow beside **New terminal** lists the shells installed on this computer: on macOS and Linux your login shell, **zsh**, **bash**, **sh**, and **fish** where present; on Windows **Windows PowerShell**, **PowerShell 7** (when installed), **Command Prompt**, **Git Bash**, and **WSL** where present. Choose one under **New terminal with** to open a tab running it; the tab is named after it, such as _bash 2_, and its split panes run the same shell.
- **Default shell** in the same menu sets the shell that **New terminal** and <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd> open. It is remembered on this computer by the app itself, not the window; if it is uninstalled, your login shell is used again.
- Only shells the app finds on this computer can run; the window cannot start another program.

- **New terminal** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>`</kbd>) opens another tab. Double-click a tab or press <kbd>F2</kbd> to rename it, and drag it — or press <kbd>Alt</kbd>+<kbd>←</kbd> / <kbd>→</kbd> — to reorder.
- **Split right** (<kbd>⌘/Ctrl</kbd>+<kbd>\\</kbd>) and **Split down** (<kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>\\</kbd>) divide a tab into panes. Drag a divider to resize panes, move between them with <kbd>⌘/Ctrl</kbd>+<kbd>Alt</kbd>+arrow keys, and close the focused one with <kbd>⌘/Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>W</kbd>.
- Right-click a tab to rename, split, or close it, other tabs, or tabs to its right.
- The toolbar clears the terminal, restarts its shell, or stops it.
- Shells keep running when you switch tabs, close the panel, or move the terminal between the panel and its window; with dev tools closed, the status bar shows how many are running.
- Elsewhere in the app, **Run in terminal** (such as a mock route's **Try it**) shows the terminal with the command at a new terminal's prompt, without line breaks or control characters, so it runs only when you press <kbd>Enter</kbd>.

> [!NOTE]
> The terminal runs commands as you, with your permissions. It is only available in the desktop app. It is a page of its own, drawn over the panel or in its own window, so nothing shown in the app's window — a response, a preview, an import — can type into it.
