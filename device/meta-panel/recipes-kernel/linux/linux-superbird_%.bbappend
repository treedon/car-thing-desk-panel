# USB Wi-Fi for the desk panel: re-enables what superbird-disable.cfg turns
# off, for the two adapters the plan allows. The kernel recipe merges any
# extra .cfg after its own fragments.
FILESEXTRAPATHS:prepend := "${THISDIR}/files:"
SRC_URI += "file://panel-wifi.cfg"
