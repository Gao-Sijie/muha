# Keep public runtime data JSON-safe

All public Turn Events, Turn Results, and structured errors will be composed of JSON-safe data so callers can store or transport them without vendor-specific serialization. Harness Adapters must convert native values rather than exposing dates, errors, class instances, functions, streams, buffers, big integers, or other process-bound objects through Core.
