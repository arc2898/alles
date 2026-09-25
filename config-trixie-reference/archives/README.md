# Local build archives

Place locally built `.deb` files in this directory. `live-build` reads `config/archives/*.deb` when constructing the chroot.

The first Calamares build will produce a local package with the same package name (`calamares`) but version `3.4.3-1`, so the staged upstream v3.4.3 build is used instead of Debian's binary package. The package must be built and tested before relying on this mechanism.
