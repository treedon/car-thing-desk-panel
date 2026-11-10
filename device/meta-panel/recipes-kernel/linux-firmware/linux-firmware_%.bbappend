# Just the MT7921AU Wi-Fi firmware, instead of every MediaTek file in
# linux-firmware-mediatek (the same split Prelude makes).
PACKAGES =+ "${PN}-panel-mt7921"
LICENSE:${PN}-panel-mt7921 = "Firmware-mediatek"
FILES:${PN}-panel-mt7921 = " \
    ${nonarch_base_libdir}/firmware/mediatek/WIFI_MT7961_patch_mcu_1_2_hdr.bin* \
    ${nonarch_base_libdir}/firmware/mediatek/WIFI_RAM_CODE_MT7961_1.bin* \
"
RDEPENDS:${PN}-panel-mt7921 += "${PN}-mediatek-license"
