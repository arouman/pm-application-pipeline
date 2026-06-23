# Keyword Bank

The keyword bank is a single JSON file that tracks every must-have keyword the pipeline has ever extracted from a job description. Each keyword is reviewed exactly once; decisions are permanent.

## File location

`keyword-bank/keyword-bank.json`

## Top-level shape

```json
{
  "version": 1,
  "updated": "YYYY-MM-DD",
  "keywords": [ /* keyword entries */ ]
}
```

| Field     | Type   | Notes                                      |
|-----------|--------|--------------------------------------------|
| `version` | number | Schema version. Increment when shape changes. |
| `updated` | string | ISO date of the last write (YYYY-MM-DD).   |
| `keywords`| array  | All keyword entries, in insertion order.   |

## Keyword entry schema

```json
{
  "term":      "design tokens",
  "status":    "pending",
  "evidence":  "",
  "domain":    "[SW]",
  "firstSeen": "2026-06-10",
  "sourceJDs": ["Figma — Senior Product Designer"]
}
```

| Field       | Type            | Values / Notes                                                                 |
|-------------|-----------------|--------------------------------------------------------------------------------|
| `term`      | string          | Lowercase, canonical form. Unique across the array.                            |
| `status`    | string (enum)   | `"pending"` · `"confirmed"` · `"rejected"` (see state machine below)          |
| `evidence`  | string          | **Required non-empty when status is `confirmed`.** One-line anchor: where/how Rob used this skill (e.g. "Led design-token migration at Shopify, 2023"). Empty string when pending or rejected. |
| `domain`    | string          | Broad category tag: `"[PM]"` (product/strategy), `"[SW]"` (software/tooling), `"[PH]"` (physical/hardware), or `""` for uncategorised. |
| `firstSeen` | string          | ISO date the term first appeared in a JD (YYYY-MM-DD).                        |
| `sourceJDs` | array\<string\> | Human-readable JD identifiers: `"Company — Role Title"`. Append each new sighting; never de-duplicate (the history is useful). |

## Status state machine

```
pending  ──[Rob: "yes" + evidence]──►  confirmed
pending  ──[Rob: "no"]──────────────►  rejected
```

- A keyword in `confirmed` state is eligible to be inserted into tailored resumes and promoted to the skills bank.
- A keyword in `rejected` state is confirmed-absent and is never re-surfaced or inserted.
- Neither `confirmed` nor `rejected` keywords are ever re-reviewed. The review UI only shows `pending` terms.

## Anti-fabrication rule

`evidence` is not optional for confirmed keywords — it is the proof that Rob can back up the claim. The server enforces this: a `POST /decision` with `status: "confirmed"` and an empty `evidence` field is rejected with HTTP 400. A bare "yes" without provenance would be fabrication; the bank prevents that.

## Review tool

Open `http://localhost:8765` after starting the local server:

```bash
python3 scripts/serve-review.py
```

Use `--port NNNN` or the `PORT` environment variable to change the port.
