#!/usr/bin/env bash
set -Eeuo pipefail

export HOME=/root
export USER=root
export LOGNAME=root
unset SUDO_USER
REPO_DIR=/tmp/osmium-assets/MacTahoe-gtk-theme
source "$REPO_DIR/libs/lib-install.sh"

colors=(Dark)
opacities=(normal)
alts=(normal)
themes=(default)
schemes=(standard)
libadwaita=true
blur=true
accent_type=default
install_libadwaita

install -d /etc/xdg/gtk-4.0
cp -a /root/.config/gtk-4.0/. /etc/xdg/gtk-4.0/
ln -sfn gtk-Dark.css /etc/xdg/gtk-4.0/gtk.css
ln -sfn gtk-Dark.css /etc/xdg/gtk-4.0/gtk-dark.css
ln -sfn gtk-Light.css /etc/xdg/gtk-4.0/gtk-light.css
cat > /etc/xdg/gtk-4.0/settings.ini <<'EOF'
[Settings]
gtk-theme-name=MacTahoe-Dark
gtk-icon-theme-name=MacTahoe-blue
gtk-cursor-theme-name=MacTahoe
gtk-application-prefer-dark-theme=1
EOF
