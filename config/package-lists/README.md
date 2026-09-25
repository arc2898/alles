# Package list policy

`live.list.chroot` is the core live-session list. `osmium.list.chroot` is the
curated Debian Forky application/tool list derived from the installed target.

`../external-packages.list` is intentionally outside this directory because
live-build loads every `*.list.chroot` file automatically. Add an external
package only after its repository, signing key, version, and licensing policy
are recorded.
