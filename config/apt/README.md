# APT sources

The active live-build profile uses the Debian Forky suite configured in
`config/bootstrap` and the target's repository evidence is recorded under
`provenance/target-snapshot/etc/apt/`.

Third-party repositories are not enabled implicitly. If Brave, GitHub CLI,
Ghostty, or another external application is selected for the ISO, add its
signed repository and key here deliberately and record the key fingerprint in
`locks/` before building.
