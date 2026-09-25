# Calamares source

The active installer source is the signed Calamares v3.4.3 release under
`upstream/`. Debian packaging/settings references are retained under
`debian/` for module compatibility. The active build profile uses Forky; the
overlay helpers have been changed from `trixie` to `forky`.

The source archive is not a prebuilt `.deb`. A future build must produce,
inspect, and test a local package before placing it in `config/archives/`.
