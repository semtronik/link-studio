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

## Status

> 🚧 Under active development. Code push and first release are planned within
> the coming days.

## Learn more

- [semtronik.com](https://semtronik.com) — product page (coming soon)

## License

MIT — see [LICENSE](LICENSE)
