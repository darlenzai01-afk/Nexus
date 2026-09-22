import type { EpisodeRow } from "@nexus/db";
import type { JobStatusView, StageStatusView } from "@nexus/jobs";
import type { QAReport } from "@nexus/qa";
import type { ResearchPackage } from "@nexus/research";
import type { SceneManifest } from "@nexus/scenes";
import type { ScriptDoc } from "@nexus/script";

/**
 * The dashboard's HTML: server-rendered templates, no client framework.
 *
 * Every page is a pure function from already-loaded documents to a string, so
 * a page either renders from real data or says what is missing — there is no
 * client-side fetch layer to fail, and every inspection page also embeds the
 * raw document (`<details>`) so nothing the tables omit is unreachable.
 * The styling is structural on purpose: readable, responsive, plain.
 */

// ── primitives ──────────────────────────────────────────────────────────────

export function esc(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function shortHash(hash: string | null | undefined): string {
  return hash === null || hash === undefined || hash === "" ? "—" : hash.slice(0, 12) + "…";
}

function when(iso: string | null | undefined): string {
  if (iso === null || iso === undefined || iso === "") return "—";
  return iso.replace("T", " ").slice(0, 19);
}

function jsonBlock(document_: unknown): string {
  return `<details class="raw"><summary>Raw document (JSON)</summary><pre>${esc(
    JSON.stringify(document_, null, 2),
  )}</pre></details>`;
}

function attr(value: unknown): string {
  return esc(value);
}

const CSS = `
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; line-height: 1.45;
  background: #f6f7f9; color: #182030; }
a { color: #0b5cad; }
main { max-width: 1100px; margin: 0 auto; padding: 0 1rem 4rem; }
header.top { background: #10233f; color: #fff; padding: .6rem 1rem; }
header.top .inner { max-width: 1100px; margin: 0 auto; display: flex; gap: 1rem; align-items: baseline; flex-wrap: wrap; }
header.top a { color: #fff; text-decoration: none; font-weight: 600; }
header.top .role { font-size: .8rem; opacity: .75; font-weight: 400; }
h1 { font-size: 1.35rem; margin: 1.2rem 0 .4rem; }
h2 { font-size: 1.05rem; margin: 1.6rem 0 .4rem; }
nav.episode { display: flex; gap: .35rem; flex-wrap: wrap; margin: .8rem 0 1rem; }
nav.episode a { padding: .28rem .7rem; border: 1px solid #c6ccd6; border-radius: 6px; background: #fff;
  text-decoration: none; font-size: .88rem; }
nav.episode a.here { background: #10233f; color: #fff; border-color: #10233f; }
nav.episode a.off { opacity: .45; pointer-events: none; }
.badge { display: inline-block; padding: .1rem .55rem; border-radius: 999px; font-size: .78rem;
  font-weight: 600; background: #e3e7ee; color: #2a3548; white-space: nowrap; }
.badge.run { background: #d7e8ff; color: #0b4c8f; }
.badge.wait { background: #fff0c2; color: #7a5b00; }
.badge.ok { background: #d3f0dc; color: #14572d; }
.badge.bad { background: #ffd9d4; color: #8c1d11; }
.badge.off { background: #e8e8ec; color: #5b5f6b; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem; background: #fff; }
th, td { border: 1px solid #d9dee6; padding: .38rem .55rem; font-size: .88rem; text-align: left;
  vertical-align: top; }
th { background: #eef1f5; }
tr.err td { background: #fff3f1; }
tr.muted { color: #667; }
pre { background: #10151f; color: #dce3ee; padding: .8rem; overflow-x: auto; border-radius: 6px;
  font-size: .8rem; max-height: 32rem; }
code { background: #e8ebf0; padding: 0 .3rem; border-radius: 4px; font-size: .85em; }
form.panel, .panel { background: #fff; border: 1px solid #d9dee6; border-radius: 8px;
  padding: .9rem 1rem; margin: .8rem 0; }
label { display: block; font-size: .85rem; font-weight: 600; margin: .5rem 0 .15rem; }
input[type=text], textarea, select { width: 100%; padding: .42rem .5rem; border: 1px solid #c3cad4;
  border-radius: 6px; font: inherit; background: #fff; color: inherit; }
textarea { min-height: 4.5rem; }
button { font: inherit; font-weight: 600; padding: .42rem .95rem; border-radius: 6px; border: 1px solid #10233f;
  background: #10233f; color: #fff; cursor: pointer; margin-top: .6rem; }
button.secondary { background: #fff; color: #10233f; }
button.approve { background: #14713a; border-color: #14713a; }
button.reject { background: #a4270f; border-color: #a4270f; }
.row { display: flex; gap: .8rem; flex-wrap: wrap; }
.row > * { flex: 1 1 240px; }
.flash { padding: .55rem .8rem; border-radius: 6px; margin: .8rem 0; font-size: .9rem; }
.flash.error { background: #ffe4de; border: 1px solid #e3a08f; color: #7c1d0c; word-break: break-word; }
.flash.ok { background: #e2f4e8; border: 1px solid #9fd3ae; color: #14572d; }
.meta { color: #5b6270; font-size: .82rem; }
.actions { display: flex; gap: .6rem; flex-wrap: wrap; align-items: flex-end; }
.actions form { margin: 0; }
.actions button { margin-top: 0; }
details.raw { margin: .6rem 0; }
details.raw summary { cursor: pointer; font-size: .85rem; color: #0b5cad; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: .8rem; margin: .8rem 0; }
.card { background: #fff; border: 1px solid #d9dee6; border-radius: 8px; padding: .7rem .9rem; }
.card h3 { margin: .1rem 0 .3rem; font-size: .92rem; }
.finding.err { border-left: 4px solid #a4270f; }
.finding.warn { border-left: 4px solid #c98a00; }
.finding.info { border-left: 4px solid #5b6270; }
@media (max-width: 720px) {
  main { padding: 0 .6rem 3rem; }
  table { display: block; overflow-x: auto; }
  h1 { font-size: 1.15rem; }
}`;

export function layout(options: {
  readonly title: string;
  readonly body: string;
  readonly autoRefreshSec?: number;
}): string {
  const refresh =
    options.autoRefreshSec !== undefined
      ? `<meta http-equiv="refresh" content="${options.autoRefreshSec}">`
      : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh}<title>${esc(options.title)} · Nexus Forge</title>
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="inner">
<a href="/">Nexus Forge</a><span class="role">episode dashboard</span>
</div></header>
<main>
${options.body}
</main>
</body>
</html>`;
}

function flash(params: { readonly error?: string; readonly notice?: string }): string {
  const error =
    params.error === undefined || params.error === ""
      ? ""
      : `<div class="flash error" role="alert"><strong>Failed:</strong> ${esc(params.error)}</div>`;
  const notice =
    params.notice === undefined || params.notice === ""
      ? ""
      : `<div class="flash ok">${esc(params.notice)}</div>`;
  return error + notice;
}

function stateBadge(state: string): string {
  const s = state.toUpperCase();
  if (["DONE", "READY", "PUBLISHED", "APPROVED"].includes(s))
    return `<span class="badge ok">${attr(s)}</span>`;
  if (["FAILED", "CANCELED", "NEEDS_CHANGES"].includes(s))
    return `<span class="badge bad">${attr(s)}</span>`;
  if (["WAITING_GATE", "WAITING"].includes(s)) return `<span class="badge wait">${attr(s)}</span>`;
  if (["RUNNING", "RETRYING", "PUBLISHING"].includes(s))
    return `<span class="badge run">${attr(s)}</span>`;
  if (["QUEUED", "PENDING"].includes(s)) return `<span class="badge run">${attr(s)}</span>`;
  return `<span class="badge">${attr(s)}</span>`;
}

/** The stage statuses that are worth a row colour. */
function stageRowClass(step: StageStatusView): string {
  if (step.state === "FAILED") return ' class="err"';
  if (step.state === "DONE") return "";
  return ' class="muted"';
}

export function episodeNav(
  episodeId: string,
  here: string,
  enabled: Record<string, boolean>,
): string {
  const links: readonly [string, string][] = [
    ["", "Overview"],
    ["research", "Research"],
    ["sources", "Sources"],
    ["script", "Script"],
    ["scenes", "Scenes"],
    ["artifacts", "Artifacts"],
    ["qa", "QA"],
  ];
  return `<nav class="episode">${links
    .map(([suffix, label]) => {
      const href = `/episodes/${attr(episodeId)}${suffix === "" ? "" : `/${suffix}`}`;
      const cls = here === suffix ? "here" : enabled[suffix] === false ? "off" : "";
      return `<a href="${href}"${cls === "" ? "" : ` class="${cls}"`}>${label}</a>`;
    })
    .join("")}</nav>`;
}

// ── home ────────────────────────────────────────────────────────────────────

export interface HomeEpisode {
  readonly episode: EpisodeRow;
  readonly job: JobStatusView | undefined;
}

export function homePage(params: {
  readonly episodes: readonly HomeEpisode[];
  readonly projects: readonly {
    readonly id: string;
    readonly name: string;
    readonly slug: string;
  }[];
  readonly flashes: { readonly error?: string; readonly notice?: string };
}): string {
  const rows = params.episodes
    .map(({ episode, job }) => {
      const status =
        job === undefined ? `<span class="badge off">NOT STARTED</span>` : stateBadge(job.status);
      const stage =
        job === undefined
          ? "—"
          : job.currentStage === null
            ? "—"
            : `${attr(job.currentStage.label)} · ${attr(job.currentStage.stateLabel)}`;
      const gate =
        job !== null && job !== undefined && job.waitingGate !== null
          ? `<div class="meta">gate: ${attr(job.waitingGate)}</div>`
          : "";
      const err =
        job !== null && job !== undefined && job.error !== null
          ? `<div class="meta">⚠ ${esc(job.error.slice(0, 220))}</div>`
          : episode.error !== null
            ? `<div class="meta">⚠ ${esc(episode.error.slice(0, 220))}</div>`
            : "";
      return `<tr>
  <td><a href="/episodes/${attr(episode.id)}">${esc(episode.topic)}</a></td>
  <td>${attr(episode.kind)}</td>
  <td>${status}<div class="meta">${stage}</div>${gate}${err}</td>
  <td>${when(episode.updated_at)}</td>
</tr>`;
    })
    .join("");

  const projectOptions = params.projects
    .map((project) => `<option value="${attr(project.id)}">${esc(project.name)}</option>`)
    .join("");

  return layout({
    title: "Episodes",
    body: `
<h1>Episodes</h1>
${flash(params.flashes)}
<form class="panel" method="post" action="/episodes">
  <h2>New episode</h2>
  <div class="row">
    <div>
      <label for="topic">Topic</label>
      <input type="text" id="topic" name="topic" required maxlength="300" placeholder="What the episode investigates">
    </div>
    <div>
      <label for="project">Project</label>
      <select id="project" name="projectId">${projectOptions || '<option value="">(a project is created automatically)</option>'}</select>
    </div>
  </div>
  <label for="outline">Outline (one point per line, optional)</label>
  <textarea id="outline" name="outline" placeholder="Point 1&#10;Point 2"></textarea>
  <button type="submit">Create episode</button>
</form>
<details class="panel">
  <summary><strong>New project</strong></summary>
  <form method="post" action="/projects">
    <div class="row">
      <div><label for="name">Name</label><input type="text" id="name" name="name" required maxlength="120"></div>
      <div><label for="slug">Slug (lowercase-with-dashes)</label><input type="text" id="slug" name="slug" required pattern="[a-z0-9][a-z0-9-]*" maxlength="60"></div>
    </div>
    <button type="submit" class="secondary">Create project</button>
  </form>
</details>
<h2>All episodes</h2>
${
  params.episodes.length === 0
    ? `<p class="meta">No episodes yet — create one above, then start its pipeline from the episode page.</p>`
    : `<table><tr><th>Topic</th><th>Kind</th><th>Job state</th><th>Updated</th></tr>${rows}</table>`
}
`,
  });
}

// ── episode overview ────────────────────────────────────────────────────────

export function episodePage(params: {
  readonly episode: EpisodeRow;
  readonly job: JobStatusView | undefined;
  readonly project: { readonly name: string } | undefined;
  readonly artifactPages: Record<string, boolean>;
  readonly flashes: { readonly error?: string; readonly notice?: string };
  readonly qaVerdict: string | null;
}): string {
  const { episode, job } = params;
  const active = job !== undefined && ["PENDING", "RUNNING", "RETRYING"].includes(job.status);
  const atGate = job !== undefined && job.state === "WAITING_GATE" && job.waitingGate !== null;
  const failed = job !== undefined && job.state === "FAILED";
  const parkedStep = job?.steps.find((step) => step.state === "WAITING");
  const notStarted = job === undefined;

  const stageRows = (job?.steps ?? [])
    .map(
      (step) => `<tr${stageRowClass(step)}>
  <td>${attr(step.label)}<div class="meta">${attr(step.key)}</div></td>
  <td>${stateBadge(step.stateLabel)}</td>
  <td>${step.attempt}</td>
  <td>${when(step.startedAt)}</td>
  <td>${when(step.finishedAt)}</td>
  <td>${step.artifacts.length > 0 ? step.artifacts.map((a) => `<div><code>${shortHash(a.hash)}</code> ${attr(a.kind)}</div>`).join("") : "—"}</td>
  <td>${step.error === null ? "—" : esc(step.error.slice(0, 300))}</td>
</tr>`,
    )
    .join("");

  const logRows = (job?.logs ?? [])
    .slice(0, 60)
    .map(
      (
        entry,
      ) => `<tr${entry.level === "error" ? ' class="err"' : entry.level === "warn" ? ' class="muted"' : ""}>
  <td>${when(entry.created_at)}</td>
  <td>${attr(entry.step_key ?? "")}</td>
  <td>${attr(entry.event)}</td>
  <td>${esc(entry.message ?? "")}</td>
</tr>`,
    )
    .join("");

  const stageOptions = (job?.steps ?? [])
    .map((step) => `<option value="${attr(step.key)}">${esc(step.label)}</option>`)
    .join("");

  const startForm =
    notStarted || job?.state === "CANCELED"
      ? `<form method="post" action="/episodes/${attr(episode.id)}/start">
      <button type="submit">${notStarted ? "Start pipeline" : "Start a new run"}</button>
      <span class="meta"> runs ${attr(episode.kind === "long" ? "longform_v1" : "shorts_v1")} — research → script → plan → media → voice → captions → render → QA → your approval (publishing is not built yet)</span>
    </form>`
      : "";

  const gatePanel =
    atGate && job !== undefined
      ? `<div class="panel">
  <h2 style="margin-top:0">Decision needed: ${attr(job.waitingGate ?? "")}</h2>
  <p class="meta">Parked at stage <code>${attr(parkedStep?.key ?? "")}</code> · content fingerprint <code>${shortHash(parkedStep?.fingerprint ?? "")}</code>. Approving binds the decision to this exact content.</p>
  <div class="actions">
    <form method="post" action="/jobs/${attr(job.id)}/approve">
      <button type="submit" class="approve">Approve &amp; continue</button>
    </form>
    <form method="post" action="/jobs/${attr(job.id)}/changes" class="row">
      <div>
        <label for="target">Request changes — rewind to</label>
        <select id="target" name="targetStage">${stageOptions}</select>
      </div>
      <div>
        <label for="changes-notes">Notes (optional)</label>
        <input type="text" id="changes-notes" name="notes" maxlength="400">
      </div>
      <button type="submit" class="secondary">Rewind &amp; re-run</button>
    </form>
    <form method="post" action="/jobs/${attr(job.id)}/reject">
      <input type="hidden" name="notes" value="rejected from the dashboard">
      <button type="submit" class="reject">Reject — cancel episode</button>
    </form>
  </div>
</div>`
      : "";

  const retryPanel =
    failed && job !== undefined
      ? `<div class="panel">
  <h2 style="margin-top:0">Run failed</h2>
  <p><strong>${esc(job.error ?? "unknown error")}</strong></p>
  <p class="meta">Failed stage: <code>${attr(job.failureStep ?? "")}</code> · kind: ${attr(job.errorKind ?? "")} · attempt ${job.attempt}/${job.maxAttempts}. A retry re-enters the pipeline at the failed stage; completed stages are reused unchanged.</p>
  <form method="post" action="/jobs/${attr(job.id)}/retry"><button type="submit">Retry failed stage</button></form>
</div>`
      : "";

  const stageTable =
    job === undefined
      ? ""
      : `<h2>Stages</h2><table>
<tr><th>Stage</th><th>State</th><th>Try</th><th>Started</th><th>Finished</th><th>Artifacts</th><th>Error</th></tr>
${stageRows}
</table>`;

  const logTable =
    job === undefined
      ? ""
      : `<h2>Job log (latest)</h2><table>
<tr><th>At</th><th>Stage</th><th>Event</th><th>Message</th></tr>
${logRows}
</table>`;

  const qaLine =
    params.qaVerdict !== null
      ? `<p>Latest QA verdict: <strong>${attr(params.qaVerdict)}</strong> — <a href="/episodes/${attr(episode.id)}/qa">full report</a></p>`
      : "";

  return layout({
    title: episode.topic,
    ...(active ? { autoRefreshSec: 3 } : {}),
    body: `
${episodeNav(episode.id, "", params.artifactPages)}
<h1>${esc(episode.topic)} ${stateBadge(episode.state)}</h1>
<p class="meta">Project: ${esc(params.project?.name ?? "—")} · kind ${attr(episode.kind)} · created ${when(episode.created_at)} · updated ${when(episode.updated_at)}${
      job === undefined ? "" : ` · job <code>${shortHash(job.id)}</code> (${attr(job.pipeline)})`
    }</p>
${episode.error !== null ? `<div class="flash error">${esc(episode.error)}</div>` : ""}
${flash(params.flashes)}
${gatePanel}
${retryPanel}
${startForm}
${qaLine}
${stageTable}
${logTable}
${jsonBlock({ episode, job })}
`,
  });
}

// ── research ────────────────────────────────────────────────────────────────

export function researchPage(
  episode: EpisodeRow,
  pkg: ResearchPackage,
  has: Record<string, boolean>,
  packageHash: string,
): string {
  const questions = pkg.questions.map((question) => `<li>${esc(question.question)}</li>`).join("");
  const sources = pkg.sources
    .map(
      (source) => `<tr>
  <td>${esc(source.title === "" ? source.url : source.title)}<div class="meta">${attr(source.publisher)}</div></td>
  <td><a href="${attr(source.url)}" rel="noreferrer">${esc(source.url.slice(0, 80))}${source.url.length > 80 ? "…" : ""}</a></td>
  <td>${pkg.evidence.filter((evidence) => evidence.sourceId === source.id).length}</td>
</tr>`,
    )
    .join("");
  const evidence = pkg.evidence
    .map(
      (item) => `<tr>
  <td><code>${shortHash(item.sourceId)}</code></td>
  <td>“${esc(item.excerpt)}”</td>
  <td class="meta">chars ${item.locator.start}–${item.locator.end}</td>
</tr>`,
    )
    .join("");
  const claims = pkg.claims
    .map(
      (claim) => `<tr>
  <td>${esc(claim.statement)}</td>
  <td>${attr(claim.status)} / ${attr(claim.certainty)}</td>
  <td>${claim.links.map((link) => `<code>${shortHash(link.sourceId)}</code> (${attr(link.stance)})`).join(" ")}</td>
  <td>${attr(claim.links.filter((link) => link.stance === "supports").length)}</td>
</tr>`,
    )
    .join("");
  const conflicts = pkg.conflicts
    .map((conflict) => `<tr><td>${esc(JSON.stringify(conflict))}</td></tr>`)
    .join("");

  return layout({
    title: `Research · ${episode.topic}`,
    body: `
${episodeNav(episode.id, "research", has)}
<h1>Research</h1>
<p class="meta">Package <code>${shortHash(packageHash)}</code> · topic “${esc(pkg.topic)}”</p>
<div class="cards">
  <div class="card"><h3>Verification</h3>
    ${stateBadge(pkg.verification.reviewRequired ? "REVIEW_REQUIRED" : "CLEAR")}
    <div class="meta">${pkg.verification.established} established · ${pkg.verification.contested} contested · ${pkg.verification.blockingClaimIds.length} blocking</div>
  </div>
  <div class="card"><h3>Counts</h3><div class="meta">${pkg.sources.length} sources · ${pkg.evidence.length} evidence · ${pkg.claims.length} claims · ${pkg.conflicts.length} conflicts</div></div>
</div>
<h2>Questions</h2><ul>${questions || "<li class='meta'>—</li>"}</ul>
<h2>Sources</h2>
${sources === "" ? `<p class="meta">The package has no sources.</p>` : `<table><tr><th>Source</th><th>URL</th><th>Evidence</th></tr>${sources}</table>`}
<h2>Evidence (verbatim)</h2>
${evidence === "" ? `<p class="meta">No evidence passages.</p>` : `<table><tr><th>Source</th><th>Excerpt</th><th>Locator</th></tr>${evidence}</table>`}
<h2>Claims</h2>
${claims === "" ? `<p class="meta">No claims.</p>` : `<table><tr><th>Statement</th><th>Status / certainty</th><th>Source links</th><th>Supporting links</th></tr>${claims}</table>`}
${conflicts === "" ? "" : `<h2>Conflicts (preserved, not resolved)</h2><table><tr><th>Detail</th></tr>${conflicts}</table>`}
${jsonBlock(pkg)}
`,
  });
}

export function sourcesPage(
  episode: EpisodeRow,
  pkg: ResearchPackage,
  has: Record<string, boolean>,
): string {
  const rows = pkg.sources
    .map((source) => {
      const items = pkg.evidence.filter((evidence) => evidence.sourceId === source.id);
      return `<tr>
  <td>${esc(source.title === "" ? "(untitled)" : source.title)}<div class="meta">${attr(source.publisher)}</div></td>
  <td><a href="${attr(source.url)}" rel="noreferrer">${esc(source.url)}</a></td>
  <td>${attr(source.id)}</td>
  <td>${items.length}</td>
  <td>${items
    .slice(0, 3)
    .map(
      (item) =>
        `<div>“${esc(item.excerpt.slice(0, 160))}${item.excerpt.length > 160 ? "…" : ""}”</div>`,
    )
    .join("")}</td>
</tr>`;
    })
    .join("");
  return layout({
    title: `Sources · ${episode.topic}`,
    body: `
${episodeNav(episode.id, "sources", has)}
<h1>Sources</h1>
<p class="meta">Every source the research package used, with the verbatim passages behind it. Nothing here was invented: a source enters only through the provider search (URL-validated) or operator paste.</p>
${rows === "" ? `<p class="meta">The research package has no sources yet — start the pipeline first.</p>` : `<table><tr><th>Title</th><th>URL</th><th>Id</th><th>Evidence</th><th>First excerpts</th></tr>${rows}</table>`}
${jsonBlock(pkg.sources)}
`,
  });
}

// ── script ──────────────────────────────────────────────────────────────────

export function scriptPage(
  episode: EpisodeRow,
  doc: ScriptDoc,
  has: Record<string, boolean>,
): string {
  const sections = doc.sections
    .map((section) => {
      const sentences = section.sentences
        .map(
          (sentence) =>
            `<li>[${attr(sentence.assertion)}] ${esc(sentence.narration)} ${sentence.claimRefs
              .map((id) => `<code>${shortHash(id)}</code>`)
              .join(
                " ",
              )}${sentence.sourceRefs.length > 0 ? ` <span class="meta">sources: ${sentence.sourceRefs.map((id) => `<code>${shortHash(id)}</code>`).join(" ")}</span>` : ""}</li>`,
        )
        .join("");
      const transition =
        section.transition === ""
          ? ""
          : `<div class="meta">↳ spoken transition: ${esc(section.transition)}</div>`;
      return `<div class="panel"><h3 style="margin-top:0">${esc(section.title)} <span class="badge">${attr(section.role)}</span></h3>
      <ol>${sentences}</ol>${transition}</div>`;
    })
    .join("");
  const claims = doc.claims
    .map(
      (claim) => `<tr>
  <td><code>${shortHash(claim.claimId)}</code></td>
  <td>${esc(claim.statement)}</td>
  <td>${attr(claim.status)} / ${attr(claim.certainty)}</td>
  <td>${claim.mayStateAsFact ? "fact" : attr(claim.usage)}</td>
  <td>${claim.evidence.map((item) => `<div>“${esc(item.excerpt.slice(0, 120))}”</div>`).join("")}</td>
  <td>${claim.sentenceIds.map((id) => `<code>${shortHash(id)}</code>`).join(" ")}</td>
</tr>`,
    )
    .join("");
  const issues = doc.quality.issues
    .map(
      (issue) => `<tr${issue.resolvedByRepair === true ? ' class="muted"' : ' class="err"'}>
  <td>${attr(issue.code)}</td>
  <td>${attr(issue.severity)}</td>
  <td>${esc(issue.message)}</td>
  <td><code>${esc(issue.sectionId ?? "")}</code></td>
  <td>${issue.resolvedByRepair === true ? "fixed by the repair round" : "open"}</td>
</tr>`,
    )
    .join("");

  return layout({
    title: `Script · ${episode.topic}`,
    body: `
${episodeNav(episode.id, "script", has)}
<h1>Script</h1>
<p><strong>${esc(doc.workingTitle)}</strong> — ${esc(doc.logline)}</p>
${sections}
<h2>Claim ledger</h2>
${claims === "" ? `<p class="meta">No claims.</p>` : `<table><tr><th>Id</th><th>Statement</th><th>Status</th><th>Used as</th><th>Evidence</th><th>Sentences</th></tr>${claims}</table>`}
<h2>Writing lint</h2>
${issues === "" ? `<p class="meta">No lint issues recorded.</p>` : `<table><tr><th>Code</th><th>Severity</th><th>Message</th><th>Section</th><th>Status</th></tr>${issues}</table>`}
${jsonBlock(doc)}
`,
  });
}

// ── scenes ──────────────────────────────────────────────────────────────────

export function scenesPage(
  episode: EpisodeRow,
  manifest: SceneManifest,
  has: Record<string, boolean>,
): string {
  const scenes = manifest.scenes
    .map(
      (scene) => `<tr>
  <td><code>${shortHash(scene.id)}</code></td>
  <td>${attr(scene.type)}</td>
  <td>${attr(scene.role ?? "")}</td>
  <td>${scene.startSec.toFixed(1)}s – ${(scene.startSec + scene.durationSec).toFixed(1)}s</td>
  <td>${esc(scene.narration.text.slice(0, 120))}${scene.narration.text.length > 120 ? "…" : ""}</td>
  <td>${attr(scene.camera.shot)} / ${attr(scene.camera.movement)}</td>
  <td>${(scene.media?.assets ?? []).length > 0 ? (scene.media?.assets ?? []).map((id) => `<code>${shortHash(id)}</code>`).join(" ") : "—"}</td>
</tr>`,
    )
    .join("");
  const assets = manifest.assets
    .map(
      (asset) => `<tr>
  <td><code>${shortHash(asset.id)}</code></td>
  <td>${attr(asset.sceneId)}</td>
  <td>${stateBadge(asset.status === "resolved" ? "DONE" : asset.status === "planned" ? "PENDING" : "FAILED")}</td>
  <td>${esc(asset.uri === "" ? "(none)" : asset.uri)}</td>
  <td>${attr(asset.licence)}</td>
  <td>${esc(asset.searchHint === "" ? "—" : asset.searchHint)}</td>
</tr>`,
    )
    .join("");
  return layout({
    title: `Scenes · ${episode.topic}`,
    body: `
${episodeNav(episode.id, "scenes", has)}
<h1>Scenes</h1>
<p class="meta">“${esc(manifest.workingTitle)}” · ${manifest.scenes.length} scenes · ${manifest.totalDurationSec.toFixed(1)}s total · ${manifest.resolution.width}×${manifest.resolution.height} @ ${manifest.fps}fps</p>
<table><tr><th>Scene</th><th>Type</th><th>Role</th><th>Window</th><th>Narration</th><th>Camera</th><th>Media</th></tr>${scenes}</table>
<h2>Assets</h2>
<table><tr><th>Asset</th><th>Scene</th><th>Status</th><th>URI</th><th>Licence</th><th>Search hint</th></tr>${assets}</table>
${jsonBlock(manifest)}
`,
  });
}

// ── artifacts ───────────────────────────────────────────────────────────────

/** The content type raw artifact bytes are served with (see GET /artifacts/:hash). */
export const ARTIFACT_CONTENT_TYPES: Readonly<Record<string, string>> = {
  script: "application/json",
  scene_graph: "application/json",
  document: "application/json",
  qa_report: "application/json",
  metadata: "application/json",
  captions: "application/json",
  audio: "audio/wav",
  video: "video/mp4",
  thumbnail: "image/jpeg",
  image: "image/png",
  other: "application/octet-stream",
};

export function contentTypeOf(kind: string): string {
  return ARTIFACT_CONTENT_TYPES[kind] ?? "application/octet-stream";
}

export interface ArtifactRowView {
  readonly stage: string;
  readonly role: string;
  readonly kind: string;
  readonly hash: string;
  readonly missing: boolean;
}

export function artifactsPage(
  episode: EpisodeRow,
  items: readonly ArtifactRowView[],
  has: Record<string, boolean>,
  videoHash: string | null,
  thumbnailHash: string | null,
): string {
  const rows = items
    .map(
      (item) => `<tr${item.missing ? ' class="err"' : ""}>
  <td>${attr(item.stage)}</td>
  <td>${attr(item.role)}</td>
  <td>${attr(item.kind)}</td>
  <td><code>${shortHash(item.hash)}</code></td>
  <td>${attr(contentTypeOf(item.kind))}</td>
  <td>
    <a href="/artifacts/${attr(item.hash)}">view</a> ·
    <a href="/artifacts/${attr(item.hash)}?download=1">download</a>
    ${item.missing ? '<div class="meta">bytes are gone from the store</div>' : ""}
  </td>
</tr>`,
    )
    .join("");
  const video =
    videoHash === null
      ? ""
      : `<h2>Video</h2><video controls muted preload="metadata" style="max-width:100%" src="/artifacts/${attr(videoHash)}"></video>`;
  const thumbnail =
    thumbnailHash === null
      ? ""
      : `<h2>Thumbnail</h2><img alt="episode thumbnail" style="max-width:100%" src="/artifacts/${attr(thumbnailHash)}">`;
  return layout({
    title: `Artifacts · ${episode.topic}`,
    body: `
${episodeNav(episode.id, "artifacts", has)}
<h1>Artifacts</h1>
<p class="meta">Every artifact the pipeline registered for the latest run. Bytes live in the content-addressed store; the hash is the address.</p>
${rows === "" ? `<p class="meta">No artifacts yet — start the pipeline first.</p>` : `<table><tr><th>Stage</th><th>Role</th><th>Kind</th><th>Hash</th><th>Served as</th><th>Bytes</th></tr>${rows}</table>`}
${video}
${thumbnail}
`,
  });
}

// ── qa ──────────────────────────────────────────────────────────────────────

export function qaPage(
  episode: EpisodeRow,
  report: QAReport,
  has: Record<string, boolean>,
): string {
  const verdictBadge = stateBadge(
    report.verdict === "fail" ? "FAILED" : report.verdict === "pass" ? "DONE" : "WAITING",
  );
  const checks = report.checks
    .map(
      (check) => `<tr>
  <td>${attr(check.id)}</td>
  <td>${stateBadge(check.status === "ok" ? "DONE" : check.status === "skipped" ? "CANCELED" : "RUNNING")}</td>
  <td>${check.examined}</td>
  <td>${esc(check.note)}</td>
</tr>`,
    )
    .join("");
  const findings = report.findings
    .map(
      (finding) => `<tr class="${finding.severity === "error" ? "err" : ""}">
  <td>${stateBadge(finding.severity === "error" ? "FAILED" : finding.severity === "warning" ? "WAITING" : "PENDING")}</td>
  <td>${attr(finding.code)}</td>
  <td><code>${esc(finding.subject)}</code></td>
  <td>${esc(finding.message)}</td>
  <td>${esc(finding.fix)}</td>
</tr>`,
    )
    .join("");
  return layout({
    title: `QA · ${episode.topic}`,
    body: `
${episodeNav(episode.id, "qa", has)}
<h1>QA report ${verdictBadge}</h1>
<p class="meta">verdict <strong>${attr(report.verdict)}</strong> · publishable ${report.publishable ? "yes" : "NO — publication is blocked"} ·
${report.counts.errors} error(s), ${report.counts.warnings} warning(s) · settings <code>${shortHash(report.settingsHash)}</code> · ${when(report.generatedAt)}</p>
${
  report.blocking.length > 0
    ? `<div class="flash error">Blocking: ${report.blocking.map((code) => `<code>${attr(code)}</code>`).join(", ")}</div>`
    : ""
}
<h2>Checks</h2>
<table><tr><th>Check</th><th>Status</th><th>Examined</th><th>Note</th></tr>${checks}</table>
<h2>Findings</h2>
${findings === "" ? `<p class="meta">No findings.</p>` : `<table><tr><th>Severity</th><th>Code</th><th>Subject</th><th>Message</th><th>Fix</th></tr>${findings}</table>`}
${jsonBlock(report)}
`,
  });
}

// ── errors ──────────────────────────────────────────────────────────────────

export function errorPage(status: number, message: string): string {
  return layout({
    title: `Error ${status}`,
    body: `<h1>${status}</h1><div class="flash error">${esc(message)}</div><p><a href="/">Back to the dashboard</a></p>`,
  });
}
