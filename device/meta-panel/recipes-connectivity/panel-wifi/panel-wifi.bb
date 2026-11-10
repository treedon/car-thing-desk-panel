SUMMARY = "Desk panel Wi-Fi: wlan0 by DHCP, joined with the network in /opt/panel/wifi.conf"
LICENSE = "GPL-3.0-only"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/GPL-3.0-only;md5=c79ff39f19dfec6d293b95dea7b07891"

SRC_URI = "file://wlan0.network"
S = "${UNPACKDIR}"

inherit systemd
RDEPENDS:${PN} = "wpa-supplicant iw wireless-regdb-static"

do_install() {
    install -d ${D}${sysconfdir}/systemd/network
    install -m 0644 ${UNPACKDIR}/wlan0.network ${D}${sysconfdir}/systemd/network/40-wlan0.network
    # wpa_supplicant@wlan0 reads /etc/wpa_supplicant/wpa_supplicant-wlan0.conf;
    # it is the provisioned file in /opt/panel (panel-settings).
    install -d ${D}${sysconfdir}/wpa_supplicant
    ln -sf /opt/panel/wifi.conf ${D}${sysconfdir}/wpa_supplicant/wpa_supplicant-wlan0.conf
    # Enable wpa_supplicant@wlan0 by hand: the template unit ships in
    # wpa-supplicant, and the systemd class only enables units in this package.
    install -d ${D}${sysconfdir}/systemd/system/multi-user.target.wants
    ln -sf ${systemd_system_unitdir}/wpa_supplicant@.service \
        ${D}${sysconfdir}/systemd/system/multi-user.target.wants/wpa_supplicant@wlan0.service
}

FILES:${PN} = "${sysconfdir}/systemd/network ${sysconfdir}/systemd/system ${sysconfdir}/wpa_supplicant"
