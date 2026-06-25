#!/usr/bin/env node
/**
 * Adapter for builder5.js/verbatim2.js pipeline.
 * Reads a build-args.json, produces resume + cover letter .docx and .pdf in outputDir.
 *
 * Usage: node build-pair.js <build-args.json>
 *
 * build-args.json schema:
 *   company       string   e.g. "Valon"
 *   title         string   exact posted title
 *   pmTitle       string?  headline override (defaults to title)
 *   summary       string   3-5 sentence tailored summary
 *   competencyText string  pipe-delimited competencies
 *   atBulletIdxs  number[] ordered indices into V2.atlassian
 *   ehBulletIdxs  number[] ordered indices into V2.ehealth
 *   tools         string   pipe-delimited tools starting with "Claude | Claude Code (Certified) | ..."
 *   p1            string   cover letter opening paragraph
 *   p2            string   cover letter credentials paragraph
 *   p3            string   cover letter closing paragraph
 *   outputDir     string   absolute path where PDFs and .docx are written
 *   date          string   YYYY-MM-DD (used for the letter date line)
 */
const { buildResume, Packer, toPDF } = require('./builder5');
const { Document, Paragraph, TextRun, BorderStyle } = require('docx');
const { V2: V } = require('./verbatim2');
const fs = require('fs');
const path = require('path');

function ro(arr, idxs) {
  const rest = arr.filter((_, i) => !idxs.includes(i));
  return [...idxs.map(i => arr[i]), ...rest];
}

function slug(s) {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function formatDate(iso) {
  const d = new Date(iso + 'T12:00:00');
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

// Same visual spec as builder5.js buildCoverLetter but with dynamic date param
const BLUE = '1a56db', LIGHT = '777777';
function buildCoverLetterDated(role, company, p1, p2, p3, dateStr) {
  const { Document: D, Paragraph: P, TextRun: T, BorderStyle: BS } = require('docx');
  return new D({
    styles: { default: { document: { run: { font: "Georgia", size: 21, color: "1a1a1a" } } } },
    sections: [{
      properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 } } },
      children: [
        new P({ spacing: { before: 0, after: 40 }, children: [new T({ text: "ADAM ROUMAN", bold: true, size: 32, font: "Arial", color: "1a1a1a" })] }),
        new P({ spacing: { before: 0, after: 60 }, border: { bottom: { style: BS.SINGLE, size: 4, color: BLUE, space: 6 } }, children: [new T({ text: "arouman@gmail.com  |  (951) 733-2310  |  adamrouman.com", size: 18, font: "Arial", color: LIGHT })] }),
        new P({ spacing: { before: 180, after: 60 }, children: [new T({ text: dateStr, size: 19, font: "Georgia", color: LIGHT })] }),
        new P({ spacing: { before: 0, after: 240 }, children: [new T({ text: `Re: ${role} at ${company}`, bold: true, size: 20, font: "Georgia", color: "1a1a1a" })] }),
        new P({ spacing: { before: 0, after: 220 }, children: [new T({ text: p1, size: 21, font: "Georgia", color: "1a1a1a" })] }),
        new P({ spacing: { before: 0, after: 220 }, children: [new T({ text: p2, size: 21, font: "Georgia", color: "1a1a1a" })] }),
        new P({ spacing: { before: 0, after: 220 }, children: [new T({ text: p3, size: 21, font: "Georgia", color: "1a1a1a" })] }),
        new P({ spacing: { before: 200, after: 60 }, children: [new T({ text: "Sincerely,", size: 21, font: "Georgia", color: "444444" })] }),
        new P({ spacing: { before: 0, after: 20 }, children: [new T({ text: "Adam Rouman", bold: true, size: 22, font: "Georgia", color: "1a1a1a" })] }),
        new P({ spacing: { before: 0, after: 0 }, children: [new T({ text: "arouman@gmail.com  |  (951) 733-2310", size: 18, font: "Georgia", color: LIGHT })] }),
      ]
    }]
  });
}

async function main() {
  const argsFile = process.argv[2];
  if (!argsFile) { console.error('Usage: node build-pair.js <build-args.json>'); process.exit(1); }

  const a = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
  const { company, title, pmTitle, summary, competencyText,
          atBulletIdxs, ehBulletIdxs, tools, p1, p2, p3, outputDir, date } = a;

  fs.mkdirSync(outputDir, { recursive: true });

  const tSlug = slug(title);
  const cSlug = slug(company);
  const dateStr = date ? formatDate(date) : new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  // Resume
  const resume = buildResume(V, summary, competencyText,
    ro(V.atlassian, atBulletIdxs), ro(V.ehealth, ehBulletIdxs), tools, pmTitle || title);
  const rDocx = path.join('/tmp', `Adam_Rouman_Resume_${tSlug}_${cSlug}.docx`);
  fs.writeFileSync(rDocx, await Packer.toBuffer(resume));
  toPDF(rDocx, outputDir);
  fs.copyFileSync(rDocx, path.join(outputDir, path.basename(rDocx)));

  // Cover letter
  const cl = buildCoverLetterDated(title, company, p1, p2, p3, dateStr);
  const cDocx = path.join('/tmp', `Adam_Rouman_Cover_Letter_${tSlug}_${cSlug}.docx`);
  fs.writeFileSync(cDocx, await Packer.toBuffer(cl));
  toPDF(cDocx, outputDir);
  fs.copyFileSync(cDocx, path.join(outputDir, path.basename(cDocx)));

  const files = fs.readdirSync(outputDir).filter(f => /\.(docx|pdf)$/.test(f));
  console.log('output:', outputDir);
  files.forEach(f => console.log(' ', f));
}

main().catch(err => { console.error(err.message); process.exit(1); });
