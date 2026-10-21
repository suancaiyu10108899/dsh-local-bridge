# Security Policy

## Supported versions

This is an alpha. Only the latest published `0.1.x` tag is supported; older tags may contain known issues.

## Threat model

- The hub is designed for **loopback only** on a single-user machine.
- Runtime state under `.local/` contains a bearer token and message history. Treat it as sensitive.
- Pairing is an explicit allowlist; do not weaken it to "accept all" without a design discussion.
- This project does not provide encryption at rest, remote access, multi-user isolation, or sandboxing.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

- Use GitHub's private vulnerability reporting on this repository, if available.
- If that is unavailable, open a minimal issue asking the maintainer for a private channel **without** including exploit details.

Include:
- affected version/tag;
- impact and prerequisites;
- minimal reproduction;
- suggested fix, if any.

Please allow a reasonable amount of time before disclosure. There is no bug bounty.
