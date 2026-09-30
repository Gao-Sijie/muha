# Enforce one active Turn in Core

Muha Core will own the Agent Session Turn state machine and atomically permit at most one active Turn per session. A conflicting Turn start fails immediately rather than being queued or translated into vendor-specific steering, while parallel work uses separate Agent Sessions and steering or follow-up remain outside the V0.1 public contract.
