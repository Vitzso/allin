# Security

AllIn keeps personal data in an encrypted vault on a machine you own. What it defends against, what it doesn't, and what has never been verified are written down in [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md). Read that first: some limits are known and stated there, and a report about one of them is still welcome if you can show it is worse than described.

## Reporting a problem

Please do not open a public issue for a security problem.

Use GitHub's private reporting instead: open the **Security** tab of this repository and choose **Report a vulnerability**. Only the maintainer sees the report. If that button isn't there, open an issue that says only that you have a security report to send, with no details.

It helps to include:

- what you did, step by step, and what happened;
- which install you used (Mac from source, Linux with systemd, or Docker) and the commit or version;
- what an attacker would need to already have: a network position, a device on the WireGuard network, a login on the machine, or nothing.

Never include your own vault, passphrase, recovery phrase, device secret or API keys in a report.

## What to expect

This is a personal project maintained in spare time. There is no bug bounty and no promised response time. A fix is published together with a note in the threat model when it changes what the app defends against.

## Supported versions

Only the newest commit on the main branch is maintained.
