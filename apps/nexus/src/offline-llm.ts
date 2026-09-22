import type { FakeLLMResponder } from "@nexus/providers";

/**
 * A coherent offline "model" for the dashboard's fake LLM.
 *
 * The default fake LLM answers from the request schema alone, so its quotes can
 * never match the fake search rows: research drops every excerpt as
 * unverifiable, the script stage finds no usable claims and parks the job, and
 * the dashboard demo can never leave MANUAL_INPUT. This responder reads the
 * engine prompts the way the research/script engines' own test doubles do:
 *
 * - `research.extract` quotes the first sentence of the SOURCE TEXT the prompt
 *   carried, so verification passes by construction; one claim per source.
 * - `script.write` uses ONLY the claim ids and source ids the prompt's FACT and
 *   REPORT lists handed it — fact sentences cite cleared claims, attributed
 *   sentences name a source behind the claim and carry a reporting marker.
 * - `context` connective sentences carry no claims, so they can never assert
 *   anything unsupported.
 *
 * It is still a fake: it invents nothing the prompts did not contain, and every
 * downstream gate (quote verification, attribution checks, QA) still runs for
 * real over its output.
 */

type Messages = readonly { readonly role: string; readonly content: string }[];

const lastMessage = (messages: Messages): string => messages[messages.length - 1]?.content ?? "";

const between = (text: string, open: string, close: string): string => {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start >= 0 && end > start ? text.slice(start + open.length, end) : "";
};

const topicOf = (text: string): string => /TOPIC: (.+)/.exec(text)?.[1]?.trim() || "the topic";

/** Cut at the last word boundary that fits, so claims stay one line of scene text. */
const truncateAtWord = (text: string, max: number): string => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max + 1);
  const at = cut.lastIndexOf(" ");
  return (at > max * 0.5 ? cut.slice(0, at) : cut.slice(0, max)).trimEnd();
};

const firstSentence = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return /^[\s\S]*?[.!?](?=\s|$)/.exec(trimmed)?.[0]?.trim() ?? trimmed.slice(0, 240);
};

/** `- cl_ab12cd34: statement …` lines from one prompt block. */
const claimLines = (block: string): { id: string; statement: string }[] =>
  [...block.matchAll(/^- (cl_[0-9a-f]{8}): (.+)$/gm)].map((match) => ({
    id: match[1]!,
    statement: match[2]!.trim(),
  }));

/** First `src_…` id mentioned in a REPORT list line's `[… sources: …]` suffix. */
const sourceIdsOf = (statement: string): string[] =>
  [...statement.matchAll(/src_[0-9a-f]{8}/g)].map((match) => match[0]);

const cleanStatement = (statement: string): string =>
  // Strip the trailing `[reason; sources: …]` / `[via …]` annotation.
  statement.replace(/\s*\[[^\]]*\]\s*$/, "").trim();

const domainOfStatement = (statement: string): string => {
  const via = /\[via ([^\]]+)\]/.exec(statement)?.[1] ?? "";
  return via.split(",")[0]?.trim() ?? "";
};

export function offlineResponder(): FakeLLMResponder {
  return (request) => {
    const text = lastMessage(request.messages);
    switch (request.task) {
      // ── research: one primary question searched with the topic itself ──
      case "research.questions": {
        const topic = topicOf(text);
        return {
          questions: [
            {
              question: `What is known about ${topic}?`,
              rationale: "the core of the topic",
              priority: "primary",
              queries: [topic],
            },
          ],
        };
      }

      // ── research: quote the shown source text verbatim ──────────────────
      case "research.extract": {
        const sourceText = between(text, '"""', '"""');
        const sentence = firstSentence(sourceText);
        if (sentence === "") return { evidence: [], claims: [] };
        return {
          evidence: [{ quote: sentence, relevance: "states it directly" }],
          claims: [
            {
              // A claim is the assertion, not the whole sentence — and scene
              // text renders the statement, so keep it short enough to fit.
              statement: truncateAtWord(sentence, 72),
              evidence: [0],
              stance: "supports",
              strength: 0.9,
              rationale: "the source states this in its opening sentence",
            },
          ],
        };
      }

      case "research.reconcile":
        return { groups: [] };

      case "research.conflicts":
        return { conflicts: [], refutations: [] };

      // ── script: write only from the brief the prompt handed over ────────
      case "script.write":
      case "script.revise": {
        const topic = topicOf(text);
        const narrativeCount = Math.max(2, Number(/(\d+) narrative sections/.exec(text)?.[1] ?? 2));
        const factBlock = between(text, "FACT list", "REPORT list");
        const facts = claimLines(factBlock);
        const reportBlock = between(text, "REPORT list", "SOURCES you may name");
        const reports = claimLines(reportBlock).map((entry) => ({
          ...entry,
          sourceIds: sourceIdsOf(entry.statement),
        }));

        const sentences: {
          narration: string;
          assertion: "fact" | "attributed" | "context";
          claimRefs: string[];
          sourceRefs: string[];
          visual: { kind: "broll" | "text"; description: string };
        }[] = [];

        for (const fact of facts.slice(0, 4)) {
          sentences.push({
            narration: cleanStatement(fact.statement),
            assertion: "fact",
            claimRefs: [fact.id],
            sourceRefs: [],
            visual: { kind: "broll", description: "Archive footage" },
          });
        }
        for (const report of reports.slice(0, 4)) {
          const sourceId = report.sourceIds[0] ?? "";
          const domain = domainOfStatement(report.statement);
          const lead = domain !== "" ? `According to ${domain}, ` : "According to the reporting, ";
          sentences.push({
            narration: `${lead}${lowerFirst(cleanStatement(report.statement))}`,
            assertion: "attributed",
            claimRefs: [report.id],
            sourceRefs: sourceId === "" ? [] : [sourceId],
            visual: { kind: "text", description: "Source card" },
          });
        }

        // Distribute the claim sentences over the required structure; sections
        // without a claim get a plain connective sentence (no assertion).
        const sections: {
          role: "hook" | "introduction" | "narrative" | "conclusion";
          title: string;
          transition: string;
          sentences: typeof sentences;
        }[] = [];
        let cursor = 0;
        const take = (): typeof sentences | null =>
          cursor < sentences.length ? [sentences[cursor++]!] : null;
        const connective = (): typeof sentences => [
          {
            narration: "Here is where the picture stands.",
            assertion: "context",
            claimRefs: [],
            sourceRefs: [],
            visual: { kind: "text", description: "Title card" },
          },
        ];

        sections.push({
          role: "hook",
          title: "Hook",
          transition: "",
          sentences: [
            {
              narration: "What do the sources say?",
              assertion: "context",
              claimRefs: [],
              sourceRefs: [],
              visual: { kind: "text", description: "Title card" },
            },
          ],
        });
        sections.push({
          role: "introduction",
          title: "Introduction",
          transition: "Start with what the research found.",
          sentences: take() ?? connective(),
        });
        for (let index = 0; index < narrativeCount; index += 1) {
          sections.push({
            role: "narrative",
            title: `Finding ${index + 1}`,
            transition: index === 0 ? "The details, one source at a time." : "",
            sentences: take() ?? connective(),
          });
        }
        sections.push({
          role: "conclusion",
          title: "Conclusion",
          transition: "So, where does that leave the topic?",
          sentences: [
            {
              narration: "Every claim above stays tied to its source.",
              assertion: "context",
              claimRefs: [],
              sourceRefs: [],
              visual: { kind: "text", description: "End card" },
            },
          ],
        });

        return {
          workingTitle: topic.slice(0, 80),
          logline: `What the sources say about ${topic}, with every claim tied to its evidence.`,
          sections,
        };
      }

      default:
        return {};
    }
  };
}

const lowerFirst = (text: string): string =>
  text.length === 0 ? text : text[0]!.toLowerCase() + text.slice(1);
