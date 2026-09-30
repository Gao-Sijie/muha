import type { OpenCodeClient, SessionPromptInput } from "@opencode/client";
import type { HarnessErrorData } from "@muha-sdk/core";
import type { LiveHarnessAdapterContext } from "@muha-sdk/core/internal";

export class OpenCodeV2Api {
  constructor(
    readonly client: OpenCodeClient,
    readonly context: LiveHarnessAdapterContext,
  ) {}

  async createSession(
    workspacePath: string,
    model?: { readonly providerID: string; readonly id: string; readonly variant?: string },
    permissions?: readonly { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }[],
  ): Promise<unknown> {
    try {
      const info: unknown = await this.client.session.create({
        location: { directory: workspacePath },
        ...(model === undefined ? {} : { model }),
        ...(permissions === undefined ? {} : { permissions }),
      });
      await this.context.recordNativeEvent("opencode", info);
      return info;
    } catch (error) {
      if (isEventStoreError(error)) throw error;
      throw commandFailure("createSession");
    }
  }

  async setPermissions(nativeSessionId: string,
    permissions: readonly { readonly action: string; readonly resource: string; readonly effect: "allow" | "deny" | "ask" }[],
  ): Promise<void> {
    try {
      await this.client.session.update({ sessionID: nativeSessionId, permissions });
    } catch {
      throw commandFailure("resumeSession");
    }
  }

  async replyPermission(nativeSessionId: string, requestID: string, decision: "allowOnce" | "deny"): Promise<void> {
    try {
      await this.client.permission.reply({ sessionID: nativeSessionId, requestID,
        decision: decision === "allowOnce" ? "once" : "reject" });
    } catch {
      throw commandFailure("respondToApproval");
    }
  }

  async replyForm(nativeSessionId: string, formID: string,
    answer: Readonly<Record<string, string | number | boolean | readonly string[]>>): Promise<void> {
    try {
      await this.client.session.form.reply({ sessionID: nativeSessionId, formID, answer });
    } catch {
      throw commandFailure("respondToQuestion");
    }
  }

  async cancelForm(nativeSessionId: string, formID: string): Promise<void> {
    try {
      await this.client.session.form.cancel({ sessionID: nativeSessionId, formID });
    } catch {
      throw commandFailure("respondToQuestion");
    }
  }

  async getSession(nativeSessionId: string): Promise<unknown> {
    try {
      const info: unknown = await this.client.session.get({ sessionID: nativeSessionId });
      await this.context.recordNativeEvent("opencode", info);
      return info;
    } catch (error) {
      if (isEventStoreError(error)) throw error;
      throw commandFailure("resumeSession", isNotFound(error) ? "session_not_found" : undefined);
    }
  }

  async listSessions(workspacePath: string): Promise<readonly unknown[]> {
    const all: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      let page: unknown;
      try {
        page = await this.client.session.list({
          directory: workspacePath,
          limit: 100,
          ...(cursor === undefined ? {} : { cursor }),
        });
      } catch (error) {
        throw commandFailure("listSessions", isNotFound(error) ? "session_not_found" : undefined);
      }
      await this.context.recordNativeEvent("opencode", page);
      if (!isRecord(page) || !Array.isArray(page.data) || !isRecord(page.cursor)) {
        throw protocolFailure("OpenCode v2 Session list response is invalid");
      }
      all.push(...page.data);
      const next = page.cursor.next;
      if (next === undefined || next === null) return all;
      if (typeof next !== "string" || next.length === 0 || seen.has(next)) {
        throw protocolFailure("OpenCode v2 Session list cursor is invalid");
      }
      seen.add(next);
      cursor = next;
    }
  }

  async listMessages(nativeSessionId: string): Promise<readonly unknown[]> {
    const all: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (;;) {
      let result: unknown;
      try {
        result = await this.client.message.list({ sessionID: nativeSessionId, limit: 100,
          ...(cursor === undefined ? { order: "desc" as const } : { cursor }) });
      } catch {
        throw commandFailure("startTurn");
      }
      await this.context.recordNativeEvent("opencode", result);
      if (!isRecord(result) || !Array.isArray(result.data) || !isRecord(result.cursor)) {
        throw protocolFailure("OpenCode v2 Message list response is invalid");
      }
      all.push(...result.data);
      const next = result.cursor.next;
      if (next === undefined || next === null) return all;
      if (typeof next !== "string" || next.length === 0 || seen.has(next)) {
        throw protocolFailure("OpenCode v2 Message list cursor is invalid");
      }
      seen.add(next);
      cursor = next;
    }
  }

  async listModels(workspacePath: string, operation: HarnessErrorData["operation"]): Promise<readonly unknown[]> {
    let result: unknown;
    try {
      result = await this.client.model.list({ location: { directory: workspacePath } });
    } catch {
      throw commandFailure(operation);
    }
    await this.context.recordNativeEvent("opencode", result);
    if (!isRecord(result) || !Array.isArray(result.data)) {
      throw protocolFailure("OpenCode v2 Model list response is invalid");
    }
    return result.data;
  }

  async defaultModel(workspacePath: string): Promise<unknown> {
    let result: unknown;
    try {
      result = await this.client.model.default({ location: { directory: workspacePath } });
    } catch {
      throw commandFailure("startTurn");
    }
    await this.context.recordNativeEvent("opencode", result);
    if (!isRecord(result) || !("data" in result)) {
      throw protocolFailure("OpenCode v2 default Model response is invalid");
    }
    return result.data;
  }

  async switchModel(
    nativeSessionId: string,
    model: { readonly providerID: string; readonly id: string; readonly variant?: string },
    operation: HarnessErrorData["operation"],
  ): Promise<void> {
    try {
      await this.client.session.switchModel({ sessionID: nativeSessionId, model });
    } catch {
      throw commandFailure(operation);
    }
  }

  async prompt(nativeSessionId: string, id: string, input: Pick<SessionPromptInput, "text" | "files" | "metadata">): Promise<unknown> {
    try {
      const inbox: unknown = await this.client.session.prompt({ sessionID: nativeSessionId, id, ...input });
      await this.context.recordNativeEvent("opencode", inbox);
      return inbox;
    } catch (error) {
      if (isEventStoreError(error)) throw error;
      throw commandFailure("startTurn", nativeErrorCode(error));
    }
  }

  async getMessage(nativeSessionId: string, messageID: string): Promise<unknown> {
    try {
      const message: unknown = await this.client.session.message.get({ sessionID: nativeSessionId, messageID });
      await this.context.recordNativeEvent("opencode", message);
      return message;
    } catch (error) {
      if (isEventStoreError(error)) throw error;
      throw commandFailure("startTurn");
    }
  }

  async interrupt(nativeSessionId: string): Promise<unknown> {
    try {
      const result: unknown = await this.client.session.interrupt({ sessionID: nativeSessionId });
      await this.context.recordNativeEvent("opencode", result);
      return result;
    } catch (error) {
      if (isEventStoreError(error)) throw error;
      throw commandFailure("interruptTurn");
    }
  }
}

function commandFailure(operation: HarnessErrorData["operation"], nativeCode?: string): HarnessErrorData {
  return {
    code: "HARNESS_ERROR",
    message: "OpenCode v2 rejected " + operation,
    harness: "opencode",
    operation,
    command: "opencode",
    ...(nativeCode === undefined ? {} : { nativeCode }),
  };
}

function protocolFailure(message: string): {
  readonly code: "ADAPTER_PROTOCOL_ERROR";
  readonly message: string;
  readonly harness: "opencode";
} {
  return { code: "ADAPTER_PROTOCOL_ERROR", message, harness: "opencode" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEventStoreError(value: unknown): boolean {
  return isRecord(value) && value.code === "EVENT_STORE_ERROR";
}

function isNotFound(value: unknown): boolean {
  return isRecord(value) && (
    value.status === 404 ||
    value._tag === "SessionNotFoundError" ||
    value.code === "SessionNotFoundError"
  );
}

function httpCode(value: unknown): string | undefined {
  if (!isRecord(value) || !Number.isSafeInteger(value.status) ||
      (value.status as number) < 400 || (value.status as number) > 599) return undefined;
  return `http_${value.status}`;
}

function nativeErrorCode(value: unknown): string | undefined {
  if (isRecord(value) && typeof value._tag === "string" &&
      /^[A-Za-z][A-Za-z0-9_]{0,79}$/.test(value._tag)) return value._tag;
  return httpCode(value);
}
