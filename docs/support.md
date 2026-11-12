---
description: Get help with API Workbench — FAQ, troubleshooting, bug reports, and security.
navTitle: Support overview
icon: lifebuoy
---

# Support

```cards
- title: FAQ
  icon: help-circle-outline
  href: faq.md
  text: Quick answers to common questions.
- title: Troubleshooting
  icon: wrench-outline
  href: troubleshooting.md
  text: Fix vault, certificate, proxy, and connection problems.
- title: Report a bug
  icon: bug-outline
  href: https://github.com/techieutils/api-workbench/issues/new?template=bug_report.yml
  text: Tell us what happened, with steps to reproduce it.
- title: Request a feature
  icon: lightbulb-on-outline
  href: https://github.com/techieutils/api-workbench/issues/new?template=feature_request.yml
  text: Describe the problem a feature would solve.
- title: Security
  icon: shield-check-outline
  href: ../SECURITY.md
  text: Report vulnerabilities privately.
- title: Contributing
  icon: source-pull
  href: ../CONTRIBUTING.md
  text: Set up the project and send a pull request.
```

## From the app or VS Code

In the app, **Settings → Help** has each of these: **Report a problem** opens GitHub's bug report form with your app version and operating system already filled in, so you only describe what happened; **Request a feature**, **Report privately** (security), **Copy details** (your version and system), and links to the documentation, troubleshooting, the changelog, known issues, and the project. The command palette has **Help and support**, **Open documentation**, and **Report a problem on GitHub**.

Each screen also links to its own guide: **Guide** beside a screen's title (in Settings, the open section's), and a book button beside the heading of the **Scripts**, **Tests**, and **Captures** tabs. The extension's pages have a **Guide** button too.

In VS Code, the **Help and Feedback** view under **API Workbench** has the same, as does the command palette (**API Workbench: Report a Problem…**, **Request a Feature…**, **Search Known Issues…**, and the rest). A report from VS Code fills in the extension's version, VS Code's version, your platform, and how the command line runs — never paths, names, or what your requests hold; turn that off with `apiWorkbench.reportDiagnostics`. See [VS Code](vscode.md#help-and-feedback).

## Before you ask

- Search the [existing issues](https://github.com/techieutils/api-workbench/issues) — someone may have hit the same thing.
- Note your app version (bottom right of the window) and operating system.
- Remove tokens, passwords, and other secrets from anything you share. The request console and generated code redact the common ones for you.

API Workbench is free and open source under the [MIT License](../LICENSE), maintained by volunteers. Please be kind — see the [Code of conduct](../CODE_OF_CONDUCT.md).
