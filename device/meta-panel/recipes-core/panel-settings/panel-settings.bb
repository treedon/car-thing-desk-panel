SUMMARY = "Desk panel: a writable, persistent /opt/panel for the provisioned settings"
DESCRIPTION = "The root filesystem is read-only. meta-superbird's opt-overlay@panel \
binds /opt/panel to /var/lib/bandaid/panel (seeded once from the empty \
/usr/lib/panel), so provision.sh's files survive reboots."
LICENSE = "GPL-3.0-only"
LIC_FILES_CHKSUM = "file://${COMMON_LICENSE_DIR}/GPL-3.0-only;md5=c79ff39f19dfec6d293b95dea7b07891"

inherit allarch
RDEPENDS:${PN} = "opt-overlay"

do_install() {
    # The mount point (the rootfs is read-only, so it must already exist) and
    # the empty factory copy that opt-overlay-bind seeds the bandaid dir from.
    install -d -m 0700 ${D}/opt/panel ${D}${libdir}/panel
    # Enabled by hand: the template unit ships in opt-overlay.
    install -d ${D}${sysconfdir}/systemd/system/multi-user.target.wants
    ln -sf ${systemd_system_unitdir}/opt-overlay@.service \
        ${D}${sysconfdir}/systemd/system/multi-user.target.wants/opt-overlay@panel.service
}

FILES:${PN} = "/opt/panel ${libdir}/panel ${sysconfdir}/systemd/system"
