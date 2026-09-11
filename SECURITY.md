# Security Policy

## Reporting a vulnerability

Please do not open a public GitHub issue for a security vulnerability. Use GitHub's private security-advisory reporting flow for this repository when available.

Include only the minimum information needed to reproduce the issue. Do not attach credentials, access tokens, private prompts, native Harness transcripts, or complete Muha Diagnostic Event Stores.

## Diagnostic data

Muha's Diagnostic Event Store can contain complete, unredacted native Harness payloads, including prompts, model output, tool input/output, file content, and provider metadata. Treat the Runtime `dataDir` as sensitive application data and protect, monitor, archive, and delete it according to your own security and retention requirements.
