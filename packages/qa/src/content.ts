import { structureFindings } from "@nexus/script";

import type { QAEvidence, QADeps } from "./evidence.js";
import { checkResult, finding, round2, skippedCheck, type CheckResult } from "./findings.js";
import type { QASettings } from "./schema.js";

/**
 * Content QA: does the video still say only what the evidence supports?
 *
 * The research and script engines already enforce their own contracts when they
 * write their documents. This check exists because the *artifacts that were kept*
 * are what ships: a plan can be edited, a script can be re-planned, a section can
 * be dropped between stages, and nothing so far compares the documents that
 * actually reached the render. So every finding here is a cross-reference:
 *
 * - the script's structure (a hook, an introduction, a body, a conclusion),
 * - a claim that is stated as fact but is not cleared to be stated as fact,
 * - a sentence that asserts a fact with no claim behind it, or a claim with no
 *   evidence behind it,
 * - a claim the research package marks contested, asserted as settled,
 * - the manifest citing a claim the script does not carry — or carrying a
 *   different statement for the same claim id than another scene does.
 *
 * No model is involved: every rule is a comparison of two documents.
 */

export function checkContent(
  evidence: QAEvidence,
  _deps: QADeps,
  _settings: QASettings,
): CheckResult {
  const findings = [];
  let examined = 0;
  const { script, research, manifest } = evidence;

  if (script === undefined) {
    return skippedCheck(
      "content.script",
      "content",
      "no script document was supplied, so the content checks could not run",
      [
        finding(
          "qa_evidence_missing",
          "script",
          "no script document was supplied, so nothing was checked against the plan",
          {},
          "run QA after the script stage, or pass params.scriptHash",
        ),
      ],
    );
  }

  const doc = script.doc;
  const sectionIds = new Set(doc.sections.map((section) => section.id));
  const claimIds = new Set(doc.claims.map((claim) => claim.claimId));
  const researchClaimIds = new Set((research?.doc.claims ?? []).map((claim) => claim.id));
  const researchSourceIds = new Set((research?.doc.sources ?? []).map((source) => source.id));
  const blockingClaims = new Set(research?.doc.verification.blockingClaimIds ?? []);
  const contested = contestedClaimIds(evidence);

  // ── Sections ─────────────────────────────────────────────────────────────
  examined += doc.sections.length;
  for (const issue of structureFindings(doc)) {
    findings.push(
      finding(
        "content_section_missing",
        "script",
        issue.message,
        { detail: issue.detail },
        "write the section",
      ),
    );
  }
  // The plan records which script it was made from. If that is not the script
  // under review, every cross-reference below is between documents that never met.
  if (manifest.scriptHash !== "" && manifest.scriptHash !== script.hash) {
    findings.push(
      finding(
        "content_contradiction",
        "plan",
        `the plan was made from script ${manifest.scriptHash.slice(0, 12)}… but the script under review is ` +
          `${script.hash.slice(0, 12)}…, so the two were never checked against each other`,
        {
          planScriptHash: manifest.scriptHash.slice(0, 12),
          scriptHash: script.hash.slice(0, 12),
        },
        "re-plan the episode from the script under review",
      ),
    );
  }

  const plannedSections = new Set(manifest.scenes.map((scene) => scene.sectionId));
  for (const section of doc.sections) {
    if (!plannedSections.has(section.id)) {
      findings.push(
        finding(
          "content_section_unplanned",
          section.id,
          `section "${section.title}" (${section.role}) has no scene in the plan, so it is never seen`,
          { sectionId: section.id, role: section.role, sentences: section.sentences.length },
          "plan the section, or drop it from the script",
        ),
      );
    }
  }
  for (const scene of manifest.scenes) {
    if (!sectionIds.has(scene.sectionId)) {
      findings.push(
        finding(
          "content_section_missing",
          scene.id,
          `scene ${scene.id} comes from section ${scene.sectionId}, which the script does not have`,
          { sceneId: scene.id, sectionId: scene.sectionId },
          "re-plan the scene from an existing section",
        ),
      );
    }
  }

  // ── Claims: what is asserted, and is it cleared to be asserted ───────────
  examined += doc.claims.length;
  for (const claim of doc.claims) {
    if (claim.sentenceIds.length === 0) {
      findings.push(
        finding(
          "content_claim_unreferenced",
          claim.claimId,
          `claim ${claim.claimId} is carried by the script but no sentence uses it`,
          { claimId: claim.claimId, status: claim.status },
        ),
      );
    }
    if (claim.usage === "fact" && !claim.mayStateAsFact) {
      findings.push(
        finding(
          "content_claim_unsupported",
          claim.claimId,
          `claim ${claim.claimId} is stated as fact but the evidence does not clear it ` +
            `(status ${claim.status}, certainty ${claim.certainty}, confidence ${round2(claim.confidence)})`,
          {
            claimId: claim.claimId,
            status: claim.status,
            certainty: claim.certainty,
            confidence: round2(claim.confidence),
          },
          "attribute it to a named source, or cut it",
        ),
      );
    }
    if (research !== undefined && !researchClaimIds.has(claim.claimId)) {
      findings.push(
        finding(
          "content_claim_unsupported",
          claim.claimId,
          `claim ${claim.claimId} is not in the research package the script was written from`,
          { claimId: claim.claimId, researchHash: research.hash.slice(0, 12) },
          "re-run the script stage against the current research package",
        ),
      );
    }
    if (blockingClaims.has(claim.claimId) && claim.usage === "fact") {
      findings.push(
        finding(
          "content_claim_unsupported",
          claim.claimId,
          `the research package marks claim ${claim.claimId} as needing human resolution, but the script states it as fact`,
          { claimId: claim.claimId },
          "resolve the claim in the fact-review gate",
        ),
      );
    }
  }

  for (const section of doc.sections) {
    for (const sentence of section.sentences) {
      examined += 1;
      if (sentence.assertion === "fact" && sentence.claimRefs.length === 0) {
        findings.push(
          finding(
            "content_claim_unsupported",
            sentence.id,
            `sentence ${sentence.id} asserts a fact with no claim behind it`,
            { sentenceId: sentence.id, sectionId: section.id },
            "mark it as context, or link the claim it rests on",
          ),
        );
      }
      for (const claimRef of sentence.claimRefs) {
        if (!claimIds.has(claimRef)) {
          findings.push(
            finding(
              "content_claim_unsupported",
              sentence.id,
              `sentence ${sentence.id} cites claim ${claimRef}, which the script does not carry`,
              { sentenceId: sentence.id, claimId: claimRef },
            ),
          );
        }
      }
    }
  }

  // ── Sources: is there anything behind the claims ─────────────────────────
  examined += doc.claims.length;
  for (const claim of doc.claims) {
    if (claim.evidence.length === 0) {
      findings.push(
        finding(
          "content_source_missing",
          claim.claimId,
          `claim ${claim.claimId} carries no source evidence, so nothing can be checked against it`,
          { claimId: claim.claimId, statement: claim.statement.slice(0, 80) },
          "re-run the script stage, or evidence the claim in the research package",
        ),
      );
    }
  }
  for (const section of doc.sections) {
    for (const sentence of section.sentences) {
      if (sentence.assertion !== "attributed") continue;
      examined += 1;
      if (sentence.sourceRefs.length === 0) {
        findings.push(
          finding(
            "content_source_missing",
            sentence.id,
            `sentence ${sentence.id} attributes a statement but names no source`,
            { sentenceId: sentence.id, sectionId: section.id },
            "name the source in the script",
          ),
        );
      }
      for (const sourceRef of sentence.sourceRefs) {
        if (research !== undefined && !researchSourceIds.has(sourceRef)) {
          findings.push(
            finding(
              "content_source_missing",
              sentence.id,
              `sentence ${sentence.id} attributes source ${sourceRef}, which the research package does not have`,
              { sentenceId: sentence.id, sourceId: sourceRef },
            ),
          );
        }
      }
    }
  }

  // ── Contradictions: disagreement preserved upstream must not ship as fact ─
  examined += manifest.scenes.length;
  for (const scene of manifest.scenes) {
    for (const claim of scene.sources) {
      examined += 1;
      if (claim.usage === "fact" && contested.has(claim.claimId)) {
        findings.push(
          finding(
            "content_contradiction",
            scene.id,
            `scene ${scene.id} states claim ${claim.claimId} as fact while the research package keeps it contested`,
            { sceneId: scene.id, claimId: claim.claimId, status: claim.status },
            "attribute it, or show the disagreement",
          ),
        );
      }
      if (claim.usage === "fact" && claim.status !== "supported" && claim.status !== "overridden") {
        findings.push(
          finding(
            "content_contradiction",
            scene.id,
            `scene ${scene.id} shows claim ${claim.claimId} as fact, but its status is ${claim.status}`,
            { sceneId: scene.id, claimId: claim.claimId, status: claim.status },
          ),
        );
      }
      const scriptClaim = doc.claims.find((entry) => entry.claimId === claim.claimId);
      if (scriptClaim !== undefined && scriptClaim.statement !== claim.statement) {
        findings.push(
          finding(
            "content_contradiction",
            scene.id,
            `scene ${scene.id} shows claim ${claim.claimId} with different wording than the script carries`,
            { sceneId: scene.id, claimId: claim.claimId },
            "re-plan the scene from the approved script",
          ),
        );
      }
    }
    if (scene.sources.length > 0 && scene.sources.every((claim) => claim.evidence.length === 0)) {
      findings.push(
        finding(
          "content_source_missing",
          scene.id,
          `scene ${scene.id} shows ${scene.sources.length} claim(s) with no evidence text behind them`,
          { sceneId: scene.id, claims: scene.sources.length },
        ),
      );
    }
  }

  // ── What the script's own lint said, that nobody fixed ───────────────────
  for (const issue of doc.quality.issues) {
    if (issue.resolvedByRepair) continue;
    examined += 1;
    findings.push(
      finding(
        "content_quality_issue",
        issue.sentenceId !== "" ? issue.sentenceId : issue.sectionId,
        `the script's ${issue.severity} issue ${issue.code} is still open: ${issue.message}`,
        { code: issue.code, severity: issue.severity, detail: issue.detail.slice(0, 200) },
      ),
    );
  }

  const note =
    doc.quality.issues.length > 0
      ? `${doc.quality.issues.length} script issue(s) recorded, ${doc.quality.issues.filter((issue) => issue.resolvedByRepair).length} fixed by repair`
      : "";

  return checkResult("content.script", "content", examined, findings, note);
}

/** Claim ids the research package itself says are disagreed about. */
function contestedClaimIds(evidence: QAEvidence): Set<string> {
  const ids = new Set<string>();
  const research = evidence.research;
  if (research === undefined) return ids;
  for (const conflict of research.doc.conflicts) {
    for (const side of conflict.sides) {
      // A side points at a claim id (or at a source, which names no claim).
      const claimId = side.claimId ?? (side.kind === "claim" ? side.id : undefined);
      if (claimId !== undefined) ids.add(claimId);
    }
  }
  for (const claim of research.doc.claims) {
    if (claim.contested || claim.status === "contradicted" || claim.certainty === "disputed") {
      ids.add(claim.id);
    }
  }
  return ids;
}
