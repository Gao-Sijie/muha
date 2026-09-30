import type { AcpQuestionMapping, AcpQuestionRequest, AdapterQuestionItem } from "@muha-sdk/core/internal";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => typeof value === "object" && value !== null && !Array.isArray(value);
function invalid(message: string): never { throw { code: "ADAPTER_PROTOCOL_ERROR", harness: "codex", message }; }

/** codex-acp 1.12.0's explicit request_user_input projection. Do not infer a
 * Question from an arbitrary form: MCP and authentication forms are declined. */
export function decodeCodexAcpQuestion(request: AcpQuestionRequest): AcpQuestionMapping | undefined {
  if (request.mode !== "form" || !record(request._meta?.codex) || !("autoResolutionMs" in request._meta.codex)) return undefined;
  const schema = request.requestedSchema;
  if (!record(schema) || schema.type !== "object" || !record(schema.properties)) invalid("Invalid Codex ACP Question schema");
  const properties = schema.properties;
  const fields: { id: string; note: string | undefined; values: string[]; public: AdapterQuestionItem }[] = [];
  for (const [id, value] of Object.entries(properties)) {
    if (!record(value) || !record(value._meta) || !record(value._meta.codex)) invalid("Codex Question field lacks native metadata");
    const meta = value._meta.codex;
    if (meta.role === "user_note") continue;
    if (typeof meta.isOther !== "boolean" || typeof meta.isSecret !== "boolean" || value.type !== "string" || typeof value.title !== "string" || !value.title) invalid("Invalid Codex Question field");
    if (meta.isSecret) invalid("Codex secret Questions cannot be represented safely");
    const choices = value.oneOf === undefined ? [] : Array.isArray(value.oneOf) ? value.oneOf : invalid("Invalid Codex Question choices");
    const values: string[] = [];
    const options = choices.flatMap(choice => {
      if (!record(choice) || typeof choice.const !== "string" || typeof choice.title !== "string") invalid("Invalid Codex Question choice");
      if (meta.isOther && choice.const === "None of the above") return [];
      values.push(choice.const);
      return [{ label: choice.title, ...(typeof choice.description === "string" && choice.description ? { description: choice.description } : {}) }];
    });
    const note = Object.entries(properties).find(([, field]) => record(field) && record(field._meta) && record(field._meta.codex)
      && field._meta.codex.role === "user_note" && field._meta.codex.questionId === id)?.[0];
    if (meta.isOther && options.length > 0 && note === undefined) invalid("Codex Question lacks its custom-answer note field");
    fields.push({ id, note, values, public: { question: value.title,
      ...(typeof value.description === "string" && value.description ? { header: value.description } : {}),
      options, multiple: false, allowCustom: options.length === 0 || meta.isOther } });
  }
  if (!fields.length) invalid("Codex Question has no fields");
  return {
    questions: fields.map(field => field.public),
    // Native request_user_input item IDs are not regular Tool Call IDs.
    reply(response) {
      if (response.action === "dismiss") return { action: "decline" };
      const content: RecordValue = {};
      for (const answer of response.answers) {
        const field = fields[answer.questionIndex];
        if (!field) invalid("Unknown Codex Question answer index");
        if (answer.kind === "skipped") continue;
        if (answer.kind === "options" || answer.kind === "optionsWithCustom") content[field.id] = field.values[answer.optionIndexes[0]!];
        if (answer.kind === "custom" || answer.kind === "optionsWithCustom") {
          if (field.note !== undefined) {
            if (answer.kind === "custom") content[field.id] = "None of the above";
            content[field.note] = answer.text;
          } else content[field.id] = answer.text;
        }
      }
      return { action: "accept", content };
    },
  };
}
