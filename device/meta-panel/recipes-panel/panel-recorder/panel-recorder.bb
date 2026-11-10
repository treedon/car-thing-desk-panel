SUMMARY = "Desk panel: serves the panel on 127.0.0.1:8095 and records the mic array for dictation"
LICENSE = "GPL-3.0-only"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/GPL-3.0-only;md5=c79ff39f19dfec6d293b95dea7b07891"

# Sources live in this repo's device/panel-recorder (tested there with `make test`).
FILESEXTRAPATHS:prepend := "${THISDIR}/../../../panel-recorder:${THISDIR}/files:"
SRC_URI = "file://main.c file://recorder_core.c file://recorder_core.h file://Makefile file://panel-recorder.service"
S = "${UNPACKDIR}"

DEPENDS = "alsa-lib"
inherit systemd
SYSTEMD_SERVICE:${PN} = "panel-recorder.service"
SYSTEMD_AUTO_ENABLE = "enable"

do_compile() {
    oe_runmake panel-recorder
}

do_install() {
    install -d ${D}${bindir}
    install -m 0755 ${B}/panel-recorder ${D}${bindir}/panel-recorder
    install -d ${D}${systemd_system_unitdir}
    install -m 0644 ${UNPACKDIR}/panel-recorder.service ${D}${systemd_system_unitdir}/panel-recorder.service
}
