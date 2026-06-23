-- word-to-pdf.applescript
-- Convert a .docx to PDF using Microsoft Word's OWN export engine. We use Word (not
-- macOS print-to-PDF) on purpose: Word emits a *tagged* PDF with a real reading order
-- and embedded fonts — what ATS parsers and screen readers need. See CLAUDE.md.
--
-- Usage:  osascript word-to-pdf.applescript <input.docx> <output.pdf>
-- Both arguments must be ABSOLUTE POSIX paths. Prefer the build-pdfs.sh wrapper, which
-- also cleans up Word afterward.
--
-- Hard-won notes — every line below guards a real failure mode; do not "simplify":
--   * Build the file refs OUTSIDE the `tell` block. Inside `tell ... Word`,
--     `POSIX file <variable>` is parsed against WORD's terminology and silently
--     returns "" — an empty save path that surfaces as a misleading -1708.
--   * `save as` needs an HFS (colon-separated) path for `file name`; a POSIX string
--     throws -1708. `(POSIX file p) as text` yields HFS even for a missing output.
--   * Keep `active document` INLINE in `save as`. A stored variable (`save as theDoc`)
--     dispatches the event to the document object (→ -1708) instead of the app.
--   * `delay 1` lets Word finish opening before save-as (avoids a readiness -1708).
--   * We do NOT close the doc. After save-as-PDF, Word refuses every `close` form
--     (-1708) and `do Visual Basic` is gone, so the doc can't be closed in-script.
--     Docs accumulate harmlessly; cleanup = quitting Word, which build-pdfs.sh does
--     at the end of a batch.
on run argv
	if (count of argv) < 2 then
		error "Usage: osascript word-to-pdf.applescript <input.docx> <output.pdf>"
	end if
	set inFile to POSIX file (item 1 of argv)
	set outHFS to (POSIX file (item 2 of argv)) as text

	tell application "Microsoft Word"
		with timeout of 300 seconds
			open inFile
			delay 1
			save as active document file name outHFS file format format PDF
			-- Mark the doc CLEAN. We can't close it (Word refuses every close form
			-- after save-as-PDF), but a clean doc never spawns Word's autorecovery
			-- pane and lets a later graceful `quit saving no` exit without prompting.
			try
				set saved of active document to true
			end try
		end timeout
	end tell

	return (item 2 of argv)
end run
