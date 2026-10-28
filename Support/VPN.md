# Soulseek and torrents through a VPN (Proton VPN, Mac)

Soulseek (slskd) and torrents connect straight to other people. Without a VPN, everyone they connect to sees your home IP address, and your internet provider can see the traffic. This guide puts slskd, and qBittorrent if you use torrents, behind **Proton VPN**, with a **kill switch**: if the VPN drops, they have no connection at all until it's back. SYNCHRO.S then shows you, in **Setup check → Privacy**, whether it's all working.

It's optional. If you don't add the VPN file, nothing changes.

**What stays the same.** SYNCHRO.S itself, your streaming-service downloads, the metadata look-ups, Plex or Jellyfin and (later) Tailscale don't go through the VPN. Only slskd and the torrent client do.

**What it doesn't do.** A VPN hides your home IP from peers and your provider. It doesn't make Soulseek anonymous: your Soulseek username stays the same over time, so use one you don't use anywhere else.

## Before you start

- **A paid Proton VPN plan (Plus or higher)** for port forwarding. Port forwarding lets other people connect to you, which Soulseek needs for many uploads and some searches. Without it (Proton Free, or until you've checked your plan) the VPN still works: downloads work, but fewer people can reach you. Step 2 says what to change.
- **Docker Desktop 4.27 or later** (it has Docker Compose 2.24, which the VPN file needs). Docker Desktop → *Check for updates*.
- **slskd in your `docker-compose.yml`**, as the Mac guide set it up, in your `~/SoulSync` folder.

## How it works

```
SYNCHRO.S ──(home network)──► gluetun ◄── slskd, qBittorrent share its network
                                 │
                                 └── WireGuard tunnel ──► Proton VPN ──► other peers
```

- **gluetun** ([qmcgaw/gluetun](https://github.com/qdm12/gluetun), pinned to v3.41.3) holds the VPN. slskd and qBittorrent run inside its network (`network_mode: "service:gluetun"`) and have no network of their own.
- **The kill switch** is gluetun's firewall. It drops everything that isn't going through the VPN tunnel (apart from the connection to the VPN server itself and your Docker network). If the tunnel goes down, slskd and qBittorrent can't reach anything. slskd also signs out of Soulseek while gluetun says the VPN is down.
- **The forwarded port.** Proton gives you a random port, and it can change. slskd follows it by itself (its built-in gluetun support). qBittorrent follows it through gluetun's port command.
- SYNCHRO.S still reaches slskd at `http://slskd:5030` and qBittorrent at `http://qbittorrent:8080`: gluetun answers to those names now.

## Step 1: get a WireGuard key from Proton

1. Sign in at [account.proton.me](https://account.proton.me), and open **VPN → WireGuard configuration** (it's in the *Downloads* part of the VPN settings).
2. Give it a name, like `SYNCHRO.S`, and pick **GNU/Linux** as the platform (gluetun runs Linux).
3. Under **Select VPN options**, turn on **NAT-PMP (Port Forwarding)**. Without this, port forwarding won't work, even on a paid plan.
4. Pick any server in the country you want (for example the Netherlands). gluetun chooses the server itself; the key works for all of Proton's servers.
5. Click **Create**. Proton shows the configuration. Copy only the value after `PrivateKey = ` (a line of letters, numbers, `+`, `/`, ending in `=`). You can't see it again later, so keep the window open until step 2 is done.

Treat the key like a password: anyone with it can use your Proton VPN.

## Step 2: fill in the settings file

1. In Finder, open your `~/SoulSync` folder. Copy `docker-compose.vpn.yml` and `vpn.env.example` from the SYNCHRO.S download into it.
2. Open Terminal and go to the folder:

   ```sh
   cd ~/SoulSync
   ```

3. Make a key for gluetun's control server (SYNCHRO.S and slskd use it to ask gluetun how the VPN is doing):

   ```sh
   docker run --rm qmcgaw/gluetun:v3.41.3 genkey
   ```

   It prints a short random key. Copy it.
4. Add the VPN lines to your `.env` file (the settings file next to `docker-compose.yml`). If you already have a `.env`, this adds to the end of it and keeps what's there:

   ```sh
   cat vpn.env.example >> .env
   open -e .env
   ```

5. In TextEdit, fill in:
   - `WIREGUARD_PRIVATE_KEY=` the Proton key from step 1;
   - `GLUETUN_API_KEY=` the key from step 3;
   - `SERVER_COUNTRIES=` the country (or countries, separated by commas) you want;
   - `PORT_FORWARDING=true` on Proton Plus or higher. **On Proton Free, or until you know your plan, set `PORT_FORWARDING=false`**: with `true`, gluetun only uses Proton's P2P servers, which Free can't use, so it wouldn't connect;
   - if you use torrents, remove the `#` in front of `COMPOSE_PROFILES=torrents`.

   Save and close.

`.env` now holds secrets. Don't share it, and don't put it on GitHub (SYNCHRO.S's own repository ignores `.env` files).

## Step 3: start with the VPN

```sh
cd ~/SoulSync
docker compose up -d
```

The `COMPOSE_FILE` line in `.env` makes `docker compose` use `docker-compose.vpn.yml` on top of `docker-compose.yml`, so this is the same command as always (and the one the drives helper runs). Docker downloads gluetun the first time.

Check it connected:

```sh
docker compose logs gluetun | tail -n 30
```

You should see `Wireguard setup is complete`, then a public IP address in the country you chose and, with port forwarding, a line from `[port forwarding]` naming the forwarded port (a number like 51234).

**Using torrents?** Open qBittorrent at `http://localhost:8080` (its first password is in `docker compose logs qbittorrent`), then in **Tools → Options → Web UI** tick **Bypass authentication for clients on localhost**, and in **Downloads** set the save path to `/downloads`. The tick lets gluetun set qBittorrent's port; only programs inside gluetun's own network count as "localhost". In SYNCHRO.S, set the torrent client's address to `http://qbittorrent:8080`.

## Step 4: check the privacy card

1. In SYNCHRO.S, open **Setup check** (as an admin).
2. In the **Privacy** card, open **Privacy check settings**:
   - **Gluetun's control address:** `http://gluetun:8000`;
   - **Gluetun key:** the `GLUETUN_API_KEY` from `.env`;
   - **Compare with my home IP:** optional. When it's on, SYNCHRO.S asks one outside service, `api.ipify.org`, for your home address (one request, at most once an hour) so it can check the VPN's address is different. It's off unless you turn it on.
3. Click **Save**. The card checks straight away.

What the card can say:

| The card says | What it means |
| --- | --- |
| **Soulseek and torrents go through Proton VPN (Netherlands) · port 51234 forwarded · if the VPN drops, they stop** | All good. |
| **Connected, no forwarded port: downloads work but fewer people can reach you** | The VPN works, but there's no port forwarding. Expected with `PORT_FORWARDING=false`. |
| **Connected, but port 51234 isn't the one slskd listens on** | Port forwarding works, but slskd or qBittorrent hasn't picked up the port yet. |
| **VPN is down: Soulseek and torrents are stopped until it's back** | The kill switch is doing its job. gluetun keeps trying to reconnect. |
| **Not using a VPN: Soulseek and torrents show your home IP** | slskd or the torrent client isn't inside gluetun's network. |
| **The privacy check isn't set up** | Gluetun's address isn't set in the card yet. |

## If the card is red or amber

**"VPN is down".** Look at gluetun's log: `docker compose logs gluetun | tail -n 50`.
- An error about finding no server, with `PORT_FORWARDING=true`: your plan may not include P2P servers, or none are in that country. Try another country, or set `PORT_FORWARDING=false`, then `docker compose up -d`.
- `i/o timeout` over and over: the private key is wrong or was revoked. Make a new configuration in Proton (step 1, with NAT-PMP on), put the new key in `.env`, then `docker compose up -d`.
- Proton's own status page may also say there's an outage.

**"Can't reach Gluetun".** `docker compose ps` should list `gluetun` as running. If it isn't, `docker compose up -d`. Check the address in the card is `http://gluetun:8000`.

**"Gluetun refused SYNCHRO.S's key".** The key in the card must be exactly the `GLUETUN_API_KEY` in `.env`. After changing `.env`, run `docker compose up -d`.

**"No forwarded port" although you have Plus.** The WireGuard configuration must have been made with **NAT-PMP (Port Forwarding)** on; make a new one if you're not sure. `PORT_FORWARDING=true` in `.env`, then `docker compose up -d`.

**"Port … isn't the one slskd listens on".** slskd follows the port by itself within a few seconds; run the check again. If it stays, check slskd is version 0.25 or later (slskd's web page shows the version) and that `docker compose config` shows `SLSKD_VPN: "true"` under slskd. For qBittorrent, check the *Bypass authentication for clients on localhost* tick.

**"Not using a VPN" or "kill switch not confirmed".** Run `docker compose config` and check slskd has `network_mode: service:gluetun`. If `COMPOSE_FILE` isn't in `.env`, add it (see `vpn.env.example`). In SYNCHRO.S, slskd's address should be `http://slskd:5030` or `http://gluetun:5030`.

**After restarting gluetun on its own** (`docker restart gluetun` or from Docker Desktop), slskd and qBittorrent lose their network until they restart too. Use `docker compose up -d` (or `docker compose restart`) instead, which restarts them in the right order.

**Stop using the VPN:** delete the `COMPOSE_FILE` line from `.env`, then `docker compose up -d --remove-orphans`. slskd gets its own network back as `docker-compose.yml` has it.

## Notes for later

- **The media centre.** The same files work on the macOS media centre with Docker Desktop: copy `docker-compose.vpn.yml` and your `.env` across with the rest of `~/SoulSync`.
- **Tailscale.** Tailscale runs on the Mac itself, not in Docker, so it reaches SYNCHRO.S at port 8008 as before; the VPN only carries slskd and qBittorrent, so the two don't get in each other's way. Don't run Proton's own Mac app at the same time as the "Compare with my home IP" switch: the Mac app would carry SYNCHRO.S's own look-up too, and the "home" address would be the Mac app's VPN address.
- **Updating gluetun.** The version is pinned in `docker-compose.vpn.yml`. To update, change the version there after reading gluetun's release notes, then `docker compose up -d`.

## What's in the VPN file

- `gluetun`: Proton VPN over WireGuard (`VPN_SERVICE_PROVIDER=protonvpn`, `VPN_TYPE=wireguard`, `WIREGUARD_PRIVATE_KEY`, `SERVER_COUNTRIES`), port forwarding (`VPN_PORT_FORWARDING`, `PORT_FORWARD_ONLY`), qBittorrent's port command (`VPN_PORT_FORWARDING_UP_COMMAND` and `_DOWN_COMMAND`, from gluetun's own guide), the firewall left on (`FIREWALL_ENABLED_DISABLING_IT_SHOOTS_YOU_IN_YOUR_FOOT=on`), and the control server on port 8000, which isn't published to your Mac. Its key only allows three questions: is the VPN up (`GET /v1/vpn/status`), what's its address (`GET /v1/publicip/ip`) and which port is forwarded (`GET /v1/portforward`). It can't stop the VPN or read its settings.
- `slskd`: `network_mode: "service:gluetun"`, its own ports removed (slskd's web page is published by gluetun on 5030; the Soulseek port goes through the VPN), and slskd's gluetun support switched on (`SLSKD_VPN`, `SLSKD_VPN_PORT_FORWARDING`, `SLSKD_VPN_GLUETUN_URL`, `SLSKD_VPN_GLUETUN_API_KEY`).
- `qbittorrent` (only with `COMPOSE_PROFILES=torrents`): `lscr.io/linuxserver/qbittorrent:5.2.3` inside gluetun's network, its web page on 8080, downloads in `./downloads`.
