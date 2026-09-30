# Keep Listed Sessions Minimal

`ListedSession` is exactly `{ reference: SessionReference; title?: string; createdAt?: string; updatedAt?: string }` in V0.1. `createdAt` and `updatedAt`, when supplied by the Coding Harness, are UTC RFC 3339 strings. An Adapter omits metadata that the Harness does not expose and does not synthesize a title from transcript text, preview text, model information, Session status, or other native fields. Muha exposes no summary, preview, model, status, transcript, or open-ended metadata bag on a Listed Session.
