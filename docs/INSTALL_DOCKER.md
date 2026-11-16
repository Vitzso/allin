# Install AllIn with Docker

This runs AllIn in a container on an always-on Linux box at home, such as a home lab. You open it from your Mac and your phone over your own WireGuard network, over HTTPS. It is a second way to install, beside the [systemd install](INSTALL_LINUX.md).

**Live feeds do not work in the container.** Markets shows replay data only. Tasks and Health are expected to work, but nobody has used them in a container. If you want a feed that keeps collecting while your Mac sleeps, use the systemd install instead.

**Status: run once, in part.** On 2026-11-16 the image was built and the container started on one box (Ubuntu 24.04, x86-64, Docker 29), using the [WireGuard-in-a-container setup](#if-wireguard-runs-in-a-container). AllIn passed its start checks there, which include the certificate files and the key volume's owner and mode, and a phone on the WireGuard network reached it over HTTPS and got AllIn's own refusal, `Cross-site access is not allowed.`, after its owner continued past a certificate warning. No sign-in page was shown. That is all that has run. Nobody has yet created a vault or signed in on that box, so the database module's binary has not been loaded on Linux, and the plain host-networking setup has never run at all. Docker is not on the Mac where this was written, so the tests for the Docker files are text checks. Treat the first install as a trial: use a backup you can afford to lose, and keep your Mac vault.

## What you need

- A Linux box that only you use, with **Docker and the compose plugin** (`docker compose version` should work). Your own Docker setup is outside what this project has seen, so check it rather than assuming.
- **WireGuard already working** between the box and the devices you will use. AllIn doesn't set it up. You need the box's WireGuard address, such as `10.8.0.1`. If WireGuard runs on the box itself, AllIn's container uses the box's network directly. If WireGuard runs in a container, follow [the extra section](#if-wireguard-runs-in-a-container) as well: the box then has no WireGuard address of its own, and without that section AllIn refuses to start.
- **The certificate.** Make it as the [Linux guide](INSTALL_LINUX.md#make-the-private-authority-and-the-server-certificate) describes, and install the authority on your devices as it describes. Use the same steps, and issue it for the address AllIn will listen on: the box's WireGuard address, or the tunnel address if WireGuard runs in a container. You get `server.crt` and `server.key`.
- **An encrypted disk.** This is an assumption for you to check, not a fact about your box. The key volume sits on the same disk as the vault volume. If the disk isn't encrypted, someone who takes the disk gets both.
- Internet access on the box for the build. See below.

## Copy the release folder to the box

On your Mac, build the release folder and copy it to the box. It holds the Docker files beside the systemd ones.

```sh
npm ci
npm run package:linux          # makes release/allin-linux-<version>/
scp -r release/allin-linux-0.1.0 you@box:~/
```

On the box, work from inside that folder. The image is built from it, and it holds the compiled app, `package.json`, `package-lock.json`, `Dockerfile`, `.dockerignore`, `compose.yaml`, `docker.env.example`, and `compose.wireguard.yaml` with `compose.env.example` for a box where WireGuard runs in a container. It holds no key, data or certificate. You add `tls/` and `docker.env` to it below, and `.env` if you use that section; `.dockerignore` lets only the compiled app and the two package files reach the Docker daemon when the image is built, so the TLS key isn't sent with them. That hasn't been tried with a real build.

```sh
cd ~/allin-linux-0.1.0
```

## Prepare the certificate folder

Make a folder called `tls` here, next to `compose.yaml`, and put the certificate and its key in it. The container runs as user and group 10001, so that user must own them.

```sh
mkdir tls
cp /path/to/server.crt /path/to/server.key tls/
sudo chown -R 10001:10001 tls
sudo chmod 600 tls/server.key
```

AllIn refuses to start if the key file is readable by anyone but its owner. Delete any other copy of `server.key` from the box. The authority key was never there.

## Fill in `docker.env`

Copy the example and edit it. `ALLIN_LISTEN` and `ALLIN_ORIGIN` are commented out in the example, so uncomment them and set them to your box's address.

```sh
cp docker.env.example docker.env
```

```text
ALLIN_LISTEN=10.8.0.1
ALLIN_ORIGIN=https://10.8.0.1:4310
ALLIN_TLS_CERT=/etc/allin/tls/server.crt
ALLIN_TLS_KEY=/etc/allin/tls/server.key
```

Leave the last two lines as they are. They are paths inside the container, where `./tls` is mounted read-only. You don't set the data and key folders: the image sets them to `/data/vault` and `/data/keys`, and the port to 4310. If you add `ALLIN_PORT` to use another port, change the port in `ALLIN_ORIGIN` to match.

The launcher refuses to start, with a message naming the problem, when:

- `ALLIN_LISTEN` is a wildcard, a public address, or not an address on this machine. `127.0.0.1` and private ranges (10.x, 172.16-31.x, 192.168.x, 100.64.0.0/10, fc00::/7) are accepted. This is why the compose file uses host networking: with Docker's own bridge network the box's WireGuard address doesn't exist inside the container. When WireGuard itself runs in a container, the address isn't on the box either: see the next section.
- `ALLIN_LISTEN` is a private address and `ALLIN_ORIGIN`, `ALLIN_TLS_CERT` or `ALLIN_TLS_KEY` is missing, or the origin isn't `https://host:port` with the same port as `ALLIN_PORT`.
- The certificate or key file is missing or can't be read by the user running AllIn, or the key is readable by anyone but its owner.
- `ALLIN_DATA_DIR` or `ALLIN_KEYSTORE_DIR` is set to an empty value in `docker.env`. Leave both out: the image sets them.
- The key folder doesn't exist, isn't mode `0700`, isn't owned by the user running AllIn, or sits inside or around the data folder. This is checked at start, before AllIn listens.

The address you type in the browser must be exactly `ALLIN_ORIGIN`.

If `ALLIN_LISTEN` is left unset, AllIn listens on `127.0.0.1` only, and it refuses the certificate lines. That is not useful from your phone, so set both.

## If WireGuard runs in a container

Skip this section if WireGuard runs on the box itself.

If WireGuard runs in a container, the box has no WireGuard address of its own, and AllIn would stop with `ALLIN_LISTEN is not an address on this machine.` So AllIn's container shares the WireGuard container's network, where the tunnel address exists. A second compose file, `compose.wireguard.yaml`, does this. It is used together with `compose.yaml` and changes only the network line. **None of this has run**, not even on a machine with Docker.

1. Find the WireGuard container's name and its tunnel address. Both commands only read.

   ```sh
   docker ps --format '{{.Names}}  {{.Image}}'
   docker exec <name> ip -brief addr
   ```

   The tunnel address is on the WireGuard interface's line, which is usually `wg0`. If the second command is refused, try `docker exec <name> ip addr`. If the image has no `ip` command at all, look for the server's address in that container's own settings.

2. Copy the compose settings and name the container in them.

   ```sh
   cp compose.env.example .env
   ```

   ```text
   COMPOSE_FILE=compose.yaml:compose.wireguard.yaml
   ALLIN_WIREGUARD_CONTAINER=<name>
   ```

   Compose reads `.env` from the folder you run it in, so every `docker compose` command in this guide then uses both files. These are settings for compose, not for AllIn. Compose stops with a message if the name is missing.

3. In `docker.env`, set `ALLIN_LISTEN` to the tunnel address and `ALLIN_ORIGIN` to `https://<tunnel address>:4310`. Issue the certificate for that address.

4. Check that both files are in use. This reads only and downloads nothing.

   ```sh
   docker compose config | grep network_mode
   ```

   It should print a line that names your WireGuard container. That shows only which files compose read. It doesn't show that the container is running or has the address. If it prints `network_mode: host`, compose isn't reading `.env`: run it from the folder that holds `.env`. If it prints an error instead, the name in `.env` is missing.

Then go on with **Build and start**. What is different with this setup:

- **Who can reach the sign-in page:**
  - Every device your WireGuard container accepts as a peer. That includes other people's devices if you have given anyone else access.
  - The WireGuard container itself.
  - Anyone who can use Docker on the box (root, or a member of the `docker` group). They can run commands inside the WireGuard container or attach another container to its network.

  All of them still need your passphrase. No port is published, and AllIn listens on the tunnel address only. A device reaches the page only if its WireGuard settings route the tunnel address through the tunnel.

- **When the WireGuard container restarts or is recreated** (an update, a change to its settings), AllIn is cut off. Its container is expected to still show as running while the page doesn't load. From the release folder, run:

  ```sh
  docker compose up -d --force-recreate
  ```

  That locks the vault, so sign in again. Nothing does this for you. After a reboot AllIn may need the same command, depending on the order Docker starts the two containers in. If the WireGuard container isn't running, Docker is expected to refuse to start AllIn at all, so start that container first. None of this has been tried.

- **Only the network is shared.** AllIn's container still has a read-only file system and no capabilities, and it gets none of the WireGuard container's privileges. A program in either container can reach services the other one listens with, including on `127.0.0.1`. AllIn's container can also open connections to your WireGuard devices and out through the WireGuard container's routes, as that container can.
- **If you rename or replace the WireGuard container,** update the name in `.env` and run the command above.

## Build and start

**This step downloads files.** Building the image pulls the base image `node:22-bookworm-slim` from Docker Hub and downloads the dependencies from the npm registry. Running the container afterwards downloads nothing.

```sh
docker compose up -d --build
```

The image runs as a fixed non-root user (uid and gid 10001). It creates `/data/vault` and `/data/keys` owned by that user with mode `0700`, and the two named volumes are expected to take that ownership from the image when Docker first creates them. That is how Docker normally behaves for a new named volume, but it hasn't been checked here. The compose file also sets a read-only root file system, drops every capability, sets `no-new-privileges`, gives `/tmp` as a memory file system, publishes no ports, and restarts the container unless you stop it.

The image needs Node 22.18 or later, and the `node:22` tag moves, so check it:

```sh
docker compose run --rm allin node -v
```

It should print `v22.18.0` or later. With a shared WireGuard container, this command needs that container to be running. If it prints something older, don't go on. Fetch the newest base image, rebuild, and replace the running container, then check again:

```sh
docker compose build --pull
docker compose up -d
```

`build` alone leaves the old container running on the old image. `up -d` replaces it.

## Check it

```sh
docker compose ps
docker compose logs allin
```

The log shows the route and error type only. If it says `ALLIN_LISTEN is not an address on this machine.`, WireGuard isn't up yet, or WireGuard runs in a container and [that section](#if-wireguard-runs-in-a-container) wasn't followed. With host networking the container restarts until the address exists. With a shared WireGuard container the same is expected once that container is running; if it isn't running, Docker may refuse to start AllIn at all. That hasn't been tried. If it names the key folder, the volume ownership isn't what was expected: see the unverified list below.

Open `https://10.8.0.1:4310` from a device that trusts the authority. Type the address or use a bookmark. If the browser shows a certificate warning, don't continue past it: the device doesn't trust the authority yet, so install it as the Linux guide describes. Continuing past the warning, or following a link from another page, ends in AllIn's own message `Cross-site access is not allowed.` Choose **Make it yours** to create a vault, or restore one as described next. In network mode up to three devices can be signed in at once. **Connections & privacy → Signed-in devices** lists them, with a **Sign out** button for each.

Then check that the feeds are off, as expected. In **Connections & privacy**, turn on Coinbase. It should not reach live. It should report that it can't prove isolation. That is correct here, and nothing runs unsandboxed.

## What does not work, and why

The feed runs only if its worker proves that it can't see the vault. On Linux that proof needs bubblewrap at `/usr/bin/bwrap`. The image has no bubblewrap, and Docker's default settings would block it anyway, because it needs user namespaces that a container normally can't create. So the feed reports that isolation is unavailable and refuses to run. No worker is started. Nothing is loosened to make it run, and the compose file adds no capability, no `privileged` mode and no seccomp change.

The limits listed for the Linux sandbox in the [Linux guide](INSTALL_LINUX.md#what-is-unverified-or-limited) (the worker sharing the host's network and starting programs under `/usr`) apply to the systemd install, where the worker runs. In the container the worker never runs, so they don't apply here.

## Move your data from the Mac

The same as the systemd install.

1. On the Mac, unlock the vault and use **Connections & privacy → Export encrypted backup**, with a recovery phrase you keep separately.
2. In the browser, open the server's address, choose **Make it yours → I have an encrypted backup**, pick the file, enter the phrase, and set a new passphrase.
3. Check your tasks and Health summaries. Then retire the Mac vault yourself. AllIn never deletes it.

Backups hold no market data and no Alpaca key. Prices stay synthetic here in any case. See the [Linux guide](INSTALL_LINUX.md#move-your-data-from-the-mac) for the scrypt compatibility note and the sign-in wait. To clear a wait you can't sit out, stop AllIn, delete `lockout.json` from the vault volume, and start it again. This hasn't been run:

```sh
docker compose stop
docker run --rm --user 0 -v allin_allin-vault:/data/vault allin-local rm -f /data/vault/lockout.json
docker compose start
```

After a reboot, or a container restart, the vault is locked until you sign in once.

## Back up the volumes

The vault and the device secret live in two volumes: `allin_allin-vault` (the encrypted vault) and `allin_allin-keys` (the key file). **Back them up together, and keep the two copies in separate places if you can.** Without the key volume the vault can't be opened. With both, the passphrase is still needed. Copies kept together on one disk are only as safe as that disk.

The compose file names the project `allin`, so the volume names stay the same whatever the release folder is called. `docker volume ls` lists them. Stop the container first so the files are not changing. These commands copy each volume into a file in the current folder, using the image you built, and download nothing:

```sh
docker compose stop
docker run --rm --user 0 -v allin_allin-vault:/from:ro -v "$PWD":/to allin-local \
  sh -c 'umask 077 && tar -C /from -czf /to/allin-vault-backup.tgz .'
docker run --rm --user 0 -v allin_allin-keys:/from:ro -v "$PWD":/to allin-local \
  sh -c 'umask 077 && tar -C /from -czf /to/allin-keys-backup.tgz .'
docker compose start
```

`umask 077` runs inside the container, where `tar` writes the files, so they are made mode `0600` rather than readable by every user on the box. A `umask` in your own shell wouldn't reach the container. The files belong to root, so use `sudo` to move them. These commands haven't been run. The files hold your vault and its device secret, so protect them like the volumes. Restoring means the same in reverse into new, empty volumes, with the folders set back to mode `0700` and owner 10001. The simpler and tested way to move a vault is the encrypted backup through the browser, which needs no volume copy.

## Update

Build a new release folder on the Mac and copy it to the box. Then:

1. Copy `docker.env` and `tls/` from the old folder into the new one, keeping their owner and modes:

   ```sh
   sudo cp -a ~/allin-linux-<old version>/docker.env ~/allin-linux-<old version>/tls ~/allin-linux-<new version>/
   ```

   If WireGuard runs in a container, copy `.env` across too. Without it compose uses host networking and AllIn refuses to start:

   ```sh
   cp -a ~/allin-linux-<old version>/.env ~/allin-linux-<new version>/
   ```

2. From inside the new folder, rebuild and replace the container:

   ```sh
   docker compose up -d --build
   ```

3. Sign in and check that your tasks are there before you delete the old folder.

The compose file fixes the project name to `allin`, so the new folder is expected to use the same volumes, `allin_allin-vault` and `allin_allin-keys`, with your vault in them. Without the fixed name, compose would name the volumes after the folder, which changes with every version, and you would see **Make it yours** on empty volumes. `docker volume ls` shows which volumes exist. None of this has been tried.

Recreating the container locks the vault, so you sign in again afterwards. The volumes stay.

## Remove a lost phone

A phone with your WireGuard key can reach the sign-in page, and a signed-in session lasts until its 15-minute idle limit or 8-hour limit.

1. On the box, remove the phone's peer from WireGuard (for example `sudo wg set wg0 peer <its public key> remove`, and delete it from `wg0.conf` so it doesn't return). If WireGuard runs in a container, remove the peer the way that container manages its peers. If that restarts the WireGuard container, restart AllIn as [that section](#if-wireguard-runs-in-a-container) describes.
2. Sign in from another device and use **Sign out** on the lost phone's row, or **Lock vault**, which ends every session. `docker compose restart` also ends them.

## What is unverified or limited

- **Most of this guide has not run.** One box has built the image and started the container (see the status at the top). Not run anywhere: creating or restoring a vault, signing in, the backup and update steps, the lockout reset, and the host-networking setup. Docker is not on the machine this was written on, so the tests for the Docker files are text checks only. The packaging test checks that the release folder holds the files.
- **Native modules.** `better-sqlite3-multiple-ciphers` and `@napi-rs/keyring` are installed by `npm ci --omit=dev --ignore-scripts` inside a Debian-based image. `--ignore-scripts` is there because the first build on a real box (Ubuntu 24.04, x86-64) failed without it: npm tried to compile the database module, and the image has no Python or compiler. The module doesn't need compiling, because it loads the binary it ships. On a Mac, an install with that option compiled nothing and both modules loaded. With the option the build succeeded on that box and AllIn started, which loads the key library. The database module's binary is loaded only when a vault is first opened, so it has not been loaded on Linux yet. Both ship ready-made Linux binaries for x86-64 and arm64, and the image has no compiler, so another CPU type won't work. Read from the binaries on a Mac: the database module asks for glibc 2.34 or later, which the Debian 12 base image has, and the key library asks only for the basic system libraries. `@napi-rs/keyring` is loaded on Linux even though a key file holds the device secret there.
- **Volume ownership.** The key folder must be mode `0700`, owned by the running user, and apart from the data folder. That is expected to hold because the image creates both folders that way, and a new named volume takes its ownership from the image folder. On the one box that has run this, AllIn's start check on the key folder passed with new volumes. A volume Docker created earlier, or a bind mount, doesn't behave that way.
- **Anyone who can use Docker on the box can read both volumes.** That means root and every member of the `docker` group. The two volumes together hold everything except the passphrase, so the passphrase is all that stands between them and your data. Keep that group small.
- **Root on the box** can also read the volumes and, while the vault is unlocked, its contents.
- **In the host-networking install, the container uses the box's network.** It listens on the one private address you set, and the address checks apply as on the systemd install. WireGuard membership alone grants nothing: you still need your passphrase. A container that shares the host's network can also reach other services on the box that listen on `127.0.0.1`.
- **When WireGuard runs in a container,** AllIn shares that container's network instead. On the one box that has run this, Docker accepted the two compose files together, compose read `COMPOSE_FILE` from `.env`, and AllIn found the tunnel address and started. Not run: the restart command, what happens when the WireGuard container restarts, and what happens after a reboot. Beyond that its tests are text checks. AllIn depends on the WireGuard container: when that one restarts, AllIn is expected to be cut off until you restart it.
- **The `node:22` tag moves.** Check the Node version after each build.
- **The disk is encrypted** is an assumption for you to confirm.
- **Browsers and name constraints:** whether your Mac, iPhone and Android browsers accept the certificate and enforce the constraint hasn't been tried. Only OpenSSL 4.1.0 on a Mac was checked to refuse a certificate for another address or for a DNS name.
- **A sign-in over WireGuard** from your phone and Mac hasn't been tried.
- Still unverified from before, on every platform: Alpaca on real data, Keychain policy on the Mac, and Coinbase's and Alpaca's terms of service. See [THREAT_MODEL.md](THREAT_MODEL.md).
