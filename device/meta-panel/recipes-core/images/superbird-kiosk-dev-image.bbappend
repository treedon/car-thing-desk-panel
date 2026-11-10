# The desk panel on the kiosk dev image: Wi-Fi (driver modules and firmware
# for the TX10UB and MT7921AU adapters), the panel itself, and its recorder;
# the USB port's role at boot, key-only SSH over Wi-Fi, and the writable
# /opt/panel that holds the provisioned settings.
# kernel-modules brings every module: the kernel builds almost everything in,
# so that is just Wi-Fi plus what mac80211 loads by name (ccm, gcm, ...).
# The kiosk image lists wpa-supplicant and wireless-regdb as BAD_RECOMMENDATIONS;
# naming them here installs them anyway.
# panel-modeswitch ejects the TX10UB's fake disk (0bda:1a2b) so it becomes a
# Wi-Fi adapter. It brings usb-modeswitch; the data package it recommends holds
# a thousand rules for other devices, so it stays out.
IMAGE_INSTALL:append = " \
    panel-wifi panel-modeswitch desk-panel panel-recorder panel-usb-mode panel-ssh panel-settings \
    wpa-supplicant iw wireless-regdb-static \
    kernel-modules \
    linux-firmware-rtl8851 linux-firmware-panel-mt7921 \
"
BAD_RECOMMENDATIONS += "usb-modeswitch-data"
