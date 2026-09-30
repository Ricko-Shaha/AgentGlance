# Installation

This guide describes AgentGlance **2.1.0**. Start with the [project overview](../README.md), then see [Using AgentGlance](USAGE.md) for the controls.

## Choose a package

| System | Architecture | Package | Validation status |
| --- | --- | --- | --- |
| Windows | x64 | Portable EXE or setup EXE | Built and tested on Windows |
| macOS | Intel x64 or Apple Silicon arm64 | DMG or ZIP | Build targets configured; native validation still required |
| Linux | x64 or arm64 | AppImage or DEB | Build targets configured; native validation still required |

The macOS and Linux entries describe configured targets, not a promise that downloadable packages have been published or tested. Choose the architecture that matches your computer. Packaged apps include their runtime; you do not need Node.js or a source checkout.

Use a package attached to a published release, if one is available. The repository's **Actions → Desktop builds** workflow also uploads artifacts after successful jobs. Extract the downloaded artifact ZIP to obtain the platform package. CI artifacts are separate from GitHub Releases: this workflow does not automatically publish a release. If no suitable artifact exists, see [Development](DEVELOPMENT.md) for native build instructions.

Windows builds currently have no publisher certificate. macOS builds use an ad-hoc signature and have no Developer ID signature or notarization. An operating system or organization policy may prevent launching them; this guide does not require disabling those protections.

## Windows

### Installer — recommended for Claude telemetry

1. Run `AgentGlance-Setup-2.1.0-x64.exe`.
2. Choose the installation location in the setup wizard. Setup uses a per-user installation and is configured to create desktop and Start-menu shortcuts.
3. Open **AgentGlance** from one of those shortcuts.

Keep the installed application at that location if you connect Claude telemetry. Its settings refer to the installed executable. The setup EXE is the installer, not the application shortcut.

### Portable app

1. Place `AgentGlance-2.1.0.exe` in a folder you intend to keep.
2. Open it directly. You may create a Windows shortcut to that EXE yourself.

The portable package does not run an installation wizard or create shortcuts automatically. It can display detected accounts, activity, and available usage. **Connect Claude** requires the installed app because the portable launcher does not provide a persistent worker location. An already configured telemetry bridge may still supply observations.

Portable refers to how the executable is distributed; preferences are still stored in the operating system's application-data location, not exclusively alongside the EXE.

## macOS

When a native package is available, choose **x64** for an Intel Mac or **arm64** for Apple Silicon.

For a DMG, open the image and copy **AgentGlance.app** into **Applications**. For a ZIP, extract it and move **AgentGlance.app** into Applications. Launch that copy, rather than a temporary copy in the mounted image or extraction folder. Keep it in place before connecting Claude telemetry.

AgentGlance provides native app, edit, and window menus and a Dock icon. These targets are configured but have not yet been validated on native macOS hardware. Signing and notarization limitations are described above.

## Linux

When a native package is available, choose **x64** for a typical Intel/AMD desktop or **arm64** for a compatible ARM desktop.

### Debian package

Open the matching `.deb` in your distribution's package installer and follow its instructions. Then launch **AgentGlance** from the applications menu. A DEB installation provides a stable executable location for **Connect Claude**. It is intended for distributions that support Debian packages.

### AppImage

Save the matching `.AppImage` in a persistent folder. Enable **Allow executing file as program** in your file manager, or grant executable permission to that specific file with `chmod +x`. Then open it. Your distribution may require FUSE 2 support for AppImage execution; use its supported installation guidance. AppImages cannot install AgentGlance's Claude telemetry worker; use an installed package for that feature.

### Display server behavior

With an X11 display available, including XWayland, AgentGlance requests X11 and offers its floating toolbar, dragging, resizing, pinning, and layout switching.

In a pure Wayland session without an X11 display, AgentGlance uses a framed vertical window. The compositor controls moving and resizing; pinning and layout switching are disabled. **Info** explains the limitation. Tray visibility depends on the desktop environment's tray support. Linux packages and desktop behavior still need native validation.

## First launch and account detection

Sign in through the assistants you already use. AgentGlance discovers supported local authentication automatically; the [project overview](../README.md) lists the supported providers and their capabilities. It has no separate account login flow and does not require copying credentials into the widget. Browser-only sign-ins do not establish local CLI authentication.

Start AgentGlance under the same operating-system user as those assistants. If you use custom assistant configuration directories, launch it with the same relevant environment settings. Refresh the widget after signing in; CLI authentication checks may remain cached for up to a minute. See [Troubleshooting](TROUBLESHOOTING.md) if an assistant is missing.

### Connect Claude telemetry

1. Install AgentGlance at a stable location and sign in to Claude Code locally.
2. Open **Info → Claude telemetry → Connect Claude**.
3. Resume normal work in Claude. Usage, context, and activity arrive as Claude emits new status-line and hook events. Reopen a Claude session if it has not loaded the new settings.

This installs local observers using the bundled worker. It preserves an existing status-line command's input/output and adds activity hooks alongside existing hooks. It does not sign you in, submit a prompt, or decide permission requests. An already working legacy connection is recognized and preserved. Read [Privacy](PRIVACY.md) for what is observed and stored.

## Updating and removing AgentGlance

There is no automatic updater. Before replacing, moving, or removing a connected installation, use **Info → Claude telemetry → Disconnect Claude** while that installation still runs. This avoids leaving Claude settings pointing at a missing executable. Then choose **Quit AgentGlance** from the tray menu; closing the widget normally only hides it.

For Windows, run the newer installer, or replace the portable EXE and update any shortcut you created to point at the new filename. For macOS, replace the application in Applications. For Linux, update the installed package through your package manager, or replace the AppImage. Launch the new version and reconnect Claude telemetry if needed. Do not keep launching an old shortcut after replacing a versioned portable filename.

To uninstall, disconnect first and quit. Remove the Windows installation through **Installed apps**, remove the macOS app from Applications, or remove the Linux package through your package manager. Portable EXEs and AppImages can be removed directly after quitting.

Disconnect restores the app-owned status-line setting and removes app-owned hooks while preserving unrelated Claude settings. If the settings were edited after setup, AgentGlance may stop and explain the conflict rather than overwrite those edits. Legacy source-installed observers retain their original disconnect procedure; see [Development](DEVELOPMENT.md). Uninstalling does not sign out your assistants or delete their conversations. Windows uninstall is configured to retain AgentGlance application data, and local preferences or observation caches may remain after removal.

For a hidden window, missing measurements, or setup errors, continue to [Troubleshooting](TROUBLESHOOTING.md).

## Upgrading from Statusline

AgentGlance 2.1.0 is the renamed application. New Windows packages are `AgentGlance-2.1.0.exe` and `AgentGlance-Setup-2.1.0-x64.exe`. Update manually created shortcuts to the new executable; an old Statusline shortcut can still launch an older copy.

The `STATUSLINE_*` environment variables and Claude integration directories named `statusline-usage`, `statusline-activity`, and `statusline-integration` remain compatibility names. Do not rename those variables or folders by hand. Before removing a connected older application, disconnect its owned Claude observers from that application, then reconnect from the new stable AgentGlance installation. Existing working legacy observers remain recognized.
