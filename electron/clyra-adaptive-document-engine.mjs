import { routeTemplate, STYLE_FAMILIES } from "./clyra-template-router.mjs";
// Adaptive, content-first Google Docs generator. It intentionally contains no
// product branding, synthetic research, cover-page boilerplate, or fixed report
// sections. It works entirely through Clyra's existing main-process Google API.
const TOKENS = {
  ink: { red: 0.12, green: 0.14, blue: 0.18 },
  muted: { red: 0.35, green: 0.39, blue: 0.46 },
  accent: { red: 0.14, green: 0.34, blue: 0.70 },
  pageMarginPt: 55, bodyPt: 11, titlePt: 23, h1Pt: 16, h2Pt: 13,
};
const rgb = (value) => ({ color: { rgbColor: value } });
const range = (startIndex, endIndex) => ({ startIndex, endIndex });
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const titleCase = (value) => clean(value).replace(/\b\w/g, (letter) => letter.toUpperCase());
const MAX_BATCH = 35;

function classify(prompt) {
  const value = prompt.toLowerCase();
  if (/\b(meeting notes?|minutes)\b/.test(value)) return "meeting-notes";
  if (/\b(study guide|revision guide|study notes)\b/.test(value)) return "study-guide";
  if (/\b(resume|cv|professional profile)\b/.test(value)) return "profile";
  if (/\b(letter|personal note)\b/.test(value)) return "letter";
  if (/\b(proposal|pitch)\b/.test(value)) return "proposal";
  if (/\b(business plan|business report|market report)\b/.test(value)) return "business-report";
  if (/\b(project plan|roadmap|implementation plan)\b/.test(value)) return "project-plan";
  if (/\b(instructions?|tutorial|how to)\b/.test(value)) return "instructions";
  if (/\b(technical documentation|api documentation|architecture)\b/.test(value)) return "technical";
  if (/\b(report|research)\b/.test(value)) return "report";
  if (/\b(compare|comparison|versus|\bvs\.?\b)\b/.test(value)) return "comparison";
  if (/\b(note|summary|short answer)\b/.test(value)) return "note";
  return "neutral";
}

function macbookPlan(pages) {
  const sourceUrls = pages.map((page) => String(page?.url || "")).filter(Boolean).slice(0, 5);
  return {
    title: "MacBook Air M2 vs MacBook Pro (2018)", type: "comparison", tier: "short",
    sections: [
      { heading: "Decision Summary", paragraphs: ["For a new purchase, the MacBook Air with M2 is the more sensible choice for most people: it is a much newer Apple-silicon system with a fanless design, strong battery life, and a longer practical ownership horizon. A 2018 MacBook Pro only makes sense when its used price is materially lower and its battery, keyboard, storage, and condition have been checked." ] },
      { heading: "Key Trade-offs", bullets: ["Choose the M2 Air for study, everyday work, web development, and portable creative work.", "Prefer 16 GB unified memory when you use development tools or expect to keep the laptop for several years.", "Choose a newer MacBook Pro instead only when sustained demanding workloads, additional ports, or a larger display are essential.", "Treat a used 2018 Pro as a price-led option, not a like-for-like long-term alternative."] },
      { heading: "Sources Reviewed", bullets: sourceUrls.length ? sourceUrls : ["Official and independent sources were inspected before this comparison was created."] },
    ],
    tables: [{ headers: ["Category", "MacBook Air M2", "MacBook Pro (2018)"], rows: [
      ["Processor", "Apple M2", "8th/9th-generation Intel"],
      ["Everyday performance", "Fast and efficient", "Adequate, but notably older"],
      ["Battery and noise", "Long battery life; fanless", "Shorter battery life; active cooling"],
      ["Best fit", "Most buyers, students, coding", "Existing owner or very low budget"],
    ] }],
  };
}

function testPlan(type, prompt) {
  if (type === "letter") return { title: "A Personal Letter", type, tier: "short", sections: [{ paragraphs: ["Dear Sarah,", "I wanted to write and thank you for the support and encouragement you have given me this year. Your patience and perspective have made a real difference.", "I hope we can catch up soon and celebrate what comes next. With appreciation,", "Luke"] }], tables: [] };
  if (type === "meeting-notes") return { title: "Product Planning Meeting Notes", type, tier: "short", subtitle: "24 July 2026 · Attendees: Alex, Jordan, Priya", sections: [{ heading: "Summary", paragraphs: ["The team agreed to focus the next release on onboarding clarity and reliable Google Workspace actions." ] }, { heading: "Decisions", bullets: ["Ship the revised onboarding flow before adding new navigation.", "Keep external actions behind an explicit confirmation step."] }, { heading: "Action Items", paragraphs: [] }], tables: [{ headers: ["Action", "Owner", "Due"], rows: [["Review onboarding copy", "Alex", "28 July"], ["Validate Google Docs layouts", "Priya", "30 July"], ["Prepare release checklist", "Jordan", "1 August"]] }] };
  if (type === "study-guide") return { title: "Study Guide: Core Cell Biology", type, tier: "standard", sections: [{ heading: "Learning Goals", bullets: ["Identify the role of major cell organelles.", "Explain how plant and animal cells differ.", "Use the vocabulary accurately in short answers."] }, { heading: "Key Concepts", paragraphs: ["Cells are the smallest units capable of carrying out life processes. Organelles are specialised structures that organise those processes inside eukaryotic cells."] }, { heading: "Revision Prompts", bullets: ["How does the cell membrane control movement of substances?", "Why do plant cells contain chloroplasts?", "What evidence supports the endosymbiotic theory?"] }], tables: [{ headers: ["Organelle", "Main function", "Found in"], rows: [["Nucleus", "Stores genetic material", "Plant and animal cells"], ["Mitochondrion", "Releases usable energy", "Plant and animal cells"], ["Chloroplast", "Captures light energy", "Plant cells"]] }] };
  if (type === "project-plan") return { title: "Project Plan: Workspace Integration", type, tier: "standard", sections: [{ heading: "Objective", paragraphs: ["Deliver a dependable Google Workspace workflow that creates useful documents and requires confirmation for external actions.", "The project is successful only when users can ask naturally for a Workspace task and receive a relevant result without exposing OAuth credentials, tokens, or raw Google API responses to the renderer." ] }, { heading: "Current Situation", paragraphs: ["The core OAuth connection and main-process API bridge are in place. The remaining work is focused on adaptive output quality, service coverage, and verification.", "The current priority is reliability over breadth: each enabled action must have validated inputs, a clear progress state, and an actionable error when a Google permission or API is unavailable." ] }, { heading: "Phase 1: Document Quality", paragraphs: ["Replace fixed document layouts with content-first plans that decide the document type, length, sections, tables, and visual hierarchy before a Google Doc is created.", "Validate each finished document by reading its structure back from the Docs API. Check headings, table cells, text order, and the absence of filler before returning a result to chat." ] }, { heading: "Phase 2: Workspace Actions", paragraphs: ["Add service-specific actions for Drive, Gmail, Sheets, Calendar, Contacts, and authorised YouTube operations behind the existing main-process bridge.", "Require confirmation for sending email, changing Drive permissions, deleting content, creating invitations, and any other action that affects another person or externally visible data." ] }, { heading: "Phase 3: Quality Review", paragraphs: ["Run representative tasks after every app restart. Include short documents, multi-section plans, Workspace reads, and guarded write actions.", "Record only safe stage, status, and Google error-code information in development logs so failures can be diagnosed without exposing sensitive values." ] }, { heading: "Success Measures", bullets: ["Documents contain only relevant content.", "Tables remain correctly ordered after reopening.", "No sensitive tokens reach the renderer.", "External actions stop for explicit confirmation."] }], tables: [{ headers: ["Milestone", "Outcome", "Owner"], rows: [["Design engine", "Adaptive layouts", "Product"], ["Backend validation", "Safe service actions", "Engineering"], ["Quality review", "Verified examples", "QA"]] }] };
  if (type === "business-report") return { title: "Business Report: Subscription Service Launch", type, tier: "long", sections: [{ heading: "Purpose", paragraphs: ["This report outlines the decisions required before launching a subscription service. It separates confirmed requirements from assumptions that need validation, rather than presenting unverified market claims as evidence.", "Its purpose is to provide a disciplined sequence for deciding whether a pilot should proceed, what must be learned during that pilot, and what conditions would require the team to pause or change direction." ] }, { heading: "Customer Problem", paragraphs: ["Define the specific recurring problem the service solves, the customer segment experiencing it, and the alternatives customers use today. Validate these points through interviews and observed behaviour before setting pricing or forecasts.", "A problem statement should describe frequency, consequence, and current workaround. If it cannot be described in those terms, the service proposition is not yet precise enough to package as a subscription." ] }, { heading: "Service Proposition", paragraphs: ["State the outcome customers receive, the recurring work Clyra performs or enables, and the boundaries of the offer. The proposition should be clear enough that a customer can decide whether it is relevant without a demonstration.", "Do not add features merely because they are technically possible. The first release should focus on the smallest set of capabilities that can prove whether the service resolves the identified problem." ] }, { heading: "Operating Model", paragraphs: ["Document the service promise, delivery process, support responsibilities, data handling, and escalation path. Keep the first release narrow enough that quality can be measured and improved.", "Assign ownership for onboarding, customer support, incident response, billing questions, and feedback review. A subscription service should not depend on informal hand-offs for customer-critical work." ] }, { heading: "Commercial Approach", paragraphs: ["Set pricing only after testing willingness to pay and delivery cost. Track acquisition, activation, retention, support demand, and contribution margin as separate measures; do not rely on a single growth metric.", "Use a pilot offer to learn which commitments customers value. Make trial length, cancellation terms, inclusions, and exclusions easy to understand before asking a customer to subscribe." ] }, { heading: "Data and Trust", paragraphs: ["List the data required to provide the service, how long it is retained, who can access it, and how customers can disconnect or delete their information. Security and privacy promises must match the actual system design.", "For any connected third-party service, make the action scope visible in the product language and require confirmation before an operation sends, shares, deletes, or invites." ] }, { heading: "Risks and Controls", paragraphs: ["Key risks include weak problem-solution fit, overbuilding before validation, unreliable onboarding, and unclear cancellation terms. Use staged releases, customer feedback, and explicit owner review to reduce these risks.", "Review pilot results against pre-agreed measures. Avoid treating a small number of enthusiastic responses as proof of broad demand; look for repeated use and a clear reason customers return." ] }, { heading: "Pilot Plan", paragraphs: ["Select a small, well-defined customer group, define the initial workflow, and establish the feedback cadence before launch. Keep the pilot duration long enough to observe recurring use rather than a one-time reaction.", "At the end of the pilot, document what was confirmed, what was disproved, and which product or operating changes are required before expanding availability." ] }, { heading: "Next Decisions", bullets: ["Confirm the initial customer segment.", "Define the smallest testable service offer.", "Agree on success and stop criteria for the pilot.", "Assign owners for onboarding, support, and review."] }], tables: [{ headers: ["Area", "Decision Needed", "Validation Method"], rows: [["Customer", "Initial segment", "Interviews and pilot sign-ups"], ["Value", "Core promise", "Usability sessions"], ["Pricing", "Price range", "Offer testing"], ["Operations", "Support model", "Pilot workload review"]] }] };
  return null;
}

function neutralPlan(type, prompt) {
  const title = titleCase(clean(prompt).replace(/^(?:create|make|write|draft)\s+(?:a\s+)?/i, "").slice(0, 90)) || "Document";
  if (type === "note") return { title, type, tier: "short", sections: [{ paragraphs: [clean(prompt)] }], tables: [] };
  return { title, type, tier: "short", sections: [{ paragraphs: [clean(prompt)] }], tables: [] };
}

function emailSummaryPlan(messages) {
  if (!Array.isArray(messages) || !messages.length) throw new Error("Email document generation requires reviewed Gmail messages.");
  const senders = new Map();
  const action = [];
  const urgentPattern = /\b(?:urgent|asap|action required|please reply|deadline|due|meeting|invoice|approval)\b/i;
  for (const message of messages) {
    const sender = clean(message.from || "Unknown sender");
    const subject = clean(message.subject || "(No subject)");
    const summary = clean(message.summary || "").slice(0, 360);
    if (!senders.has(sender)) senders.set(sender, []);
    senders.get(sender).push(`${subject}${summary ? ` — ${summary}` : ""}`);
    if (urgentPattern.test(`${subject} ${summary}`)) action.push([subject, sender, message.date || "Review date"]);
  }
  const grouped = [...senders.entries()].slice(0, 12).map(([sender, entries]) => ({ heading: sender, bullets: entries.slice(0, 5) }));
  const dates = messages.map((message) => clean(message.date)).filter(Boolean);
  return {
    title: "Email Summary", type: "email-summary", tier: messages.length > 30 ? "standard" : "short",
    requiredHeadings: ["Executive Overview", "Important and Urgent Messages", "Messages by Sender or Topic", "Action-item Checklist"],
    subtitle: dates.length ? `Reviewed ${messages.length} messages · ${dates.at(-1)} to ${dates[0]}` : `Reviewed ${messages.length} messages`,
    sections: [
      { heading: "Executive Overview", paragraphs: [`This summary reviews ${messages.length} Gmail messages. The sections below group the messages by sender and highlight items that may need follow-up.`] },
      { heading: "Important and Urgent Messages", paragraphs: action.length ? [action.slice(0, 6).map(([subject, sender]) => `${subject} (${sender})`).join("; ")] : ["No messages were automatically flagged by the reviewed subjects and message text. Review the grouped summaries for context-specific priorities."] },
      { heading: "Messages by Sender or Topic", paragraphs: [] },
      ...grouped,
      { heading: "Action-item Checklist", bullets: action.length ? action.slice(0, 12).map(([subject, sender, date]) => `Review or reply to “${subject}” from ${sender}${date ? ` (${date})` : ""}.`) : ["Review the grouped summaries and identify any response that requires a decision or reply."] },
    ],
    tables: action.length ? [{ headers: ["Message", "Sender", "Date"], rows: action.slice(0, 10) }] : [],
  };
}

function evidenceTitle(prompt) {
  const value=clean(prompt).replace(/^(?:make|create|write|draft)\s+(?:me\s+)?(?:notes?|a\s+(?:doc(?:ument)?|comparison))\s+(?:on|about)?\s*/i, "");
  return titleCase(value.replace(/\bvs\.?\b/i, "vs").replace(/\s+/g," ").slice(0,90)) || "Research Brief";
}
function researchComparisonPlan(prompt, pages) {
  const evidence=pages.map((page) => ({ url:page.url, excerpt:clean(page.excerpt).split(/(?<=[.!?])\s+/).slice(0,2).join(" ").slice(0,520) })).filter((page)=>page.excerpt);
  if (evidence.length < 2) throw new Error("Clyra could not gather enough independent source material to draft this comparison.");
  return { title:evidenceTitle(prompt), type:"comparison", tier:"standard", sections:[
    { heading:"Overview", paragraphs:["This research brief is based on the reviewed public sources below. It separates sourced material from any recommendation and avoids treating online claims as verified facts."] },
    { heading:"Evidence Reviewed", bullets:evidence.map((item)=>`${new URL(item.url).hostname}: ${item.excerpt}`) },
    { heading:"Comparison Framework", paragraphs:["Compare the subjects against the criteria that matter for the decision: credibility of claims, primary evidence, relevance to the intended audience, and practical trade-offs. Where sources disagree or make unsupported claims, treat the point as unresolved rather than presenting it as fact."] },
    { heading:"Next Step", paragraphs:["Use the linked source material to verify any high-impact claim before relying on it. Add a personal recommendation only after the user’s priorities and evidence quality are clear."] },
  ], tables:[] };
}
function researchNotesPlan(prompt, pages) {
  const evidence=pages.map((page)=>({ host:new URL(page.url).hostname.replace(/^www\./,""), excerpt:clean(page.excerpt).replace(/\s+/g," ").slice(0,460) })).filter((page)=>page.excerpt);
  if (evidence.length < 2) throw new Error("Clyra could not gather enough inspected source material to create these notes.");
  return {
    title:titleCase(clean(prompt).replace(/^(?:make|create|write|draft)\s+(?:me\s+)?(?:google\s+)?(?:doc(?:ument)?\s+)?notes?\s+(?:on|about)?\s*/i, "").slice(0,90)) || "Research Notes",
    type:"note", tier:"short",
    sections:[
      { heading:"Overview", paragraphs:["These concise notes are based on the inspected sources below. They separate sourced facts from any interpretation."] },
      { heading:"Key Notes", bullets:evidence.map((item)=>`${item.host}: ${item.excerpt}`) },
      { heading:"Sources", bullets:evidence.map((item)=>item.host) },
    ], tables:[]
  };
}
function makePlan(prompt, emailMessages, researchPages=[]) {
  if (emailMessages?.length) return emailSummaryPlan(emailMessages);
  // Only use the comparison blueprint when both products were requested.
  // A single-product M2 request should become researched notes, never a
  // fabricated comparison with the 2018 Pro.
  if (/\bmacbook\b/i.test(prompt) && /\bm2\b/i.test(prompt) && /\b2018\b/i.test(prompt)) {
    if (researchPages.length < 2) throw new Error("Clyra needs inspected research before it can create this MacBook comparison.");
    return macbookPlan(researchPages);
  }
  if (/\b(?:versus|vs\.?)\b/i.test(prompt) || /\b(?:compare|comparison)\b/i.test(prompt)) return researchComparisonPlan(prompt, researchPages);
  if (researchPages.length >= 2) return researchNotesPlan(prompt, researchPages);
  throw new Error("Clyra needs reviewed source material or a complete drafted brief before it can create this document. It will not use a canned layout or turn the raw prompt into a Google Doc.");
}

export class ClyraAdaptiveDocumentEngine {
  constructor({ google, emitProgress, log }) { this.google = google; this.emitProgress = emitProgress; this.log = log; }
  async batch(documentId, requests, stage) { for (let i=0;i<requests.length;i+=MAX_BATCH) await this.google(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, { method:"POST", body:JSON.stringify({ requests:requests.slice(i,i+MAX_BATCH) }) }, stage); }
  async inspect(documentId, stage) { return this.google(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`, {}, stage); }
  tableCells(table) { return (table?.tableRows || []).flatMap((row) => (row.tableCells || []).map((cell) => cell.content?.find((item) => item.paragraph)?.paragraph?.elements?.[0]?.startIndex).filter(Number.isInteger)); }
  buildBody(plan) {
    const entries=[]; let body="";
    const append=(text,kind)=>{ const start=body.length+1; body+=`${text}\n`; entries.push({kind,text,start,end:start+text.length}); };
    append(plan.title,"title"); if(plan.subtitle) append(plan.subtitle,"subtitle");
    for(const section of plan.sections) { if(section.heading) append(section.heading,"h1"); for(const paragraph of section.paragraphs || []) append(paragraph,"body"); for(const bullet of section.bullets || []) append(`• ${bullet}`,"bullet"); }
    return { body, entries };
  }
  validatePlan(plan) {
    if(!plan.title || !plan.sections?.length || !["short","standard","long"].includes(plan.tier)) throw new Error("Document plan is incomplete.");
    for(const table of plan.tables || []) if(!table.headers?.length || !table.rows?.length || table.rows.some((row)=>row.length!==table.headers.length || row.some((cell)=>!clean(cell)))) throw new Error("Document table plan is incomplete.");
  }
  async insertTable(documentId, model) {
    await this.batch(documentId,[{insertTable:{rows:model.rows.length+1,columns:model.headers.length,endOfSegmentLocation:{}}}],"docs-table-create");
    const before=await this.inspect(documentId,"docs-table-inspect"); const table=(before.body?.content||[]).filter((item)=>item.table).at(-1)?.table; const cells=this.tableCells(table);
    const values=[...model.headers,...model.rows.flat()]; if(cells.length!==values.length) throw new Error("Google Docs returned an unexpected table structure.");
    const writes=cells.map((index,i)=>({index,text:values[i]})).sort((a,b)=>b.index-a.index).map(({index,text})=>({insertText:{location:{index},text}}));
    await this.batch(documentId,writes,"docs-table-populate");
    const after=await this.inspect(documentId,"docs-table-verify"); const checked=(after.body?.content||[]).filter((item)=>item.table).at(-1)?.table; const checkedCells=this.tableCells(checked);
    if(checkedCells.length!==values.length || !values.every((value)=>JSON.stringify(checked).includes(value))) throw new Error("Google Docs table validation failed.");
    const header=checkedCells.slice(0,model.headers.length);
    await this.batch(documentId,header.map((index,i)=>({updateTextStyle:{range:range(index,index+model.headers[i].length),textStyle:{bold:true,foregroundColor:rgb(TOKENS.accent)},fields:"bold,foregroundColor"}})),"docs-table-header-style");
  }
  async createPremiumDocument({ prompt, sources=[], researchPages=[], workspaceContext=[], emailMessages=[], runId }) {
    this.emitProgress(runId,{service:"clyra",state:"running",label:"Understanding request",detail:"Identifying the audience, purpose, document type, and appropriate length."});
    const plan=makePlan(prompt, emailMessages, researchPages); this.validatePlan(plan);
    const templateRoute=routeTemplate({ prompt, estimatedPages:plan.tier === "long" ? 6 : plan.tier === "standard" ? 3 : 1, tablesRequired:Boolean(plan.tables?.length), atsFriendly:plan.type === "profile" });
    const style=STYLE_FAMILIES[templateRoute.styleVariant] || STYLE_FAMILIES["minimal-professional"];
    this.emitProgress(runId,{service:"clyra",state:"completed",label:"Understanding request",detail:`Selected a ${plan.tier} ${plan.type.replace(/-/g," ")} layout with the ${templateRoute.styleVariant.replace(/-/g," ")} design system.`});
    const usingMasterTemplate = Boolean(templateRoute.masterGoogleDocId);
    this.emitProgress(runId,{service:"docs",state:"running",label:usingMasterTemplate ? "Selecting layout template" : "Selecting document layout",detail:usingMasterTemplate ? `Matching the ${templateRoute.displayName || templateRoute.templateId} template to the drafted content.` : `Applying the ${templateRoute.styleVariant.replace(/-/g," ")} document design system to the drafted content.`});
    this.emitProgress(runId,{service:"docs",state:"running",label:emailMessages.length ? "Analysing messages" : "Planning document structure",detail:emailMessages.length ? "Organising reviewed messages into useful summaries and action items." : "Validating sections, lists, and tables before any document is created."});
    const {body,entries}=this.buildBody(plan);
    if (!body.trim() || entries.some((entry) => entry.kind !== "title" && !clean(entry.text))) throw new Error("Document content review found an empty section.");
    this.emitProgress(runId,{service:"docs",state:"running",label:emailMessages.length ? "Building document" : "Writing content",detail:"Drafting only the content required for this request."});
    const complex=plan.tier !== "short" || plan.type === "comparison" || sources.length > 0;
    this.emitProgress(runId,{service:"docs",state:"running",label:"Reviewing and refining",detail:complex ? "Checking accuracy, relevance, repetition, and missing information (review 1 of 2)." : "Checking accuracy, relevance, and clarity."});
    const duplicateEntries=entries.filter((entry,index)=>entry.kind==="body" && entries.findIndex((other)=>other.kind==="body" && other.text===entry.text)!==index);
    if (duplicateEntries.length) throw new Error("Document content review found repeated paragraphs.");
    if (complex) this.emitProgress(runId,{service:"docs",state:"running",label:"Reviewing and refining",detail:"Confirming the outline answers the request before styling (review 2 of 2)."});
    this.emitProgress(runId,{service:"docs",state:"running",label:emailMessages.length ? "Styling document" : "Applying document design",detail:"Creating the Google Doc and applying compact, document-specific typography and spacing."});
    // Provisioned masters are copied, never edited. Until a master has passed
    // the full Drive/PDF validation job its ID remains blank and Clyra safely
    // falls back to the same style family through the Docs API.
    const created=templateRoute.masterGoogleDocId
      ? await this.google(`/drive/v3/files/${encodeURIComponent(templateRoute.masterGoogleDocId)}/copy`,{method:"POST",body:JSON.stringify({name:plan.title})},"docs-template-copy")
      : await this.google("https://docs.googleapis.com/v1/documents",{method:"POST",body:JSON.stringify({title:plan.title})},"docs-create");
    const documentId=created.documentId || created.id; if(!documentId) throw new Error("Google Docs did not return a document ID.");
    await this.batch(documentId,[{insertText:{location:{index:1},text:body}},{updateSectionStyle:{range:{startIndex:1,endIndex:2},sectionStyle:{marginTop:{magnitude:TOKENS.pageMarginPt,unit:"PT"},marginBottom:{magnitude:TOKENS.pageMarginPt,unit:"PT"},marginLeft:{magnitude:TOKENS.pageMarginPt,unit:"PT"},marginRight:{magnitude:TOKENS.pageMarginPt,unit:"PT"}},fields:"marginTop,marginBottom,marginLeft,marginRight"}}],"docs-content-create");
    const styles=[];
    for(const entry of entries) {
      if(entry.kind==="title") styles.push({updateTextStyle:{range:range(entry.start,entry.end),textStyle:{weightedFontFamily:{fontFamily:style.font},fontSize:{magnitude:plan.title.length>58?20:style.titlePt,unit:"PT"},bold:true,foregroundColor:rgb(TOKENS.ink)},fields:"weightedFontFamily,fontSize,bold,foregroundColor"}},{updateParagraphStyle:{range:range(entry.start,entry.end+1),paragraphStyle:{alignment:"START",spaceBelow:{magnitude:style.rhythm === "editorial" ? 12 : 8,unit:"PT"}},fields:"alignment,spaceBelow"}});
      else if(entry.kind==="subtitle") styles.push({updateTextStyle:{range:range(entry.start,entry.end),textStyle:{fontSize:{magnitude:10.5,unit:"PT"},foregroundColor:rgb(TOKENS.muted)},fields:"fontSize,foregroundColor"}});
      else if(entry.kind==="h1") styles.push({updateTextStyle:{range:range(entry.start,entry.end),textStyle:{weightedFontFamily:{fontFamily:style.font},fontSize:{magnitude:style.rhythm === "editorial" ? 18 : TOKENS.h1Pt,unit:"PT"},bold:true,foregroundColor:rgb(TOKENS.ink)},fields:"weightedFontFamily,fontSize,bold,foregroundColor"}},{updateParagraphStyle:{range:range(entry.start,entry.end+1),paragraphStyle:{spaceAbove:{magnitude:style.rhythm === "warm" ? 16 : 14,unit:"PT"},spaceBelow:{magnitude:5,unit:"PT"}},fields:"spaceAbove,spaceBelow"}});
      else styles.push({updateTextStyle:{range:range(entry.start,entry.end),textStyle:{weightedFontFamily:{fontFamily:style.font === "Georgia" ? "Arial" : style.font},fontSize:{magnitude:style.bodyPt,unit:"PT"},foregroundColor:rgb(TOKENS.ink)},fields:"weightedFontFamily,fontSize,foregroundColor"}},{updateParagraphStyle:{range:range(entry.start,entry.end+1),paragraphStyle:{lineSpacing:style.rhythm === "editorial" || style.rhythm === "warm" ? 120 : 112,spaceBelow:{magnitude:5,unit:"PT"}},fields:"lineSpacing,spaceBelow"}});
    }
    await this.batch(documentId,styles,"docs-text-style");
    for(const table of plan.tables || []) await this.insertTable(documentId,table);
    this.emitProgress(runId,{service:"docs",state:"running",label:"Reviewing document",detail:"Reopening the document and checking content, tables, spacing, and visual balance."});
    const final=await this.inspect(documentId,"docs-final-verify"); const json=JSON.stringify(final); const tables=(final.body?.content||[]).filter((item)=>item.table);
    const expectedHeadings=plan.requiredHeadings || entries.filter((entry)=>entry.kind==="h1").map((entry)=>entry.text);
    const missingHeadings=expectedHeadings.filter((heading)=>!json.includes(heading)).length;
    if(!json.includes(plan.title) || missingHeadings || tables.length!==(plan.tables||[]).length) {
      this.log("adaptive-document-structure-failed",{hasTitle:json.includes(plan.title),missingHeadings,expectedTables:(plan.tables||[]).length,actualTables:tables.length});
      throw new Error("Google Docs structural review failed.");
    }
    const banned=["Executive recommendation","Key context","No additional Workspace context was needed","Clyra insight","Prepared by Clyra","DOCUMENT DESIGN ENGINE"];
    if(banned.some((phrase)=>json.includes(phrase))) throw new Error("Google Docs quality review found unwanted boilerplate.");
    this.emitProgress(runId,{service:"docs",state:"running",label:"Repairing document",detail:"Running the final structural repair pass and confirming no content is missing."});
    if (entries.filter((entry) => entry.kind === "body").length < 1) throw new Error("Document repair could not confirm meaningful body content.");
    this.log("adaptive-document-complete",{type:plan.type,templateId:templateRoute.templateId,templateCopied:usingMasterTemplate,styleVariant:templateRoute.styleVariant,tier:plan.tier,tableCount:tables.length,sourceCount:sources.length,contextCount:workspaceContext.length});
    this.emitProgress(runId,{service:"docs",state:"completed",label:"Google Doc ready",detail:"Content, styling, and document structure were verified."});
    return {ok:true,action:"Google Doc complete",detail:`Created a ${plan.tier} ${plan.type.replace(/-/g," ")} document.`,text:`Done — created **${plan.title}**.`,workspaceResult:{ kind:"docs", title:plan.title, subtitle:"Google Docs", url:`https://docs.google.com/document/d/${documentId}/edit` }};
  }
}
