// Encodes strings in the qualified native protobuf metadata fixture. This is
// independent of the Adapter's reader and supports long Workspace URI bytes.
export function nativeStringField(tagBytes, value) {
  const bytes = Buffer.from(value);
  const length = [];
  let remaining = bytes.length;
  do {
    length.push((remaining & 0x7f) | (remaining > 0x7f ? 0x80 : 0));
    remaining = Math.floor(remaining / 128);
  } while (remaining);
  return Buffer.concat([Buffer.from(tagBytes), Buffer.from(length), bytes]);
}
