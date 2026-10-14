# Osmium OS

Osmium OS is a Debian 14 (Forky)-based Linux distribution focused on a macOS-inspired desktop experience, using GNOME and custom themes, icons, cursors, and extensions.

## Build the Debian base

The repository keeps Debian upstream separate instead of copying the entire Debian source archive into this project. Use the official Debian repositories to bootstrap a reproducible minimal root filesystem.

On a Debian/Ubuntu Linux build host, install `debootstrap`:

```bash
sudo apt-get update
sudo apt-get install debootstrap
```

Then run the bootstrap script as root:

```bash
sudo ./scripts/bootstrap-rootfs.sh
```

Defaults: suite `forky`, architecture `amd64`, and output directory `out/osmium-rootfs`. Override them with environment variables, for example `sudo ARCH=arm64 TARGET=/srv/osmium-rootfs ./scripts/bootstrap-rootfs.sh`.

**Note:** this creates a minimal root filesystem only. It does not yet create a bootable ISO. The next steps are configuring the system, installing GNOME and Osmium customizations, integrating Calamares, and adding an ISO build pipeline.

## Project status

The project is under development. Desktop customizations, self-built GNOME extensions, installer integration, and background assets still need work.
