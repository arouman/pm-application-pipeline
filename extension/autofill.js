/* autofill.js — client-side job-form autofill for Rob's pipeline.
 *
 * Runs in the page (console snippet, bookmarklet, or userscript). Given a
 * field-map object it fills the standard text fields + textareas, then
 * HIGHLIGHTS every control it can't safely set (dropdowns, radios, file inputs)
 * and lists them in a floating panel so Rob knows exactly what to finish by hand.
 *
 * Why this works where a naive .value = x fails: modern ATS (Greenhouse,
 * Lever, Ashby, Workday) use React/controlled inputs. Setting .value directly
 * doesn't notify React. We set the value through the element's NATIVE setter and
 * dispatch real input/change/blur events so the framework commits it.
 *
 * It NEVER clicks submit and NEVER sets dropdown values (those are Rob's — the
 * safety boundary). File inputs can't be set by injected JS at all (browser
 * security); the panel flags them for manual attach.
 *
 * Usage:
 *   robAutofill(FIELD_MAP)                      // fill immediately (console-snippet path)
 *   robAutofill(FIELD_MAP, {planOnly: true})     // plan-only mode: tag elements, record plan
 *                                                 // on window.__robFillPlan, do NOT fill
 */
(function (root) {
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA"
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  // label text associated with a field (for/aria-labelledby/wrapping label/placeholder)
  function labelFor(el) {
    let t = "";
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) t += " " + l.textContent;
    }
    if (el.getAttribute("aria-labelledby")) {
      el.getAttribute("aria-labelledby").split(/\s+/).forEach(id => {
        const n = document.getElementById(id); if (n) t += " " + n.textContent;
      });
    }
    const wrap = el.closest("label"); if (wrap) t += " " + wrap.textContent;
    t += " " + (el.name || "") + " " + (el.id || "") + " " +
         (el.getAttribute("placeholder") || "") + " " +
         (el.getAttribute("aria-label") || "") + " " +
         (el.getAttribute("autocomplete") || "");
    return t.toLowerCase().replace(/\s+/g, " ").trim();
  }

  const visible = (el) => el.offsetParent !== null && !el.disabled && !el.readOnly;

  /**
   * Core matching logic shared by fill mode and plan mode.
   *
   * In fill mode (planOnly=false): sets values via setNativeValue immediately.
   * In plan mode (planOnly=true): tags each matched element with data-rob-fill-id="n"
   *   and records metadata on window.__robFillPlan; does NOT set any values.
   *
   * Returns an array of [labelKey, value] pairs (fill mode) or the plan array (plan mode).
   */
  function fillFields(map, planOnly) {
    const id = map.identity || {};
    const rules = [
      [["first name", "firstname", "given name", "legal first"], id.firstName],
      [["last name", "lastname", "family name", "surname", "legal last"], id.lastName],
      [["full name", "your name", "candidate name"], id.fullName],
      [["email"], id.email],
      [["phone", "mobile", "telephone"], id.phone],
      [["linkedin"], id.linkedin],
      // github must come before the website rule — "GitHub URL" labels contain "url"
      [["github"], id.github],
      [["website", "portfolio", "personal site", "url"], id.website],
      [["city", "location", "where are you", "current location"], id.location],
    ];
    const filled = [];
    const plan = [];
    let planId = 0;

    const inputs = [...document.querySelectorAll('input[type="text"],input[type="email"],input[type="tel"],input[type="url"],input:not([type])')]
      .filter(visible).filter(el => !el.value);
    for (const [keys, val] of rules) {
      if (!val) continue;
      const el = inputs.find(i => keys.some(k => labelFor(i).includes(k)));
      if (el) {
        if (planOnly) {
          const fillIdStr = String(planId++);
          el.setAttribute("data-rob-fill-id", fillIdStr);
          plan.push({ id: fillIdStr, kind: "input", label: keys[0], value: val });
        } else {
          setNativeValue(el, val);
          el.dataset._robFilled = "1";
          filled.push([keys[0], val]);
        }
      }
    }

    // textareas: cover letter + why-company
    const tas = [...document.querySelectorAll("textarea")].filter(visible).filter(el => !el.value);
    for (const ta of tas) {
      const lt = labelFor(ta);
      if ((/cover letter|additional info|anything else|tell us more/.test(lt)) && map.coverLetterText) {
        if (planOnly) {
          const fillIdStr = String(planId++);
          ta.setAttribute("data-rob-fill-id", fillIdStr);
          plan.push({ id: fillIdStr, kind: "textarea", label: "cover letter", value: map.coverLetterText });
        } else {
          setNativeValue(ta, map.coverLetterText);
          ta.dataset._robFilled = "1";
          filled.push(["cover letter", "(letter)"]);
        }
      } else if (/why|interest|excite|motivat/.test(lt) && map.essays && map.essays.whyCompany) {
        if (planOnly) {
          const fillIdStr = String(planId++);
          ta.setAttribute("data-rob-fill-id", fillIdStr);
          plan.push({ id: fillIdStr, kind: "textarea", label: "why-company essay", value: map.essays.whyCompany });
        } else {
          setNativeValue(ta, map.essays.whyCompany);
          ta.dataset._robFilled = "1";
          filled.push(["why-company essay", "(essay)"]);
        }
      }
    }

    if (planOnly) {
      window.__robFillPlan = plan;
      return plan;
    }
    return filled;
  }

  // controls Rob must finish by hand → outline + collect
  function flagManual() {
    const manual = [];
    const mark = (el, kind) => {
      el.style.outline = "2px solid #d98c00"; el.style.outlineOffset = "1px";
      const lt = labelFor(el).slice(0, 60) || kind;
      manual.push(kind + ": " + lt);
    };
    document.querySelectorAll("select").forEach(el => visible(el) && mark(el, "dropdown"));
    document.querySelectorAll('[role="combobox"],[role="listbox"],.select__control,.select-shell,[class*="react-select"]')
      .forEach(el => { if (el.offsetParent !== null) mark(el, "dropdown"); });
    document.querySelectorAll('input[type="file"]').forEach(el => mark(el, "file-attach"));
    // radio/checkbox groups (collect once per group name)
    const seen = new Set();
    document.querySelectorAll('input[type="radio"],input[type="checkbox"]').forEach(el => {
      if (!visible(el)) return; const g = el.name || el.id; if (seen.has(g)) return; seen.add(g);
      mark(el, el.type);
    });
    return [...new Set(manual)];
  }

  function panel(filled, manual, map) {
    // Remove any prior panel — both the old non-shadow version and the new shadow host.
    document.getElementById("_rob_panel")?.remove();
    document.getElementById("_rob_panel_host")?.remove();

    // ── Shadow DOM isolation ──────────────────────────────────────────────────
    // ATS pages (Greenhouse, Ashby, Workday, arbitrary careers pages) ship their
    // own CSS resets, font stacks, line-height overrides, and sometimes global
    // `* { position: absolute }` nightmares.  Attaching our panel to the regular
    // DOM means those rules bleed in and produce garbled, overlapping text.
    //
    // Solution: mount the panel inside a Shadow DOM root on a plain <div>.
    // Styles inside a shadow root are fully scoped — the host page can't reach
    // them and they can't inherit from the host page.  We also set `all: initial`
    // on the inner container as an extra belt-and-suspenders reset, then re-apply
    // exactly the properties we need on every element we create.
    const host = document.createElement("div");
    host.id = "_rob_panel_host";
    // Host element itself: only needs to be fixed-positioned and on top.
    host.style.cssText = [
      "all: initial",
      "position: fixed",
      "top: 12px",
      "right: 12px",
      "z-index: 2147483647",
      "display: block",
    ].join(";");

    const shadow = host.attachShadow({ mode: "open" });

    // Scoped stylesheet — lives only inside the shadow root.
    const style = document.createElement("style");
    style.textContent = `
      :host { all: initial; display: block; }
      #panel {
        all: initial;
        display: block;
        position: relative;
        width: 320px;
        max-height: 80vh;
        overflow-y: auto;
        background: #11181f;
        color: #e6edf3;
        font-family: -apple-system, system-ui, sans-serif;
        font-size: 13px;
        line-height: 1.45;
        font-weight: 400;
        font-style: normal;
        text-decoration: none;
        border: 1px solid #2b3640;
        border-radius: 10px;
        box-shadow: 0 8px 30px rgba(0,0,0,.45);
        padding: 12px 14px;
        box-sizing: border-box;
      }
      .row {
        display: block;
        margin: 2px 0;
        font-size: 13px;
        line-height: 1.45;
        font-family: -apple-system, system-ui, sans-serif;
        color: #e6edf3;
        box-sizing: border-box;
      }
      .header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 6px;
        font-size: 13px;
        line-height: 1.45;
        font-family: -apple-system, system-ui, sans-serif;
        box-sizing: border-box;
      }
      .title {
        font-size: 13px;
        font-weight: 700;
        line-height: 1.45;
        color: #58c4dc;
        font-family: -apple-system, system-ui, sans-serif;
      }
      .close-btn {
        cursor: pointer;
        color: #8b97a3;
        font-size: 14px;
        line-height: 1;
        font-family: -apple-system, system-ui, sans-serif;
        background: none;
        border: none;
        padding: 0;
        margin: 0;
      }
      .section-filled {
        display: block;
        color: #7ee787;
        margin-bottom: 4px;
        font-size: 13px;
        line-height: 1.45;
        font-family: -apple-system, system-ui, sans-serif;
        box-sizing: border-box;
      }
      .section-manual {
        display: block;
        color: #ffa657;
        margin: 8px 0 4px;
        font-size: 13px;
        line-height: 1.45;
        font-family: -apple-system, system-ui, sans-serif;
        box-sizing: border-box;
      }
      .footer {
        display: block;
        margin-top: 8px;
        color: #8b97a3;
        border-top: 1px solid #2b3640;
        padding-top: 6px;
        font-size: 12px;
        line-height: 1.5;
        font-family: -apple-system, system-ui, sans-serif;
        box-sizing: border-box;
      }
    `;
    shadow.appendChild(style);

    const panel = document.createElement("div");
    panel.id = "panel";

    // Build inner HTML — safe because all values are our own strings
    const liHtml = (s) => `<div class="row">${s}</div>`;
    const resumeName  = (map.resumePdf      || "").split("/").pop() || "resume.pdf";
    const coverName   = (map.coverLetterPdf || "").split("/").pop() || "cover.pdf";

    panel.innerHTML = `
      <div class="header">
        <span class="title">Rob Autofill — ${map.company || ""}</span>
        <button class="close-btn" id="_rob_x" aria-label="Dismiss">✕</button>
      </div>
      <span class="section-filled">✓ Filled ${filled.length}</span>
      ${filled.map(f => liHtml("• " + f[0])).join("")}
      <span class="section-manual">✋ You finish (${manual.length}) — outlined orange</span>
      ${manual.map(m => liHtml("• " + m)).join("") || liHtml("<i>none detected</i>")}
      <span class="footer">Attach PDFs:<br>${resumeName}<br>${coverName}<br><i>Review everything, then submit.</i></span>
    `;

    shadow.appendChild(panel);
    document.body.appendChild(host);

    // Close button lives inside the shadow root — querySelector on the shadow.
    shadow.getElementById("_rob_x").onclick = () => host.remove();
  }

  /**
   * Main entry point.
   *
   * @param {object} map        - field-map.json payload (must include .identity)
   * @param {object} [opts]     - options
   * @param {boolean} [opts.planOnly=false]
   *   When true: tags matched elements with data-rob-fill-id, records the fill
   *   plan on window.__robFillPlan, and returns the plan array. Does NOT set any
   *   values. Used by stage-apps.js so it can type values via CDP Input.insertText
   *   (trusted events) instead of synthetic JS events (which Ashby's validator ignores).
   *   When false (default): fills immediately via setNativeValue. This is the
   *   console-snippet path and must not change behavior.
   */
  root.robAutofill = function (map, opts) {
    if (!map || !map.identity) { console.error("robAutofill: bad field-map"); return; }
    const planOnly = !!(opts && opts.planOnly);

    if (planOnly) {
      const plan = fillFields(map, true);
      console.log("robAutofill (planOnly): tagged", plan.length, "fields; plan on window.__robFillPlan");
      return { plan };
    }

    const filled = fillFields(map, false);
    const manual = flagManual();
    panel(filled, manual, map);
    console.log("robAutofill: filled", filled.length, "fields; manual:", manual);
    return { filled, manual };
  };
})(window);
