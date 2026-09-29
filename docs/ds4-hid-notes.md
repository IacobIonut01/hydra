# DS4/DualSense HID notes (vendored from DS4Windows)

Reference distilled from `schmaldeo/DS4Windows` (`DS4Windows/DS4Library`) for the
`native/hydra-native/src/controller` module. Ported here so the implementation is
self-contained — offsets and CRC details are the parts that are easy to get
silently wrong.

## Device table

Sony VID `0x054C`:

| PID      | Model           | Notes                              |
| -------- | --------------- | ---------------------------------- |
| `0x05C4` | DS4 v1          |                                    |
| `0x09CC` | DS4 v2          |                                    |
| `0x0BA0` | DS4 (PS3/early) | rare, same report layout           |
| `0x0CE6` | DualSense       |                                    |
| `0x0DF2` | DualSense Edge  | same reports, extra Fn/paddle bits |

Third-party clones (Razer Raiju, Nacon, Hori) carry feature flags in DS4Windows:
`NoOutputData`, `NoBatteryReading`, `NoGyroCalib`, `OnlyOutputData0x05` (USB
report id only). Keep a `quirks` mask per device id for this.

## DS4 input report `0x01` (USB, 64 bytes)

| Bytes      | Field                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------- |
| `[0]`      | report id `0x01`                                                                                        |
| `[1..4]`   | LX, LY, RX, RY (0..255, stick Y is down-positive)                                                       |
| `[5]`      | low nibble = dpad hat (0-7 clockwise from up, 8=none); bit4=Square bit5=Cross bit6=Circle bit7=Triangle |
| `[6]`      | bit0=L1 bit1=R1 bit2=L2 bit3=R2 bit4=Share bit5=Options bit6=L3 bit7=R3                                 |
| `[7]`      | bit0=PS, bit1=Touchpad click, rest = report frame ctr                                                   |
| `[8..9]`   | L2, R2 analog (0..255)                                                                                  |
| `[10..11]` | sensor timestamp (LE u16)                                                                               |
| `[13..18]` | gyro pitch/yaw/roll (LE i16, NB: pitch is `[17..18]` swapped sign)                                      |
| `[19..24]` | accel x/y/z (LE i16)                                                                                    |
| `[30]`     | battery: low nibble 0-10 (÷11 BT, ÷8 USB → %); `0x10` bit = charging/cable                              |
| `[33+]`    | up to 2 touch packets, 9 bytes each: id(7bit)+active flag, x(12b LE), y(12b LE)                         |

BT variant: report `0x11`, payload shifted +2 (base fields at `[3..]`),
trailing CRC-32 over `[0xA1 head] + payload` — see CRC section. Fake/clone pads
send garbage CRCs; DS4Windows tolerates input-CRC errors (count and warn, don't
drop after N bad frames).

## DS4 output report

USB `0x05` (32 bytes):

| Bytes    | Field                              |
| -------- | ---------------------------------- |
| `[1]`    | features `0x07` (rumble+led+flash) |
| `[4]`    | light/small rumble (0..255)        |
| `[5]`    | heavy/large rumble                 |
| `[6..8]` | lightbar R, G, B                   |
| `[9]`    | flash-on duration                  |
| `[10]`   | flash-off duration                 |

BT `0x11` (78 bytes): `[1] = 0xC0 | pollRate(0..15)`, `[3]` = feature flags
(`0x07`), `[4] = 0x04`, rumble `[6..7]`, RGB `[8..10]`, flash `[11..12]`,
then CRC-32 tail over `[0xA2 head] + [0..73]` written at `[74..77]`.
(Some stacks want the 334-byte `0x15` variant instead — same layout, padded.)

## DualSense input `0x01` (USB, 64 bytes)

Same base layout as DS4 for `[1..10]` plus:

- byte `[10]`: bit0=Mute, bit1=FnL (Edge), bit2=FnR (Edge), bit3=BLP (left paddle), bit4=BRP (right paddle)
- battery ≈ `[53]`: low nibble 0-10 → %, `0x10` = charging
- touch packets at `[33]`/`[42]` (4 bytes each: id+active, x(12b), y(12b))
- gyro `[16..21]`, accel `[22..27]`

BT `0x31` (78 bytes): `reportOffset = 1`, payload +1, CRC-32 tail `[74..77]`
over `[0xA1 head] + payload`. Validate CRC but tolerate clones.

## DualSense output report `0x02` (USB, 48 bytes)

| Bytes      | Field                                                                                                                         |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `[1]`      | valid flag 0 `0xFF` (enable all) or mask                                                                                      |
| `[2]`      | valid flag 1 `0xF7` — toggles: bit0 rumble, bit1 haptics, bit2 mic-led, bit4 lightbar, bit5 player leds, bit6 trigger effects |
| `[3..4]`   | rumble light, heavy                                                                                                           |
| `[9]`      | mic LED (0=off, 1=on, 2=pulse)                                                                                                |
| `[10..20]` | R2 trigger-effect block (mode + params, 11 bytes)                                                                             |
| `[21..31]` | L2 trigger-effect block                                                                                                       |
| `[37]`     | power save / LED brightness opts                                                                                              |
| `[39]`     | player-LED brightness                                                                                                         |
| `[42]`     | player-LED opts (bit3 = instant/fade)                                                                                         |
| `[43]`     | player-LED mask opts                                                                                                          |
| `[44]`     | player-LED bitmask (5 LEDs, bits 0-4)                                                                                         |
| `[45..47]` | **lightbar R, G, B**                                                                                                          |

BT `0x31`: `[1] = 0x02` (bt flags), payload shifted +1, CRC-32 tail at
`[74..77]` over `[0xA2 head] + [0..73]`.

Trigger effects (mode byte first of each 11-byte block): `0x00` off,
`0x01` continuous resistance (start, force), `0x02` section (start, end,
force), `0x06` vibration (freq amp start …), `0x21`/`0x22`/`0x25`/`0x26`
compound modes. Edge-only modes `0xFC`-extended.

## CRC-32 (BT reports)

Reflected CRC-32, poly `0xEDB88320`, init `0xFFFFFFFF`, xorout `0xFFFFFFFF`
(standard zlib CRC) computed over a synthetic buffer = single head byte +
report bytes, result LE at the tail. Head `0xA2` for output reports, `0xA1`
for input validation. DS4Windows `Crc32.cs` is a plain table implementation —
port verbatim and unit-test against captured vectors. If CRC is wrong the
controller **silently ignores** output reports — hardest failure to debug.

## Battery quirks

- DS4 over USB/cable reports ~99% constantly; `charging` bit at `0x10`.
- `NoBatteryReading` clones: skip battery byte entirely.
- DualSense: `level = min(nibble * 10 + 5, 100)` convention.

## Mapping model (`DS4Control`/`ScpUtil.cs`)

~54 inputs: face buttons, dpad (4), L1/R1/L2/R2/L3/R3, PS, Share/Options,
Touch click, Mute, FnL/FnR, BLP/BRP (Edge), stick directions (8), trigger
"full pull" (2), gyro directions (6), touch quadrants/zones and swipes.
Outputs: X360 buttons/axes, keyboard keys, mouse buttons/motion, or unbound.
Per-profile extras: lightbar (color + charging color + low-batt color +
flash-at %), stick deadzones/anti-deadzones, rumble boost, rainbow mode,
shift-modifier layer (hold control → alternate map), touchpad-as-mouse,
gyro output mode. Auto-profiles keyed per executable.

## Output plumbing / hiding

Virtual output = feed mapped state into a ViGEm client (`Xbox360OutDevice` /
`DS4OutDevice`) — requires ViGEmBus kernel driver (Windows). `HidHide` hides
the physical device so games see only the virtual one — without it games may
double-read inputs. Linux equivalent path is `uinput`/evdev. `UdpServer.cs`
is a DSU/cemuhook motion server (gyro to emulators) — optional add-on.

## USB vs BT detection

Path/usage heuristics: BT devices enumerate on the Bluetooth HID interface
(DS4Windows checks `DevicePath` for `BTHENUM`/`&ig_`/service GUID); also
report-id probe — send `0x11`-style read and watch which report id arrives.
hidapi exposes `interface_number`/bus type — BT has `bus_type == Bluetooth`
on hidraw backends.

## HidHide driver contract (exclusive access, Windows)

Control device `\\.\HidHide` (GENERIC_READ|WRITE, share rwd). IOCTLs are
`CTL_CODE(DeviceHidHide=0x8001, Function, METHOD_BUFFERED, FILE_ANY_ACCESS)`
→ `0x80016000 + (fn - 2048) * 4`:

- 2048 `GET_WHITELIST` (0x80016000): call with null out → lpBytesReturned =
  needed bytes; REG_MULTI_SZ of DOS paths (`\??\C:\...\app.exe`) allowed to
  see hidden devices. SET = 2052 (0x80016004).
- 2049 `GET_BLACKLIST` (0x80016008): REG_MULTI_SZ of device instance paths.
  SET = 2053 (0x8001600C).
- 2050 `GET_ACTIVE` (0x80016010): 1-byte out. SET = 2054 (0x80016014).
- 2055 `ADD_SESSION_BLACKLIST` (0x80016020): in-REG_MULTI_SZ; entries persist
  only while the opening process lives — self-cleaning, preferred.
  2056 `CLEAR_SESSION_BLACKLIST` (0x80016024).
- Older drivers return an error on the session IOCTLs → fall back to the
  persistent blacklist and remove the entry on drop.

Device path → instance path: strip `\\?\` prefix, cut at `#{` GUID tail,
`#` → `\`, uppercase: `\\?\HID#VID_054C&PID_09CC&IG_00#9&1a2b&0&0000#{guid}`
→ `HID\VID_054C&PID_09CC&IG_00\9&1A2B&0&0000`. Whitelist FIRST (own exe in
DOS notation), then blacklist, then set active — otherwise the caller loses
its own device mid-flow. Restore on exit: clear session list / remove
instance from persistent list / restore prior active flag.

Linux equivalent: `EVIOCGRAB` (`0x40044590`) on each evdev node under
`/sys/class/hidraw/<node>/device/input/input*/event*`.
