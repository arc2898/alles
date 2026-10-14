# Osmium

Osmium is a Debian 14 (Forky)-based Linux distribution focused on a macOS-inspired desktop experience, with GNOME and custom themes, icons, cursors, and extensions.

## Build the Debian base

The repository keeps Debian upstream separate instead of copying the entire Debian source archive into this project. Use the official Debian repositories to bootstrap a minimal root filesystem.

On a Debian/Ubuntu Linux build host, install `debootstrap`:

```bash
sudo apt-get update
sudo apt-get install debootstrap
```

Create the root filesystem:

```bash
sudo ./scripts/bootstrap-rootfs.sh
```

Defaults: suite `forky`, architecture `amd64`, and output directory `out/osmium-rootfs`. Override them with environment variables, for example `sudo ARCH=arm64 TARGET=/srv/osmium-rootfs ./scripts/bootstrap-rootfs.sh`.

## Install GNOME 50.2 and GDM3

After the base bootstrap completes:

```bash
sudo ./scripts/install-desktop.sh
```

The script requests `gnome-shell 50.2-3` and `gdm3 50.2-1` from the configured Debian snapshot, along with GNOME Session, Control Center, Terminal, and NetworkManager. You can override `ROOTFS`, `SNAPSHOT`, `GNOME_SHELL_VERSION`, and `GDM3_VERSION`. Package versions must exist in the selected snapshot.

## Apply Osmium branding

Apply the OS identity, hostname, login banner, MOTD, and root Bash prompt:

```bash
sudo ./scripts/brand-osmium.sh
```

Defaults: OS name `Osmium`, version `0.1.0`, codename `forky`, hostname `osmium`. Customize with `ROOTFS`, `OS_VERSION`, `CODENAME`, and `HOSTNAME_VALUE`.

The branding script does not enable root auto-login or remote root access. It updates the target root filesystem, not the build host.

## Status

These scripts prepare a root filesystem; they do **not** produce a bootable ISO yet. Next: add the Osmium theme/icon assets and GNOME defaults, integrate Calamares, then build and test an installer image.
