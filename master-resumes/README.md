# Master Resumes

Place your two master resume files here. The pipeline references them by role type.

## Expected filenames

Use your own name slug (FirstLast or First-Last, matching `identity.fullName`
in your `private/applicant-profile.json`):

```
<NAME_SLUG>_Resume_PM_Master.docx       # PM / business / strategy / operations roles
<NAME_SLUG>_Resume_Design_Master.docx   # Design / UX / product design / industrial roles
```

Example for Jane Smith:
```
Jane_Smith_Resume_PM_Master.docx
Jane_Smith_Resume_Design_Master.docx
```

## How to create them

- Option A: Draft your own in Word/Pages, save as .docx.
- Option B: Use the dossier-builder Claude agent — run `/dossier-builder` in Claude
  after completing setup.sh onboarding; it can draft master resumes from your profile.

## Format notes

- Use Source Sans 3 (variable font, included in typeface/).
- The pipeline converts .docx → PDF via LibreOffice (see scripts/build-pdfs.sh).
- Do NOT install the static Source Sans 3 weights system-wide; use only the variable font.
