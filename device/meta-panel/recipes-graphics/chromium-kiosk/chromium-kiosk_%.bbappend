# The panel is served on the device by panel-recorder (Chromium won't run
# module scripts from file://, and localhost is a secure origin). Set here, not
# in local.conf: the superbird-kiosk distro assigns the URL with a hard "=".
CHROMIUM_KIOSK_URL = "http://127.0.0.1:8095/"
