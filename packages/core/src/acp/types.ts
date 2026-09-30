/// <reference lib="esnext.disposable" preserve="true" />
// Node >=22.20 supports disposal symbols. Carry the SDK's declaration-library
// requirement here instead of making ES2022 consumers change their tsconfig.
// Private ACP boundary, pinned to the upstream SDK's v1 schema (ADR-0136).
// Harness-specific configuration/metadata belongs to the owning Adapter.
import type { ClientCapabilities, CreateElicitationRequest, PromptResponse, ToolCallUpdate } from "@agentclientprotocol/sdk";
import type { AdapterCreateSessionOptions, AdapterQuestionItem, AdapterQuestionResponse, AdapterTurnEvent, AdapterTurnUsage } from "../internal.js";
import type { HarnessErrorData } from "../errors.js";
export type AcpQuestionRequest = CreateElicitationRequest;

export interface AcpRouteOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
}

export interface AcpSessionIdentity extends AdapterCreateSessionOptions {
  readonly nativeSessionId: string;
}

export interface AcpQuestionMapping {
  readonly questions: readonly AdapterQuestionItem[];
  readonly nativeToolCallId?: string;
  reply(response: AdapterQuestionResponse): Record<string, unknown>;
}

/** These operations cannot submit a prompt. The shared Driver is the sole
 * executor; each Adapter supplies only its proven native semantic supplement. */
export interface AcpHarnessBehavior {
  readonly effortConfigId: string;
  // Both Harness Drivers keep tools native-owned. This shared client offers
  // only native-Question form elicitation, never host file or terminal tools.
  readonly clientCapabilities?: Pick<ClientCapabilities, "elicitation">;
  classifyError?(error: HarnessErrorData): HarnessErrorData;
  configureSession?(session: AcpSessionIdentity): Promise<void>;
  /** Native supplements use their Adapter context to commit full payloads
   * before publishing. The callback is bound to this one immutable Turn. */
  openTurn?(session: AcpSessionIdentity, publishCommitted: (event: AdapterTurnEvent) => Promise<void>): Promise<AcpTurnSupplement>;
  decodeQuestion?(request: CreateElicitationRequest): AcpQuestionMapping | undefined;
}

export interface AcpTurnSupplement {
  tool?(update: ToolCallUpdate): Promise<{ readonly name: string; readonly input: unknown; readonly output?: unknown } | undefined>;
  settle?(result: PromptResponse): Promise<{ readonly usage?: AdapterTurnUsage; readonly failure?: HarnessErrorData }>;
  /** A prompt RPC failure may still follow native execution. Preserve its
   * committed terminal/usage barrier without pretending it was a response. */
  settleFailure?(error: HarnessErrorData): Promise<{ readonly usage?: AdapterTurnUsage; readonly failure?: HarnessErrorData }>;
  respondToQuestion?(nativeRequestId: string, response: AdapterQuestionResponse): Promise<void>;
  respondToApproval?(nativeRequestId: string, decision: "allowOnce" | "deny"): Promise<boolean>;
  close?(): void;
}
