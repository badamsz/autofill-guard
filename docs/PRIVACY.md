# Privacy Policy

**Autofill Guard** · Effective November 27, 2026

Autofill Guard is a browser extension for Chrome, Microsoft Edge and other Chromium-based browsers. It stops the browser from saving or suggesting form data on websites that you or your organization choose.

## Summary

Autofill Guard does not collect, store, sell or transmit any personal information. It makes no network requests, contains no analytics or tracking, and has no servers.

## What the extension accesses, and why

| Information | How it is used | Leaves your device? |
|---|---|---|
| Address (URL) of the active tab | Compared locally against your protected-site list, to show the toolbar indicator and apply protection | No |
| Form fields on protected sites | Each field's `autocomplete` attribute is set to `off` so the browser does not store or suggest entries. Field contents (what you type) are never read. | No |
| Your protected-site list and settings | Stored in the browser's extension storage so your choices persist | Only through your browser's own sync, if you have it enabled (see below) |
| Policy set by your organization | Read from the browser's managed storage to apply mandatory and recommended sites and settings | No |
| Browser autofill and password-saving settings | Adjusted on protected sites to block autofill, then restored to your own setting | No |

Autofill Guard does not read page content, form values, passwords, cookies, browsing history or any other data. It does not access sites you have not listed, except to check each tab's address against your list.

## Data storage and sync

Your site list and settings are stored using the browser's `chrome.storage.sync` area. If you have browser sync turned on (for example, signed in to Chrome with a Google account, or to Edge with a Microsoft account), your browser may sync these settings across your devices. That sync is handled by your browser provider under their privacy policy; Autofill Guard never receives a copy.

Removing the extension deletes its stored settings and returns the browser's autofill settings to your own preferences.

## Data sharing

Autofill Guard does not share data with anyone, because it does not collect any. It does not use data for advertising, creditworthiness or lending decisions, and no data is sold or transferred to third parties.

## Organizations

If your organization manages Autofill Guard by policy, the protected-site list and settings come from your administrator. The extension only reads that configuration; it does not report anything back to your organization.

## Permissions

| Permission | Purpose |
|---|---|
| `storage` | Saves your site list and settings, and reads organization policy |
| `scripting` | Runs the protection script on protected sites only |
| `privacy` | Uses the browser's per-site autofill setting, and turns autofill and password saving off on protected sites |
| `tabs` | Reads the active tab's address to decide whether it is a protected site |
| Access to all sites | Lets the protection script run on whichever sites you add, since they can't be known in advance |

## Children

Autofill Guard is not directed at children and collects no information from anyone.

## Changes to this policy

Any change will be posted in this file with a new effective date. The full history is available in the project's GitHub repository.

## Contact

Questions or concerns: open an issue at <https://github.com/badamsz/autofill-guard/issues>.
