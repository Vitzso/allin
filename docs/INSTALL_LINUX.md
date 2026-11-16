# Install AllIn on a Linux server

This puts AllIn on an always-on Linux box at home. You open it from your Mac and your phone over your own WireGuard network, over HTTPS. A feed you turned on keeps collecting while your Mac sleeps.

If your box runs Docker and you can do without live feeds, [INSTALL_DOCKER.md](INSTALL_DOCKER.md) is a second way to install.

**Status: nothing here has run on a real Linux machine.** The code was written and tested on a Mac. The installer, the systemd unit, the bubblewrap sandbox for the feed worker and a sign-in over WireGuard are all unverified. Both native modules were installed in the Docker image on one box, and `@napi-rs/keyring` loaded when AllIn started there; `better-sqlite3-multiple-ciphers` has not opened a vault on Linux, and neither has run under systemd. Docker, a different install, has run in part: see its guide. The checks near the end of this guide are how you find out. Treat the first install as a trial: use a backup you can afford to lose, and keep your Mac vault.

## What you need

- A Linux box that only you use, with **systemd**. The distribution is unknown to this project, so check yours against this list rather than assuming it works.
- **WireGuard already working** between the box and the devices you will use. AllIn doesn't set it up. You need the box's WireGuard address, such as `10.8.0.1`.
- **Node 22.18 or later**, installed system-wide (such as `/usr/bin/node`). A Node installed under a home folder, such as with nvm, is refused: the service can't read home folders.
- **bubblewrap** at `/usr/bin/bwrap`, working for ordinary users. Some distributions restrict unprivileged user namespaces, which bubblewrap needs. The installer tests this as the `allin` user and stops if it fails.
- **An encrypted disk.** This is an assumption for you to check, not a fact about your box. The Linux key file keeps the device secret on that disk. If the disk isn't encrypted, someone who takes the disk gets the key file next to the vault, and only your passphrase stands between them and your data.
- OpenSSL 3 or later on the machine where you make the certificate. Apple's built-in `openssl` is LibreSSL, which differs. Use `brew install openssl` or a Linux machine.
- An x86-64 or arm64 box with glibc 2.34 or later, which means Debian 12, Ubuntu 22.04 or newer. The encrypted-database module ships ready-made Linux binaries for those two CPU types, and they ask for that glibc. This was read from the binaries on a Mac, not run.
- Internet access on the box for the install: it downloads dependencies from the npm registry.

## Make the private authority and the server certificate

AllIn doesn't make certificates. Browsers on your devices need to trust the box's address over HTTPS, so you make your own small authority. A name constraint permits it the box's one address and one DNS name, `allin.invalid`, that nothing real uses. The DNS part matters: a constraint applies only to the name types it lists, so an authority constrained by address alone can still sign for any DNS name. **Do this on your Mac or another machine, not on the box, and keep the authority key off the box.** Work in a folder of its own outside the project, such as `~/allin-ca`, so the keys can't end up in a commit. Replace `10.8.0.1` with your box's WireGuard address.

```sh
mkdir -m 700 ~/allin-ca && cd ~/allin-ca
# The authority. Give its key a passphrase when asked.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -aes-256-cbc -out allin-ca.key
cat > ca.cnf <<'CNF'
[req]
distinguished_name = dn
x509_extensions = ca_ext
prompt = no
[dn]
CN = AllIn private authority
[ca_ext]
basicConstraints = critical, CA:true, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
nameConstraints = critical, permitted;IP:10.8.0.1/255.255.255.255, permitted;DNS:allin.invalid
CNF
openssl req -x509 -new -key allin-ca.key -days 1825 -config ca.cnf -out allin-ca.crt

# The server certificate for that address.
openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out server.key
openssl req -new -key server.key -subj "/CN=allin.invalid" -out server.csr
cat > server.ext <<'CNF'
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = serverAuth
subjectAltName = IP:10.8.0.1
CNF
openssl x509 -req -in server.csr -CA allin-ca.crt -CAkey allin-ca.key -CAcreateserial \
  -days 397 -extfile server.ext -out server.crt
openssl verify -CAfile allin-ca.crt server.crt
```

The last line should print `server.crt: OK`. These commands ran with OpenSSL 4.1.0 (Homebrew) on a Mac, without the key passphrase option. With that OpenSSL, the box certificate verified, and certificates from the same authority for another address (`IP:10.8.0.2`) and for a DNS name (`DNS:accounts.example.com`) both failed with "permitted subtree violation". Checked with Apple's built-in LibreSSL 3.3.6, the same three certificates gave the same results. The server certificate's name is `allin.invalid` on purpose: some checkers test that name against the constraint, and LibreSSL refused the box's own certificate when it was named `AllIn`, the one other name tried. Whether your Mac, iPhone and Android browsers enforce the constraint hasn't been established. Apple's and Google's certificate checks are not OpenSSL, and two quick checks with macOS's `security verify-cert` tool disagreed with each other.

Keep `allin-ca.key` somewhere safe and offline. Anyone who holds it can impersonate the box to your devices. If your devices enforce the constraint as OpenSSL does, that is all they can impersonate: the box's address and the unused name `allin.invalid`. Until that is established, assume the worst case: a device that trusts this authority could be shown a forged certificate for any site by whoever holds the key. Guard the key accordingly. The server certificate lasts 397 days, so make a new one with the same authority next year, copy it to the box and restart the service. You never need to install the authority again.

## Install the authority on your devices

Copy only `allin-ca.crt` to each device. Menu names change between versions, and none of these steps was run for this guide.

- **Mac:** open `allin-ca.crt` in Keychain Access, add it to the **login** keychain, open it, expand **Trust**, and set **When using this certificate** to **Always Trust**.
- **iPhone:** send the file to the phone (AirDrop or a file share), open it, and allow the profile. Then in **Settings → General → VPN & Device Management** install it, and in **Settings → General → About → Certificate Trust Settings** switch on full trust for it.
- **Android:** **Settings → Security** (or **Security & privacy**) **→ Encryption & credentials → Install a certificate → CA certificate**, then pick the file. Chrome on Android uses it. Some apps ignore user-installed authorities.

## Run the installer

On your Mac, build the release folder, then copy it to the box.

```sh
npm ci
npm run package:linux          # makes release/allin-linux-<version>/
scp -r release/allin-linux-0.1.0 you@box:~/
```

On the box, as root, from inside that folder:

```sh
cd ~/allin-linux-0.1.0
sudo ./install-linux.sh
```

The installer stops with one line if systemd, Node 22.18 or later, or bubblewrap is missing, or if bubblewrap fails for the `allin` user. Otherwise it:

1. Creates the `allin` system user if it's missing.
2. Creates `/var/lib/allin/vault` and `/var/lib/allin/keys` (`0700`, `allin`), `/etc/allin` and `/etc/allin/tls`, **only if they're missing**. It never changes or removes anything already under `/var/lib/allin`.
3. Prints `Downloading dependencies from the npm registry.`, then puts the app in `/opt/allin` (owned by root) and runs `npm ci --omit=dev --ignore-scripts` there. Without `--ignore-scripts`, npm tries to compile the database module, as root, which fails on a box without Python and a compiler and isn't needed: the module loads the binary it ships.
4. Installs `/etc/systemd/system/allin.service`, and `/etc/allin/allin.env` from the example only if that file doesn't exist, then runs `systemctl daemon-reload`.

It doesn't enable or start the service. It is written to be safe to run again, but it has only been checked with `bash -n`.

Put the certificate in place, from the folder where you made it, copied to the box first:

```sh
sudo install -o allin -g allin -m 0644 server.crt /etc/allin/tls/server.crt
sudo install -o allin -g allin -m 0600 server.key /etc/allin/tls/server.key
```

Then delete `server.key` and `server.csr` from wherever you copied them on the box. The authority key was never there.

## Fill in `allin.env`

Edit `/etc/allin/allin.env`. The installer writes the first three lines and comments out the rest. Uncomment the last four and set them:

```text
ALLIN_PORT=4310
ALLIN_DATA_DIR=/var/lib/allin/vault
ALLIN_KEYSTORE_DIR=/var/lib/allin/keys
ALLIN_LISTEN=10.8.0.1
ALLIN_ORIGIN=https://10.8.0.1:4310
ALLIN_TLS_CERT=/etc/allin/tls/server.crt
ALLIN_TLS_KEY=/etc/allin/tls/server.key
```

The launcher refuses to start, with a message naming the problem, when:

- `ALLIN_LISTEN` is a wildcard, a public address, or not an address on this machine. `127.0.0.1` and private ranges (10.x, 172.16-31.x, 192.168.x, 100.64.0.0/10, fc00::/7) are accepted.
- `ALLIN_LISTEN` is a private address and `ALLIN_ORIGIN`, `ALLIN_TLS_CERT` or `ALLIN_TLS_KEY` is missing, or the origin isn't `https://host:port` with the same port as `ALLIN_PORT`.
- The certificate or key file is missing or can't be read by the user running AllIn, or the key is readable by anyone but its owner.
- `ALLIN_DATA_DIR` or `ALLIN_KEYSTORE_DIR` is missing on Linux, or either is set to an empty value.
- The key folder doesn't exist, isn't mode `0700`, isn't owned by the user running AllIn, or sits inside or around the data folder. This is checked at start, before AllIn listens.

The address you type in the browser must be exactly `ALLIN_ORIGIN`.

## Start and check the service

```sh
sudo systemctl enable --now allin
systemctl status allin
journalctl -u allin -e
```

The log shows the route and error type only. If WireGuard comes up after AllIn, you may see `ALLIN_LISTEN is not an address on this machine.`. The unit has `Restart=on-failure` with a 5-second delay, so it keeps trying until the address exists.

Open `https://10.8.0.1:4310` from a device that trusts the authority. Type the address or use a bookmark. If the browser shows a certificate warning, don't continue past it: the device doesn't trust the authority yet. Continuing past the warning, or following a link from another page, ends in AllIn's own message `Cross-site access is not allowed.` Choose **Make it yours** to create a vault, or restore one as described next. In network mode up to three devices can be signed in at once. A fourth sign-in replaces the device that has been idle longest. **Connections & privacy → Signed-in devices** lists them, with a **Sign out** button for each.

The unit applies `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes` and `ReadWritePaths=/var/lib/allin`, and no more. Further systemd hardening hasn't been added because it hasn't been tried against bubblewrap on a real box. If you add a line, add it through a drop-in (`sudo systemctl edit allin`), one at a time, and rerun the feed check below. **The unit file itself is replaced on every update**, so a line edited into it is lost; a drop-in is kept.

## Move your data from the Mac

1. On the Mac, unlock the vault and use **Connections & privacy → Export encrypted backup**, with a recovery phrase you keep separately.
2. In the browser, open the server's address, choose **Make it yours → I have an encrypted backup**, pick the file, enter the phrase, and set a new passphrase.
3. Check your tasks and Health summaries. Then retire the Mac vault yourself. AllIn never deletes it.

**The Alpaca key and market history don't move.** Backups hold neither. Feeds start off on the server. Turn them on again and enter the Alpaca key again.

**Compatibility.** This version of AllIn uses a stronger scrypt setting (N=131072). Once it unlocks an existing vault, or creates a vault or a backup, an older copy of AllIn can no longer open that vault or restore that backup. A version 1 vault is upgraded at its next unlock, and the old file is replaced only after the new one is checked. Keep an old backup if you may want to go back, and use this version on the Mac too.

Sign-in is rate limited: after 5 wrong passphrases AllIn makes you wait 1 minute, doubling with each further wrong guess up to 1 hour. The wait is saved in `lockout.json` in the data folder and survives a restart. It applies to the whole server, not to one device, so anyone on your WireGuard network who guesses wrong can keep you waiting too. To clear a wait you can't sit out, stop AllIn (`sudo systemctl stop allin`), delete the file from the data folder (`sudo rm /var/lib/allin/vault/lockout.json`), and start it again (`sudo systemctl start allin`).

After a reboot the service starts, but the vault is locked and feeds are off until you sign in once. A feed you turn on keeps running while the vault is locked, until you turn it off or the box restarts.

## Checks to run on the box

None of these has run. Until they do, the Linux parts are unverified.

1. **The Linux sandbox tests.** On the box, in a checkout of the project with `npm ci` done (these need the dev tools, which the release folder leaves out), as an ordinary user and not root:

   ```sh
   node --import tsx --test tests/feedSandboxLinux.test.ts
   ```

   They are skipped on a Mac and have never run. They make their scratch folders beside the checkout, so the folder that holds the checkout must be writable by you, and the checkout must not be under `/tmp`: the sandbox hides `/tmp`, which would make the tests pass without proving anything. They start the real worker inside the real `bwrap` and check that it can't see the vault or the key folder, can't write, and that a worker started without `bwrap` fails its proof.

2. **A feed turned on.** Sign in, open **Connections & privacy**, and turn on Coinbase. The row should reach live. If it says it can't prove isolation, bubblewrap isn't working under the service. Check `journalctl -u allin`, and whether the unit's protections interfere.
3. **A reboot and an unlock.** Run `sudo reboot`. When the box is back, `systemctl status allin` should show it running, and the page should show the sign-in screen. Sign in from your phone over WireGuard. This also checks that the key file survives a reboot.
4. **Both devices.** Sign in from the Mac and the phone, check that **Signed-in devices** lists both, and that the browsers show no certificate warning.
5. **The installer twice.** Run it again and confirm `/var/lib/allin` is unchanged.

## Remove a lost phone

A phone with your WireGuard key can reach the sign-in page, and a signed-in session lasts until its 15-minute idle limit or 8-hour limit.

1. On the box, remove the phone's peer from WireGuard (for example `sudo wg set wg0 peer <its public key> remove`, and delete it from `wg0.conf` so it doesn't return).
2. Sign in from another device and use **Sign out** on the lost phone's row, or **Lock vault**, which ends every session. `sudo systemctl restart allin` also ends them.

AllIn can't change the passphrase yet. If you think someone saw it, restoring a backup into a new vault with a new passphrase is the only way to rekey.

## Update

Build a new release folder on the Mac, copy it over, then on the box:

```sh
sudo systemctl stop allin
sudo ./install-linux.sh
sudo systemctl start allin
```

Stopping locks the vault and ends feeds, so you sign in again afterwards. The installer refuses to run while the service is active. It replaces only `/opt/allin` and the unit file (drop-ins from `systemctl edit` stay), and leaves your env file, certificate and data alone.

## What is unverified or limited

- **Nothing in this guide has run on a real Linux machine:** the bubblewrap sandbox, the installer, the unit, and a sign-in over WireGuard. The database module has never opened a vault on Linux. The [Docker install](INSTALL_DOCKER.md) has run in part, once, on one box. `@napi-rs/keyring` is still a dependency and is loaded on Linux even though the key file is used there. Installing it, and `better-sqlite3-multiple-ciphers`, may need prebuilt binaries for your CPU or a compiler, which hasn't been tried.
- **Which systemd hardening works with bubblewrap** hasn't been tried.
- **The disk is encrypted** and **the distribution works** are assumptions for you to confirm.
- **Browsers and name constraints:** whether your Mac, iPhone and Android browsers accept the certificate and enforce the constraint hasn't been tried. Only OpenSSL 4.1.0 on a Mac was checked to refuse a certificate for another address or for a DNS name.
- **The Linux sandbox contains the worker's file system only.** The Mac sandbox is the stricter of the two:
  - The worker shares the host's network. It can reach any address and any port, including `127.0.0.1`, the box's own WireGuard address and other machines on your home network, over plain HTTP as well as HTTPS. Only the worker's own list of two hosts keeps it to Coinbase and Alpaca.
  - It can therefore reach AllIn's own address. AllIn still demands a session cookie and its token for every private request, and the worker has neither.
  - It can start other programs found under `/usr`. The Mac profile denies starting any child process.
  - It can't see the vault folder, the key folder or (in this install) the home folders, and it can't write outside its private `/tmp`.
  - Narrowing the Linux worker's network needs its own design.
- **Root on the box** can read the key file and, while the vault is unlocked, its contents.
- Still unverified from before, on every platform: Alpaca on real data, Keychain policy on the Mac, and Coinbase's and Alpaca's terms of service. See [THREAT_MODEL.md](THREAT_MODEL.md).
