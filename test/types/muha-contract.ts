import {
  createMuhaRuntime,
  codexAdapter,
  openCodeAdapter,
  kimiAdapter,
  piAdapter,
  agyAdapter,
  parseSessionReference,
  MuhaError,
  type MuhaRuntime,
  type MuhaRuntimeConfig,
  type OfficialAdapterOptions,
  type SessionReference,
  type TurnResult,
} from "muha";

const options: OfficialAdapterOptions = { env: { EXAMPLE: undefined } };
const create: (harnesses: MuhaRuntimeConfig["harnesses"]) => Promise<MuhaRuntime> =
  harnesses => createMuhaRuntime({ harnesses });
void create([codexAdapter(options), openCodeAdapter(), kimiAdapter(), piAdapter(), agyAdapter()]);
declare const reference: SessionReference;
declare const result: TurnResult;
void parseSessionReference(reference);
void result.status;
void MuhaError;

// @ts-expect-error The entry package does not expose the private Adapter protocol.
import { createOfficialHarnessRegistration } from "muha";
void createOfficialHarnessRegistration;

// @ts-expect-error There is no internal entry point on the public SDK package.
import { createOfficialHarnessRegistration as internalRegistration } from "muha/internal";
void internalRegistration;
