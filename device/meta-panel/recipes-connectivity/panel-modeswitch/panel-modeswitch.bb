SUMMARY = "Desk panel Wi-Fi: flips the TX10UB Nano out of its fake-disk mode so the rtw89 driver can claim it"
LICENSE = "GPL-3.0-only"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/GPL-3.0-only;md5=c79ff39f19dfec6d293b95dea7b07891"

# Tested by device/test/panel-modeswitch.test.sh.
SRC_URI = " \
    file://40-panel-modeswitch.rules \
    file://modeswitch-0bda-1a2b.conf \
"
S = "${UNPACKDIR}"

# usb-modeswitch's udev wrapper starts usb_modeswitch@<device>.service, whose
# dispatcher reads /etc/usb_modeswitch.d/<vendor>:<product> before the data
# package's /usr/share/usb_modeswitch, so this config wins either way.
RDEPENDS:${PN} = "usb-modeswitch"

do_install() {
    install -d ${D}${nonarch_base_libdir}/udev/rules.d
    install -m 0644 ${UNPACKDIR}/40-panel-modeswitch.rules ${D}${nonarch_base_libdir}/udev/rules.d/40-panel-modeswitch.rules
    # The filename is the USB ID, which the source tree can't use (the colon).
    install -d ${D}${sysconfdir}/usb_modeswitch.d
    install -m 0644 ${UNPACKDIR}/modeswitch-0bda-1a2b.conf ${D}${sysconfdir}/usb_modeswitch.d/0bda:1a2b
}

FILES:${PN} = "${nonarch_base_libdir}/udev/rules.d ${sysconfdir}/usb_modeswitch.d"
