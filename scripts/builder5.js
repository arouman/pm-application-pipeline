const { Document, Packer, Paragraph, TextRun, AlignmentType, LevelFormat, BorderStyle, TabStopType } = require('docx');
const { execSync } = require('child_process');
const nodePath = require('path');
const fs = require('fs');

const PROFILE_PATH = nodePath.resolve(__dirname, '../private/applicant-profile.json');
const PROFILE = (() => {
  try { return JSON.parse(fs.readFileSync(PROFILE_PATH, 'utf8')).identity; }
  catch { throw new Error(`Missing private/applicant-profile.json — copy private/applicant-profile.example.json and fill in your details.`); }
})();

const BLUE='1a56db', DARK='1a1a1a', MED='444444', LIGHT='777777';

function bm(metric, rest) {
  return new Paragraph({ numbering:{reference:"bullets",level:0}, spacing:{before:44,after:44},
    children:[new TextRun({text:metric,size:20,font:"Arial",color:DARK,bold:true}),
              new TextRun({text:rest,size:20,font:"Arial",color:MED})]});
}
function hdr(text) {
  return new Paragraph({spacing:{before:200,after:60},
    border:{bottom:{style:BorderStyle.SINGLE,size:6,color:BLUE,space:2}},
    children:[new TextRun({text:text.toUpperCase(),bold:true,size:22,color:BLUE,font:"Arial"})]});
}
function jobHdr(title,dates) {
  return new Paragraph({spacing:{before:160,after:30},tabStops:[{type:TabStopType.RIGHT,position:9360}],
    children:[new TextRun({text:title,bold:true,size:22,font:"Arial",color:DARK}),
              new TextRun({text:"\t"+dates,size:20,font:"Arial",color:LIGHT,italics:true})]});
}
function coLine(name,desc) {
  return new Paragraph({spacing:{before:0,after:50},
    children:[new TextRun({text:name,bold:true,size:20,font:"Arial",color:BLUE}),
              new TextRun({text:desc?"  |  "+desc:"",size:20,font:"Arial",color:LIGHT})]});
}
function miniHdr(text) {
  return new Paragraph({spacing:{before:100,after:10},
    children:[new TextRun({text,bold:true,size:20,font:"Arial",color:DARK})]});
}
function sp(pts=60){return new Paragraph({spacing:{before:0,after:pts},children:[new TextRun("")]});}

function nameBlock(pmTitle) {
  const title = pmTitle || "Senior Product Manager";
  const contactParts = [PROFILE.email, PROFILE.locationForApplications, PROFILE.website, PROFILE.phone].filter(Boolean);
  const contactChildren = contactParts.flatMap((part, i) => [
    new TextRun({text: part, size:19, font:"Arial", color:MED}),
    ...(i < contactParts.length - 1 ? [new TextRun({text:"  |  ",size:19,font:"Arial",color:LIGHT})] : []),
  ]);
  return [
    new Paragraph({alignment:AlignmentType.CENTER,spacing:{before:0,after:20},children:[new TextRun({text:PROFILE.fullName.toUpperCase(),bold:true,size:40,font:"Arial",color:DARK})]}),
    new Paragraph({alignment:AlignmentType.CENTER,spacing:{before:0,after:30},children:[new TextRun({text:title,size:24,font:"Arial",color:BLUE})]}),
    new Paragraph({alignment:AlignmentType.CENTER,spacing:{before:0,after:20},children:contactChildren}),
    sp(80),
  ];
}

function earlyCareer(V) {
  return [
    hdr("Early Career Highlights (2012-2017)"),
    new Paragraph({spacing:{before:60,after:30},children:[new TextRun({text:"CAKE (acq. by Sysco Foods), Rocket Lawyer, SlidePay (YC W12, acq. by Rocket Lawyer)",bold:true,size:20,font:"Arial",color:MED})]}),
    new Paragraph({spacing:{before:0,after:50},children:[new TextRun({text:"First product hire at a Y Combinator startup through acquisition to Rocket Lawyer, then to a senior PM at CAKE.",size:19,font:"Arial",color:LIGHT,italics:true})]}),
    miniHdr("CAKE (acq. by Sysco Foods)"),
    ...V.cake.map(([m,r])=>bm(m,r)),
    miniHdr("Rocket Lawyer"),
    ...V.rocketLawyer.map(([m,r])=>bm(m,r)),
    miniHdr("SlidePay (Y-Combinator, Acquired by Rocket Lawyer)"),
    ...V.slidepay.map(([m,r])=>bm(m,r)),
    sp(60),
  ];
}

function aiDevSection(V) {
  return [
    hdr("AI Development  |  Currently Building"),
    ...V.aiDev.website.map(([m,r])=>bm(m,r)),
    ...V.aiDev.handyman.map(([m,r])=>bm(m,r)),
    ...V.aiDev.hyrox.map(([m,r])=>bm(m,r)),
    sp(40),
  ];
}

function educationSection(V) {
  return [
    hdr("Education"),
    ...V.education.map(e=>new Paragraph({spacing:{before:40,after:20},children:[new TextRun({text:e,size:20,font:"Arial",color:DARK})]})),
  ];
}

function buildResume(V, summary, competencyText, atBullets, ehBullets, tools, pmTitle) {
  const children = [
    ...nameBlock(pmTitle),
    hdr("Summary"),
    new Paragraph({spacing:{before:80,after:80},children:[new TextRun({text:summary,size:20,font:"Arial",color:DARK})]}),
    sp(40),
    hdr("Core Competencies"),
    new Paragraph({spacing:{before:60,after:60},children:[new TextRun({text:competencyText,size:19,font:"Arial",color:MED})]}),
    sp(40),
    hdr("Experience"),
    jobHdr("Senior Product Manager","May 2021 -- April 2026"),
    coLine("Atlassian","Enterprise SaaS  |  Team Collaboration & DevOps"),
    ...atBullets.map(([m,r])=>bm(m,r)),
    sp(60),
    jobHdr("Senior Product Manager -- Agent Tools","Sep 2018 -- May 2021"),
    coLine("eHealth","Public HealthTech  |  2,000+ nationwide sales agents"),
    ...ehBullets.map(([m,r])=>bm(m,r)),
    sp(60),
    ...earlyCareer(V),
    hdr("AI & Technical Tooling"),
    new Paragraph({spacing:{before:60,after:60},children:[new TextRun({text:tools,size:19,font:"Arial",color:MED})]}),
    sp(40),
    ...aiDevSection(V),
    ...educationSection(V),
  ];
  return new Document({
    numbering:{config:[{reference:"bullets",levels:[{level:0,format:LevelFormat.BULLET,text:"•",alignment:AlignmentType.LEFT,style:{paragraph:{indent:{left:360,hanging:220}}}}]}]},
    styles:{default:{document:{run:{font:"Arial",size:20,color:DARK}}}},
    sections:[{properties:{page:{size:{width:12240,height:15840},margin:{top:1080,right:1080,bottom:1080,left:1080}}},children}]
  });
}

function buildCoverLetter(role, company, p1, p2, p3) {
  return new Document({
    styles:{default:{document:{run:{font:"Georgia",size:21,color:"1a1a1a"}}}},
    sections:[{properties:{page:{size:{width:12240,height:15840},margin:{top:1440,right:1440,bottom:1440,left:1440}}},
      children:[
        new Paragraph({spacing:{before:0,after:40},children:[new TextRun({text:PROFILE.fullName.toUpperCase(),bold:true,size:32,font:"Arial",color:"1a1a1a"})]}),
        new Paragraph({spacing:{before:0,after:60},border:{bottom:{style:BorderStyle.SINGLE,size:4,color:BLUE,space:6}},children:[new TextRun({text:[PROFILE.email,PROFILE.phone,PROFILE.website].filter(Boolean).join("  |  "),size:18,font:"Arial",color:LIGHT})]}),
        new Paragraph({spacing:{before:180,after:60},children:[new TextRun({text:"June 24, 2026",size:19,font:"Georgia",color:LIGHT})]}),
        new Paragraph({spacing:{before:0,after:240},children:[new TextRun({text:`Re: ${role} at ${company}`,bold:true,size:20,font:"Georgia",color:"1a1a1a"})]}),
        new Paragraph({spacing:{before:0,after:220},children:[new TextRun({text:p1,size:21,font:"Georgia",color:"1a1a1a"})]}),
        new Paragraph({spacing:{before:0,after:220},children:[new TextRun({text:p2,size:21,font:"Georgia",color:"1a1a1a"})]}),
        new Paragraph({spacing:{before:0,after:220},children:[new TextRun({text:p3,size:21,font:"Georgia",color:"1a1a1a"})]}),
        new Paragraph({spacing:{before:200,after:60},children:[new TextRun({text:"Sincerely,",size:21,font:"Georgia",color:"444444"})]}),
        new Paragraph({spacing:{before:0,after:20},children:[new TextRun({text:PROFILE.fullName,bold:true,size:22,font:"Georgia",color:"1a1a1a"})]}),
        new Paragraph({spacing:{before:0,after:0},children:[new TextRun({text:[PROFILE.email,PROFILE.phone].filter(Boolean).join("  |  "),size:18,font:"Georgia",color:LIGHT})]}),
      ]
    }]
  });
}

function toPDF(docxPath, outputDir) {
  const lo = process.env.LIBREOFFICE_BIN || '/Applications/LibreOffice.app/Contents/MacOS/soffice';
  execSync(`"${lo}" --headless --convert-to pdf --outdir "${outputDir}" "${docxPath}"`, {stdio:'pipe'});
  return require('path').join(outputDir, require('path').basename(docxPath, '.docx') + '.pdf');
}

module.exports = { buildResume, buildCoverLetter, Packer, toPDF };
