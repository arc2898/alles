# Osmium OS

Osmium OS is a Debian 14 (Forky)-based Linux distribution focused on a macOS-inspired desktop experience, using GNOME and custom themes, icons, cursors, and extensions.

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

After the base bootstrap completes, install the GNOME desktop and display manager:

```bash
sudo ./scripts/install-desktop.sh
```

The script uses a dated Debian snapshot (default `20260615T000000Z`) to request `gnome-shell 50.2-3` and `gdm3 50.2-1` together with GNOME Session, Control Center, Terminal, and NetworkManager. You can override `ROOTFS`, `SNAPSHOT`, `GNOME_SHELL_VERSION`, and `GDM3_VERSION`. A snapshot keeps package dependencies consistent; the exact versions must exist in that snapshot.

This installs the desktop into the root filesystem; it does **not** create a bootable ISO. Next steps are adding Osmium themes/icons/extensions, integrating Calamares, and building/testing an installer image.

## Project status

The project is under development. Desktop customizations, self-built GNOME extensions, installer integration, and background assets still need work.
