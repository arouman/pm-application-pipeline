/**
 * sidepanel.js — Rob's Job Scout side panel logic
 *
 * Data flow:
 *   load → health check → discover → render
 *   chrome.storage.local caches last fetch so the panel feels instant on reopen
 *
 * All role data is HTML-escaped before DOM insertion to prevent XSS.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BRIDGE = "http://localhost:8787";
const CACHE_KEY = "jobScout_cache";

// ---------------------------------------------------------------------------
// DOM refs — resolved once at startup
// ---------------------------------------------------------------------------

const btnRefresh       = document.getElementById("btn-refresh");
const btnRetry         = document.getElementById("btn-retry");
const statusLine       = document.getElementById("status-line");
const filterText       = document.getElementById("filter-text");
const filterCompany    = document.getElementById("filter-company");
const rolesContainer   = document.getElementById("roles-container");

const stateLoading     = document.getElementById("state-loading");
const stateOffline     = document.getElementById("state-offline");
const stateEmpty       = document.getElementById("state-empty");
const stateResults     = document.getElementById("state-results");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Array<RoleRecord>} All roles from the last successful fetch */
let allRoles = [];
/** @type {number|null} Unix ms timestamp of last successful fetch */
let lastFetchedAt = null;

/**
 * @typedef {{ company: string, title: string, location: string,
 *             url: string, ats: string, jobId: string, tier: number }} RoleRecord
 */

// ---------------------------------------------------------------------------
// Utility — safe HTML escaping (no innerHTML injection of raw API strings)
// ---------------------------------------------------------------------------

/** Escapes &, <, >, ", ' in a string so it's safe to embed in HTML attributes or text. */
function esc(str) {
  return String(str ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ---------------------------------------------------------------------------
// Utility — relative timestamp
// ---------------------------------------------------------------------------

/** Returns a human-friendly string like "Updated just now" or "Updated 4 min ago". */
function relativeTime(tsMs) {
  if (!tsMs) return "";
  const seconds = Math.floor((Date.now() - tsMs) / 1000);
  if (seconds < 10) return "Updated just now";
  if (seconds < 60) return `Updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `Updated ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `Updated ${hours}h ago`;
}

// ---------------------------------------------------------------------------
// State switcher
// ---------------------------------------------------------------------------

const allStates = [stateLoading, stateOffline, stateEmpty, stateResults];

/** Shows one state panel and hides the others. */
function showState(activeEl) {
  allStates.forEach((el) => {
    if (el === activeEl) {
      el.removeAttribute("hidden");
    } else {
      el.setAttribute("hidden", "");
    }
  });
}

// ---------------------------------------------------------------------------
// Status line
// ---------------------------------------------------------------------------

function updateStatusLine() {
  const count = allRoles.length;
  const visibleCount = getFilteredRoles().length;
  const timeStr = relativeTime(lastFetchedAt);

  if (count === 0) {
    statusLine.textContent = timeStr;
    return;
  }

  const matchStr = visibleCount === count
    ? `${count} match${count !== 1 ? "es" : ""}`
    : `${visibleCount} of ${count} shown`;

  statusLine.textContent = timeStr ? `${matchStr} · ${timeStr}` : matchStr;
}

// ---------------------------------------------------------------------------
// Storage — persist / restore last fetch
// ---------------------------------------------------------------------------

/** Saves roles + timestamp to chrome.storage.local. */
async function saveToCache(roles) {
  await chrome.storage.local.set({
    [CACHE_KEY]: { roles, fetchedAt: Date.now() },
  });
}

/** Loads cached roles + timestamp. Returns null if nothing cached. */
async function loadFromCache() {
  const result = await chrome.storage.local.get(CACHE_KEY);
  return result[CACHE_KEY] ?? null;
}

// ---------------------------------------------------------------------------
// Bridge calls
// ---------------------------------------------------------------------------

/**
 * Calls GET /health.
 * Returns true if the bridge is up, false on any network/HTTP error.
 */
async function checkHealth() {
  try {
    const res = await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(4_000) });
    if (!res.ok) return false;
    const data = await res.json();
    return data.ok === true;
  } catch {
    return false;
  }
}

/**
 * Calls GET /discover (with optional company filter).
 * Throws on network errors; caller handles them.
 *
 * @param {string} [companySlug] - Optional company name to pass as ?company=
 * @returns {Promise<{ roles: RoleRecord[], count: number, errors: Array }>}
 */
async function fetchDiscover(companySlug) {
  const url = companySlug
    ? `${BRIDGE}/discover?company=${encodeURIComponent(companySlug)}`
    : `${BRIDGE}/discover`;

  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Bridge returned HTTP ${res.status}`);
  return res.json();
}

/**
 * Calls POST /scout { company, jobId }.
 * The bridge currently returns { ok: false, status: "not_implemented" }.
 * Returns an object with { ok, status } regardless of server state so the
 * caller can easily handle the implemented case later by checking ok === true.
 *
 * @param {{ company: string, jobId: string }} payload
 * @returns {Promise<{ ok: boolean, status: string }>}
 */
async function postScout(payload) {
  const res = await fetch(`${BRIDGE}/scout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  return res.json();
}

// ---------------------------------------------------------------------------
// Company filter dropdown — populate from loaded roles
// ---------------------------------------------------------------------------

/** Rebuilds the company <select> options from the current allRoles list. */
function populateCompanySelect(roles) {
  const companies = [...new Set(roles.map((r) => r.company))].sort();
  // Keep the "All companies" sentinel, replace the rest
  filterCompany.innerHTML = `<option value="">All companies</option>`;
  companies.forEach((name) => {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    filterCompany.appendChild(opt);
  });
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** Returns the subset of allRoles that match the current filter inputs. */
function getFilteredRoles() {
  const text  = filterText.value.trim().toLowerCase();
  const company = filterCompany.value; // exact company name or "" for all

  return allRoles.filter((role) => {
    if (company && role.company !== company) return false;
    if (text) {
      const haystack = `${role.company} ${role.title}`.toLowerCase();
      if (!haystack.includes(text)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/**
 * Builds and injects the role list grouped by tier.
 * All dynamic text is HTML-escaped before insertion.
 */
function renderRoles() {
  const visible = getFilteredRoles();

  if (visible.length === 0 && allRoles.length > 0) {
    // Roles exist but none match the current filter
    showState(stateResults); // keep results pane visible so filters stay accessible
    rolesContainer.innerHTML = `
      <div class="empty-state" style="padding-top: var(--space-xl)">
        <p class="empty-body">No roles match that filter.</p>
      </div>`;
    updateStatusLine();
    return;
  }

  if (visible.length === 0) {
    showState(stateEmpty);
    updateStatusLine();
    return;
  }

  // Group by tier, preserving the sort order from the bridge (tier asc, company asc)
  const byTier = new Map();
  visible.forEach((role) => {
    const key = role.tier ?? 99;
    if (!byTier.has(key)) byTier.set(key, []);
    byTier.get(key).push(role);
  });

  const tiers = [...byTier.keys()].sort((a, b) => a - b);

  const html = tiers.map((tier) => {
    const roles = byTier.get(tier);
    const tierClass = tier <= 3 ? tier : "other";
    const tierCards = roles.map(buildCardHTML).join("");

    return `
      <section class="tier-section">
        <div class="tier-header">
          <span class="tier-label tier-label--${tierClass}">Tier ${esc(String(tier))}</span>
          <span class="tier-count">${roles.length} role${roles.length !== 1 ? "s" : ""}</span>
          <div class="tier-divider" aria-hidden="true"></div>
        </div>
        <div class="roles-list">${tierCards}</div>
      </section>`;
  }).join("");

  rolesContainer.innerHTML = html;
  showState(stateResults);
  updateStatusLine();

  // Attach Scout button listeners (they need the DOM to exist first)
  rolesContainer.querySelectorAll(".btn-scout").forEach((btn) => {
    btn.addEventListener("click", handleScoutClick);
  });
}

/**
 * Returns the HTML string for a single role card.
 * Every piece of role data is escaped through esc().
 *
 * @param {RoleRecord} role
 * @returns {string}
 */
function buildCardHTML(role) {
  const tier = role.tier ?? 99;
  const tierClass = tier <= 3 ? tier : "other";
  const locationHTML = role.location
    ? `<p class="card-location">${esc(role.location)}</p>`
    : "";

  // data-* attributes for the Scout button handler
  return `
    <article class="role-card">
      <p class="card-company">${esc(role.company)}</p>
      <h2 class="card-title">${esc(role.title)}</h2>
      ${locationHTML}
      <div class="card-footer">
        <div class="badge-group">
          <span class="badge-ats">${esc(role.ats)}</span>
          <span class="badge-tier badge-tier--${tierClass}">T${esc(String(tier))}</span>
        </div>
        <div class="card-actions">
          <a class="btn-link"
             href="${esc(role.url)}"
             target="_blank"
             rel="noopener noreferrer">Open JD ↗</a>
          <button class="btn-scout"
                  data-company="${esc(role.company)}"
                  data-jobid="${esc(role.jobId)}">Scout</button>
        </div>
      </div>
    </article>`;
}

// ---------------------------------------------------------------------------
// Scout button handler
// ---------------------------------------------------------------------------

/**
 * Handles a click on a Scout button.
 * Calls POST /scout and shows an inline note beneath the card.
 * When the bridge implements scout fully, change the ok === true branch.
 *
 * @param {MouseEvent} event
 */
async function handleScoutClick(event) {
  const btn = event.currentTarget;
  const company = btn.dataset.company;
  const jobId   = btn.dataset.jobid;

  btn.disabled = true;
  btn.textContent = "Scouting…";

  try {
    const result = await postScout({ company, jobId });

    // --- Swap this branch when /scout is implemented ---
    if (result.ok === true) {
      // Future: show scoring results, gap analysis, etc.
      showInlineNote(btn, "Scouted!");
    } else {
      // Currently always lands here: { ok: false, status: "not_implemented" }
      showInlineNote(btn, "Scout wiring coming next");
      btn.disabled = false;
      btn.textContent = "Scout";
    }
  } catch {
    showInlineNote(btn, "Could not reach bridge");
    btn.disabled = false;
    btn.textContent = "Scout";
  }
}

/**
 * Inserts a small muted note directly after a button.
 * Removes any existing note first so repeated clicks don't stack.
 *
 * @param {HTMLElement} btn
 * @param {string} message  Plain text only — never inserted as HTML.
 */
function showInlineNote(btn, message) {
  // Remove any previous note attached to this card
  const card = btn.closest(".role-card");
  card?.querySelector(".scout-note")?.remove();

  const note = document.createElement("p");
  note.className = "scout-note";
  note.textContent = message; // textContent — safe, not innerHTML
  btn.closest(".card-actions")?.after(note);
}

// ---------------------------------------------------------------------------
// Main load / refresh flow
// ---------------------------------------------------------------------------

/** Sets the refresh button into its loading spinner state. */
function setRefreshSpinning(spinning) {
  if (spinning) {
    btnRefresh.classList.add("spinning");
    btnRefresh.disabled = true;
  } else {
    btnRefresh.classList.remove("spinning");
    btnRefresh.disabled = false;
  }
}

/**
 * Full refresh cycle:
 *   1. Show loading state
 *   2. Health check
 *   3. If healthy, fetch /discover
 *   4. Render and cache
 *   5. If unhealthy, show offline state (with cached data visible if available)
 */
async function refresh() {
  setRefreshSpinning(true);
  showState(stateLoading);

  const healthy = await checkHealth();

  if (!healthy) {
    // If we have stale cached data, show it with an offline note rather than
    // a blank panel — better to have stale info visible than nothing.
    if (allRoles.length > 0) {
      showState(stateResults);
      statusLine.textContent = `Bridge offline · ${relativeTime(lastFetchedAt)} (stale)`;
    } else {
      showState(stateOffline);
      statusLine.textContent = "";
    }
    setRefreshSpinning(false);
    return;
  }

  try {
    // Pass through the company dropdown filter as a server-side hint if set
    const companyFilter = filterCompany.value || undefined;
    const data = await fetchDiscover(companyFilter);

    allRoles       = data.roles ?? [];
    lastFetchedAt  = Date.now();

    // Rebuild the company dropdown from fresh data (only when fetching all)
    if (!companyFilter) {
      populateCompanySelect(allRoles);
    }

    await saveToCache(allRoles);
    renderRoles();
  } catch {
    // Network or JSON parse failure after a healthy ping — show stale or offline
    if (allRoles.length > 0) {
      showState(stateResults);
      statusLine.textContent = `Fetch failed · ${relativeTime(lastFetchedAt)} (stale)`;
    } else {
      showState(stateOffline);
    }
  }

  setRefreshSpinning(false);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

async function init() {
  // Wire up event listeners first so the UI is interactive during load
  btnRefresh.addEventListener("click", refresh);
  btnRetry.addEventListener("click", refresh);

  filterText.addEventListener("input", () => {
    renderRoles();
    updateStatusLine();
  });

  filterCompany.addEventListener("change", () => {
    // Company select triggers a re-fetch so the server can narrow the dataset.
    // The text filter stays active on top of the server-filtered result.
    refresh();
  });

  // Restore cache immediately for a fast first paint
  const cached = await loadFromCache();
  if (cached?.roles?.length) {
    allRoles      = cached.roles;
    lastFetchedAt = cached.fetchedAt;
    populateCompanySelect(allRoles);
    renderRoles();
    // Status shows stale time while we refresh in the background
    statusLine.textContent = `${relativeTime(lastFetchedAt)} (refreshing…)`;
  }

  // Then do a live refresh in the background
  refresh();
}

init();
