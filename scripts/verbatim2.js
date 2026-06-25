/**
 * verbatim2.js — Pre-vetted resume bullet bank
 *
 * SETUP: Replace every entry below with your own verified bullets.
 * Each bullet is a two-part array: [bold metric prefix, rest of the sentence].
 * The application-builder agent selects and reorders these by index — it NEVER
 * rewrites them. All claims must trace to your projects.md / competencies.md.
 *
 * Structure per employer:
 *   V2.atlassian   — your most recent / most prominent role (8 bullets recommended)
 *   V2.ehealth     — second employer (3+ bullets)
 *   V2.cake        — third employer (2+ bullets)
 *   V2.rocketLawyer — fourth employer (2+ bullets)
 *   V2.slidepay    — fifth employer (2+ bullets)
 *   V2.aiDev       — personal / side projects (optional, grouped by project)
 *   V2.education   — degrees and certifications (plain strings, not bullet pairs)
 *
 * Rename the keys to match your actual employers. Update application-builder.md
 * and builder5.js accordingly if you rename keys.
 */

const V2 = {
  // ── EMPLOYER 1 (most recent / most prominent) ──────────────────────────────
  atlassian: [
    // Format: ["Bold metric or outcome", " — supporting detail and method."]
    ["[Metric: e.g. 10x YoY KR improvement]", " — [what you did, how you did it, tools/teams involved]."],
    ["[Metric: e.g. $4M+ MRR migrated]", " — [what you did, how you did it]."],
    ["[Metric: e.g. +1M adopted seats]", " — [what you did, how you did it]."],
    ["[Metric: e.g. $150K in COGS saved]", " — [what you did, how you did it]."],
    ["[Metric: e.g. Compliance milestone achieved]", " — [what you did, how you did it]."],
    ["[Metric: e.g. 40+ hours of manual work eliminated]", " — [what you did, how you did it]."],
    ["[Metric: e.g. 15K new activations]", " — [what you did, how you did it]."],
    ["[Metric: e.g. Activation up 25%]", " — [what you did, how you did it]."],
  ],

  // ── EMPLOYER 2 ─────────────────────────────────────────────────────────────
  ehealth: [
    ["[Metric: e.g. 10% enrollment lift]", " — [what you did, how you did it]."],
    ["[Metric: e.g. 45% pipeline growth]", " — [what you did, how you did it]."],
    ["[Metric: e.g. $1M+ in time savings]", " — [what you did, how you did it]."],
  ],

  // ── EMPLOYER 3 ─────────────────────────────────────────────────────────────
  cake: [
    ["[Metric: e.g. 3x monthly revenue increase]", " — [what you did, how you did it]."],
    ["[Metric: e.g. $150K recovered in 12 months]", " — [what you did, how you did it]."],
  ],

  // ── EMPLOYER 4 ─────────────────────────────────────────────────────────────
  rocketLawyer: [
    ["[Metric: e.g. Call-to-triage time cut 30%]", " — [what you did, how you did it]."],
    ["[Metric: e.g. Payout times cut from 90 days to under 24 hours]", " — [what you did, how you did it]."],
  ],

  // ── EMPLOYER 5 ─────────────────────────────────────────────────────────────
  slidepay: [
    ["[Outcome: e.g. iOS/Android apps built from the ground up]", " — [what you did, how you did it]."],
    ["[Metric: e.g. Disputes reduced 90%]", " — [what you did, how you did it]."],
  ],

  // ── PERSONAL / SIDE PROJECTS (optional) ────────────────────────────────────
  aiDev: {
    website: [["[Project name (yourwebsite.com)]", " — [what you built, stack, outcome]."]],
    handyman: [["[Project name (In Development)]", " — [what you're building, stack, stage]."]],
    hyrox: [["[Project name (In Development)]", " — [what you're building, stack, stage]."]],
  },

  // ── EDUCATION ──────────────────────────────────────────────────────────────
  education: [
    "[Degree], [Major]  |  [University], [Location]",
    "[Certification]  |  [Issuing organization]",
  ],
};

module.exports = { V2 };
