// Main-process-only template catalogue. Master IDs are deliberately empty until
// the live Google Docs provisioning job has created and validated each master.
// The router can therefore never silently copy an unverified template.
export const STYLE_FAMILIES = Object.freeze({
  "minimal-professional": { font:"Arial", titlePt:24, bodyPt:11, accent:{red:.14,green:.34,blue:.7}, rhythm:"compact" },
  "modern-editorial": { font:"Georgia", titlePt:28, bodyPt:11, accent:{red:.16,green:.29,blue:.52}, rhythm:"editorial" },
  "structured-corporate": { font:"Roboto", titlePt:24, bodyPt:10.5, accent:{red:.12,green:.31,blue:.61}, rhythm:"structured" },
  "warm-creative": { font:"Georgia", titlePt:26, bodyPt:11.5, accent:{red:.35,green:.32,blue:.28}, rhythm:"warm" },
});

const TYPES = [
  ["quick-note", "Notes", ["title", "content"]], ["meeting-notes", "Meetings", ["purpose", "summary", "decisions", "action-items"]],
  ["meeting-agenda", "Meetings", ["objective", "agenda", "expected-decisions"]], ["essay", "Academic", ["introduction", "body", "conclusion"]],
  ["research-paper", "Academic", ["abstract", "introduction", "findings", "discussion", "references"]], ["study-guide", "Academic", ["learning-goals", "key-concepts", "review-questions"]],
  ["business-report", "Business", ["executive-summary", "findings", "analysis", "recommendations"]], ["business-proposal", "Business", ["opportunity", "solution", "scope", "deliverables", "next-steps"]],
  ["project-plan", "Business", ["objective", "scope", "milestones", "risks", "success-criteria"]], ["business-plan", "Business", ["overview", "market", "model", "operations", "risks"]],
  ["resume", "Career", ["summary", "skills", "experience", "education"]], ["cover-letter", "Career", ["recipient", "opening", "experience", "closing"]],
  ["formal-letter", "Communications", ["sender", "recipient", "subject", "body", "signature"]], ["comparison", "Business", ["decision-question", "criteria", "comparison", "recommendation"]],
  ["technical-documentation", "Technical", ["purpose", "requirements", "usage", "troubleshooting", "security"]], ["standard-operating-procedure", "Technical", ["purpose", "scope", "procedure", "quality-checks"]],
  ["product-brief", "Product", ["problem", "users", "goals", "requirements", "success-metrics"]], ["case-study", "Business", ["challenge", "approach", "results", "lessons"]],
  ["newsletter", "Communications", ["opening", "updates", "events", "links"]], ["invoice", "Finance", ["business", "customer", "items", "totals", "terms"]],
];

export const TEMPLATE_MANIFESTS = Object.freeze(TYPES.flatMap(([documentType, folder, requiredSections]) => Object.keys(STYLE_FAMILIES).map((styleVariant) => ({
  templateId: `${documentType}-${styleVariant}`, documentType, styleVariant,
  displayName: `${styleVariant.replace(/-/g," ").replace(/\b\w/g, (c) => c.toUpperCase())} ${documentType.replace(/-/g," ")}`,
  folder, masterGoogleDocId:"", version:1, requiredSections, optionalSections:[], placeholderMap:{}, namedRanges:{}, tableDefinitions:[], validationRules:["no-placeholders", "meaningful-body", "valid-tables", "consistent-typography"],
}))));

const chooseType = (prompt) => {
  const value = String(prompt || "").toLowerCase();
  const pairs = [["invoice",/\b(invoice|estimate|quote)\b/],["resume",/\b(resume|cv)\b/],["cover-letter",/\bcover letter\b/],["meeting-agenda",/\b(meeting agenda|agenda)\b/],["meeting-notes",/\b(meeting notes?|minutes)\b/],["research-paper",/\b(research paper|abstract)\b/],["study-guide",/\b(study guide|revision)\b/],["technical-documentation",/\b(technical documentation|api documentation|architecture)\b/],["standard-operating-procedure",/\b(sop|standard operating procedure)\b/],["product-brief",/\b(product brief|prd|requirements document)\b/],["case-study",/\bcase study\b/],["newsletter",/\b(newsletter|monthly update)\b/],["comparison",/\b(compare|comparison| versus |\bvs\.?\b)\b/],["business-proposal",/\b(proposal|pitch)\b/],["business-plan",/\bbusiness plan\b/],["project-plan",/\b(project plan|roadmap)\b/],["business-report",/\b(report|investor)\b/],["essay",/\bessay\b/],["formal-letter",/\b(formal letter|letter)\b/],["quick-note",/\b(note|summary)\b/]];
  return pairs.find(([, pattern]) => pattern.test(value))?.[0] || "quick-note";
};

export function routeTemplate({ prompt, audience="", tone="", estimatedPages=1, tablesRequired=false, atsFriendly=false }) {
  const documentType=chooseType(prompt); const text=`${prompt} ${audience} ${tone}`.toLowerCase();
  const styleVariant = atsFriendly || /\b(formal|board|investor|compliance|executive)\b/.test(text) ? "structured-corporate"
    : /\b(creative|reflective|personal|workshop|community)\b/.test(text) ? "warm-creative"
    : /\b(editorial|magazine|story|engaging)\b/.test(text) || estimatedPages > 5 ? "modern-editorial" : "minimal-professional";
  const templateId=`${documentType}-${styleVariant}`;
  const manifest=TEMPLATE_MANIFESTS.find((item)=>item.templateId===templateId);
  return { documentType, styleVariant, templateId, reason:`Selected for the ${documentType.replace(/-/g," ")} purpose, ${styleVariant.replace(/-/g," ")} tone, and ${tablesRequired ? "structured-data" : "content"} needs.`, requiredSections:manifest?.requiredSections || [], optionalSections:[], pageOrientation:"portrait", estimatedPages, needsResearch:/\b(current|latest|compare|research|pricing)\b/i.test(prompt), needsImages:/\b(image|newsletter|portfolio|case study)\b/i.test(prompt), masterGoogleDocId:manifest?.masterGoogleDocId || "" };
}
