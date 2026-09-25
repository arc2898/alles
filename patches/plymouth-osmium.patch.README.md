# Plymouth integration note

The exact current Plymouth theme is preserved in
`assets/plymouth/osmium/`. The script uses native integer-sized artwork for
the boot logo to avoid fractional-scaling seams, displays the logo/progress
bar during boot, and suppresses the boot-specific animation during shutdown.

If the theme is changed, update both the source asset and the generated
initramfs, then verify the image contains:
`usr/share/plymouth/themes/osmium/logo.png`.
