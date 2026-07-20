/**
 * Insight adapters — title / summary / action items (design-spec §6.1).
 * - BedrockInsight: Claude on Amazon Bedrock under the AWS BAA (Q5 resolution;
 *   `anthropic.claude-sonnet-5` by default). Minimum-necessary payload:
 *   attributed transcript text + the requesting author's notes; never audio,
 *   emails, or other users' notes. Assignees are validated against the
 *   attendee list — hallucinated assignees are dropped (spec §6.1).
 * - MockInsight: deterministic extractive fallback used in dev/tests and as
 *   the §6.6 local heuristic when the Claude job is gated off.
 */
import { ActionItem, AiOutputs, Meeting, User, Utterance } from "@collective/shared";
import { newId } from "../store.js";

export interface InsightInput {
  meeting: Meeting;
  utterances: Utterance[];
  authorNotes?: string;
  attendees: User[];
  speakerName: (u: Utterance) => string;
}

export interface Insight {
  readonly name: string;
  generate(input: InsightInput): Promise<AiOutputs>;
}

function validateAssignees(items: ActionItem[], attendees: User[]): ActionItem[] {
  const ids = new Set(attendees.map((a) => a.id));
  return items.map((i) => (i.assigneeUserId && !ids.has(i.assigneeUserId) ? { ...i, assigneeUserId: undefined } : i));
}

/* ------------------------------- mock ---------------------------------- */

export class MockInsight implements Insight {
  readonly name = "mock";

  async generate({ meeting, utterances, attendees, speakerName }: InsightInput): Promise<AiOutputs> {
    const text = utterances.map((u) => `${speakerName(u)}: ${u.text}`);
    const actionLines = utterances.filter((u) => /\b(i will|can you|i can take|action items?)\b/i.test(u.text));
    const items: ActionItem[] = actionLines.slice(0, 5).map((u) => ({
      id: newId("act"),
      text: u.text.replace(/^(okay|yes|great)[,— ]*/i, "").slice(0, 140),
      assigneeUserId: u.speakerUserId,
      done: false,
      sourceUtteranceIds: [u.id],
    }));
    return {
      title: meeting.title || (utterances[0]?.text.slice(0, 56) ?? "Untitled meeting"),
      summary:
        `Meeting with ${attendees.map((a) => a.displayName.split(" ")[0]).join(", ")}. ` +
        `${utterances.length} turns captured. Key discussion: ${text.slice(1, 3).join(" ")}`.slice(0, 400),
      actionItems: validateAssignees(items, attendees),
      model: "mock",
      generatedAt: new Date().toISOString(),
    };
  }
}

/* ------------------------------ Bedrock -------------------------------- */

const PROMPT = `You produce meeting notes for a healthcare operations team.
Given the transcript (and optionally the author's own notes), reply with ONLY a JSON object:
{"title": string (<=60 chars), "summary": string (one paragraph), "actionItems": [{"text": string, "assignee": string|null (display name from the transcript, or null), "sourceQuotes": string[] (verbatim supporting quotes)}]}
Only name an assignee who is a named speaker or attendee. Do not invent items that lack transcript support.`;

export class BedrockInsight implements Insight {
  readonly name = "bedrock";
  constructor(private modelId: string) {}

  async generate(input: InsightInput): Promise<AiOutputs> {
    const { BedrockRuntimeClient, ConverseCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const client = new BedrockRuntimeClient({});
    const transcript = input.utterances.map((u) => `${input.speakerName(u)}: ${u.text}`).join("\n");
    const userMsg =
      `TRANSCRIPT:\n${transcript}\n` + (input.authorNotes ? `\nAUTHOR NOTES:\n${input.authorNotes}\n` : "");
    const res = await client.send(
      new ConverseCommand({
        modelId: this.modelId,
        system: [{ text: PROMPT }],
        messages: [{ role: "user", content: [{ text: userMsg }] }],
        inferenceConfig: { maxTokens: 1500, temperature: 0.2 },
      }),
    );
    const text = res.output?.message?.content?.map((c) => ("text" in c ? c.text : "")).join("") ?? "";
    const json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as {
      title: string;
      summary: string;
      actionItems: Array<{ text: string; assignee: string | null; sourceQuotes: string[] }>;
    };
    const byName = new Map(input.attendees.map((a) => [a.displayName.toLowerCase(), a.id]));
    const quoteToId = (q: string) =>
      input.utterances.find((u) => u.text.includes(q.slice(0, 60)))?.id;
    const items: ActionItem[] = json.actionItems.map((i) => ({
      id: newId("act"),
      text: i.text,
      assigneeUserId: i.assignee ? byName.get(i.assignee.toLowerCase()) : undefined,
      done: false,
      sourceUtteranceIds: i.sourceQuotes.map(quoteToId).filter((x): x is string => !!x),
    }));
    return {
      title: json.title.slice(0, 60),
      summary: json.summary,
      actionItems: validateAssignees(items, input.attendees),
      model: this.modelId,
      generatedAt: new Date().toISOString(),
    };
  }
}

export function makeInsight(): Insight {
  const hasAws = !!(process.env.AWS_ACCESS_KEY_ID || process.env.AWS_PROFILE || process.env.AWS_ROLE_ARN);
  if (process.env.BEDROCK_DISABLED === "1" || !hasAws) return new MockInsight();
  return new BedrockInsight(process.env.BEDROCK_MODEL_ID ?? "anthropic.claude-sonnet-5");
}
