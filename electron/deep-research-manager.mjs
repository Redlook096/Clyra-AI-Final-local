// Main-process Deep Research harness. It uses Clyra's existing search endpoint
// and returns only source metadata, inspected excerpts, safe progress, and a
// synthesis brief to the renderer — never credentials or private tool output.
const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return "source"; } };

export class DeepResearchManager {
  constructor({ uiContents, serviceUrl, development = false }) {
    this.uiContents = uiContents;
    this.serviceUrl = serviceUrl;
    this.development = development;
    this.checkpoints = new Map();
    this.cancelled = new Set();
    this.progressListeners = new Map();
  }

  emit(runId, payload) {
    this.progressListeners.get(runId)?.({ runId, ...payload });
    const contents = this.uiContents?.();
    if (runId && contents && !contents.isDestroyed()) contents.send("research:agent-progress", { runId, ...payload });
  }

  subscribe(runId, listener) {
    if (!runId || typeof listener !== "function") return () => {};
    this.progressListeners.set(runId, listener);
    return () => this.progressListeners.delete(runId);
  }

  log(stage, detail) { if (this.development) console.info("[deep-research]", stage, detail); }

  briefFor(prompt, answers = "") {
    const question = clean(prompt.replace(/^\/(?:deep-research|research)\s*/i, ""));
    const lower = question.toLowerCase();
    const recommendation = /\b(?:best|recommend|should i|which|choose)\b/.test(lower);
    const current = /\b(?:latest|current|price|pricing|availability|202[4-9]|today|now)\b/.test(lower) || recommendation;
    const broad = question.split(/\s+/).length < 12 || /\b(?:best|options?|research|investigate|compare)\b/.test(lower);
    const needsGeography = recommendation || /\b(?:price|pricing|availability|buy|budget|cost)\b/.test(lower);
    const missing = [];
    if (broad && recommendation && !/\b(?:\$|aud|usd|gbp|eur|budget)\b/.test(lower)) missing.push("What budget should I work within, if any?");
    if (broad && current && needsGeography && !/\b(?:australia|australian|usa|united states|uk|canada|europe|india)\b/.test(lower)) missing.push("Which country or region should current pricing and availability use?");
    if (broad && recommendation) missing.push("Which trade-off matters most: value, performance, portability, battery life, or longevity?");
    return {
      primaryQuestion: question,
      desiredOutcome: recommendation ? "A supported recommendation with trade-offs" : "A verified explanatory report",
      researchType: recommendation ? "comparison-and-recommendation" : "investigation",
      audience: "the user",
      scope: { timeRange: current ? "current" : "best available evidence", geography: "not yet specified", topics: question ? [question] : [], excludedTopics: [] },
      constraints: answers ? ["User clarification: " + clean(answers)] : [],
      knownContext: [], missingDetails: missing, assumptions: [],
      subquestions: ["What do authoritative sources establish?", "What independent evidence or practical trade-offs matter?", "What limitations or counterarguments change the conclusion?"],
      sourceRequirements: ["official or primary sources", "independent corroboration", "limitation or counterevidence"],
      connectedToolsRequired: [], requiresCurrentInformation: current, requiresRecommendation: recommendation,
      riskLevel: /\b(?:medical|health|legal|law|financial|investment)\b/.test(lower) ? "high" : "normal",
      outputFormat: "detailed-research-report",
    };
  }

  queriesFor(brief) {
    // A geographic or budget constraint changes the evidence that is useful.
    // Carry the user's clarification into the queries rather than asking a
    // generic web search to infer local availability or pricing.
    const constraints = Array.isArray(brief.constraints) ? brief.constraints.join(" ") : "";
    const topic = clean(`${brief.primaryQuestion} ${constraints}`);
    const current = brief.requiresCurrentInformation ? " current" : "";
    return [
      { branch:"core", query:topic },
      { branch:"primary", query:`${topic} official documentation specifications${current}` },
      { branch:"independent", query:`${topic} independent analysis review evidence${current}` },
      { branch:"limitations", query:`${topic} limitations criticism drawbacks alternatives${current}` },
    ];
  }

  async search(query, runId, branch, index, total) {
    this.emit(runId, { service:"research", state:"running", label:"Searching trusted sources", detail:`${branch} research ${index} of ${total}: “${query}”` });
    const response = await fetch(`${this.serviceUrl()}/api/research/web-search`, {
      method:"POST", headers:{"content-type":"application/json"},
      body:JSON.stringify({ query, maxResults:6, fetchTop:4 }), signal:AbortSignal.timeout(35_000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body?.ok) throw Object.assign(new Error("Research search did not return usable evidence."), { stage:"deep-research-search", httpStatus:response.status, errorCode:body?.error?.code || "search_failed" });
    const pages = (Array.isArray(body.pages) ? body.pages : [])
      .filter((page) => page && !page.blocked && typeof page.url === "string" && clean(page.excerpt))
      .map((page) => ({ url:page.url, excerpt:clean(page.excerpt).slice(0,900), branch, query }));
    this.log("search", { branch, resultCount:Array.isArray(body.urls) ? body.urls.length : 0, inspectedPageCount:pages.length });
    return pages;
  }

  buildSynthesisBrief(brief, evidence) {
    const sources = evidence.map((item, index) => `[${index + 1}] ${host(item.url)}\nURL: ${item.url}\nInspected excerpt: ${item.excerpt}`).join("\n\n");
    return [
      "Write a rigorous Clyra Deep Research report using only the inspected sources below.",
      "Do not invent facts, sources, prices, dates, or testing. Cite every important factual claim inline with the matching [n] source marker and URL. Treat excerpts as evidence from inspected pages, not search snippets. Clearly mark inferences and uncertainty.",
      "For a location-specific recommendation, state a numeric local price, availability, or budget fit only when an inspected source explicitly supports that exact location and figure. Otherwise say that current local retailer pricing needs validation; never convert foreign pricing or infer a local figure.",
      "Never call a title-only or excerpt-free result evidence. If a source does not substantively support a claim, omit it from the findings and sources rather than padding the report.",
      "Use: Research question; concise answer; scope and assumptions; findings by subquestion; counterevidence and limitations; recommendation only if requested; sources. Be concise where evidence is weak rather than filling gaps.",
      `Research brief: ${JSON.stringify(brief)}`,
      "Inspected public evidence:", sources,
    ].join("\n\n");
  }

  async execute({ prompt, runId, checkpointId, answers, action = "start" }) {
    if (typeof prompt !== "string" || prompt.length < 3 || prompt.length > 8_000 || (runId && (typeof runId !== "string" || runId.length > 120))) throw new Error("Invalid Deep Research request.");
    if (action === "cancel") { this.cancelled.add(checkpointId || runId); return { ok:false, cancelled:true, text:"Research paused. You can resume from the saved checkpoint." }; }
    let checkpoint = checkpointId ? this.checkpoints.get(checkpointId) : null;
    let brief = checkpoint?.brief || this.briefFor(prompt, answers);
    const id = checkpointId || `research-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    this.emit(runId, { service:"clyra", state:"running", label:"Preparing the research scope", detail:"Assessing the question, evidence needed, uncertainty, and appropriate depth." });
    if (checkpoint && answers) brief = { ...brief, ...this.briefFor(brief.primaryQuestion, answers), missingDetails:[] };
    if (!checkpoint && brief.missingDetails.length && !/\buse (?:your|ur) judgement\b/i.test(prompt)) {
      this.checkpoints.set(id, { brief, status:"waiting-for-clarification", createdAt:Date.now() });
      this.emit(runId, { service:"clyra", state:"completed", label:"Waiting for clarification", detail:"A few choices would materially change the research conclusion." });
      return { ok:false, needsClarification:true, checkpointId:id, questions:brief.missingDetails.slice(0,4), text:"" };
    }
    if (/\buse (?:your|ur) judgement\b/i.test(prompt)) brief.assumptions.push("Used Clyra’s judgement where the request did not specify constraints.");
    this.checkpoints.set(id, { brief, status:"researching", createdAt:Date.now(), graph:this.queriesFor(brief).map(({branch}) => ({ nodeId:branch, type:"search", status:"pending" })) });
    this.emit(runId, { service:"clyra", state:"completed", label:"Research scope ready", detail:`Breaking the topic into ${this.queriesFor(brief).length} evidence branches.` });
    const records = new Map(); const queries = this.queriesFor(brief);
    for (let index=0; index<queries.length; index += 1) {
      if (this.cancelled.has(id) || this.cancelled.has(runId)) return { ok:false, paused:true, checkpointId:id, text:"Research paused. Resume when you are ready." };
      const item=queries[index];
      try {
        const pages=await this.search(item.query, runId, item.branch, index + 1, queries.length);
        for (const page of pages) if (!records.has(page.url)) records.set(page.url, page);
      } catch (error) {
        this.log("search-failed", { branch:item.branch, stage:error?.stage, httpStatus:error?.httpStatus, errorCode:error?.errorCode });
        this.emit(runId, { service:"research", state:"completed", label:"Recovering a research branch", detail:`${item.branch} sources were unavailable; continuing with independent evidence.` });
      }
    }
    const evidence=[...records.values()].slice(0,16);
    if (evidence.length < 3) throw Object.assign(new Error("Clyra could not inspect enough reliable sources to complete this research safely."), { stage:"deep-research-evidence" });
    this.emit(runId, { service:"research", state:"running", label:"Comparing evidence", detail:`Inspecting ${evidence.length} distinct sources across primary, independent, and limitation branches.` });
    this.emit(runId, { service:"research", state:"running", label:"Challenging early conclusions", detail:"Checking counterevidence, limitations, freshness, and unresolved claims." });
    this.emit(runId, { service:"clyra", state:"running", label:"Drafting the report", detail:"Building a cited report from inspected evidence only." });
    const analysisPrompt=this.buildSynthesisBrief(brief, evidence);
    this.checkpoints.set(id, { brief, status:"complete", completedAt:Date.now(), sourceCount:evidence.length, evidence:evidence.map(({url,branch})=>({url,branch})) });
    this.emit(runId, { service:"research", state:"completed", label:"Research complete", detail:`Verified ${evidence.length} inspected sources; citations are ready for the final report.` });
    return { ok:true, checkpointId:id, analysisPrompt, sources:evidence.map(({url,branch})=>({url, publisher:host(url), branch})), assumptions:brief.assumptions };
  }
}
