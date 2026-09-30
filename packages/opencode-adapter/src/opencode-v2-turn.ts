import { randomUUID } from "node:crypto";

import type {
  AdapterCreateSessionOptions,
  AdapterQuestionAnswer,
  AdapterQuestionItem,
  AdapterQuestionResponse,
  AdapterTypedQuestionItem,
  AdapterTurn,
  AdapterTurnEvent,
} from "@muha-sdk/core/internal";
import { OpenCodeV2Api } from "./opencode-v2-api.js";

type EventValue = Record<string, unknown>;
type ToolState = {
  readonly sessionID: string;
  readonly assistantMessageID: string;
  readonly id: string;
  readonly name: string;
  called: boolean;
  completed: boolean;
  inputText?: string;
};
type FormField = {
  readonly key: string;
  readonly question: AdapterTypedQuestionItem;
};
type FormState = { readonly fields: readonly FormField[];
  status: "pending" | "resolving" | "resolved" | "invalidated" };

export class OpenCodeV2Turn implements AdapterTurn {
  readonly nativeTurnId = randomUUID();
  readonly inboxID = "msg_" + this.nativeTurnId.replaceAll("-", "");
  readonly #events = new TurnEvents();
  readonly #pending: EventValue[] = [];
  readonly #baselineMessageIDs: ReadonlySet<string>;
  readonly #text = new Map<string, string>();
  readonly #completed = new Set<string>();
  readonly #tools = new Map<string, ToolState>();
  readonly #children = new Set<string>();
  readonly #childExecutions = new Set<string>();
  readonly #activeMessages = new Map<string, string>();
  readonly #nativeRetries = new Map<string, { messageID: string; attempt: number; pending: boolean }>();
  readonly #messageProgress = new Set<string>();
  readonly #permissions = new Map<string, "pending" | "resolving" | "resolved" | "invalidated">();
  readonly #permissionSessions = new Map<string, string>();
  readonly #forms = new Map<string, FormState>();
  readonly #formSessions = new Map<string, string>();
  readonly #usage = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedInputTokens: 0 };
  #unsubscribe: (() => void) | undefined;
  #accepted = false;
  #draining = false;
  #disposed = false;
  #enqueued = false;
  #delivered = false;
  #executing = false;
  #lastCompletedText: string | undefined;
  readonly #lastDurableSeq = new Map<string, number>();

  constructor(
    readonly api: OpenCodeV2Api,
    readonly nativeSessionId: string,
    baselineMessages: readonly unknown[],
    readonly onStreamLoss: () => void,
    readonly approvalPolicy: AdapterCreateSessionOptions["approvalPolicy"],
  ) {
    const ids = new Set<string>();
    for (const value of baselineMessages) {
      if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
        throw protocolFailure("OpenCode v2 Message baseline is invalid");
      }
      ids.add(value.id);
    }
    this.#baselineMessageIDs = ids;
  }

  attach(unsubscribe: () => void): void {
    this.#unsubscribe = unsubscribe;
  }

  accept(value: unknown): void {
    if (
      !isRecord(value) ||
      value.id !== this.inboxID ||
      value.sessionID !== this.nativeSessionId ||
      value.type !== "user"
    ) throw protocolFailure("OpenCode v2 prompt acknowledged a different input");
    this.#accepted = true;
    void this.#drain();
  }

  receive(value: EventValue): void {
    if (this.#disposed) return;
    if (value.type === "adapter.protocolError") {
      const message = isRecord(value.properties) && typeof value.properties.message === "string"
        ? value.properties.message : "OpenCode v2 event stream failed";
      this.onStreamLoss();
      this.#push({ type: "adapter.protocolError", message });
      this.dispose();
      return;
    }
    this.#pending.push(value);
    if (this.#accepted) void this.#drain();
  }

  [Symbol.asyncIterator](): AsyncIterator<AdapterTurnEvent> {
    return this.#events[Symbol.asyncIterator]();
  }

  async interrupt(): Promise<void> {
    const value = await this.api.interrupt(this.nativeSessionId);
    if (!isRecord(value) || value.interrupted !== true) {
      throw protocolFailure("OpenCode v2 did not interrupt the active Turn");
    }
    if (!this.#disposed) {
      this.#push({ type: "turn.interrupted" });
      this.dispose();
    }
  }

  async respondToApproval(nativeRequestId: string, decision: "allowOnce" | "deny"): Promise<void> {
    if (this.#disposed || this.#permissions.get(nativeRequestId) !== "pending") {
      throw protocolFailure("OpenCode v2 Approval response targets no pending request");
    }
    this.#permissions.set(nativeRequestId, "resolving");
    try {
      const sessionID = this.#permissionSessions.get(nativeRequestId);
      if (!sessionID) throw protocolFailure("OpenCode v2 Permission Session identity is missing");
      await this.api.replyPermission(sessionID, nativeRequestId, decision);
      this.#permissions.set(nativeRequestId, "resolved");
    } catch (error) {
      if (this.#permissions.get(nativeRequestId) === "resolving") {
        this.#permissions.set(nativeRequestId, "pending");
      }
      throw error;
    }
  }

  async respondToQuestion(nativeRequestId: string, response: AdapterQuestionResponse): Promise<void> {
    const form = this.#forms.get(nativeRequestId);
    if (this.#disposed || !form || form.status !== "pending") {
      throw protocolFailure("OpenCode v2 Form response targets no pending request");
    }
    form.status = "resolving";
    try {
      if (response.action === "dismiss") {
        const sessionID = this.#formSessions.get(nativeRequestId);
        if (!sessionID) throw protocolFailure("OpenCode v2 Form Session identity is missing");
        await this.api.cancelForm(sessionID, nativeRequestId);
      } else {
        const sessionID = this.#formSessions.get(nativeRequestId);
        if (!sessionID) throw protocolFailure("OpenCode v2 Form Session identity is missing");
        await this.api.replyForm(sessionID, nativeRequestId,
          nativeFormAnswer(response.answers, form.fields));
      }
      form.status = "resolved";
    } catch (error) {
      if (form.status === "resolving") form.status = "pending";
      throw error;
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#events.end();
  }

  #push(value: AdapterTurnEvent): void {
    if (!this.#disposed) this.#events.push(value);
  }

  async #drain(): Promise<void> {
    if (this.#draining || this.#disposed || !this.#accepted) return;
    this.#draining = true;
    try {
      while (this.#pending.length > 0 && !this.#disposed) {
        const event = this.#pending.shift();
        if (event !== undefined) await this.#handle(event);
      }
    } catch (error) {
      this.onStreamLoss();
      this.#push({
        type: "adapter.protocolError",
        message: isRecord(error) && typeof error.message === "string"
          ? error.message : error instanceof Error ? error.message : "OpenCode v2 event is invalid",
      });
      this.dispose();
    } finally {
      this.#draining = false;
    }
  }

  async #handle(event: EventValue): Promise<void> {
    const type = requireString(event.type, "OpenCode v2 event type");
    const data = requireRecord(event.data, "OpenCode v2 event data");
    const eventSessionID = data.sessionID ?? (isRecord(data.form) ? data.form.sessionID : undefined);
    if (eventSessionID !== this.nativeSessionId && !this.#children.has(String(eventSessionID)) &&
        !(type === "session.created" && this.#executing &&
          (data.parentID === this.nativeSessionId || this.#children.has(String(data.parentID))))) return;
    if (typeof eventSessionID !== "string" || eventSessionID.length === 0) {
      throw protocolFailure("OpenCode v2 Session event identity is invalid");
    }
    if (isRecord(event.durable)) {
      const seq = event.durable.seq;
      if (!Number.isSafeInteger(seq) || (seq as number) < 1) {
        throw protocolFailure("OpenCode v2 event sequence is invalid");
      }
      const last = this.#lastDurableSeq.get(eventSessionID);
      // /api/event exposes only server-visible events. The durable aggregate
      // sequence can therefore skip private persisted events in a healthy
      // live stream; event/state identities, not adjacent seq values, prove
      // the public Turn's semantic continuity.
      if (last !== undefined && (seq as number) <= last) {
        throw protocolFailure(`OpenCode v2 event order regressed before ${type} (${last} -> ${seq})`);
      }
      this.#lastDurableSeq.set(eventSessionID, seq as number);
    }
    if (type === "session.created" && eventSessionID !== this.nativeSessionId) {
      if (this.#children.has(eventSessionID)) throw protocolFailure("OpenCode v2 child Session was created twice");
      this.#children.add(eventSessionID);
      return;
    }
    if (eventSessionID !== this.nativeSessionId && !this.#children.has(eventSessionID)) return;
    if (this.#nativeRetries.get(eventSessionID)?.pending &&
        (type.startsWith("session.text.") || type.startsWith("session.reasoning.") ||
         type.startsWith("session.tool.") || type === "session.step.ended" ||
         type === "session.execution.succeeded" || type === "permission.asked" || type === "form.created")) {
      throw protocolFailure("OpenCode v2 native retry omitted the required step restart");
    }
    if (type === "session.inbox.enqueued" && eventSessionID === this.nativeSessionId) {
      if (data.inboxID !== this.inboxID) {
        throw protocolFailure("OpenCode v2 enqueued another input during this Turn");
      }
      if (this.#enqueued) throw protocolFailure("OpenCode v2 enqueued the Turn input twice");
      this.#enqueued = true;
      return;
    }
    if (type === "session.inbox.delivered" && eventSessionID === this.nativeSessionId) {
      if (data.inboxID !== this.inboxID) {
        if (this.#delivered) throw protocolFailure("OpenCode v2 delivered another input during this Turn");
        return;
      }
      if (!this.#enqueued) throw protocolFailure("OpenCode v2 delivered an input that was not observed enqueued");
      if (this.#delivered) throw protocolFailure("OpenCode v2 delivered the Turn input twice");
      this.#delivered = true;
      this.#push({ type: "turn.started" });
      return;
    }
    if (type === "session.execution.started") {
      if (eventSessionID === this.nativeSessionId) {
        if (!this.#enqueued) return;
        if (this.#executing) throw protocolFailure("OpenCode v2 started execution twice");
        this.#executing = true;
      } else {
        if (!this.#delivered) return;
        if (this.#childExecutions.has(eventSessionID)) {
          throw protocolFailure("OpenCode v2 child Session started execution twice");
        }
        this.#childExecutions.add(eventSessionID);
      }
      return;
    }
    if (!this.#delivered) return;
    if (!this.#executing || (eventSessionID !== this.nativeSessionId &&
        !this.#childExecutions.has(eventSessionID))) return;
    if (type === "form.created") {
      const native = requireRecord(data.form, "OpenCode v2 Form");
      const id = requireString(native.id, "OpenCode v2 Form ID");
      const title = requireFormString(native.title, "OpenCode v2 Form title");
      if (native.metadata !== undefined && !isRecord(native.metadata)) {
        throw protocolFailure("OpenCode v2 Form metadata is invalid");
      }
      const metadata = native.metadata as EventValue | undefined;
      if (metadata?.message !== undefined && typeof metadata.message !== "string") {
        throw protocolFailure("OpenCode v2 Form message metadata is invalid");
      }
      const rawFields = native.fields;
      if (this.#forms.has(id) || !Array.isArray(rawFields) || rawFields.length === 0) {
        throw protocolFailure("OpenCode v2 Form is invalid");
      }
      const keys = rawFields.map((value) => requireFormString(requireRecord(value, "OpenCode v2 Form field").key,
        "OpenCode v2 Form field key"));
      const keyIndexes = new Map(keys.map((key, index) => [key, index]));
      if (keyIndexes.size !== keys.length) throw protocolFailure("OpenCode v2 Form field keys repeat");
      const fields = rawFields.map((value, index) => mapFormField(value, keyIndexes, index));
      if (new Set(fields.map((field) => field.key)).size !== fields.length) {
        throw protocolFailure("OpenCode v2 Form field keys repeat");
      }
      const questions: AdapterQuestionItem[] = fields.map((field) => field.question);
      let nativeToolCallId: string | undefined;
      if (metadata?.kind === "question") {
        const tool = requireRecord(metadata.tool, "OpenCode v2 Question Tool identity");
        const messageID = requireString(tool.messageID, "OpenCode v2 Question Tool Message ID");
        const callID = requireString(tool.id, "OpenCode v2 Question Tool ID");
        const key = toolKey(eventSessionID, messageID, callID);
        if (!this.#tools.get(key)?.called) {
          throw protocolFailure("OpenCode v2 Question Form refers to a Tool that has not started");
        }
        nativeToolCallId = key;
      }
      this.#forms.set(id, { fields, status: "pending" });
      this.#formSessions.set(id, eventSessionID);
      this.#push({ type: "question.requested", nativeRequestId: id, questions,
        ...(nativeToolCallId === undefined ? {} : { nativeToolCallId }),
        ...(typeof metadata?.message === "string" && metadata.message.length > 0
          ? { description: metadata.message } : title.length > 0 ? { description: title } : {}) });
      return;
    }
    if (type === "form.replied" || type === "form.cancelled") {
      const id = requireString(data.id, "OpenCode v2 Form resolution ID");
      const form = this.#forms.get(id);
      if (!form) throw protocolFailure("OpenCode v2 resolved an unknown Form");
      if (form.status === "pending") {
        form.status = "invalidated";
        this.#push(type === "form.cancelled"
          ? { type: "question.dismissed", nativeRequestId: id }
          : { type: "question.answered", nativeRequestId: id,
            answers: mapNativeFormAnswers(data.answer, form.fields) });
      } else if (form.status === "invalidated") {
        throw protocolFailure("OpenCode v2 Form resolution repeated");
      }
      return;
    }
    if (type === "permission.asked") {
      if (this.approvalPolicy === "harnessManaged") {
        throw protocolFailure("OpenCode v2 exposed an Approval under harnessManaged policy");
      }
      const id = requireString(data.id, "OpenCode v2 Permission ID");
      const action = requireString(data.action, "OpenCode v2 Permission action");
      if (this.#permissions.has(id) || !Array.isArray(data.resources) ||
          data.resources.some((value) => typeof value !== "string")) {
        throw protocolFailure("OpenCode v2 Permission request is invalid");
      }
      let nativeToolCallId: string | undefined;
      if (data.source !== undefined) {
        const source = requireRecord(data.source, "OpenCode v2 Permission source");
        if (source.type !== "tool") throw protocolFailure("OpenCode v2 Permission source is invalid");
        const messageID = requireString(source.messageID, "OpenCode v2 Permission Message ID");
        const callID = requireString(source.id, "OpenCode v2 Permission Tool ID");
        const key = toolKey(eventSessionID, messageID, callID);
        if (!this.#tools.get(key)?.called) {
          throw protocolFailure("OpenCode v2 Permission refers to an unknown Tool Call");
        }
        nativeToolCallId = key;
      }
      this.#permissions.set(id, "pending");
      this.#permissionSessions.set(id, eventSessionID);
      this.#push({ type: "approval.requested", nativeRequestId: id,
        title: `OpenCode requests ${action} permission`,
        ...(typeof data.message === "string" && data.message.length > 0
          ? { description: data.message }
          : data.resources.length > 0 ? { description: data.resources.join("\n") } : {}),
        ...(nativeToolCallId === undefined ? {} : { nativeToolCallId }),
        details: { action, resources: data.resources },
      });
      return;
    }
    if (type === "permission.replied") {
      const id = requireString(data.requestID, "OpenCode v2 Permission reply ID");
      const state = this.#permissions.get(id);
      if (state === undefined) throw protocolFailure("OpenCode v2 replied to an unknown Permission");
      if (state === "pending") {
        this.#permissions.set(id, "invalidated");
        this.#push({ type: "approval.invalidated", nativeRequestId: id });
      } else if (state === "invalidated") {
        throw protocolFailure("OpenCode v2 Permission reply repeated");
      }
      return;
    }
    if (type === "session.retry.scheduled") {
      const id = requireString(data.assistantMessageID, "OpenCode v2 retry Message ID");
      const previous = this.#nativeRetries.get(eventSessionID);
      if (id !== this.#activeMessages.get(eventSessionID) || this.#messageProgress.has(id) ||
          !Number.isSafeInteger(data.attempt) || (data.attempt as number) <= (previous?.attempt ?? 1) ||
          previous?.pending) {
        throw protocolFailure("OpenCode v2 native retry cannot preserve the active Message");
      }
      this.#nativeRetries.set(eventSessionID, { messageID: id, attempt: data.attempt as number, pending: true });
      return;
    }
    if (type === "session.step.started") {
      const id = requireString(data.assistantMessageID, "OpenCode v2 Assistant Message ID");
      const retry = this.#nativeRetries.get(eventSessionID);
      if (retry?.pending) {
        if (retry.messageID !== id || this.#activeMessages.get(eventSessionID) !== id ||
            this.#messageProgress.has(id)) {
          throw protocolFailure("OpenCode v2 native retry started a different Message");
        }
        retry.pending = false;
        return;
      }
      if (this.#activeMessages.has(eventSessionID) || this.#baselineMessageIDs.has(id) || this.#text.has(id)) {
        throw protocolFailure("OpenCode v2 reused an Assistant Message");
      }
      this.#activeMessages.set(eventSessionID, id);
      this.#nativeRetries.delete(eventSessionID);
      this.#text.set(id, "");
      this.#push({ type: "assistant.message.started", nativeMessageId: id });
      return;
    }
    if (type === "session.text.delta" || type === "session.reasoning.delta") {
      const id = requireString(data.assistantMessageID, "OpenCode v2 Assistant Message ID");
      if (id !== this.#activeMessages.get(eventSessionID)) throw protocolFailure("OpenCode v2 streamed a different Message");
      const delta = requireString(data.delta, "OpenCode v2 text delta");
      this.#messageProgress.add(id);
      if (type === "session.text.delta") {
        this.#text.set(id, (this.#text.get(id) ?? "") + delta);
        this.#push({ type: "assistant.message.delta", nativeMessageId: id, delta });
      } else {
        this.#push({ type: "assistant.reasoning.delta", nativeMessageId: id, delta });
      }
      return;
    }
    if (type === "session.text.ended") {
      const id = requireString(data.assistantMessageID, "OpenCode v2 Assistant Message ID");
      if (id !== this.#activeMessages.get(eventSessionID) || typeof data.text !== "string") {
        throw protocolFailure("OpenCode v2 text completion is invalid");
      }
      const observed = this.#text.get(id) ?? "";
      if (observed.length > 0 && observed !== data.text) {
        throw protocolFailure("OpenCode v2 text stream differs from final text");
      }
      this.#text.set(id, data.text);
      this.#messageProgress.add(id);
      return;
    }
    if (type === "session.tool.input.started") {
      const assistantMessageID = requireString(data.assistantMessageID, "OpenCode v2 Tool Message ID");
      const id = requireString(data.id, "OpenCode v2 Tool call ID");
      const name = requireString(data.name, "OpenCode v2 Tool name");
      if (assistantMessageID !== this.#activeMessages.get(eventSessionID)) {
        throw protocolFailure("OpenCode v2 Tool started outside the active Message");
      }
      this.#messageProgress.add(assistantMessageID);
      const key = toolKey(eventSessionID, assistantMessageID, id);
      if (this.#tools.has(key)) throw protocolFailure("OpenCode v2 Tool identity was reused");
      this.#tools.set(key, { sessionID: eventSessionID, assistantMessageID, id, name,
        called: false, completed: false });
      return;
    }
    if (type === "session.tool.input.ended") {
      const tool = this.#requireTool(data, eventSessionID);
      if (tool.called || tool.inputText !== undefined || typeof data.text !== "string") {
        throw protocolFailure("OpenCode v2 Tool input completion is invalid");
      }
      tool.inputText = data.text;
      return;
    }
    if (type === "session.tool.called") {
      const tool = this.#requireTool(data, eventSessionID);
      if (tool.called || tool.inputText === undefined || !isRecord(data.input) ||
          typeof data.executed !== "boolean") {
        throw protocolFailure("OpenCode v2 Tool call is invalid");
      }
      tool.called = true;
      this.#push({ type: "tool.started", nativeToolCallId: toolKey(tool.sessionID, tool.assistantMessageID, tool.id),
        toolName: tool.name, input: data.input });
      return;
    }
    if (type === "session.tool.progress") {
      const tool = this.#requireTool(data, eventSessionID);
      if (!tool.called || tool.completed || !isRecord(data.metadata)) {
        throw protocolFailure("OpenCode v2 Tool progress is invalid");
      }
      this.#push({ type: "tool.updated", nativeToolCallId: toolKey(tool.sessionID, tool.assistantMessageID, tool.id),
        update: data.metadata });
      return;
    }
    if (type === "session.tool.success" || type === "session.tool.failed") {
      const tool = this.#requireTool(data, eventSessionID);
      if (!tool.called || tool.completed || typeof data.executed !== "boolean" ||
          (type === "session.tool.success" && !Array.isArray(data.content)) ||
          (type === "session.tool.failed" && !isRecord(data.error))) {
        throw protocolFailure("OpenCode v2 Tool terminal is invalid");
      }
      tool.completed = true;
      this.#push({ type: "tool.completed", nativeToolCallId: toolKey(tool.sessionID, tool.assistantMessageID, tool.id),
        output: type === "session.tool.success" ? data.content : {
          error: data.error,
          ...(data.content === undefined ? {} : { content: data.content }),
        },
        isError: type === "session.tool.failed" });
      return;
    }
    if (type === "session.step.ended") {
      const id = requireString(data.assistantMessageID, "OpenCode v2 Assistant Message ID");
      if (id !== this.#activeMessages.get(eventSessionID) || this.#completed.has(id)) {
        throw protocolFailure("OpenCode v2 completed a different Message");
      }
      if ([...this.#tools.values()].some((tool) => tool.sessionID === eventSessionID &&
          tool.assistantMessageID === id && !tool.completed)) {
        throw protocolFailure("OpenCode v2 completed a step with an unresolved Tool");
      }
      const message = requireRecord(
        await this.api.getMessage(eventSessionID, id),
        "OpenCode v2 Assistant Message",
      );
      if (message.id !== id || message.type !== "assistant" || !Array.isArray(message.content)) {
        throw protocolFailure("OpenCode v2 Assistant Message identity is invalid");
      }
      const text = message.content.filter((part) => isRecord(part) && part.type === "text")
        .map((part) => requireString(part.text, "OpenCode v2 Assistant text", true)).join("");
      if ((this.#text.get(id) ?? "") !== text) {
        throw protocolFailure("OpenCode v2 Message differs from streamed text");
      }
      const tokens = usageTokens(data.tokens);
      if (message.tokens !== undefined &&
          !sameUsage(tokens, usageTokens(message.tokens))) {
        throw protocolFailure("OpenCode v2 Assistant usage conflicts with completed step");
      }
      this.#usage.inputTokens += tokens.inputTokens;
      this.#usage.outputTokens += tokens.outputTokens;
      this.#usage.reasoningTokens += tokens.reasoningTokens;
      this.#usage.cachedInputTokens += tokens.cachedInputTokens;
      if (Object.values(this.#usage).some((value) => !Number.isSafeInteger(value))) {
        throw protocolFailure("OpenCode v2 Turn usage overflowed");
      }
      if (eventSessionID === this.nativeSessionId) this.#lastCompletedText = text;
      this.#completed.add(id);
      this.#activeMessages.delete(eventSessionID);
      this.#push({ type: "usage.updated", usage: { ...this.#usage } });
      this.#push({ type: "assistant.message.completed", nativeMessageId: id, text });
      return;
    }
    if (type === "session.execution.succeeded") {
      if (eventSessionID !== this.nativeSessionId) {
        if (this.#activeMessages.has(eventSessionID)) {
          throw protocolFailure("OpenCode v2 child Session completed with an active Message");
        }
        this.#childExecutions.delete(eventSessionID);
        return;
      }
      if (this.#activeMessages.size > 0 || this.#childExecutions.size > 0 ||
        this.#lastCompletedText?.trim().length === 0 ||
        this.#lastCompletedText === undefined) {
        throw protocolFailure("OpenCode v2 completed without a final Assistant Message");
      }
      this.#push({ type: "turn.completed" });
      this.dispose();
      return;
    }
    if (type === "session.execution.failed") {
      this.#push({
        type: "turn.failed",
        error: {
          code: "HARNESS_ERROR",
          message: "OpenCode v2 Turn failed",
          harness: "opencode",
          operation: "startTurn",
          command: "opencode",
        },
      });
      this.dispose();
      return;
    }
    if (type === "session.execution.interrupted") {
      this.#push({ type: "turn.interrupted" });
      this.dispose();
    }
  }

  #requireTool(data: EventValue, sessionID: string): ToolState {
    const assistantMessageID = requireString(data.assistantMessageID, "OpenCode v2 Tool Message ID");
    const id = requireString(data.id, "OpenCode v2 Tool call ID");
    if (assistantMessageID !== this.#activeMessages.get(sessionID)) {
      throw protocolFailure("OpenCode v2 Tool event belongs to another Message");
    }
    const tool = this.#tools.get(toolKey(sessionID, assistantMessageID, id));
    if (!tool) throw protocolFailure("OpenCode v2 Tool event lacks a matching call");
    return tool;
  }
}

function toolKey(sessionID: string, messageID: string, callID: string): string {
  return `${sessionID}:${messageID}:${callID}`;
}

function mapFormField(value: unknown, keyIndexes: ReadonlyMap<string, number>, index: number): FormField {
  const field = requireRecord(value, "OpenCode v2 Form field");
  const key = requireFormString(field.key, "OpenCode v2 Form field key");
  const question = typeof field.title === "string" && field.title.length > 0
    ? field.title : key.length > 0 ? key : `Field ${index + 1}`;
  if (field.title !== undefined && typeof field.title !== "string" ||
      field.description !== undefined && typeof field.description !== "string") {
    throw protocolFailure("OpenCode v2 Form field presentation is invalid");
  }
  const description = typeof field.description === "string" && field.description.length > 0
    ? field.description : undefined;
  if (field.type === "external") {
    assertFormKeys(field, ["key", "type", "url", "title", "description"]);
    return { key, question: { question, ...(description === undefined ? {} : { description }),
      input: { kind: "external", url: requireFormString(field.url, "OpenCode v2 external Form URL") },
      required: true, hidden: false } };
  }
  if (field.required !== undefined && typeof field.required !== "boolean" ||
      field.hidden !== undefined && typeof field.hidden !== "boolean") {
    throw protocolFailure("OpenCode v2 Form field flags are invalid");
  }
  const when = parseFormConditions(field.when, keyIndexes, index);
  const common = { question, ...(description === undefined ? {} : { description }),
    required: field.required === true, hidden: field.hidden === true,
    ...(field.default === undefined ? {} : { defaultValue: field.default }),
    ...(when.length === 0 ? {} : { when }) };
  let input: AdapterTypedQuestionItem["input"];
  if (field.type === "string") {
    assertFormKeys(field, ["key", "type", "title", "description", "required", "hidden", "when",
      "format", "minLength", "maxLength", "pattern", "placeholder", "default", "options", "custom"]);
    if (field.default !== undefined && typeof field.default !== "string") {
      throw protocolFailure("OpenCode v2 string Form default is invalid");
    }
    if (field.custom !== undefined && typeof field.custom !== "boolean") {
      throw protocolFailure("OpenCode v2 string Form custom flag is invalid");
    }
    const text = parseTextConstraints(field);
    input = field.options === undefined ? { kind: "text", ...text }
      : { kind: "select", options: parseFormOptions(field.options), allowCustom: field.custom === true, ...text };
  } else if (field.type === "multiselect") {
    assertFormKeys(field, ["key", "type", "title", "description", "required", "hidden", "when",
      "options", "minItems", "maxItems", "custom", "default"]);
    if (field.custom !== undefined && typeof field.custom !== "boolean" ||
        field.default !== undefined && (!Array.isArray(field.default) ||
          field.default.some((entry) => typeof entry !== "string"))) {
      throw protocolFailure("OpenCode v2 multiselect Form defaults or flags are invalid");
    }
    input = { kind: "multiselect", options: parseFormOptions(field.options), allowCustom: field.custom === true,
      ...(field.minItems === undefined ? {} : { minItems: nonnegativeInteger(field.minItems, "Form minItems") }),
      ...(field.maxItems === undefined ? {} : { maxItems: nonnegativeInteger(field.maxItems, "Form maxItems") }) };
  } else if (field.type === "number" || field.type === "integer") {
    assertFormKeys(field, ["key", "type", "title", "description", "required", "hidden", "when",
      "minimum", "maximum", "default"]);
    if (field.default !== undefined && (!finiteNumber(field.default) ||
        field.type === "integer" && !Number.isInteger(field.default))) {
      throw protocolFailure("OpenCode v2 numeric Form default is invalid");
    }
    input = { kind: "number", integer: field.type === "integer",
      ...(field.minimum === undefined ? {} : { minimum: requireFiniteNumber(field.minimum, "Form minimum") }),
      ...(field.maximum === undefined ? {} : { maximum: requireFiniteNumber(field.maximum, "Form maximum") }) };
  } else if (field.type === "boolean") {
    assertFormKeys(field, ["key", "type", "title", "description", "required", "hidden", "when", "default"]);
    if (field.default !== undefined && typeof field.default !== "boolean") {
      throw protocolFailure("OpenCode v2 boolean Form default is invalid");
    }
    input = { kind: "boolean" };
  } else {
    throw protocolFailure("OpenCode v2 Form field type is unsupported");
  }
  return { key, question: { ...common, input } as AdapterTypedQuestionItem };
}

function assertFormKeys(field: EventValue, allowed: readonly string[]): void {
  if (Object.keys(field).some((key) => !allowed.includes(key))) {
    throw protocolFailure("OpenCode v2 Form field schema changed");
  }
}

function parseFormConditions(value: unknown, keys: ReadonlyMap<string, number>, index: number):
  NonNullable<AdapterTypedQuestionItem["when"]> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw protocolFailure("OpenCode v2 Form conditions are invalid");
  return value.map((entry) => {
    const condition = requireRecord(entry, "OpenCode v2 Form condition");
    assertFormKeys(condition, ["key", "op", "value"]);
    const target = keys.get(requireFormString(condition.key, "OpenCode v2 Form condition key"));
    if (target === undefined || target >= index ||
        condition.op !== "eq" && condition.op !== "neq" ||
        !["string", "number", "boolean"].includes(typeof condition.value) ||
        typeof condition.value === "number" && !Number.isFinite(condition.value)) {
      throw protocolFailure("OpenCode v2 Form condition is invalid");
    }
    return { questionIndex: target, op: condition.op, value: condition.value as string | number | boolean };
  });
}

function parseFormOptions(value: unknown): readonly { readonly value: string; readonly label: string;
  readonly description?: string }[] {
  if (!Array.isArray(value)) throw protocolFailure("OpenCode v2 Form options are invalid");
  return value.map((entry) => {
    const option = requireRecord(entry, "OpenCode v2 Form option");
    assertFormKeys(option, ["value", "label", "description"]);
    const label = requireFormString(option.label, "OpenCode v2 Form option label");
    if (typeof option.value !== "string" || option.description !== undefined && typeof option.description !== "string") {
      throw protocolFailure("OpenCode v2 Form option is invalid");
    }
    return { value: option.value, label,
      ...(typeof option.description === "string" && option.description.length > 0
        ? { description: option.description } : {}) };
  });
}

function requireFormString(value: unknown, name: string): string {
  if (typeof value !== "string") throw protocolFailure(`${name} is invalid`);
  return value;
}

function parseTextConstraints(field: EventValue) {
  if (field.format !== undefined && !["email", "uri", "date", "date-time"].includes(field.format as string) ||
      field.pattern !== undefined && typeof field.pattern !== "string" ||
      field.placeholder !== undefined && typeof field.placeholder !== "string") {
    throw protocolFailure("OpenCode v2 Form text constraints are invalid");
  }
  return {
    ...(field.format === undefined ? {} : { format: field.format as "email" | "uri" | "date" | "date-time" }),
    ...(field.minLength === undefined ? {} : { minLength: nonnegativeInteger(field.minLength, "Form minLength") }),
    ...(field.maxLength === undefined ? {} : { maxLength: nonnegativeInteger(field.maxLength, "Form maxLength") }),
    ...(field.pattern === undefined ? {} : { pattern: field.pattern as string }),
    ...(field.placeholder === undefined ? {} : { placeholder: field.placeholder as string }),
  };
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function requireFiniteNumber(value: unknown, name: string): number {
  if (!finiteNumber(value)) throw protocolFailure(`OpenCode v2 ${name} is invalid`);
  return value;
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw protocolFailure(`OpenCode v2 ${name} is invalid`);
  }
  return value as number;
}

function nativeFormAnswer(answers: readonly AdapterQuestionAnswer[],
  fields: readonly FormField[]): Record<string, string | number | boolean | readonly string[]> {
  if (answers.length !== fields.length) throw protocolFailure("OpenCode v2 Form answer count is invalid");
  const result: Record<string, string | number | boolean | readonly string[]> = {};
  const seen = new Set<number>();
  for (const answer of answers) {
    const index = answer.questionIndex;
    const field = fields[index];
    if (!field || seen.has(index)) throw protocolFailure("OpenCode v2 Form answer index is invalid");
    seen.add(index);
    if (answer.kind === "skipped") continue;
    if (answer.kind === "useDefault") {
      if (field.question.defaultValue === undefined) throw protocolFailure("OpenCode v2 Form default is missing");
      result[field.key] = field.question.defaultValue;
      continue;
    }
    const input = field.question.input;
    if (answer.kind === "selection" && (input.kind === "select" || input.kind === "multiselect")) {
      const selected = answer.optionIndexes.map((optionIndex) => {
        const option = input.options[optionIndex];
        if (!option) throw protocolFailure("OpenCode v2 Form option index is invalid");
        return option.value;
      });
      const values = [...selected, ...answer.customValues];
      result[field.key] = input.kind === "select" ? values[0]! : values;
    } else if (answer.kind === "text" && input.kind === "text") result[field.key] = answer.text;
    else if (answer.kind === "number" && input.kind === "number") result[field.key] = answer.value;
    else if (answer.kind === "boolean" && input.kind === "boolean") result[field.key] = answer.value;
    else if (answer.kind === "externalAcknowledged" && input.kind === "external") result[field.key] = true;
    else throw protocolFailure("OpenCode v2 Form answer type is invalid");
  }
  return result;
}

function mapNativeFormAnswers(value: unknown, fields: readonly FormField[]): AdapterQuestionAnswer[] {
  const answer = requireRecord(value, "OpenCode v2 Form native answer");
  const keys = new Set(fields.map((field) => field.key));
  if (Object.keys(answer).some((key) => !keys.has(key))) {
    throw protocolFailure("OpenCode v2 Form native answer has an unknown field");
  }
  return fields.map((field, questionIndex): AdapterQuestionAnswer => {
    if (!Object.hasOwn(answer, field.key)) return { questionIndex, kind: "skipped" };
    const item = answer[field.key];
    const question = field.question;
    if (question.hidden) {
      if (question.defaultValue !== undefined && sameFormValue(item, question.defaultValue)) {
        return { questionIndex, kind: "useDefault" };
      }
      throw protocolFailure("OpenCode v2 answered a hidden Form field outside its private default");
    }
    const input = question.input;
    if (input.kind === "text" && typeof item === "string") {
      return { questionIndex, kind: "text", text: item };
    }
    if (input.kind === "select" && typeof item === "string") {
      const optionIndex = input.options.findIndex((option) => option.value === item);
      if (optionIndex >= 0) return { questionIndex, kind: "selection", optionIndexes: [optionIndex], customValues: [] };
      if (input.allowCustom) return { questionIndex, kind: "selection", optionIndexes: [], customValues: [item] };
    }
    if (input.kind === "multiselect" && Array.isArray(item) &&
        item.every((entry) => typeof entry === "string")) {
      const optionIndexes: number[] = [];
      const customValues: string[] = [];
      const used = new Set<number>();
      for (const entry of item as string[]) {
        const optionIndex = input.options.findIndex((option, index) => option.value === entry && !used.has(index));
        if (optionIndex >= 0) {
          used.add(optionIndex);
          optionIndexes.push(optionIndex);
        } else if (input.allowCustom) customValues.push(entry);
        else throw protocolFailure("OpenCode v2 Form native selection cannot be projected without ambiguity");
      }
      return { questionIndex, kind: "selection", optionIndexes, customValues };
    }
    if (input.kind === "number" && typeof item === "number" && Number.isFinite(item)) {
      return { questionIndex, kind: "number", value: item };
    }
    if (input.kind === "boolean" && typeof item === "boolean") {
      return { questionIndex, kind: "boolean", value: item };
    }
    if (input.kind === "external" && item === true) return { questionIndex, kind: "externalAcknowledged" };
    throw protocolFailure("OpenCode v2 Form native answer type is invalid");
  });
}

function sameFormValue(left: unknown, right: NonNullable<AdapterTypedQuestionItem["defaultValue"]>): boolean {
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((entry, index) => entry === right[index]);
  }
  return left === right;
}

type Usage = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly cachedInputTokens: number;
};

function usageTokens(value: unknown): Usage {
  const tokens = requireRecord(value, "OpenCode v2 Model step tokens");
  const cache = requireRecord(tokens.cache, "OpenCode v2 Model step cache tokens");
  for (const number of [tokens.input, tokens.output, tokens.reasoning, cache.read, cache.write]) {
    if (!Number.isSafeInteger(number) || (number as number) < 0) {
      throw protocolFailure("OpenCode v2 Model step usage is invalid");
    }
  }
  return {
    inputTokens: tokens.input as number,
    outputTokens: tokens.output as number,
    reasoningTokens: tokens.reasoning as number,
    cachedInputTokens: cache.read as number,
  };
}

function sameUsage(left: Usage, right: Usage): boolean {
  return left.inputTokens === right.inputTokens && left.outputTokens === right.outputTokens &&
    left.reasoningTokens === right.reasoningTokens && left.cachedInputTokens === right.cachedInputTokens;
}

class TurnEvents implements AsyncIterable<AdapterTurnEvent> {
  readonly #values: AdapterTurnEvent[] = [];
  readonly #waiting: Array<(value: IteratorResult<AdapterTurnEvent>) => void> = [];
  #ended = false;

  push(value: AdapterTurnEvent): void {
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ done: false, value });
    else this.#values.push(value);
  }

  end(): void {
    this.#ended = true;
    for (const waiter of this.#waiting.splice(0)) waiter({ done: true, value: undefined });
  }

  async *[Symbol.asyncIterator](): AsyncIterator<AdapterTurnEvent> {
    for (;;) {
      if (this.#values.length > 0) {
        yield this.#values.shift()!;
        continue;
      }
      if (this.#ended) return;
      const next = await new Promise<IteratorResult<AdapterTurnEvent>>((resolve) => this.#waiting.push(resolve));
      if (next.done) return;
      yield next.value;
    }
  }
}

function isRecord(value: unknown): value is EventValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, description: string): EventValue {
  if (!isRecord(value)) throw protocolFailure(description + " is invalid");
  return value;
}

function requireString(value: unknown, description: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw protocolFailure(description + " is invalid");
  }
  return value;
}

function protocolFailure(message: string): {
  readonly code: "ADAPTER_PROTOCOL_ERROR";
  readonly message: string;
  readonly harness: "opencode";
} {
  return { code: "ADAPTER_PROTOCOL_ERROR", message, harness: "opencode" };
}
