import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

import {
  MuhaError,
  unsupportedCapabilityError as unsupportedCapability,
} from "./errors.js";
import type { ControlCommandRunner } from "./control.js";
import type {
  AdapterProtocolErrorData,
  EventStoreErrorData,
  HarnessErrorData,
  TurnEventBackpressureErrorData,
  TurnEventTooLargeErrorData,
} from "./errors.js";
import type {
  AdapterSession,
  AdapterQuestionAnswer,
  AdapterQuestionItem,
  AdapterQuestionResponse,
  AdapterTurn,
  AdapterTurnInput,
  AdapterTurnEvent,
} from "./internal.js";
import type {
  CapabilityOperation,
  HarnessCapabilities,
  HarnessCapabilityPath,
} from "./capabilities.js";
import type { HarnessKind } from "./index.js";

export interface SessionReference {
  readonly harness: HarnessKind;
  readonly sessionId: string;
  readonly workspacePath: string;
}

export interface ListedSession {
  readonly reference: SessionReference;
  readonly title?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export type AgentSessionStatus =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly turnId: string }
  | { readonly status: "closed" };

export interface TextTurnContentPart {
  readonly type: "text";
  readonly text: string;
}

export type ImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface ImageTurnContentPart {
  readonly type: "image";
  readonly source:
    | { readonly type: "file"; readonly path: string }
    | {
        readonly type: "base64";
        readonly mediaType: ImageMediaType;
        readonly data: string;
      };
}

export type TurnContentPart = TextTurnContentPart | ImageTurnContentPart;
export type TurnInput = readonly [TurnContentPart, ...TurnContentPart[]];

export interface AssistantMessage {
  readonly id: string;
  readonly text: string;
}

interface TurnEventEnvelope {
  readonly turnId: string;
  readonly sequence: number;
  readonly timestamp: string;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface TurnUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
}

export interface TurnRetryPolicy {
  readonly maxRetries: number;
}

export type TurnFailure =
  | HarnessErrorData
  | AdapterProtocolErrorData
  | EventStoreErrorData
  | TurnEventBackpressureErrorData
  | TurnEventTooLargeErrorData;
export type TurnInterruptionReason = "caller" | "sessionClosed" | "runtimeClosed" | "harness";
export type ApprovalPolicy = "interactive" | "autoApprove" | "autoDeny" | "harnessManaged";
export type ApprovalDecision = "allowOnce" | "deny";

export interface QuestionOption {
  readonly optionId: string;
  readonly label: string;
  readonly description?: string;
}

export interface QuestionItem {
  readonly questionId: string;
  readonly header?: string;
  readonly question: string;
  readonly description?: string;
  readonly options: readonly QuestionOption[];
  readonly multiple: boolean;
  readonly allowCustom: boolean;
}

export interface QuestionRequest {
  readonly requestId: string;
  readonly questions: readonly [QuestionItem, ...QuestionItem[]];
  readonly toolCallId?: string;
}

export type QuestionAnswer =
  | { readonly questionId: string; readonly kind: "options"; readonly optionIds: readonly [string, ...string[]] }
  | { readonly questionId: string; readonly kind: "custom"; readonly text: string }
  | {
      readonly questionId: string;
      readonly kind: "optionsWithCustom";
      readonly optionIds: readonly [string, ...string[]];
      readonly text: string;
    }
  | { readonly questionId: string; readonly kind: "skipped" };

export type QuestionResponse =
  | { readonly action: "answer"; readonly answers: readonly [QuestionAnswer, ...QuestionAnswer[]] }
  | { readonly action: "dismiss" };

export type TurnEvent =
  | (TurnEventEnvelope & { readonly type: "turn.started" })
  | (TurnEventEnvelope & {
      readonly type: "turn.retrying";
      readonly retryNumber: number;
      readonly maxRetries: number;
      readonly error: HarnessErrorData;
    })
  | (TurnEventEnvelope & {
      readonly type: "assistant.message.started";
      readonly messageId: string;
    })
  | (TurnEventEnvelope & {
      readonly type: "assistant.message.delta";
      readonly messageId: string;
      readonly delta: string;
    })
  | (TurnEventEnvelope & {
      readonly type: "assistant.reasoning.delta";
      readonly messageId: string;
      readonly delta: string;
    })
  | (TurnEventEnvelope & {
      readonly type: "assistant.message.completed";
      readonly message: AssistantMessage;
    })
  | (TurnEventEnvelope & {
      readonly type: "tool.started";
      readonly toolCallId: string;
      readonly toolName: string;
      readonly input: JsonValue;
    })
  | (TurnEventEnvelope & {
      readonly type: "tool.updated";
      readonly toolCallId: string;
      readonly update: JsonValue;
    })
  | (TurnEventEnvelope & {
      readonly type: "tool.completed";
      readonly toolCallId: string;
      readonly output: JsonValue;
      readonly isError: boolean;
    })
  | (TurnEventEnvelope & {
      readonly type: "usage.updated";
      readonly usage: TurnUsage;
    })
  | (TurnEventEnvelope & {
      readonly type: "approval.requested";
      readonly requestId: string;
      readonly title: string;
      readonly description?: string;
      readonly toolCallId?: string;
      readonly details?: JsonValue;
    })
  | (TurnEventEnvelope & {
      readonly type: "approval.resolved";
      readonly requestId: string;
      readonly outcome: "allowOnce" | "deny";
      readonly source: "caller" | "policy";
    })
  | (TurnEventEnvelope & {
      readonly type: "approval.resolved";
      readonly requestId: string;
      readonly outcome: "invalidated";
      readonly source: "harness" | "turn";
    })
  | (TurnEventEnvelope & QuestionRequest & { readonly type: "question.requested" })
  | (TurnEventEnvelope & {
      readonly type: "question.resolved";
      readonly requestId: string;
      readonly outcome: "answered";
      readonly answers: readonly [QuestionAnswer, ...QuestionAnswer[]];
      readonly source: "caller" | "harness";
    })
  | (TurnEventEnvelope & {
      readonly type: "question.resolved";
      readonly requestId: string;
      readonly outcome: "dismissed";
      readonly source: "caller" | "harness";
    })
  | (TurnEventEnvelope & {
      readonly type: "question.resolved";
      readonly requestId: string;
      readonly outcome: "invalidated";
      readonly source: "harness" | "turn";
    })
  | (TurnEventEnvelope & {
      readonly type: "turn.completed";
      readonly message: AssistantMessage;
      readonly usage?: TurnUsage;
    })
  | (TurnEventEnvelope & {
      readonly type: "turn.failed";
      readonly error: TurnFailure;
      readonly usage?: TurnUsage;
    })
  | (TurnEventEnvelope & {
      readonly type: "turn.interrupted";
      readonly reason: TurnInterruptionReason;
      readonly usage?: TurnUsage;
    });

export interface CompletedTurnResult {
  readonly status: "completed";
  readonly turnId: string;
  readonly message: AssistantMessage;
  readonly usage?: TurnUsage;
}

export interface FailedTurnResult {
  readonly status: "failed";
  readonly turnId: string;
  readonly error: TurnFailure;
  readonly usage?: TurnUsage;
}

export interface InterruptedTurnResult {
  readonly status: "interrupted";
  readonly turnId: string;
  readonly reason: TurnInterruptionReason;
  readonly usage?: TurnUsage;
}

export type TurnResult = CompletedTurnResult | FailedTurnResult | InterruptedTurnResult;

export interface TurnHandle extends AsyncIterable<TurnEvent> {
  readonly turnId: string;
  readonly result: Promise<TurnResult>;
  interrupt(): Promise<void>;
  respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void>;
  respondToQuestion(requestId: string, response: QuestionResponse): Promise<void>;
}

export interface AgentSession {
  readonly reference: SessionReference;
  readonly model: string | undefined;
  readonly effort: string | undefined;
  readonly status: AgentSessionStatus;
  startTurn(input: TurnInput): Promise<TurnHandle>;
  setModel(model: string): Promise<void>;
  setEffort(effort: string): Promise<void>;
  close(): Promise<void>;
}

export interface TurnQueueLimits {
  readonly maxEvents: number;
  readonly maxBytes: number;
}

const defaultTurnQueueLimits: TurnQueueLimits = {
  maxEvents: 4_096,
  maxBytes: 16 * 1024 * 1024,
};

const defaultTurnRetryPolicy: TurnRetryPolicy = Object.freeze({ maxRetries: 0 });

type TurnRetrySleeper = (delayMs: number, signal: AbortSignal) => Promise<void>;

export class CoreAgentSession implements AgentSession {
  readonly reference: SessionReference;
  readonly turnRetryPolicy: TurnRetryPolicy;
  #status: AgentSessionStatus = { status: "idle" };
  #closePromise: Promise<void> | undefined;
  #activeTurn: CoreTurnHandle | undefined;
  #starting = false;
  #selectionPending = false;
  #startSettled: Promise<void> | undefined;
  #resolveStartSettled: (() => void) | undefined;
  #closing = false;

  constructor(
    harness: HarnessKind,
    workspacePath: string,
    readonly adapterSession: AdapterSession,
    readonly approvalPolicy: ApprovalPolicy,
    readonly capabilities: HarnessCapabilities,
    readonly recordCoreEvent: (payload: unknown) => Promise<void>,
    readonly turnQueueLimits: TurnQueueLimits = defaultTurnQueueLimits,
    readonly runControlCommand: ControlCommandRunner = (_harness, _operation, start) => start(),
    turnRetryPolicy: TurnRetryPolicy = defaultTurnRetryPolicy,
    readonly sleepBeforeRetry: TurnRetrySleeper = sleepWithAbort,
    readonly retryJitter: () => number = Math.random,
  ) {
    this.turnRetryPolicy = Object.freeze({ maxRetries: turnRetryPolicy.maxRetries });
    this.reference = Object.freeze({
      harness,
      sessionId: adapterSession.nativeSessionId,
      workspacePath,
    });
  }

  get model(): string | undefined {
    return this.adapterSession.model;
  }

  get effort(): string | undefined {
    return this.adapterSession.effort;
  }

  get status(): AgentSessionStatus {
    if (this.adapterSession.closed && this.#status.status !== "closed") {
      this.#closing = true;
      this.#status = { status: "closed" };
    }
    return this.#status;
  }

  async startTurn(input: TurnInput): Promise<TurnHandle> {
    if (this.status.status === "closed" || this.#closing) {
      throw new MuhaError({ code: "SESSION_CLOSED", message: "Session is closed" });
    }
    if (this.#status.status === "running" || this.#starting || this.#selectionPending) {
      throw new MuhaError({ code: "SESSION_BUSY", message: "Session already has an active Turn" });
    }
    this.#starting = true;
    this.#startSettled = new Promise((resolve) => {
      this.#resolveStartSettled = resolve;
    });
    try {
      const adapterInput = await validateTurnInput(input);
      if (!this.capabilities.imageInput && adapterInput.some(({ type }) => type === "image")) {
        throw unsupportedCapability(this.reference.harness, "imageInput", "startTurn");
      }
      const startNativeTurn = () => this.runControlCommand(
        this.reference.harness,
        "startTurn",
        () => this.adapterSession.startTurn(adapterInput),
      );
      let nativeTurn;
      try {
        nativeTurn = await startNativeTurn();
      } catch (error) {
        if (error instanceof MuhaError) throw error;
        if (isHarnessErrorData(error)) throw new MuhaError(error);
        throw new MuhaError({
          code: "HARNESS_ERROR",
          message: "Harness rejected the Turn before acceptance",
          harness: this.reference.harness,
          operation: "startTurn",
        });
      }
      if (this.#closing) {
        try {
          void nativeTurn.interrupt().catch(() => undefined);
        } catch {
          // Runtime/Session closure remains authoritative.
        }
        throw new MuhaError({
          code: "RUNTIME_CLOSED",
          message: "Runtime closed before the Turn Handle was returned",
        });
      }
      const turnId = randomUUID();
      this.#status = { status: "running", turnId };
      let handle: CoreTurnHandle;
      handle = new CoreTurnHandle(
        turnId,
        nativeTurn,
        this.reference.harness,
        this.approvalPolicy,
        this.capabilities,
        this.turnQueueLimits,
        this.recordCoreEvent,
        this.runControlCommand,
        () => {
          if (this.#activeTurn === handle) this.#activeTurn = undefined;
          if (this.#status.status === "running" && this.#status.turnId === turnId) {
            this.#status = this.adapterSession.closed
              ? { status: "closed" }
              : { status: "idle" };
            if (this.adapterSession.closed) this.#closing = true;
          }
        },
        startNativeTurn,
        this.turnRetryPolicy,
        this.sleepBeforeRetry,
        this.retryJitter,
      );
      this.#activeTurn = handle;
      return handle;
    } finally {
      this.#starting = false;
      this.#resolveStartSettled?.();
      this.#resolveStartSettled = undefined;
    }
  }

  async setModel(model: string): Promise<void> {
    if (this.status.status === "closed" || this.#closing) {
      throw new MuhaError({ code: "SESSION_CLOSED", message: "Session is closed" });
    }
    if (this.#status.status === "running" || this.#starting || this.#selectionPending) {
      throw new MuhaError({ code: "SESSION_BUSY", message: "Model can only be changed while idle" });
    }
    if (typeof model !== "string" || model.length === 0) invalid("Model must be a non-empty string");
    if (!this.capabilities.model.selectionAt.includes("idleSession")) {
      throw unsupportedCapability(
        this.reference.harness,
        "model.selectionAt.idleSession",
        "setModel",
      );
    }
    this.#selectionPending = true;
    try {
      await this.runControlCommand(
        this.reference.harness,
        "setModel",
        () => this.adapterSession.setModel(model),
      );
      if (this.#closing) {
        throw new MuhaError({
          code: "RUNTIME_CLOSED",
          message: "Runtime closed before the model change completed",
        });
      }
    } catch (error) {
      if (error instanceof MuhaError) throw error;
      if (isAdapterProtocolErrorData(error)) throw new MuhaError(error);
      if (isHarnessErrorData(error)) throw new MuhaError(error);
      throw new MuhaError({
        code: "HARNESS_ERROR",
        message: "Harness rejected the model",
        harness: this.reference.harness,
        operation: "setModel",
      });
    } finally {
      this.#selectionPending = false;
    }
  }

  async setEffort(effort: string): Promise<void> {
    if (this.status.status === "closed" || this.#closing) {
      throw new MuhaError({ code: "SESSION_CLOSED", message: "Session is closed" });
    }
    if (this.#status.status === "running" || this.#starting || this.#selectionPending) {
      throw new MuhaError({ code: "SESSION_BUSY", message: "Effort can only be changed while idle" });
    }
    validateEffortInput(effort);
    if (!this.capabilities.effort.selectionAt.includes("idleSession")) {
      throw unsupportedCapability(
        this.reference.harness,
        "effort.selectionAt.idleSession",
        "setEffort",
      );
    }
    this.#selectionPending = true;
    try {
      await this.runControlCommand(
        this.reference.harness,
        "setEffort",
        () => this.adapterSession.setEffort(effort),
      );
      if (this.#closing) {
        throw new MuhaError({
          code: "RUNTIME_CLOSED",
          message: "Runtime closed before the Effort change completed",
        });
      }
    } catch (error) {
      if (error instanceof MuhaError) throw error;
      if (isAdapterProtocolErrorData(error)) throw new MuhaError(error);
      if (isHarnessErrorData(error)) throw new MuhaError(error);
      throw new MuhaError({
        code: "HARNESS_ERROR",
        message: "Harness rejected the Effort",
        harness: this.reference.harness,
        operation: "setEffort",
      });
    } finally {
      this.#selectionPending = false;
    }
  }

  close(): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#performClose("sessionClosed");
    return this.#closePromise;
  }

  closeForRuntime(): Promise<void> {
    this.#closing = true;
    if (this.#activeTurn) void this.#activeTurn.interruptForClose("runtimeClosed");
    this.#closePromise ??= this.#performClose("runtimeClosed");
    return this.#closePromise;
  }

  closeForEventStoreFailure(error: EventStoreErrorData): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#performEventStoreFailureClose(error);
    return this.#closePromise;
  }

  closeForHarnessFailure(error: HarnessErrorData): Promise<void> {
    this.#closing = true;
    this.#closePromise ??= this.#performHarnessFailureClose(error);
    return this.#closePromise;
  }

  async #performHarnessFailureClose(error: HarnessErrorData): Promise<void> {
    try {
      if (this.#starting) await this.#startSettled;
      const activeTurn = this.#activeTurn;
      if (activeTurn) {
        await activeTurn.failForHarness(error);
        await activeTurn.result;
      }
      await this.adapterSession.close();
    } finally {
      this.#status = { status: "closed" };
    }
  }

  async #performEventStoreFailureClose(error: EventStoreErrorData): Promise<void> {
    try {
      if (this.#starting) await this.#startSettled;
      const activeTurn = this.#activeTurn;
      if (activeTurn) {
        await activeTurn.failForEventStore(error);
        await activeTurn.result;
      }
      await this.adapterSession.close();
    } finally {
      this.#status = { status: "closed" };
    }
  }

  async #performClose(reason: "sessionClosed" | "runtimeClosed"): Promise<void> {
    try {
      if (this.#starting) await this.#startSettled;
      const activeTurn = this.#activeTurn;
      if (activeTurn) {
        await activeTurn.interruptForClose(reason);
        await activeTurn.result;
      }
      await this.adapterSession.close();
    } finally {
      this.#status = { status: "closed" };
    }
  }
}

interface ApprovalState {
  readonly requestId: string;
  readonly nativeRequestId: string;
  status: "pending" | "resolving" | "resolved" | "invalidated";
}

function approvalIsInvalidated(approval: ApprovalState): boolean {
  return approval.status === "invalidated";
}

interface QuestionState {
  readonly request: QuestionRequest;
  readonly nativeRequestId: string;
  status: "pending" | "resolving" | "resolved" | "invalidated";
}

function questionHasStatus(
  question: QuestionState,
  status: QuestionState["status"],
): boolean {
  return question.status === status;
}

interface ValidatedQuestionResponse {
  readonly publicResponse: QuestionResponse;
  readonly adapterResponse: AdapterQuestionResponse;
}

function createQuestionRequest(
  nativeQuestions: readonly AdapterQuestionItem[],
  toolCallId: string | undefined,
): QuestionRequest {
  if (!Array.isArray(nativeQuestions) || nativeQuestions.length === 0) {
    protocol("Question Request must contain at least one Question");
  }
  const questions = nativeQuestions.map((item) => {
    if (!isPlainObject(item)) protocol("Question item must be an object");
    requireNonEmpty(item.question, "Question text");
    if (item.header !== undefined) requireNonEmpty(item.header, "Question header");
    if (item.description !== undefined) requireNonEmpty(item.description, "Question description");
    if (typeof item.multiple !== "boolean" || typeof item.allowCustom !== "boolean") {
      protocol("Question multiple and allowCustom must be booleans");
    }
    if (!Array.isArray(item.options)) protocol("Question options must be an array");
    if (item.options.length === 0 && !item.allowCustom) {
      protocol("Question without options must allow a custom answer");
    }
    const options = item.options.map((option) => {
      if (!isPlainObject(option)) protocol("Question option must be an object");
      requireNonEmpty(option.label, "Question option label");
      if (option.description !== undefined) requireNonEmpty(option.description, "Question option description");
      return Object.freeze({
        optionId: randomUUID(),
        label: option.label,
        ...(option.description === undefined ? {} : { description: option.description }),
      });
    });
    return Object.freeze({
      questionId: randomUUID(),
      ...(item.header === undefined ? {} : { header: item.header }),
      question: item.question,
      ...(item.description === undefined ? {} : { description: item.description }),
      options: Object.freeze(options),
      multiple: item.multiple,
      allowCustom: item.allowCustom,
    });
  }) as [QuestionItem, ...QuestionItem[]];
  return Object.freeze({
    requestId: randomUUID(),
    questions: Object.freeze(questions),
    ...(toolCallId === undefined ? {} : { toolCallId }),
  });
}

function validateQuestionResponse(
  value: QuestionResponse,
  request: QuestionRequest,
): ValidatedQuestionResponse {
  if (!isPlainObject(value)) invalid("Question response must be an object");
  if (value.action === "dismiss") {
    assertOnlyKeys(value, ["action"], "Question dismiss response");
    return { publicResponse: Object.freeze({ action: "dismiss" }), adapterResponse: { action: "dismiss" } };
  }
  if (value.action !== "answer") invalid("Question response action must be answer or dismiss");
  assertOnlyKeys(value, ["action", "answers"], "Question answer response");
  if (!Array.isArray(value.answers) || value.answers.length !== request.questions.length) {
    invalid("Question response must answer every Question exactly once");
  }
  const byQuestion = new Map<string, QuestionAnswer>();
  for (const answer of value.answers) {
    if (!isPlainObject(answer) || typeof answer.questionId !== "string") {
      invalid("Question answer must identify a Question");
    }
    if (byQuestion.has(answer.questionId)) invalid("Question response contains a duplicate Question answer");
    byQuestion.set(answer.questionId, answer as QuestionAnswer);
  }
  const publicAnswers: QuestionAnswer[] = [];
  const adapterAnswers: AdapterQuestionAnswer[] = [];
  request.questions.forEach((question, questionIndex) => {
    const answer = byQuestion.get(question.questionId);
    if (!answer) invalid("Question response contains a missing or foreign Question ID");
    const mapped = validatePublicQuestionAnswer(answer, question, questionIndex);
    publicAnswers.push(mapped.publicAnswer);
    adapterAnswers.push(mapped.adapterAnswer);
  });
  const tuple = Object.freeze(publicAnswers) as readonly [QuestionAnswer, ...QuestionAnswer[]];
  return {
    publicResponse: Object.freeze({ action: "answer", answers: tuple }),
    adapterResponse: { action: "answer", answers: adapterAnswers },
  };
}

function validatePublicQuestionAnswer(
  answer: QuestionAnswer,
  question: QuestionItem,
  questionIndex: number,
): { publicAnswer: QuestionAnswer; adapterAnswer: AdapterQuestionAnswer } {
  if (answer.kind === "skipped") {
    assertOnlyKeys(answer, ["questionId", "kind"], "Skipped Question answer");
    return {
      publicAnswer: Object.freeze({ questionId: question.questionId, kind: "skipped" }),
      adapterAnswer: { questionIndex, kind: "skipped" },
    };
  }
  if (answer.kind === "custom") {
    assertOnlyKeys(answer, ["questionId", "kind", "text"], "Custom Question answer");
    if (!question.allowCustom || typeof answer.text !== "string" || answer.text.length === 0) {
      invalid("Custom Question answer is not allowed or is empty");
    }
    return {
      publicAnswer: Object.freeze({ questionId: question.questionId, kind: "custom", text: answer.text }),
      adapterAnswer: { questionIndex, kind: "custom", text: answer.text },
    };
  }
  if (answer.kind !== "options" && answer.kind !== "optionsWithCustom") {
    invalid("Question answer kind is invalid");
  }
  const withCustom = answer.kind === "optionsWithCustom";
  assertOnlyKeys(
    answer,
    withCustom ? ["questionId", "kind", "optionIds", "text"] : ["questionId", "kind", "optionIds"],
    "Option Question answer",
  );
  if (!Array.isArray(answer.optionIds) || answer.optionIds.length === 0) {
    invalid("Option Question answer requires at least one option");
  }
  if (!question.multiple && answer.optionIds.length !== 1) {
    invalid("A single-select Question requires exactly one option");
  }
  if (
    withCustom &&
    (!question.multiple ||
      !question.allowCustom ||
      typeof answer.text !== "string" ||
      answer.text.length === 0)
  ) {
    invalid("Options with custom text require a multiple custom-enabled Question");
  }
  const optionIndexes: number[] = [];
  const seen = new Set<string>();
  for (const optionId of answer.optionIds) {
    if (typeof optionId !== "string" || seen.has(optionId)) invalid("Question option IDs must be unique strings");
    seen.add(optionId);
    const optionIndex = question.options.findIndex((option) => option.optionId === optionId);
    if (optionIndex < 0) invalid("Question answer contains a foreign option ID");
    optionIndexes.push(optionIndex);
  }
  const optionIds = Object.freeze([...answer.optionIds]) as readonly [string, ...string[]];
  if (withCustom) {
    const text = answer.text;
    return {
      publicAnswer: Object.freeze({ questionId: question.questionId, kind: "optionsWithCustom", optionIds, text }),
      adapterAnswer: { questionIndex, kind: "optionsWithCustom", optionIndexes, text },
    };
  }
  return {
    publicAnswer: Object.freeze({ questionId: question.questionId, kind: "options", optionIds }),
    adapterAnswer: { questionIndex, kind: "options", optionIndexes },
  };
}

function mapAdapterQuestionAnswers(
  answers: readonly AdapterQuestionAnswer[],
  request: QuestionRequest,
): { publicAnswers: readonly [QuestionAnswer, ...QuestionAnswer[]] } {
  if (!Array.isArray(answers) || answers.length !== request.questions.length) {
    protocol("Harness Question answer must cover every Question exactly once");
  }
  const byIndex = new Map<number, AdapterQuestionAnswer>();
  for (const answer of answers) {
    const questionIndex = answer.questionIndex;
    if (!Number.isSafeInteger(questionIndex)) {
      protocol("Harness Question answer index is invalid");
    }
    if (byIndex.has(questionIndex)) protocol("Harness repeated a Question answer index");
    byIndex.set(questionIndex, answer);
  }
  const publicAnswers = request.questions.map((question, questionIndex): QuestionAnswer => {
    const answer = byIndex.get(questionIndex);
    if (!answer) protocol("Harness omitted a Question answer");
    if (answer.kind === "skipped") return { questionId: question.questionId, kind: "skipped" };
    if (answer.kind === "custom") {
      return { questionId: question.questionId, kind: "custom", text: answer.text };
    }
    if (answer.kind !== "options" && answer.kind !== "optionsWithCustom") {
      protocol("Harness Question answer kind is invalid");
    }
    if (!Array.isArray(answer.optionIndexes)) protocol("Harness Question option indexes are invalid");
    const optionIds = answer.optionIndexes.map((optionIndex) => {
      if (!Number.isSafeInteger(optionIndex) || optionIndex < 0 || optionIndex >= question.options.length) {
        protocol("Harness Question option index is out of range");
      }
      return question.options[optionIndex]!.optionId;
    }) as [string, ...string[]];
    return answer.kind === "options"
      ? { questionId: question.questionId, kind: "options", optionIds }
      : {
          questionId: question.questionId,
          kind: "optionsWithCustom",
          optionIds,
          text: answer.text,
        };
  }) as [QuestionAnswer, ...QuestionAnswer[]];
  const validated = validateQuestionResponse({ action: "answer", answers: publicAnswers }, request);
  if (validated.publicResponse.action !== "answer") protocol("Harness Question answer mapping failed");
  return { publicAnswers: validated.publicResponse.answers };
}

class CoreTurnHandle implements TurnHandle {
  readonly result: Promise<TurnResult>;
  readonly #events: BoundedTurnEventQueue;
  #claimed = false;
  #sequence = 0;
  #lastUsage: TurnUsage | undefined;
  #completedAttemptUsage: TurnUsage | undefined;
  #attemptUsage: TurnUsage | undefined;
  #activeNativeTurn: AdapterTurn | undefined;
  #retryAbortController: AbortController | undefined;
  #retryCount = 0;
  #publicStarted = false;
  #terminal = false;
  #settling = false;
  #resolveResult!: (result: TurnResult) => void;
  #interruptPromise: Promise<void> | undefined;
  #interruptionReason: Exclude<TurnInterruptionReason, "harness"> | undefined;
  readonly #approvals = new Map<string, ApprovalState>();
  readonly #approvalIdsByNative = new Map<string, string>();
  readonly #questions = new Map<string, QuestionState>();
  readonly #questionIdsByNative = new Map<string, string>();

  constructor(
    readonly turnId: string,
    nativeTurn: AdapterTurn,
    readonly harness: HarnessKind,
    readonly approvalPolicy: ApprovalPolicy,
    readonly capabilities: HarnessCapabilities,
    turnQueueLimits: TurnQueueLimits,
    readonly recordCoreEvent: (payload: unknown) => Promise<void>,
    readonly runControlCommand: ControlCommandRunner,
    readonly onTerminal: () => void,
    readonly startRetryAttempt: () => Promise<AdapterTurn>,
    readonly turnRetryPolicy: TurnRetryPolicy,
    readonly sleepBeforeRetry: TurnRetrySleeper,
    readonly retryJitter: () => number,
  ) {
    this.#events = new BoundedTurnEventQueue(turnQueueLimits);
    this.result = new Promise((resolve) => {
      this.#resolveResult = resolve;
    });
    queueMicrotask(() => void this.#consume(nativeTurn));
  }

  [Symbol.asyncIterator](): AsyncIterator<TurnEvent> {
    if (this.#claimed) {
      throw new MuhaError({
        code: "TURN_EVENT_STREAM_ALREADY_CLAIMED",
        message: "Turn event stream has already been claimed",
      });
    }
    this.#claimed = true;
    return this.#events[Symbol.asyncIterator]();
  }

  interrupt(): Promise<void> {
    return this.#requestInterrupt("caller");
  }

  async respondToApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    if (typeof requestId !== "string" || requestId.length === 0) invalid("Approval requestId must be non-empty");
    if (decision !== "allowOnce" && decision !== "deny") invalid("Approval decision must be allowOnce or deny");
    const approval = this.#approvals.get(requestId);
    if (!approval) throw interactionError("TURN_INTERACTION_NOT_FOUND", "approval", requestId);
    await this.#resolveApproval(approval, decision, "caller");
  }

  async respondToQuestion(requestId: string, response: QuestionResponse): Promise<void> {
    if (typeof requestId !== "string" || requestId.length === 0) invalid("Question requestId must be non-empty");
    const question = this.#questions.get(requestId);
    if (!question) throw interactionError("TURN_INTERACTION_NOT_FOUND", "question", requestId);
    const validated = validateQuestionResponse(response, question.request);
    await this.#resolveQuestion(question, validated, "caller");
  }

  async interruptForClose(reason: "sessionClosed" | "runtimeClosed"): Promise<void> {
    this.#upgradeInterruptionReason(reason);
    try {
      await this.#requestInterrupt(reason);
    } catch {
      await this.#acceptCoreInterruption(reason);
    }
  }

  async failForEventStore(error: EventStoreErrorData): Promise<void> {
    if (this.#terminal) return;
    this.#retryAbortController?.abort();
    try {
      void this.#activeNativeTurn?.interrupt().catch(() => undefined);
    } catch {
      // The Event Store failure remains authoritative.
    }
    await this.#invalidateInteractions(false);
    await this.#completeQueueFailure(error);
  }

  async failForHarness(error: HarnessErrorData): Promise<void> {
    if (this.#terminal) return;
    this.#retryAbortController?.abort();
    try {
      void this.#activeNativeTurn?.interrupt().catch(() => undefined);
    } catch {
      // The Adapter loss remains authoritative.
    }
    await this.#invalidateInteractions();
    try {
      await this.recordCoreEvent({
        type: "turn.failed",
        turnId: this.turnId,
        error,
        ...(this.#lastUsage === undefined ? {} : { usage: this.#lastUsage }),
      });
    } catch (storeError) {
      await this.#completeQueueFailure(isEventStoreFailure(storeError)
        ? storeError
        : {
            code: "EVENT_STORE_ERROR",
            message: "Diagnostic Event Store failed while recording a Core event",
            operation: "commit",
          });
      return;
    }
    await this.#completeQueueFailure(error);
  }

  async #consume(firstNativeTurn: AdapterTurn): Promise<void> {
    let nativeTurn = firstNativeTurn;
    for (;;) {
      this.#activeNativeTurn = nativeTurn;
      this.#attemptUsage = undefined;
      this.#approvalIdsByNative.clear();
      this.#questionIdsByNative.clear();
      let failure: TurnFailure | undefined;
      let failureNeedsRecord = false;
      try {
        failure = await this.#consumeValidated(nativeTurn);
      } catch (error) {
        this.#activeNativeTurn = undefined;
        await this.#failProtocol(error);
        return;
      }
      this.#activeNativeTurn = undefined;
      if (failure !== undefined && this.#interruptionReason !== undefined && this.#interruptPromise !== undefined) {
        try {
          await this.#interruptPromise;
        } catch {
          // A rejected interrupt command clears the requested reason and leaves
          // the native terminal failure authoritative.
        }
      }
      if (failure === undefined || this.#terminal || this.#settling) return;

      for (;;) {
        if (!this.#canRetry(failure)) {
          await this.#finishTurnFailure(failure, failureNeedsRecord);
          return;
        }
        this.#commitAttemptUsage();
        this.#retryCount += 1;
        const retrying = {
          type: "turn.retrying",
          retryNumber: this.#retryCount,
          maxRetries: this.turnRetryPolicy.maxRetries,
          error: failure,
        } as const;
        try {
          await this.recordCoreEvent({ ...retrying, turnId: this.turnId });
        } catch (error) {
          await this.#failStore(error);
          return;
        }
        this.#emit(retrying);
        if (this.#terminal || this.#settling) return;
        const controller = new AbortController();
        this.#retryAbortController = controller;
        try {
          await this.sleepBeforeRetry(
            retryDelayMs(this.#retryCount, this.retryJitter()),
            controller.signal,
          );
        } catch (error) {
          if (!controller.signal.aborted && !this.#terminal) await this.#failProtocol(error);
          return;
        } finally {
          if (this.#retryAbortController === controller) this.#retryAbortController = undefined;
        }
        if (this.#terminal || this.#settling || this.#interruptionReason) return;
        try {
          nativeTurn = await this.startRetryAttempt();
          if (this.#terminal || this.#settling || this.#interruptionReason) {
            void nativeTurn.interrupt().catch(() => undefined);
            return;
          }
          break;
        } catch (error) {
          if (this.#terminal || this.#settling || this.#interruptionReason) return;
          failure = normalizeRetryStartFailure(error, this.harness);
          failureNeedsRecord = true;
        }
      }
    }
  }

  async #consumeValidated(nativeTurn: AsyncIterable<AdapterTurnEvent>): Promise<HarnessErrorData | undefined> {
    let started = false;
    const messages = new Map<string, { id: string; completed: boolean }>();
    const tools = new Map<string, { id: string; completed: boolean }>();
    let finalMessage: AssistantMessage | undefined;

    for await (const nativeEvent of nativeTurn) {
      if (this.#terminal || this.#settling) return;
      if (nativeEvent.type === "turn.started") {
        if (started) protocol("Turn emitted turn.started more than once");
        started = true;
        if (!this.#publicStarted) {
          this.#publicStarted = true;
          this.#emit({ type: "turn.started" });
        }
        continue;
      }
      if (!started) protocol("Turn event preceded turn.started");

      switch (nativeEvent.type) {
        case "adapter.protocolError":
          protocol(nativeEvent.message);
        case "assistant.message.started": {
          this.#requireEventCapability(
            this.capabilities.assistantMessageStreaming,
            "assistantMessageStreaming",
          );
          requireNonEmpty(nativeEvent.nativeMessageId, "native Assistant Message ID");
          if (messages.has(nativeEvent.nativeMessageId)) protocol("Assistant Message started more than once");
          const id = randomUUID();
          messages.set(nativeEvent.nativeMessageId, { id, completed: false });
          this.#emit({ type: nativeEvent.type, messageId: id });
          break;
        }
        case "assistant.message.delta": {
          this.#requireEventCapability(
            this.capabilities.assistantMessageStreaming,
            "assistantMessageStreaming",
          );
          const message = requireActive(messages, nativeEvent.nativeMessageId, "Assistant Message");
          requireNonEmpty(nativeEvent.delta, `${nativeEvent.type} delta`);
          this.#emit({ type: nativeEvent.type, messageId: message.id, delta: nativeEvent.delta });
          break;
        }
        case "assistant.reasoning.delta": {
          this.#requireEventCapability(
            this.capabilities.assistantReasoningStreaming,
            "assistantReasoningStreaming",
          );
          if (!this.capabilities.assistantMessageStreaming &&
            !messages.has(nativeEvent.nativeMessageId)) {
            requireNonEmpty(nativeEvent.nativeMessageId, "native Assistant Message ID");
            messages.set(nativeEvent.nativeMessageId, { id: randomUUID(), completed: false });
          }
          const message = requireActive(messages, nativeEvent.nativeMessageId, "Assistant Message");
          requireNonEmpty(nativeEvent.delta, `${nativeEvent.type} delta`);
          this.#emit({ type: nativeEvent.type, messageId: message.id, delta: nativeEvent.delta });
          break;
        }
        case "assistant.message.completed": {
          if (!this.capabilities.assistantMessageStreaming) {
            requireNonEmpty(nativeEvent.nativeMessageId, "native Assistant Message ID");
            if (typeof nativeEvent.text !== "string") {
              protocol("Assistant Message completion text is invalid");
            }
            if (finalMessage) protocol("Assistant Message completed more than once");
            const messageState = messages.get(nativeEvent.nativeMessageId) ?? {
              id: randomUUID(),
              completed: false,
            };
            if (messageState.completed) protocol("Assistant Message completed more than once");
            messageState.completed = true;
            messages.set(nativeEvent.nativeMessageId, messageState);
            finalMessage = Object.freeze({ id: messageState.id, text: nativeEvent.text });
            break;
          }
          const messageState = requireActive(messages, nativeEvent.nativeMessageId, "Assistant Message");
          if (typeof nativeEvent.text !== "string") protocol("Assistant Message completion text is invalid");
          messageState.completed = true;
          finalMessage = Object.freeze({ id: messageState.id, text: nativeEvent.text });
          this.#emit({ type: nativeEvent.type, message: finalMessage });
          break;
        }
        case "tool.started": {
          this.#requireEventCapability(this.capabilities.toolEvents, "toolEvents");
          requireNonEmpty(nativeEvent.nativeToolCallId, "native Tool Call ID");
          requireNonEmpty(nativeEvent.toolName, "Tool name");
          if (tools.has(nativeEvent.nativeToolCallId)) protocol("Tool Call started more than once");
          const id = randomUUID();
          tools.set(nativeEvent.nativeToolCallId, { id, completed: false });
          this.#emit({
            type: nativeEvent.type,
            toolCallId: id,
            toolName: nativeEvent.toolName,
            input: asJsonValue(nativeEvent.input),
          });
          break;
        }
        case "tool.updated": {
          this.#requireEventCapability(this.capabilities.toolEvents, "toolEvents");
          const tool = requireActive(tools, nativeEvent.nativeToolCallId, "Tool Call");
          this.#emit({
            type: nativeEvent.type,
            toolCallId: tool.id,
            update: asJsonValue(nativeEvent.update),
          });
          break;
        }
        case "tool.completed": {
          this.#requireEventCapability(this.capabilities.toolEvents, "toolEvents");
          const tool = requireActive(tools, nativeEvent.nativeToolCallId, "Tool Call");
          if (typeof nativeEvent.isError !== "boolean") protocol("Tool completion isError is invalid");
          tool.completed = true;
          this.#emit({
            type: nativeEvent.type,
            toolCallId: tool.id,
            output: asJsonValue(nativeEvent.output),
            isError: nativeEvent.isError,
          });
          break;
        }
        case "usage.updated": {
          this.#requireEventCapability(this.capabilities.turnUsage, "turnUsage");
          const nextUsage = validateUsage(nativeEvent.usage);
          this.#attemptUsage = nextUsage;
          const cumulativeUsage = addUsage(this.#completedAttemptUsage, nextUsage)!;
          if (!sameUsage(this.#lastUsage, cumulativeUsage)) {
            this.#lastUsage = cumulativeUsage;
            this.#emit({ type: nativeEvent.type, usage: this.#lastUsage });
          }
          break;
        }
        case "approval.requested": {
          this.#requireEventCapability(
            this.approvalPolicy !== "harnessManaged",
            "approvalPolicy.harnessManaged",
          );
          requireNonEmpty(nativeEvent.nativeRequestId, "native Approval Request ID");
          requireNonEmpty(nativeEvent.title, "Approval title");
          if (this.#approvalIdsByNative.has(nativeEvent.nativeRequestId)) {
            protocol("Approval Request was emitted more than once");
          }
          let toolCallId: string | undefined;
          if (nativeEvent.nativeToolCallId !== undefined) {
            const tool = tools.get(nativeEvent.nativeToolCallId);
            if (!tool) protocol("Approval Request references a Tool Call that has not started");
            toolCallId = tool.id;
          }
          if (nativeEvent.description !== undefined) {
            requireNonEmpty(nativeEvent.description, "Approval description");
          }
          const requestId = randomUUID();
          const approval: ApprovalState = {
            requestId,
            nativeRequestId: nativeEvent.nativeRequestId,
            status: "pending",
          };
          this.#approvals.set(requestId, approval);
          this.#approvalIdsByNative.set(nativeEvent.nativeRequestId, requestId);
          this.#emit({
            type: "approval.requested",
            requestId,
            title: nativeEvent.title,
            ...(nativeEvent.description === undefined ? {} : { description: nativeEvent.description }),
            ...(toolCallId === undefined ? {} : { toolCallId }),
            ...(nativeEvent.details === undefined ? {} : { details: asJsonValue(nativeEvent.details) }),
          });
          if (this.#settling) return;
          if (this.approvalPolicy !== "interactive") {
            await this.#resolveApproval(
              approval,
              this.approvalPolicy === "autoApprove" ? "allowOnce" : "deny",
              "policy",
            );
          }
          break;
        }
        case "approval.invalidated": {
          this.#requireEventCapability(
            this.approvalPolicy !== "harnessManaged",
            "approvalPolicy.harnessManaged",
          );
          const requestId = this.#approvalIdsByNative.get(nativeEvent.nativeRequestId);
          if (!requestId) protocol("Harness invalidated an unknown Approval Request");
          const approval = this.#approvals.get(requestId);
          if (!approval) protocol("Approval Request state is missing");
          if (approval.status === "pending" || approval.status === "resolving") {
            approval.status = "invalidated";
            this.#emit({
              type: "approval.resolved",
              requestId,
              outcome: "invalidated",
              source: "harness",
            });
          }
          break;
        }
        case "question.requested": {
          this.#requireEventCapability(this.capabilities.turnQuestions, "turnQuestions");
          requireNonEmpty(nativeEvent.nativeRequestId, "native Question Request ID");
          if (this.#questionIdsByNative.has(nativeEvent.nativeRequestId)) {
            protocol("Question Request was emitted more than once");
          }
          let toolCallId: string | undefined;
          if (nativeEvent.nativeToolCallId !== undefined) {
            const tool = tools.get(nativeEvent.nativeToolCallId);
            if (!tool) protocol("Question Request references a Tool Call that has not started");
            toolCallId = tool.id;
          }
          const request = createQuestionRequest(nativeEvent.questions, toolCallId);
          const question: QuestionState = {
            request,
            nativeRequestId: nativeEvent.nativeRequestId,
            status: "pending",
          };
          this.#questions.set(request.requestId, question);
          this.#questionIdsByNative.set(nativeEvent.nativeRequestId, request.requestId);
          this.#emit({ type: "question.requested", ...request });
          break;
        }
        case "question.answered": {
          this.#requireEventCapability(this.capabilities.turnQuestions, "turnQuestions");
          const question = this.#requireNativeQuestion(nativeEvent.nativeRequestId);
          if (question.status === "pending" || question.status === "resolving") {
            const { publicAnswers } = mapAdapterQuestionAnswers(nativeEvent.answers, question.request);
            question.status = "resolved";
            this.#emit({
              type: "question.resolved",
              requestId: question.request.requestId,
              outcome: "answered",
              answers: publicAnswers,
              source: "harness",
            });
          }
          break;
        }
        case "question.dismissed":
        case "question.invalidated": {
          this.#requireEventCapability(this.capabilities.turnQuestions, "turnQuestions");
          const question = this.#requireNativeQuestion(nativeEvent.nativeRequestId);
          if (question.status === "pending" || question.status === "resolving") {
            question.status = nativeEvent.type === "question.dismissed" ? "resolved" : "invalidated";
            this.#emit({
              type: "question.resolved",
              requestId: question.request.requestId,
              outcome: nativeEvent.type === "question.dismissed" ? "dismissed" : "invalidated",
              source: "harness",
            });
          }
          break;
        }
        case "turn.completed": {
          if ([...messages.values()].some(({ completed }) => !completed)) {
            protocol("Codex completed with an unfinished Assistant Message");
          }
          if ([...tools.values()].some(({ completed }) => !completed)) {
            protocol("Codex completed with an unfinished Tool Call");
          }
          if (!finalMessage) protocol("Codex completed without an Assistant Message");
          await this.#invalidateInteractions();
          const usage = this.#lastUsage;
          const terminal = {
            type: "turn.completed" as const,
            message: finalMessage,
            ...(usage === undefined ? {} : { usage }),
          };
          this.#finish(terminal, {
            status: "completed",
            turnId: this.turnId,
            message: finalMessage,
            ...(usage === undefined ? {} : { usage }),
          });
          return;
        }
        case "turn.failed": {
          const error = validateHarnessFailure(nativeEvent.error, this.harness);
          return error;
        }
        case "turn.interrupted": {
          await this.#invalidateInteractions();
          const usage = this.#lastUsage;
          const reason = this.#interruptionReason ?? "harness";
          this.#finish(
            { type: "turn.interrupted", reason, ...(usage === undefined ? {} : { usage }) },
            { status: "interrupted", turnId: this.turnId, reason, ...(usage === undefined ? {} : { usage }) },
          );
          return;
        }
        default:
          protocol("Adapter emitted an unknown Turn event");
      }
    }
    if (!this.#terminal) protocol("Harness Turn event stream ended before a terminal event");
    return undefined;
  }

  #requireEventCapability(supported: boolean, capability: HarnessCapabilityPath): void {
    if (!supported) {
      protocol(`Adapter emitted an event forbidden by Capability ${capability}`);
    }
  }

  #canRetry(error: TurnFailure): error is HarnessErrorData {
    return error.code === "HARNESS_ERROR" &&
      error.operation === "startTurn" &&
      this.#retryCount < this.turnRetryPolicy.maxRetries &&
      error.retryable !== false &&
      this.#interruptionReason === undefined &&
      !this.#hasUnresolvedInteractions();
  }

  #hasUnresolvedInteractions(): boolean {
    return [...this.#approvals.values()].some(({ status }) => status === "pending" || status === "resolving") ||
      [...this.#questions.values()].some(({ status }) => status === "pending" || status === "resolving");
  }

  #commitAttemptUsage(): void {
    this.#completedAttemptUsage = addUsage(this.#completedAttemptUsage, this.#attemptUsage);
    this.#attemptUsage = undefined;
  }

  async #finishTurnFailure(error: TurnFailure, record: boolean): Promise<void> {
    await this.#invalidateInteractions();
    const usage = this.#lastUsage;
    if (record) {
      try {
        await this.recordCoreEvent({
          type: "turn.failed",
          turnId: this.turnId,
          error,
          ...(usage === undefined ? {} : { usage }),
        });
      } catch (storeError) {
        await this.#failStore(storeError);
        return;
      }
    }
    this.#finish(
      { type: "turn.failed", error, ...(usage === undefined ? {} : { usage }) },
      { status: "failed", turnId: this.turnId, error, ...(usage === undefined ? {} : { usage }) },
    );
  }

  async #failProtocol(cause: unknown): Promise<void> {
    if (this.#terminal || this.#settling) return;
    await this.#invalidateInteractions();
    let error: TurnFailure = {
      code: "ADAPTER_PROTOCOL_ERROR",
      message: cause instanceof Error ? cause.message : "Adapter protocol violation",
      harness: this.harness,
    };
    try {
      await this.recordCoreEvent({
        type: "turn.failed",
        turnId: this.turnId,
        error,
        ...(this.#lastUsage === undefined ? {} : { usage: this.#lastUsage }),
      });
    } catch (storeError) {
      error = isEventStoreFailure(storeError)
        ? storeError
        : {
            code: "EVENT_STORE_ERROR",
            message: "Diagnostic Event Store failed while recording a Core event",
            operation: "commit",
          };
    }
    const usage = this.#lastUsage;
    this.#finish(
      { type: "turn.failed", error, ...(usage === undefined ? {} : { usage }) },
      { status: "failed", turnId: this.turnId, error, ...(usage === undefined ? {} : { usage }) },
    );
  }

  #requestInterrupt(reason: Exclude<TurnInterruptionReason, "harness">): Promise<void> {
    if (this.#terminal || this.#settling) return Promise.resolve();
    this.#upgradeInterruptionReason(reason);
    this.#interruptPromise ??= this.runControlCommand(
      this.harness,
      "interruptTurn",
      async () => {
        this.#retryAbortController?.abort();
        await this.#activeNativeTurn?.interrupt();
        await this.#acceptCoreInterruption(this.#interruptionReason ?? reason);
      },
    ).catch((error: unknown) => {
      if (!this.#terminal) this.#interruptionReason = undefined;
      throw normalizeTurnCommandError(error, this.harness, "interruptTurn");
    });
    return this.#interruptPromise;
  }

  async #acceptCoreInterruption(
    reason: Exclude<TurnInterruptionReason, "harness">,
  ): Promise<void> {
    if (this.#terminal) return;
    await this.#invalidateInteractions();
    const usage = this.#lastUsage;
    try {
      await this.recordCoreEvent({
        type: "turn.interrupted",
        turnId: this.turnId,
        reason,
        ...(usage === undefined ? {} : { usage }),
      });
    } catch (error) {
      await this.#failStore(error);
      return;
    }
    this.#finish(
      { type: "turn.interrupted", reason, ...(usage === undefined ? {} : { usage }) },
      { status: "interrupted", turnId: this.turnId, reason, ...(usage === undefined ? {} : { usage }) },
    );
  }

  async #failStore(cause: unknown): Promise<void> {
    if (this.#terminal) return;
    await this.#invalidateInteractions(false);
    const error: EventStoreErrorData = isEventStoreFailure(cause)
      ? cause
      : {
          code: "EVENT_STORE_ERROR",
          message: "Diagnostic Event Store failed while recording a Core event",
          operation: "commit",
        };
    const usage = this.#lastUsage;
    this.#finish(
      { type: "turn.failed", error, ...(usage === undefined ? {} : { usage }) },
      { status: "failed", turnId: this.turnId, error, ...(usage === undefined ? {} : { usage }) },
    );
  }

  #upgradeInterruptionReason(reason: Exclude<TurnInterruptionReason, "harness">): void {
    const priority = { caller: 1, sessionClosed: 2, runtimeClosed: 3 } as const;
    if (!this.#interruptionReason || priority[reason] > priority[this.#interruptionReason]) {
      this.#interruptionReason = reason;
    }
  }

  async #resolveApproval(
    approval: ApprovalState,
    decision: ApprovalDecision,
    source: "caller" | "policy",
  ): Promise<void> {
    return this.runControlCommand(
      this.harness,
      "respondToApproval",
      () => this.#resolveApprovalAcknowledgement(approval, decision, source),
    );
  }

  async #resolveApprovalAcknowledgement(
    approval: ApprovalState,
    decision: ApprovalDecision,
    source: "caller" | "policy",
  ): Promise<void> {
    if (approval.status === "invalidated") {
      throw interactionError("TURN_INTERACTION_INVALIDATED", "approval", approval.requestId);
    }
    if (approval.status !== "pending") {
      throw interactionError("TURN_INTERACTION_ALREADY_RESOLVED", "approval", approval.requestId);
    }
    if (this.#terminal || this.#settling) {
      approval.status = "invalidated";
      throw interactionError("TURN_INTERACTION_INVALIDATED", "approval", approval.requestId);
    }
    approval.status = "resolving";
    try {
      const nativeTurn = this.#activeNativeTurn;
      if (!nativeTurn) throw interactionError("TURN_INTERACTION_INVALIDATED", "approval", approval.requestId);
      await nativeTurn.respondToApproval(approval.nativeRequestId, decision);
    } catch (error) {
      if (approval.status === "resolving") approval.status = "pending";
      throw normalizeTurnCommandError(error, this.harness, "respondToApproval");
    }
    if (approvalIsInvalidated(approval) || this.#terminal) {
      throw interactionError("TURN_INTERACTION_INVALIDATED", "approval", approval.requestId);
    }
    await this.recordCoreEvent({
      type: "approval.resolved",
      turnId: this.turnId,
      requestId: approval.requestId,
      outcome: decision,
      source,
    });
    if (approvalIsInvalidated(approval) || this.#terminal) {
      throw interactionError("TURN_INTERACTION_INVALIDATED", "approval", approval.requestId);
    }
    approval.status = "resolved";
    this.#emit({
      type: "approval.resolved",
      requestId: approval.requestId,
      outcome: decision,
      source,
    });
  }

  #requireNativeQuestion(nativeRequestId: string): QuestionState {
    const requestId = this.#questionIdsByNative.get(nativeRequestId);
    if (!requestId) protocol("Harness resolved an unknown Question Request");
    const question = this.#questions.get(requestId);
    if (!question) protocol("Question Request state is missing");
    return question;
  }

  async #resolveQuestion(
    question: QuestionState,
    validated: ValidatedQuestionResponse,
    source: "caller",
  ): Promise<void> {
    return this.runControlCommand(
      this.harness,
      "respondToQuestion",
      () => this.#resolveQuestionAcknowledgement(question, validated, source),
    );
  }

  async #resolveQuestionAcknowledgement(
    question: QuestionState,
    validated: ValidatedQuestionResponse,
    source: "caller",
  ): Promise<void> {
    if (question.status === "invalidated") {
      throw interactionError("TURN_INTERACTION_INVALIDATED", "question", question.request.requestId);
    }
    if (question.status !== "pending") {
      throw interactionError("TURN_INTERACTION_ALREADY_RESOLVED", "question", question.request.requestId);
    }
    if (this.#terminal || this.#settling) {
      question.status = "invalidated";
      throw interactionError("TURN_INTERACTION_INVALIDATED", "question", question.request.requestId);
    }
    question.status = "resolving";
    try {
      const nativeTurn = this.#activeNativeTurn;
      if (!nativeTurn) {
        throw interactionError("TURN_INTERACTION_INVALIDATED", "question", question.request.requestId);
      }
      await nativeTurn.respondToQuestion(
        question.nativeRequestId,
        validated.adapterResponse,
      );
    } catch (error) {
      if (question.status === "resolving") question.status = "pending";
      throw normalizeTurnCommandError(error, this.harness, "respondToQuestion");
    }
    if (questionHasStatus(question, "invalidated") || this.#terminal) {
      throw interactionError("TURN_INTERACTION_INVALIDATED", "question", question.request.requestId);
    }
    if (questionHasStatus(question, "resolved")) {
      throw interactionError("TURN_INTERACTION_ALREADY_RESOLVED", "question", question.request.requestId);
    }
    const payload = validated.publicResponse.action === "answer"
      ? {
          type: "question.resolved" as const,
          turnId: this.turnId,
          requestId: question.request.requestId,
          outcome: "answered" as const,
          answers: validated.publicResponse.answers,
          source,
        }
      : {
          type: "question.resolved" as const,
          turnId: this.turnId,
          requestId: question.request.requestId,
          outcome: "dismissed" as const,
          source,
        };
    await this.recordCoreEvent(payload);
    if (question.status !== "resolving" || this.#terminal) {
      throw interactionError("TURN_INTERACTION_INVALIDATED", "question", question.request.requestId);
    }
    question.status = "resolved";
    this.#emit(payload);
  }

  async #invalidateInteractions(record = true): Promise<void> {
    await this.#invalidateApprovals(record);
    await this.#invalidateQuestions(record);
  }

  async #invalidateApprovals(record = true): Promise<void> {
    for (const approval of this.#approvals.values()) {
      if (approval.status !== "pending" && approval.status !== "resolving") continue;
      approval.status = "invalidated";
      const payload = {
        type: "approval.resolved" as const,
        turnId: this.turnId,
        requestId: approval.requestId,
        outcome: "invalidated" as const,
        source: "turn" as const,
      };
      if (record) await this.recordCoreEvent(payload);
      this.#emit(payload);
    }
  }

  async #invalidateQuestions(record = true): Promise<void> {
    for (const question of this.#questions.values()) {
      if (question.status !== "pending" && question.status !== "resolving") continue;
      question.status = "invalidated";
      const payload = {
        type: "question.resolved" as const,
        turnId: this.turnId,
        requestId: question.request.requestId,
        outcome: "invalidated" as const,
        source: "turn" as const,
      };
      if (record) await this.recordCoreEvent(payload);
      this.#emit(payload);
    }
  }

  #finish(
    event: { readonly type: TurnEvent["type"]; readonly [key: string]: unknown },
    result: TurnResult,
  ): void {
    if (this.#terminal || this.#settling) return;
    const queued = this.#envelope(event);
    if (!this.#events.fitsSingleEvent(queued)) {
      this.#settling = true;
      void this.#failQueue("TURN_EVENT_TOO_LARGE");
      return;
    }
    this.#terminal = true;
    this.#sequence = queued.sequence;
    this.#events.endWithTerminal(queued);
    this.#resolveResult(result);
    this.onTerminal();
  }

  #emit(payload: { readonly type: TurnEvent["type"]; readonly [key: string]: unknown }): void {
    if (this.#terminal || this.#settling) return;
    const event = this.#envelope(payload);
    const outcome = this.#events.push(event);
    if (outcome === "accepted") {
      this.#sequence = event.sequence;
      return;
    }
    if (outcome === "coalesced") return;
    this.#settling = true;
    void this.#failQueue(outcome);
  }

  #envelope(
    payload: { readonly type: TurnEvent["type"]; readonly [key: string]: unknown },
  ): TurnEvent {
    return {
      ...payload,
      turnId: this.turnId,
      sequence: this.#sequence + 1,
      timestamp: new Date().toISOString(),
    } as TurnEvent;
  }

  async #failQueue(
    code: "TURN_EVENT_BACKPRESSURE" | "TURN_EVENT_TOO_LARGE",
  ): Promise<void> {
    try {
      this.#retryAbortController?.abort();
      void this.#activeNativeTurn?.interrupt().catch(() => undefined);
    } catch {
      // The local queue failure remains authoritative.
    }
    const error: TurnEventBackpressureErrorData | TurnEventTooLargeErrorData = {
      code,
      message: code === "TURN_EVENT_BACKPRESSURE"
        ? "Turn event queue exceeded its configured backlog"
        : "A normalized Turn event exceeded the configured byte limit",
    };
    const usage = this.#lastUsage;
    try {
      await this.recordCoreEvent({
        type: "turn.failed",
        turnId: this.turnId,
        error,
        ...(usage === undefined ? {} : { usage }),
      });
    } catch (storeError) {
      await this.#completeQueueFailure(isEventStoreFailure(storeError)
        ? storeError
        : {
            code: "EVENT_STORE_ERROR",
            message: "Diagnostic Event Store failed while recording a Core event",
            operation: "commit",
          });
      return;
    }
    await this.#completeQueueFailure(error);
  }

  #completeQueueFailure(error: TurnFailure): Promise<void> {
    if (this.#terminal) return Promise.resolve();
    const usage = this.#lastUsage;
    const event = this.#envelope({
      type: "turn.failed",
      error,
      ...(usage === undefined ? {} : { usage }),
    });
    this.#terminal = true;
    this.#sequence = event.sequence;
    this.#events.endWithTerminal(event);
    this.#resolveResult({
      status: "failed",
      turnId: this.turnId,
      error,
      ...(usage === undefined ? {} : { usage }),
    });
    this.onTerminal();
    return Promise.resolve();
  }
}

type QueuePushOutcome =
  | "accepted"
  | "coalesced"
  | "TURN_EVENT_BACKPRESSURE"
  | "TURN_EVENT_TOO_LARGE";

class BoundedTurnEventQueue implements AsyncIterable<TurnEvent> {
  readonly #values: Array<{ value: TurnEvent; bytes: number }> = [];
  readonly #waiters: Array<(result: IteratorResult<TurnEvent>) => void> = [];
  #queuedBytes = 0;
  #ended = false;
  #terminal: TurnEvent | undefined;

  constructor(readonly limits: TurnQueueLimits) {}

  fitsSingleEvent(value: TurnEvent): boolean {
    return eventBytes(value) <= this.limits.maxBytes;
  }

  push(value: TurnEvent): QueuePushOutcome {
    const bytes = eventBytes(value);
    if (bytes > this.limits.maxBytes) return "TURN_EVENT_TOO_LARGE";
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return "accepted";
    }
    const last = this.#values.at(-1);
    const merged = last ? mergeTurnDelta(last.value, value) : undefined;
    if (last && merged) {
      const mergedBytes = eventBytes(merged);
      const nextBytes = this.#queuedBytes - last.bytes + mergedBytes;
      if (mergedBytes <= this.limits.maxBytes && nextBytes <= this.limits.maxBytes) {
        last.value = merged;
        last.bytes = mergedBytes;
        this.#queuedBytes = nextBytes;
        return "coalesced";
      }
    }
    if (
      this.#values.length + 1 > this.limits.maxEvents ||
      this.#queuedBytes + bytes > this.limits.maxBytes
    ) {
      return "TURN_EVENT_BACKPRESSURE";
    }
    this.#values.push({ value, bytes });
    this.#queuedBytes += bytes;
    return "accepted";
  }

  endWithTerminal(value: TurnEvent): void {
    if (this.#ended) return;
    this.#ended = true;
    const waiter = this.#waiters.shift();
    if (waiter && this.#values.length === 0) waiter({ value, done: false });
    else this.#terminal = value;
    for (const remaining of this.#waiters.splice(0)) {
      remaining({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<TurnEvent> {
    return {
      next: () => {
        const entry = this.#values.shift();
        if (entry !== undefined) {
          this.#queuedBytes -= entry.bytes;
          return Promise.resolve({ value: entry.value, done: false });
        }
        if (this.#terminal) {
          const terminal = this.#terminal;
          this.#terminal = undefined;
          return Promise.resolve({ value: terminal, done: false });
        }
        if (this.#ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiters.push(resolve));
      },
    };
  }
}

function eventBytes(event: TurnEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function mergeTurnDelta(previous: TurnEvent, next: TurnEvent): TurnEvent | undefined {
  if (
    (previous.type !== "assistant.message.delta" &&
      previous.type !== "assistant.reasoning.delta") ||
    next.type !== previous.type ||
    next.messageId !== previous.messageId
  ) {
    return undefined;
  }
  return { ...previous, delta: previous.delta + next.delta };
}

async function validateTurnInput(input: TurnInput): Promise<readonly AdapterTurnInput[]> {
  if (!Array.isArray(input) || input.length === 0) invalid("Turn input must not be empty");
  return Promise.all(input.map(async (part) => {
    if (!isPlainObject(part)) invalid("Turn content part must be an object");
    if (part.type === "text") {
      if (typeof part.text !== "string" || part.text.length === 0) {
        invalid("Text Turn parts require non-empty text");
      }
      assertOnlyKeys(part, ["type", "text"], "Turn text part");
      return { type: "text", text: part.text };
    }
    if (part.type !== "image") invalid("Turn content supports only text and image parts");
    assertOnlyKeys(part, ["type", "source"], "Turn image part");
    if (!isPlainObject(part.source)) invalid("Image source must be an object");
    if (part.source.type === "file") {
      assertOnlyKeys(part.source, ["type", "path"], "Image file source");
      if (typeof part.source.path !== "string" || !isAbsolute(part.source.path)) {
        invalid("Image file path must be absolute");
      }
      let bytes: Buffer;
      try {
        bytes = await readFile(part.source.path);
      } catch {
        invalid("Image file must be readable");
      }
      if (!detectImageMediaType(bytes)) invalid("Image file has an unsupported or invalid signature");
      return { type: "image", source: { type: "file", path: part.source.path } };
    }
    if (part.source.type === "base64") {
      assertOnlyKeys(part.source, ["type", "mediaType", "data"], "Base64 image source");
      if (!isImageMediaType(part.source.mediaType)) invalid("Unsupported image media type");
      if (typeof part.source.data !== "string" || !isStrictBase64(part.source.data)) {
        invalid("Image data must be non-empty raw base64");
      }
      const bytes = Buffer.from(part.source.data, "base64");
      if (detectImageMediaType(bytes) !== part.source.mediaType) {
        invalid("Image signature does not match its declared media type");
      }
      return {
        type: "image",
        source: {
          type: "base64",
          mediaType: part.source.mediaType,
          data: part.source.data,
        },
      };
    }
    invalid("Image source supports only file and base64");
  }));
}

function assertOnlyKeys(value: Record<string, unknown>, keys: readonly string[], description: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) invalid(`${description} contains an unknown field`);
}

function isImageMediaType(value: unknown): value is ImageMediaType {
  return typeof value === "string" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(value);
}

function isStrictBase64(value: string): boolean {
  if (value.length === 0 || value.startsWith("data:") || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const firstPadding = value.indexOf("=");
  if (firstPadding >= 0 && value.length % 4 !== 0) return false;
  if (firstPadding < 0 && value.length % 4 === 1) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length > 0 &&
    decoded.toString("base64").replace(/=+$/, "") === value.replace(/=+$/, "");
}

function detectImageMediaType(bytes: Uint8Array): ImageMediaType | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "image/webp";
  if (bytes.length >= 6) {
    const signature = Buffer.from(bytes.subarray(0, 6)).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  return undefined;
}

function requireActive<T extends { completed: boolean }>(
  states: Map<string, T>,
  nativeId: string,
  description: string,
): T {
  const state = states.get(nativeId);
  if (!state) protocol(`${description} event occurred without start`);
  if (state.completed) protocol(`${description} event occurred after completion`);
  return state;
}

function requireNonEmpty(value: unknown, description: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) protocol(`${description} must be non-empty`);
}

function validateUsage(value: unknown): TurnUsage {
  if (!isPlainObject(value)) protocol("Usage snapshot must be an object");
  assertProtocolKeys(value, ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"], "Usage snapshot");
  const usage: Record<string, number> = {};
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"] as const) {
    const count = value[key];
    if (count === undefined) continue;
    if (!Number.isSafeInteger(count) || (count as number) < 0) protocol(`Usage ${key} must be a non-negative safe integer`);
    usage[key] = count as number;
  }
  if (Object.keys(usage).length === 0) protocol("Usage snapshot must contain at least one token count");
  return Object.freeze(usage) as TurnUsage;
}

function sameUsage(left: TurnUsage | undefined, right: TurnUsage): boolean {
  return left !== undefined &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.cachedInputTokens === right.cachedInputTokens &&
    left.reasoningTokens === right.reasoningTokens;
}

function addUsage(left: TurnUsage | undefined, right: TurnUsage | undefined): TurnUsage | undefined {
  if (left === undefined) return right;
  if (right === undefined) return left;
  const usage: Record<string, number> = {};
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens"] as const) {
    const leftCount = left[key];
    const rightCount = right[key];
    if (leftCount === undefined && rightCount === undefined) continue;
    const total = (leftCount ?? 0) + (rightCount ?? 0);
    if (!Number.isSafeInteger(total)) protocol(`Cumulative Usage ${key} exceeds the safe integer range`);
    usage[key] = total;
  }
  return Object.freeze(usage) as TurnUsage;
}

function retryDelayMs(retryNumber: number, jitter: number): number {
  const exponential = Math.min(500 * (2 ** (retryNumber - 1)), 5_000);
  return Math.min(5_000, Math.round(exponential * (1 + jitter * 0.25)));
}

function sleepWithAbort(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validateHarnessFailure(value: unknown, harness: HarnessKind): HarnessErrorData {
  asJsonValue(value);
  if (!isValidHarnessFailure(value, harness)) protocol("Harness failure payload is invalid");
  return value;
}

function normalizeRetryStartFailure(
  error: unknown,
  harness: HarnessKind,
): HarnessErrorData | AdapterProtocolErrorData {
  const data = error instanceof MuhaError ? error.data : error;
  if (
    isPlainObject(data) &&
    data.code === "ADAPTER_PROTOCOL_ERROR" &&
    data.harness === harness &&
    typeof data.message === "string"
  ) {
    return {
      code: "ADAPTER_PROTOCOL_ERROR",
      message: data.message,
      harness,
    };
  }
  if (isPlainObject(data) && data.code === "HARNESS_ERROR") {
    if (isValidHarnessFailure(data, harness) && data.operation === "startTurn") return data;
    return {
      code: "ADAPTER_PROTOCOL_ERROR",
      message: "Harness retry start rejection payload is invalid",
      harness,
    };
  }
  return {
    code: "HARNESS_ERROR",
    message: "Harness rejected a retry Turn Attempt",
    harness,
    operation: "startTurn",
  };
}

const harnessErrorOperations = new Set<HarnessErrorData["operation"]>([
  "initialize",
  "createSession",
  "resumeSession",
  "listSessions",
  "setModel",
  "setEffort",
  "startTurn",
  "interruptTurn",
  "respondToApproval",
  "respondToQuestion",
  "closeSession",
  "closeHarness",
]);

const harnessErrorStages = new Set<NonNullable<HarnessErrorData["stage"]>>([
  "spawn",
  "handshake",
  "ready",
  "shutdown",
]);

const harnessErrorKeys = new Set([
  "code",
  "message",
  "harness",
  "operation",
  "command",
  "stage",
  "exitCode",
  "signal",
  "retryable",
  "nativeCode",
]);

function isValidHarnessFailure(value: unknown, harness: HarnessKind): value is HarnessErrorData {
  if (
    !isPlainObject(value) ||
    value.code !== "HARNESS_ERROR" ||
    value.harness !== harness ||
    typeof value.message !== "string" ||
    typeof value.operation !== "string" ||
    !harnessErrorOperations.has(value.operation as HarnessErrorData["operation"]) ||
    (value.command !== undefined && typeof value.command !== "string") ||
    (value.stage !== undefined &&
      (typeof value.stage !== "string" ||
        !harnessErrorStages.has(value.stage as NonNullable<HarnessErrorData["stage"]>))) ||
    (value.exitCode !== undefined && value.exitCode !== null &&
      (typeof value.exitCode !== "number" || !Number.isFinite(value.exitCode))) ||
    (value.signal !== undefined && value.signal !== null && typeof value.signal !== "string") ||
    (value.retryable !== undefined && typeof value.retryable !== "boolean") ||
    (value.nativeCode !== undefined && typeof value.nativeCode !== "string") ||
    Object.keys(value).some((key) => !harnessErrorKeys.has(key))
  ) return false;
  return true;
}

function asJsonValue(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) protocol("JSON value contains a non-finite number");
    return value;
  }
  if (typeof value !== "object") protocol("Value is not JSON-safe");
  if (ancestors.has(value)) protocol("JSON value contains a cycle");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(value.map((entry) => asJsonValue(entry, ancestors)));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) protocol("JSON object has a non-plain prototype");
    const output: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) output[key] = asJsonValue(entry, ancestors);
    return Object.freeze(output);
  } finally {
    ancestors.delete(value);
  }
}

function assertProtocolKeys(value: Record<string, unknown>, keys: readonly string[], description: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) protocol(`${description} contains an unknown field`);
}

function isEventStoreFailure(value: unknown): value is EventStoreErrorData {
  return isPlainObject(value) && value.code === "EVENT_STORE_ERROR" && typeof value.message === "string";
}

function protocol(message: string): never {
  throw new Error(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new MuhaError({ code: "INVALID_INPUT", message });
}

function validateEffortInput(effort: unknown): void {
  if (typeof effort !== "string") invalid("Effort must be a string");
  if (effort.length === 0 || effort !== effort.trim()) {
    invalid("Effort must be non-empty without leading or trailing whitespace");
  }
}

export { validateEffortInput };

function isHarnessErrorData(error: unknown): error is Extract<MuhaError["data"], { code: "HARNESS_ERROR" }> {
  return isPlainObject(error) && error.code === "HARNESS_ERROR";
}

function isAdapterProtocolErrorData(
  error: unknown,
): error is Extract<MuhaError["data"], { code: "ADAPTER_PROTOCOL_ERROR" }> {
  return isPlainObject(error) &&
    error.code === "ADAPTER_PROTOCOL_ERROR" &&
    typeof error.message === "string" &&
    typeof error.harness === "string";
}

function normalizeTurnCommandError(
  error: unknown,
  harness: HarnessKind,
  operation: HarnessErrorData["operation"],
): MuhaError {
  if (error instanceof MuhaError) return error;
  if (isAdapterProtocolErrorData(error)) return new MuhaError(error);
  if (isHarnessErrorData(error)) return new MuhaError(error);
  return new MuhaError({
    code: "HARNESS_ERROR",
    message: `Harness ${operation} command failed`,
    harness,
    operation,
  });
}

function interactionError(
  code:
    | "TURN_INTERACTION_NOT_FOUND"
    | "TURN_INTERACTION_ALREADY_RESOLVED"
    | "TURN_INTERACTION_INVALIDATED",
  interaction: "approval" | "question",
  requestId: string,
): MuhaError {
  return new MuhaError({
    code,
    message: `${interaction} interaction ${code.toLowerCase()}`,
    interaction,
    requestId,
  });
}
