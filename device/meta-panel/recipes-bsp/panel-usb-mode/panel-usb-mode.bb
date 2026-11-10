SUMMARY = "Desk panel USB port role at boot: host for the Wi-Fi adapter, or USB networking with Back held"
LICENSE = "GPL-3.0-only"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/GPL-3.0-only;md5=c79ff39f19dfec6d293b95dea7b07891"

# The script and the recovery page live in this repo's device/panel-usb-mode
# (tested by device/test/panel-usb-mode.test.sh).
FILESEXTRAPATHS:prepend := "${THISDIR}/../../../panel-usb-mode:${THISDIR}/files:"
SRC_URI = "file://panel-usb-mode.sh file://recovery.html file://panel-usb-mode.service"
S = "${UNPACKDIR}"

inherit systemd
SYSTEMD_SERVICE:${PN} = "panel-usb-mode.service"
SYSTEMD_AUTO_ENABLE = "enable"
# evtest reads the Back button; superbird-usb-role switches the port.
RDEPENDS:${PN} = "evtest superbird-usb-role panel-settings"

do_install() {
    install -d ${D}${libexecdir}
    install -m 0755 ${UNPACKDIR}/panel-usb-mode.sh ${D}${libexecdir}/panel-usb-mode
    install -d ${D}${systemd_system_unitdir}
    install -m 0644 ${UNPACKDIR}/panel-usb-mode.service ${D}${systemd_system_unitdir}/panel-usb-mode.service
    # Served by panel-recorder in place of the panel on a recovery boot.
    install -d ${D}${datadir}/desk-panel
    install -m 0644 ${UNPACKDIR}/recovery.html ${D}${datadir}/desk-panel/recovery.html
}

FILES:${PN} += "${libexecdir}/panel-usb-mode ${datadir}/desk-panel/recovery.html"
