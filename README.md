# LFT App

Desktop companion app for the **LoRa Field Toolkit (LFT)** — a handheld
diagnostic tool for LoRa P2P radio links.

## What this app does

When connected to an LFT device over USB, the app displays:

- **Received frames** in real time (RSSI, SNR, payload in hex, timestamp)
- **Link quality metrics** (packet timing, frame statistics)
- **Radio configuration** of the device (frequency, spreading factor, bandwidth)
- **Custom JavaScript parsers** — write your own decoder for application
  payloads, with live preview as frames arrive

The LFT device receives LoRa P2P frames; this app is the window to read them
from a laptop.

## Tech stack

- Tauri 2 (Rust backend + React 19 frontend)
- TypeScript, Tailwind CSS
- Cross-platform: Windows, Linux, macOS

## Build from source

### Prerequisites

- **Node.js** ≥ 18
- **Rust** stable — install via [rustup.rs](https://rustup.rs/)
- **Tauri 2 system dependencies** — see the
  [Tauri prerequisites guide](https://v2.tauri.app/start/prerequisites/)
  for your OS (Xcode CLT on macOS, build tools on Windows, GTK/WebKit
  packages on Linux).

### Build

```bash
git clone https://github.com/semtronik/lft-app.git
cd lft-app
npm install
npm run tauri build
```

The binary is generated in `src-tauri/target/release/bundle/`
(`.exe` / `.msi` on Windows, `.dmg` / `.app` on macOS,
`.deb` / `.AppImage` on Linux).

## Development

```bash
npm install
npm run tauri dev
```

Launches the app with hot-reload (Vite on port 1420).

## Troubleshooting

**Serial port not detected**

- Windows: install the CP210x or CH340 USB-serial driver depending on the
  device.
- Linux: add your user to the `dialout` group:
  `sudo usermod -aG dialout $USER` (logout/login required).
- Check that the USB cable supports data, not just charging.

**Tauri build error**

- Update Rust: `rustup update`
- Re-check the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
  for missing system packages.

## Status

> Under active development. Releases are published as GitHub Releases for
> Windows; macOS and Linux users currently build from source.

## Learn more

- [semtronik.com](https://semtronik.com) — product page (coming soon)

## License

MIT — see [LICENSE](LICENSE)
