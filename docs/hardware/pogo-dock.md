# Pogo-pin dock

A pogo-pin dock for the Car Thing that plugs a USB-C breakout into the Car Thing's own USB-C port. The Car Thing stays closed, nothing is soldered to it, and every recovery path still works: holding Back at boot (USB SSH) and holding 1+4 for mask-ROM flashing both run over the same D+/D− lines.

## Pinout (6 pins)

| # | Signal | Notes |
|---|---|---|
| 1 | VBUS | 5 V from the hub to the Car Thing |
| 2 | GND | |
| 3 | D+ | USB 2.0 data |
| 4 | D− | USB 2.0 data |
| 5 | CC | So the Car Thing and the hub can see each other |
| 6 | GND | Second ground, spreads the charge-through current |

The ID pin isn't needed: `superbird-usb-role` switches host and device mode in software. Leave VCONN unconnected.

**Why CC:** the powered OTG hub (Plan 2) connects with USB-C, and the two sides use CC to work out who supplies power. Without CC the hub may never turn on VBUS, so you get no power, or data with no charging.

**Four pins instead:** if the far side of the dock is a USB-A port or a plain 5 V supply, drop the CC pogo pin. Put a 56 kΩ resistor from CC to VBUS on the Car Thing side, as a USB-C to USB-A cable does.

## Parts

- **USB-C male plug breakout** with VBUS, GND, D+, D− and CC. Many breakouts are power-only (VBUS and GND); avoid those.
- **USB-C female receptacle breakout** for the hub side, or the hub's own cable. It also needs D+, D− and CC.
- **6 pogo pins and a matching target pad or strip.** A magnetic pogo connector pair makes the dock self-aligning.

## Build notes

- **Remove the CC resistors on both breakouts.** Many have a 5.1 kΩ resistor from CC to GND (often R1/R2 near the connector). On a pass-through link they clash with the real CC resistors in the Car Thing and the hub, so take them off or cut the trace.
- A plug breakout has only one CC pin. Wire CC to CC at each end.
- Keep D+ and D− side by side and about the same length.
- Pogo pins carry 1–2 A each, but contact resistance adds up. If the hub's charge-through current is high, add a second VBUS pin as well.

## Before plugging in

1. Check continuity on every pin, end to end.
2. Check that VBUS and GND aren't shorted.
3. Confirm the CC resistors are gone.

## First test

1. Connect the hub to the Car Thing through the dock and check that it charges and boots.
2. Do the Wi-Fi check from Plan 2 Task 3: `ip link` shows `wlan0`.
3. If the hub's lights come on but the Wi-Fi adapter doesn't show up, check D+/D− first. A swapped pair is the most common mistake.
