# Magnetic door sensor setup

Target verified over SSH: Raspberry Pi 4 Model B Rev 1.1, `gpiochip0` (`pinctrl-bcm2711`), BCM GPIO17 / physical header pin 11. libgpiod 2.2.1 is already installed and the `roman` account can read it without sudo.

## What the app does

- Door open: starts the USB webcam, even if no browser is open.
- Door closed: stops FFmpeg, releases the webcam, ends streams, and blocks snapshots.
- The web UI reconnects when the door opens (unless you paused the preview).
- The sensor is sampled about every 110 ms and must remain stable for 250 ms before a change is accepted. Expect roughly 0.3–0.5 seconds for a switch change, plus webcam startup time. UI status polls every second.
- Missing GPIO access or read errors stop capture until stable readings return.
- A disconnected wire reads high, just like an open door; this simple circuit cannot detect a broken wire.
- This switches **capture**, not USB electrical power. The webcam remains powered by USB. There is no audio or continuous video recording. Snapshots are saved only on request.

Sensor control is installed but **disabled until you finish wiring**. The existing manual stream still works.

## Parts

- One wired sensor and its matching unwired magnet from the Gebildet kit.
- Two female-ended jumper leads suitable for the Pi header, with secure connections to the sensor's bare wires (e.g. a breadboard or screw-terminal adaptor).
- One 1 kΩ resistor in series with the signal wire, recommended as protection against accidentally configuring the pin as an output. No external pull-up is required for this short test circuit.
- Tape or heat-shrink for the unused wire; adhesive for mounting.
- A multimeter with continuity mode to confirm the contact behavior before connecting it.

## Identify the contact first

The [manufacturer's listing on Amazon for the same ASIN](https://www.amazon.com/dp/B085XQLQ3N) identifies **blue = common, black = NC, white = NO**. Amazon France was inaccessible during setup, so verify that your actual unit matches the three-wire version.

With the sensor completely disconnected from the Pi, measure continuity between blue and white while bringing the magnet close, then moving it away. For the default configuration, choose the pair that **conducts with the magnet close and does not conduct with it away**. Start with blue/white; if this pair behaves oppositely, use blue/black instead. Insulate the unused wire individually. If your sensor differs from this description, identify its contacts before connecting anything.

## Wire it with the Pi powered off

1. Shut the Pi down (`ssh -t roman@fridgeai.local 'sudo shutdown -h now'`), wait for shutdown, then disconnect its power supply. The app/tunnel will disconnect.
2. Leave the webcam connected by USB. Do not route webcam power through GPIO or the reed switch.
3. Connect the verified contacts:

| Connection | Raspberry Pi header |
| --- | --- |
| Blue/common | **Physical pin 6 — GND** |
| Contact that conducts to blue when magnet is close (usually white; verify above) | **1 kΩ resistor → physical pin 11 — BCM GPIO17** |
| Remaining sensor wire | Insulate; do not connect |
| Unwired magnet | No electrical connection |

```text
GPIO17 / physical pin 11 ── 1 kΩ ── selected contact wire
                                      [reed switch]
GND / physical pin 6 ──────────────── blue/common

Internal 3.3 V pull-up is enabled in software when sampling GPIO17.
```

**No sensor wire connects to a 3.3 V or 5 V power pin.** This is a passive switch. Never apply 5 V to a GPIO input. Confirm physical pin numbers against the [official Pi header diagram](https://www.raspberrypi.com/documentation/computers/raspberry-pi.html#gpio). GPIO17 means physical pin **11**, not physical pin 17 (which supplies 3.3 V).

## Check and enable

Reconnect Pi power and wait for SSH to return. From this project folder on the Mac:

```sh
# With magnet close: expect 0.
npm run pi:sensor:check
# Move magnet away and repeat: expect 1.
npm run pi:sensor:check
```

The check briefly requests GPIO17 as an input with an internal pull-up. Run it before enabling monitoring to avoid competing for the line. If readings do not change, check contacts, wiring, magnet position, and ground. If they are reversed, either use the other contact (power down before rewiring) or set `DOOR_CLOSED_LEVEL=1` in `/home/roman/fridge-ai/.env`.

Once the readings match:

```sh
npm run pi:sensor:on
```

Open http://fridgeai.local:3000. Bring the magnet close: the UI should say **Door closed · Camera off**. Move it away: **Door open**, followed by live video. Test both positions several times before mounting. The Pi service is not enabled at boot; `pi:sensor:on` restarts/starts it after the wiring reboot. For later reboots, use `ssh roman@fridgeai.local 'systemctl --user start fridge-ai'` and open the LAN URL.

To return to manual camera control:

```sh
npm run pi:sensor:off
```

Pausing the browser preview in sensor mode does not stop camera capture while the door is open. Closing the door does.

## Mounting

Tape the wired half to a fixed part of the fridge frame and the magnet to the door so they align closely when closed and separate when opened. Start with a few millimetres of separation and confirm the readings in the actual location; the metal fridge body can affect operation. Use adhesive rather than drilling into the appliance, and route the lead without crushing it in the seal or preventing the door from closing. Keep the Pi outside the cold, damp compartment.

## Configuration and implementation

```dotenv
DOOR_SENSOR_ENABLED=false
DOOR_GPIO_CHIP=gpiochip0
DOOR_GPIO_LINE=17
DOOR_CLOSED_LEVEL=0
DOOR_DEBOUNCE_MS=250
```

`server/door.ts` reads GPIO through libgpiod's `gpioget` and debounces input. `server/stream.ts` enforces the gate for both live streams and snapshots, with one shared FFmpeg process. `/api/status` includes the door state and the last raw reading. No GPIO output or USB power-switching circuit is used.

Validation completed without the sensor connected: GPIO input/pull-up access, unit tests for contact bounce/polarity/error recovery, and camera gate tests. The actual magnet/contact transitions must be checked after wiring.
