# Daily Job Search + Enqueue (Ashby + Greenhouse)

You are running an automated daily job search for Adam Rouman's application pipeline.

REPO=/Users/adamrouman/Projects/applications
QUEUE=$REPO/applied/_queue/queue.json

## Goal
Find exactly 25 NEW qualifying Senior/Staff/Principal PM roles across Ashby AND Greenhouse that are NOT already in the queue. Save their JDs, add them to queue.json, then stop. The build batch runs separately.

## Step 1 — Get today's date and load existing queue
Run: `date +%Y-%m-%d` → use as TODAY throughout.
Read $QUEUE → extract all "id" values (format: `ashby__{uuid}` or `greenhouse__{id}`). These are already-seen IDs to skip.

## Step 2 — Search both platforms

### Ashby
WebSearch queries:
- `site:jobs.ashbyhq.com "Senior Product Manager" remote`
- `site:jobs.ashbyhq.com "Staff Product Manager" remote`
- `site:jobs.ashbyhq.com "Principal Product Manager" remote`
- `site:jobs.ashbyhq.com "Sr. Product Manager" remote`
Add variants: "B2B", "SaaS", "AI", "platform", "growth", "fintech", "healthcare", "enterprise"

From each result URL (jobs.ashbyhq.com/{slug}/...) extract the company slug. Then fetch the board:
  GET https://api.ashbyhq.com/posting-api/job-board/{slug}
  User-Agent: RobStoutJobWatcher/1.0

Jobs array fields: `id`, `title`, `isRemote`, `locationName`, `jobUrl`, `descriptionPlain`.
Canonical job URL: https://jobs.ashbyhq.com/{slug}/{id}
Record ID prefix: `ashby__{id}`

**After fetching each board:** filter immediately for PM titles + remote eligibility. Keep only:
  {id, title, isRemote, locationName, jobUrl, descriptionPlain}
Discard the rest of the board response before fetching the next company.

### Greenhouse
WebSearch queries:
- `site:boards.greenhouse.io "Senior Product Manager" remote`
- `site:boards.greenhouse.io "Staff Product Manager" remote`
- `site:boards.greenhouse.io "Principal Product Manager" remote`
- `site:boards.greenhouse.io "Sr. Product Manager" remote`
Add variants: "B2B", "SaaS", "AI", "platform", "growth", "fintech", "healthcare", "enterprise"

From each result URL (boards.greenhouse.io/{slug}/jobs/...) extract the company slug. Fetch the board listing (no content):
  GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs

Jobs array fields: `id` (integer), `title`, `location.name`, `absolute_url`.
Record ID prefix: `greenhouse__{id}`

**After fetching each board:** filter immediately for PM titles + remote eligibility. Keep only:
  {id, title, location_name, absolute_url}
Discard the rest of the board response before fetching the next company.

For each Greenhouse role that passes title/location/dedup qualification, fetch the full description:
  GET https://boards-api.greenhouse.io/v1/boards/{slug}/jobs/{id}
This returns `content` (HTML). Strip HTML tags before saving: remove all `<...>` tags, collapse whitespace.

## Step 3 — Qualify each role (ALL must be true)
PASS:
- Title contains: Senior PM / Staff PM / Principal PM / Sr. PM / Senior Product Manager / Staff Product Manager / Principal Product Manager
- Location: remote-eligible (isRemote=true, or location contains "Remote", or US role with remote option in description)
- Record ID not already in queue
- Company is a funded startup or established tech company (not agency/staffing)
- fitScore ≥ 70 based on Adam's background: enterprise SaaS, AI/agentic products, B2B platform, growth/PLG, billing/payments, healthcare AI

SKIP (any one disqualifies):
- Title contains: Director, VP, Head of, CPO, Group PM, Lead PM, Junior, Associate, Intern
- Title contains: UX PM, Design PM, Marketing PM, Data PM, Technical PM (requiring eng degree)
- On-site only with no remote option
- Commission-only or staffing/agency posting
- Record ID already in queue

## Step 4 — Collect 25 qualifying roles total
Pull from both Ashby and Greenhouse combined. Keep searching until you have 25 new qualifying jobs.

## Step 5 — Save JDs and add to queue

### For Ashby jobs
Save JD:
  $REPO/applied/_queue/jds/ashby__{jobId}.json
  Content: {"id": "ashby__{jobId}", "company": "...", "title": "...", "jobId": "{uuid}", "ats": "ashby", "slug": "{ashby-slug}", "jdUrl": "https://jobs.ashbyhq.com/{slug}/{jobId}", "content": {"title": "...", "isRemote": true, "locationName": "...", "description": "{descriptionPlain value}"}}

Add to queue:
  python3 $REPO/scripts/lib/queue.py $QUEUE add --json '{
    "id": "ashby__{jobId}",
    "company": "Company Name",
    "title": "Senior Product Manager",
    "ats": "ashby",
    "slug": "{ashby-slug}",
    "jobId": "{uuid}",
    "jdUrl": "https://jobs.ashbyhq.com/{slug}/{jobId}",
    "location": "Remote",
    "jdPath": "$REPO/applied/_queue/jds/ashby__{jobId}.json",
    "master": "PM",
    "roleType": "PM",
    "tier": 2,
    "fitScore": {score},
    "fitNote": "one line why strong/weak match",
    "trap": "none",
    "folderName": "{company-slug}",
    "date": "{TODAY}",
    "status": "pending"
  }'

### For Greenhouse jobs
Save JD:
  $REPO/applied/_queue/jds/greenhouse__{jobId}.json
  Content: {"id": "greenhouse__{jobId}", "company": "...", "title": "...", "jobId": "{integer-id}", "ats": "greenhouse", "slug": "{gh-slug}", "jdUrl": "{absolute_url}", "content": {"title": "...", "location": {...}, "absolute_url": "...", "content": "{html-stripped description}"}}

Add to queue:
  python3 $REPO/scripts/lib/queue.py $QUEUE add --json '{
    "id": "greenhouse__{jobId}",
    "company": "Company Name",
    "title": "Senior Product Manager",
    "ats": "greenhouse",
    "slug": "{gh-slug}",
    "jobId": "{integer-id}",
    "jdUrl": "{absolute_url}",
    "location": "Remote",
    "jdPath": "$REPO/applied/_queue/jds/greenhouse__{jobId}.json",
    "master": "PM",
    "roleType": "PM",
    "tier": 2,
    "fitScore": {score},
    "fitNote": "one line why strong/weak match",
    "trap": "none",
    "folderName": "{company-slug}",
    "date": "{TODAY}",
    "status": "pending"
  }'

folderName = company name lowercased, spaces/punctuation → hyphens (e.g. "stripe", "monarch-money").
If the same company has 2+ roles today, append a title keyword: "stripe-growth".

## Step 6 — Confirm and report
After all 25 are added, print a summary:
- Total added: N (X from Ashby, Y from Greenhouse)
- List: [ATS] company — title (fitScore)
- Any skipped with reason
