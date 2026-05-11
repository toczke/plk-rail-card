# PLK Rail Card

[![HACS Custom](https://img.shields.io/badge/HACS-Custom-orange.svg)](https://hacs.xyz)
[![Version](https://img.shields.io/badge/version-2.0.0-blue.svg)](#)

Work in progress Home Assistant integration with a bundled Lovelace card for railway departures from the PLK OpenData API.

## Status

This project is **work in progress**. The repository structure, card UI and local mock preview are prepared, but the status of end-to-end operation with Home Assistant and the real PLK API is **not confirmed yet**.

Do not treat this as production-ready. Expect API mapping fixes, Home Assistant packaging fixes and UI changes before a stable release.

## What It Is

This repository is intended to be installed as a **Home Assistant integration** through HACS, not as a standalone dashboard plugin. The integration contains both parts:

- Python backend in `custom_components/plk_rail_card`
- bundled Lovelace card in `custom_components/plk_rail_card/www/plk-rail-card.js`

The backend stores the optional PLK API key, exposes an authenticated proxy at `/api/plk_rail_card`, and serves the card JavaScript at `/plk_rail_card/plk-rail-card.js`.

## Screenshots

### Standard

![Standard PLK Rail Card](docs/images/card-standard.png)

### E-ink

![E-ink PLK Rail Card](docs/images/card-eink.png)

### Next train

![Next train PLK Rail Card](docs/images/card-next.png)

### Visual editor

![PLK Rail Card editor](docs/images/editor.png)

## Current Features

- Visual Lovelace editor.
- Home Assistant backend proxy at `/api/plk_rail_card`.
- Optional API key storage in `configuration.yaml`.
- Optional API key field in the card for quick testing.
- API limit mode: Basic, Standard, Premium or custom limits.
- Automatic refresh clamping based on limit profile, card count and safety buffer.
- Station picker using the PLK station dictionary, quick stations and recent stations.
- Carrier dictionary and carrier suggestions for the selected station.
- Planned departures from `/api/v1/schedules`.
- Realtime status, delays and cancellation data from `/api/v1/operations`.
- Optional disruptions from `/api/v1/disruptions`.
- Last-good local cache when live fetch fails.
- Departure, arrival or mixed board mode.
- Regional/long-distance scope filter.
- Destination/relation filter.
- Carrier include/exclude filters.
- Cancelled train handling: show, hide or move to bottom.
- Standard, compact, e-ink and next-train display presets.
- Brand presets: PLK, SKM, REGIO, Intercity and neutral.
- Local test page without Home Assistant.
- Local fake-data mode for design preview before the PLK key is active.

## Installation

### HACS Custom Repository

Add this repository to HACS as a custom repository with category **Integration**. After installation, restart Home Assistant.

Then add the integration to `configuration.yaml`:

```yaml
plk_rail_card:
  api_key: YOUR_PLK_API_KEY
```

Restart Home Assistant again so the proxy endpoint and static card path are registered.

Add the Lovelace resource:

```yaml
url: /plk_rail_card/plk-rail-card.js
type: JavaScript module
```

Then add the card in Lovelace.

### Manual

Copy `custom_components/plk_rail_card` to:

```text
config/custom_components/plk_rail_card
```

Then follow the same `configuration.yaml` and Lovelace resource steps above.

## Configuration

Minimal, with the key stored in Home Assistant:

```yaml
type: custom:plk-rail-card
proxy_url: /api/plk_rail_card
station_id: "38851"
station_name: Gdańsk Wrzeszcz
api_limit_mode: basic
```

Quick SKM-style preset:

```yaml
type: custom:plk-rail-card
proxy_url: /api/plk_rail_card
station_id: "38851"
station_name: Gdańsk Wrzeszcz
preset: skm_city
```

Full example:

```yaml
type: custom:plk-rail-card
proxy_url: /api/plk_rail_card
station_id: "38851"
station_name: Gdańsk Wrzeszcz
title: Pociągi z Wrzeszcza
preset: skm_city
display_preset: standard
brand_preset: skm
board_mode: departures
train_scope: all
cancelled_mode: bottom
max_departures: 8
refresh_interval: 240
e_ink_refresh_interval: 900
api_limit_mode: basic
api_key_clients: 1
api_limit_safety: 85
max_minutes_ahead: 0
show_delays: true
show_platform: true
show_carrier_name: true
show_disruptions: true
show_footer: true
realtime_only: false
carriers_include:
  - SKM
  - PR
carriers_exclude: []
destination_filter:
  - Gdynia
```

## Options

| Option | Type | Default | Description |
|---|---:|---:|---|
| `api_key` | string | empty | Optional PLK API key in Lovelace config. Prefer `plk_rail_card.api_key` in `configuration.yaml`. |
| `proxy_url` | string | `/api/plk_rail_card` | Home Assistant proxy endpoint. |
| `direct_api` | boolean | `false` | Calls PLK directly from the browser. Usually fails because of CORS. |
| `preset` | string | `custom` | `custom`, `skm_city`, `long_distance`, `e_ink_station_board`, `next_train`. |
| `api_limit_mode` | string | `basic` | Rate limit profile: `basic`, `standard`, `premium` or `custom`. |
| `api_key_clients` | number | `1` | Number of cards/devices sharing the same API key. |
| `api_limit_safety` | number | `85` | Percentage of the API limit the card may use. |
| `api_limit_hourly` | number | profile value | Custom hourly limit, used with `api_limit_mode: custom`. |
| `api_limit_daily` | number | profile value | Custom daily limit, used with `api_limit_mode: custom`. |
| `station_id` | string | empty | PLK station ID from the station dictionary. |
| `station_name` | string | empty | Display name saved by the editor. |
| `title` | string | station name | Custom card title. |
| `display_preset` | string | `standard` | `standard`, `compact`, `e_ink` or `next`. |
| `brand_preset` | string | `plk` | `plk`, `skm`, `regio`, `ic` or `neutral`. |
| `board_mode` | string | `departures` | `departures`, `arrivals` or `both`. |
| `train_scope` | string | `all` | `all`, `regional` or `long_distance`. |
| `cancelled_mode` | string | `show` | `show`, `hide` or `bottom`. |
| `max_departures` | number | `8` | Number of rows, 3-30. Next mode forces 1. |
| `refresh_interval` | number | `240` | Refresh in seconds, clamped by API limit settings. |
| `e_ink_refresh_interval` | number | `600` | Refresh in seconds for e-ink mode. |
| `max_minutes_ahead` | number | `0` | Hide departures later than this many minutes ahead. `0` disables the limit. |
| `show_delays` | boolean | `true` | Show delay badges and planned time for delayed trains. |
| `show_platform` | boolean | `true` | Show platform and track. |
| `show_carrier_name` | boolean | `false` | Show full carrier name instead of only code. |
| `show_disruptions` | boolean | `false` | Fetch and show disruptions. Adds one API request per refresh. |
| `show_footer` | boolean | `true` | Show footer. E-ink hides volatile refresh time. |
| `realtime_only` | boolean | `false` | Show only trains matched with realtime operations. |
| `carriers_include` | list/string | empty | Carrier codes to include, for example `SKM`, `PR`, `IC`. Empty means all. |
| `carriers_exclude` | list/string | empty | Carrier codes to exclude. |
| `destination_filter` | list/string | empty | Show only rows whose destination or origin contains one of these phrases. |

## Local Testing

Run from this repository:

```bash
node dev/server.cjs 8124
```

Open:

```text
http://127.0.0.1:8124/dev/
```

For live local testing, pass your API key through the local proxy process:

```bash
$env:PLK_API_KEY="YOUR_PLK_API_KEY"
node dev/server.cjs 8124
```

Use **Mock danych** in the local toolbar to preview fake SKM/PKM departures while the PLK key is inactive.

## Data Notes

The card combines planned schedules and realtime operations:

- `/api/v1/schedules` provides route metadata, destination, carrier, train number, platform and planned times.
- `/api/v1/operations` provides current execution, cancellation status and delay information.
- `/api/v1/disruptions` provides optional disruption messages.
- `/api/v1/dictionaries/stations` powers the station picker.
- `/api/v1/dictionaries/carriers` powers carrier chips in the editor.

If realtime fetch fails but planned data works, the card still shows planned departures and displays a warning. If a full refresh fails, the card can show the last-good local cache for a short time.

## Recommended Refresh

The default card performs two data calls per refresh: planned schedules and realtime operations. Enabling disruptions adds a third call.

With `api_limit_mode: basic`, `api_key_clients: 1`, `api_limit_safety: 85` and disruptions enabled, the card will not refresh faster than about 305 seconds even if `refresh_interval` is set lower.

Use `api_key_clients` for every card/device sharing the same key. Use `api_limit_mode: custom` if PLK gives you a different limit.
