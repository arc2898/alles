# Current environment notes

Captured from the installed Osmium target on 2026-09-25.

- Base: Debian `forky/sid` (`/etc/debian_version`).
- GNOME Shell: 50.5-1; GNOME 50 desktop packages.
- Desktop: GNOME with MacTahoe-Dark GTK/Shell assets, MacTahoe-dark icons,
  MacTahoe cursor, ArcMenu, DING, and the other enabled system extensions.
- Installer source: Calamares v3.4.3 is staged; no Calamares package has been
  built or installed into the target yet.
- Live-image tooling: live-build/live-boot/live-config source is staged from
  the Trixie reference set; the active profile has been retargeted to Forky
  and must be tested with a compatible live-build package before ISO creation.
- Current target package count: 1902 binary packages (see
  `locks/target-dpkg-packages.tsv`).
- Current target uses the `forky` APT suite plus signed Brave and GitHub CLI
  repositories. Ghostty was installed separately and is not yet pinned as a
  reproducible package.
- The source overlay includes the current dconf defaults, wallpaper catalog,
  zsh configuration, FastFetch profile, system extensions, themes, icons,
  Plymouth theme, GRUB assets, and Calamares branding.
- The previous target wallpaper XML contained an invisible U+200B character
  in several filename tags and stale `osmium-macos` paths. The review overlay
  contains a corrected XML catalog and matching asset paths; the target was
  not rewritten as part of creating this source review.
- The GDM gresource in the installed target is a compiled binary. Its source
  assets are retained in the MacTahoe GTK source tree, but the exact compiled
  resource still needs a reproducible build/test step.
- No live ISO, Calamares installation test, VM boot test, or real-disk
  destructive install has been performed.
