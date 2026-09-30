# Use ordered content parts for Turn input

`AgentSession.startTurn` accepts a non-empty ordered `TurnContentPart[]` containing text and image parts rather than a prompt string plus separate attachments. Images may be supplied as an absolute local file path or base64 data with an explicit media type; Core does not resolve paths against process cwd or download remote URLs, while invalid input produces `INVALID_INPUT` and a Harness or model rejection produces `HARNESS_ERROR`. A future string overload may only translate to one text part.
