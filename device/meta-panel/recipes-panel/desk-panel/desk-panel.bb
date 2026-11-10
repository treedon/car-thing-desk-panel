SUMMARY = "Desk panel web app (panel/dist), served by panel-recorder"
LICENSE = "GPL-3.0-only"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/GPL-3.0-only;md5=c79ff39f19dfec6d293b95dea7b07891"

# Built on the Mac first: `npm --prefix panel run build` (the device Justfile does it).
FILESEXTRAPATHS:prepend := "${THISDIR}/../../../../panel:"
SRC_URI = "file://dist"
S = "${UNPACKDIR}"

RDEPENDS:${PN} = "panel-recorder"

do_install() {
    install -d ${D}${datadir}/desk-panel
    cp -R --no-preserve=ownership ${UNPACKDIR}/dist/. ${D}${datadir}/desk-panel/
    # The per-home settings are provisioned into /opt/panel (panel-settings).
    rm -f ${D}${datadir}/desk-panel/panel-config.js
}

FILES:${PN} = "${datadir}/desk-panel"
