SUMMARY = "Desk panel SSH: key-only over Wi-Fi, the empty dev password only over the USB cable"
LICENSE = "GPL-3.0-only"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/GPL-3.0-only;md5=c79ff39f19dfec6d293b95dea7b07891"

SRC_URI = "file://50-panel.conf"
S = "${UNPACKDIR}"

RDEPENDS:${PN} = "openssh-sshd"

do_install() {
    install -d ${D}${sysconfdir}/ssh/sshd_config.d
    install -m 0644 ${UNPACKDIR}/50-panel.conf ${D}${sysconfdir}/ssh/sshd_config.d/50-panel.conf
}

FILES:${PN} = "${sysconfdir}/ssh/sshd_config.d"
