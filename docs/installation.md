---
description: Install API Workbench on macOS, Windows, or Linux, verify the download, deploy it across an organization, and uninstall it.
icon: download
---

# Installation

API Workbench is a desktop app for macOS, Windows, and Linux, on Intel or AMD (x64) and Arm (arm64) processors, with a command line and a VS Code extension. It needs no account, licence server, or cloud service: download it, install it, and start sending requests.

```cards
- title: Verify
  icon: shield-check-outline
  href: '#check-a-download'
  text: Checksums, build provenance, and signatures.
- title: Deploy
  icon: domain
  href: '#deploy-across-an-organization'
  text: Silent installs, update policy, and network access.
- title: Uninstall
  icon: delete-outline
  href: '#uninstall'
  text: Remove the app, and optionally your data.
```

## System requirements

| System  | Versions                                   | Architectures                      |
| ------- | ------------------------------------------ | ---------------------------------- |
| macOS   | 12 (Monterey) or later                     | Apple silicon (arm64), Intel (x64) |
| Windows | 10 or 11                                   | x64, arm64                         |
| Linux   | 64-bit, with a desktop environment         | x64, arm64                         |
| Any     | The [command line](cli.md), Node.js 22.19+ | Any                                |

- **Administrator rights** are not needed for the Windows installer when you install it for yourself, or for the macOS `.dmg`, the Linux AppImage, or the portable and archive builds. The macOS `.pkg`, the Linux `.deb` and `.rpm`, and an all-users Windows install need them.
- **Linux** needs a keyring service, such as GNOME Keyring or KWallet, for the credential vault to encrypt secrets — see [Platform notes](#platform-notes). The AppImage also needs FUSE 2 (`libfuse2`; `libfuse2t64` on Ubuntu 24.04).
- **Network access** is needed only for the APIs you call and for update checks — see [Network access](#network-access).

## Download an installer

Choose your system, architecture, and version, and the picker below gives the download link, the commands to download and check the file from a terminal, and every file of that version. It starts from the computer you are reading on.

```download
The download picker appears here on the documentation website. In Markdown, see the table below.
```

Every file is attached to its release on [GitHub Releases](https://github.com/techieutils/api-workbench/releases), at this address:

```text
https://github.com/techieutils/api-workbench/releases/download/v<version>/<file>
```

The files are:

| System  | Architecture             | File                                                                                                                                                                              |
| ------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | Apple silicon, Intel     | `API-Workbench-<version>-mac-arm64.dmg` or `-mac-x64.dmg`: open it and drag API Workbench to Applications. The `.pkg` installs it into Applications for you; `.zip` holds the app |
| Windows | x64 and arm64            | `API-Workbench-Setup-<version>.exe`: one installer for both, which lets you choose who it is installed for and where, and adds desktop and Start menu shortcuts                   |
| Windows | x64, arm64               | `API-Workbench-<version>-win-portable-x64.exe` runs without installing; `API-Workbench-<version>-win-x64.zip` is a portable archive. Replace `x64` with `arm64` for Arm           |
| Linux   | x86_64, arm64            | `API-Workbench-<version>-linux-x86_64.AppImage`: make it executable, then run it                                                                                                  |
| Linux   | x86_64, arm64            | `.deb` (`amd64` or `arm64`), `.rpm` (`x86_64` or `aarch64`), and `.tar.gz` (`x64` or `arm64`) packages, such as `API-Workbench-<version>-linux-amd64.deb`                         |
| Any     | Any, with Node.js 22.19+ | `api-workbench-cli.cjs`: the [command line](cli.md)                                                                                                                               |

Not sure which architecture you have? On a Mac, choose **Apple menu → About This Mac**: a chip named Apple M1 or later is Apple silicon (`arm64`), and an Intel processor is `x64`. On Windows, **Settings → System → About** shows the system type. On Linux, `uname -m` prints `x86_64` or `aarch64`.

### Which format to choose

Most people want the first format listed for their system. The others suit managed machines, locked-down accounts, and scripted installs.

| Format                  | Installs for                      | Admin rights | Updates itself | Best for                                      |
| ----------------------- | --------------------------------- | ------------ | -------------- | --------------------------------------------- |
| macOS `.dmg`            | Whoever copies it                 | No           | Yes            | Installing on your own Mac                    |
| macOS `.pkg`            | Every account, in `/Applications` | Yes          | Yes            | MDM tools such as Jamf, Kandji, or Intune     |
| macOS `.zip`            | Whoever unzips it                 | No           | Yes            | Scripts that place the app themselves         |
| Windows installer       | You, or every account             | Only for all | Yes            | Most Windows machines; silent installs        |
| Windows portable `.exe` | Nobody: runs in place             | No           | No             | Trying it, or a machine you cannot install on |
| Windows `.zip`          | Nobody: unzip and run             | No           | No             | Running from a shared or removable drive      |
| Linux AppImage          | You                               | No           | Yes            | Any distribution, without a package manager   |
| Linux `.deb`            | Every account                     | Yes          | Yes            | Debian, Ubuntu, and their derivatives         |
| Linux `.rpm`            | Every account                     | Yes          | Yes            | Fedora, RHEL, openSUSE                        |
| Linux `.tar.gz`         | Whoever extracts it               | No           | No             | Custom locations and offline machines         |

## Install

### macOS

1. Open the `.dmg` and drag **API Workbench** to **Applications**. Or double-click the `.pkg` and follow the installer, which puts the app in `/Applications`.
2. Open API Workbench from **Applications** or Spotlight.

If macOS says it cannot verify the app or its developer, check the download first ([Check a download](#check-a-download)), then open **System Settings → Privacy & Security** and click **Open Anyway** next to the message about API Workbench. macOS asks once; the app opens normally after that.

The first time you send a request to a device on your network, macOS asks to allow local network access. Allow it, or requests to those addresses fail. You can change the choice later in **System Settings → Privacy & Security → Local Network**.

### Windows

1. Run `API-Workbench-Setup-<version>.exe`.
2. Choose **Only for me** (no administrator rights; installs in `%LOCALAPPDATA%\Programs\API Workbench`) or **Anyone who uses this computer** (installs in `C:\Program Files\API Workbench`), and the folder.
3. Open API Workbench from the Start menu or the desktop shortcut.

If Microsoft Defender SmartScreen says it prevented an unrecognized app from starting, check the download ([Check a download](#check-a-download)), then click **More info → Run anyway**.

To run without installing, download the portable `.exe` and run it, or unzip the `.zip` anywhere and run `API Workbench.exe`. Both keep your data in the same [data folder](#where-your-data-is-stored) as an installed copy, but neither updates itself.

### Linux

**AppImage** — make it executable and run it:

```sh
chmod +x API-Workbench-<version>-linux-x86_64.AppImage
./API-Workbench-<version>-linux-x86_64.AppImage
```

**Debian or Ubuntu** — install the `.deb` with apt, which also installs what it depends on:

```sh
sudo apt install ./API-Workbench-<version>-linux-amd64.deb
```

**Fedora, RHEL, or openSUSE** — install the `.rpm` with dnf (or `zypper install` on openSUSE):

```sh
sudo dnf install ./API-Workbench-<version>-linux-x86_64.rpm
```

**Archive** — extract it wherever you like and run `api-workbench` from the folder:

```sh
tar -xzf API-Workbench-<version>-linux-x64.tar.gz
```

The `.deb` and `.rpm` add API Workbench to the application menu and `api-workbench` to your path, and register `apiworkbench://` links.

### Command line

The command line is one file that runs anywhere Node.js 22.19 or later does, with no install step:

```sh
curl -fLO https://github.com/techieutils/api-workbench/releases/latest/download/api-workbench-cli.cjs
node api-workbench-cli.cjs --help
```

See [Command line](cli.md) for its commands, and [Run API tests in CI](guides/run-api-tests-in-ci.md) to use it in a pipeline with a pinned, checked version.

### VS Code extension

The extension is attached to every release as `api-workbench-vscode-<version>.vsix`, with the command line inside it. It needs VS Code 1.145 or later:

```sh
gh release download --repo techieutils/api-workbench --pattern "api-workbench-vscode-*.vsix"
code --install-extension api-workbench-vscode-*.vsix
```

Or download it from the [latest release](https://github.com/techieutils/api-workbench/releases/latest) and, in VS Code, choose **Extensions → ⋯ → Install from VSIX…**. Its file is checked like any other, against `SHA256SUMS` and its attestation (below). See [VS Code extension](vscode.md).

## Check a download

Check every file before you install it, and before you put it in a software catalogue or deployment tool. There are three checks, from quickest to strongest.

### Checksums

Each release lists the SHA-256 checksum of every file in `SHA256SUMS`. Download it into the same folder as the installer and check the installer against it:

```sh
# macOS
shasum -a 256 --check --ignore-missing SHA256SUMS
# Linux
sha256sum --check --ignore-missing SHA256SUMS
```

Each command prints `OK` next to the file you downloaded. On Windows, in PowerShell:

```powershell
(Get-FileHash '<file>').Hash.ToLower()
(Select-String -Path SHA256SUMS -SimpleMatch '<file>').Line.Split(' ')[0]
```

The two lines print the same hash when the download is intact. The download picker above gives these commands with the file name filled in.

### Build provenance

A checksum shows the file is unchanged since `SHA256SUMS` was written. To check that the file was built by API Workbench's own release workflow, verify its attestation with the [GitHub CLI](https://cli.github.com/):

```sh
gh attestation verify '<file>' --repo techieutils/api-workbench
```

It prints `Verification succeeded!` and the commit the file was built from. A file that was changed, or built anywhere else, fails.

### Code signatures

Releases are code-signed when the release workflow has the project's signing certificates. To see a file's signature:

```sh
# macOS: the signing identity, and whether Gatekeeper accepts it
codesign --display --verbose=2 '/Applications/API Workbench.app'
spctl --assess --verbose '/Applications/API Workbench.app'
```

```powershell
# Windows: the signer and whether the signature is valid
Get-AuthenticodeSignature '.\API-Workbench-Setup-<version>.exe' | Format-List
```

A file without a signature still passes the checksum and provenance checks; your system warns before opening it, as described under [Install](#install).

## Deploy across an organization

API Workbench installs per machine or per account like any desktop app, with no licence keys or sign-in, so the files from the releases page can go straight into Intune, Jamf, Configuration Manager, Ansible, or any other deployment tool. [Check each file](#check-a-download) before you add it.

### Silent installs

**Windows** — the installer takes these switches:

| Switch         | Effect                                                                       |
| -------------- | ---------------------------------------------------------------------------- |
| `/S`           | Install with no windows or questions                                         |
| `/currentuser` | Install for the account running it, in `%LOCALAPPDATA%\Programs` (default)   |
| `/allusers`    | Install for every account, in `C:\Program Files`; needs administrator rights |
| `/D=<folder>`  | Install in this folder. It must come last, and is not quoted                 |

```powershell
# For every account on the machine, from an elevated prompt or a deployment tool
.\API-Workbench-Setup-<version>.exe /S /allusers
# For the signed-in account only
.\API-Workbench-Setup-<version>.exe /S /currentuser
```

**macOS** — install the `.pkg` with `installer`, or hand it to your MDM tool as a package:

```sh
sudo installer -pkg API-Workbench-<version>-mac-arm64.pkg -target /
```

Use the `-mac-arm64` package for Apple silicon and `-mac-x64` for Intel; most MDM tools can scope each to the right machines by architecture.

**Linux** — install the package non-interactively:

```sh
sudo apt-get install -y ./API-Workbench-<version>-linux-amd64.deb
sudo dnf install -y ./API-Workbench-<version>-linux-x86_64.rpm
```

The package is named `api-workbench`, so `apt`, `dnf`, `rpm -q`, and configuration-management tools can find, upgrade, and remove it by that name.

### Control updates

Installed copies check GitHub for new versions and, by default, ask before downloading one. Each account's choice is kept in `updates.json` in its [data folder](#where-your-data-is-stored). To stop copies checking on their own — so that your deployment tool decides which version people run — place this file there before first launch:

```json
{ "mode": "off", "prerelease": false }
```

`"mode"` is `"notify"` (ask before downloading, the default), `"auto"` (download and install automatically), or `"off"` (only when the person clicks **Check for updates**). People can still change it in **Settings → Updates**; see [Updates](updates.md) for what each choice does.

An all-users Windows install asks for administrator permission when it installs an update. Where people do not have that, set `"mode": "off"` and deploy new versions yourself.

### Network access

API Workbench contacts nothing by itself except GitHub, for update checks. Everything else it sends is a request someone made: the APIs they call, OAuth sign-ins, and git remotes or GitHub Gists when they share a workspace. There is no account, analytics, or telemetry.

| Purpose                   | Hosts                                                                | When                                                 |
| ------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------- |
| Update checks, downloads  | `github.com`, and GitHub's download hosts on `githubusercontent.com` | At startup and every 6 hours, unless updates are off |
| Your requests             | The APIs, proxies, and identity providers your requests name         | When someone sends them                              |
| Team workspaces           | Your git remote; `api.github.com` for Gist sharing                   | When someone syncs or shares                         |
| Mock servers, Interceptor | `127.0.0.1` only, on the ports chosen                                | While they run                                       |

Update checks use the operating system's proxy settings. The proxy in **Settings → Requests** applies only to the requests people send — see [Proxy](settings.md#proxy). Behind a TLS-inspecting proxy, add your organization's root certificate with **Settings → Certificates → Add CA file** so requests trust it; see [Trusted CA certificates](client-certificates.md#trusted-ca-certificates).

### Offline and air-gapped machines

Copy the installer and `SHA256SUMS` across, check the file, and install it as above. Set `"mode": "off"` in `updates.json` so the app does not try to reach GitHub, and bring new versions across the same way. Everything else — workspaces, the vault, mock servers, the runner — works without a network.

## Stay up to date

Installed copies check GitHub for new versions and ask before downloading one. To download and install updates automatically, or to check only when you ask, open **Settings → Updates** — see [Updates](updates.md). The portable Windows `.exe` and `.zip`, and the Linux `.tar.gz`, do not update themselves; download a new version from [GitHub Releases](https://github.com/techieutils/api-workbench/releases) instead.

To move to an earlier version, install it over the current one. Your data is kept.

## Uninstall

Uninstalling removes the app and keeps your workspaces, collections, history, and vault in the [data folder](#where-your-data-is-stored), so a reinstall picks up where you left off. To remove everything, delete that folder too.

| System  | Remove the app                                                                                                                      |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| macOS   | Quit the app and drag **API Workbench** from **Applications** to the Trash                                                          |
| Windows | **Settings → Apps → Installed apps → API Workbench → Uninstall**. For a portable copy, delete the `.exe` or the folder you unzipped |
| Linux   | `sudo apt remove api-workbench` or `sudo dnf remove api-workbench`; for the AppImage or archive, delete the file or folder          |

To uninstall silently on Windows, run the uninstaller from the install folder with `/S`, adding `/allusers` for an all-users install:

```powershell
& "$env:LOCALAPPDATA\Programs\API Workbench\Uninstall API Workbench.exe" /S
& "C:\Program Files\API Workbench\Uninstall API Workbench.exe" /S /allusers
```

> [!CAUTION]
> Deleting the data folder deletes every workspace and secret in it, and cannot be undone. Export anything you want to keep first — see [Import and export](import-export.md). Team workspaces are kept in their own folders and are not affected.

## Build from source

You need **Node.js 22.19 or later** (24 recommended, the version Electron uses) and npm. The repository's `.nvmrc` names Node 24, so `nvm use` picks it up.

```sh
git clone https://github.com/techieutils/api-workbench.git
cd api-workbench
npm install
npm start
```

`npm start` compiles the app and opens it. To build an installer for the platform you are on, in `release/`:

```sh
npm run dist
```

A build from source keeps its data in a folder named `api-workbench`, apart from an installed copy's, and does not update itself.

## Platform notes

> [!IMPORTANT]
> **Linux:** the credential vault needs a running keyring service — GNOME Keyring or KWallet — to encrypt secrets. Most desktop environments start one automatically. Without it the app still works, but it will not store secrets. See [Troubleshooting](troubleshooting.md#linux-no-keyring).

- **macOS** may ask for Keychain access the first time you open **Credentials**. Allow it so the vault can encrypt your secrets.
- **Windows** encrypts the vault with your Windows account (DPAPI); there is nothing to set up.

## Where your data is stored

Everything stays in the app's user data folder on your machine, one for each account:

| Platform | Folder                                        |
| -------- | --------------------------------------------- |
| macOS    | `~/Library/Application Support/API Workbench` |
| Windows  | `%APPDATA%\API Workbench`                     |
| Linux    | `~/.config/API Workbench`                     |

Back up this folder to back up everything. Besides workspaces, it holds `workspaces.json` (the workspace list) and `updates.json` (the [update choice](#control-updates)).

Each workspace has a `workspace.json` (environments, settings, history, tabs, cookies, and any saved responses), an encrypted `credentials.enc`, a `collections` folder (a folder for each collection and each folder inside it, with every request in its own readable YAML file), a `specs` folder with each [API specification](api-specs.md) as written, and a `mocks` folder with a YAML file per [mock server](mock-servers.md).

```
collections/
  Posts/
    _collection.yaml      name, order, HTTP settings, default authorization
    Get all posts.yaml    one request
    Drafts/
      _folder.yaml
      Create draft.yaml
specs/
  Shop API.yaml           an OpenAPI or Swagger document, exactly as written
mocks/
  Shop mock.yaml          port, CORS setting, and routes
```

File and folder names are made safe for every system; the real names are kept inside the files. You can edit these files — the request files, `workspace.json`, and `workspaces.json` — in any editor, or update them with git, while the app is open: changes reload into the window, with a notice. Switching the open workspace still happens in the app: if `workspaces.json` changes the active workspace or removes the open one, the open workspace stays open and listed. A request file you add gets an `id:` line at the top and is otherwise left as you wrote it. If a file has invalid YAML or JSON, the app keeps what it has, tells you, and does not overwrite the file until you fix it; when an edit outside the app and one inside it cross, the file on disk wins. When run from source, the folder is named `api-workbench` instead.

## Next

Continue with the [Quick start](getting-started.md), or take a [tour of the interface](interface.md).
