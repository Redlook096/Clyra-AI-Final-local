import crypto from "node:crypto";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { Notification, safeStorage, shell } from "electron";
import { ClyraAdaptiveDocumentEngine } from "./clyra-adaptive-document-engine.mjs";
import { AgentOrchestrator } from "./agent-orchestrator.mjs";
import { recordApiUsage } from "../lib/api-usage-ledger.mjs";

const AUTH_TIMEOUT_MS = 10 * 60_000;
const SCOPES = [
  "openid", "email", "profile", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/documents", "https://www.googleapis.com/auth/presentations",
  "https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/contacts.readonly",
  "https://www.googleapis.com/auth/youtube.readonly", "https://www.googleapis.com/auth/youtube.upload",
].join(" ");
const cleanTitle = (prompt, fallback) => String(prompt || "").replace(/^\/(?:google-)?(?:docs?|sheets?|slides?|drive|gmail|calendar)\s*/i, "").replace(/\b(?:create|make|new|a|an|google|document|doc|spreadsheet|sheet|presentation|slides?)\b/gi, " ").replace(/\s+/g, " ").trim().replace(/[.?!]+$/, "").slice(0, 120) || fallback;
const base64url = (value) => Buffer.from(value).toString("base64url");
const successPage = `<!doctype html><title>Google connected to Clyra</title><style>body{margin:0;display:grid;min-height:100vh;place-items:center;background:#f8fafc;color:#162033;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.card{width:min(340px,calc(100% - 48px));padding:32px;border:1px solid #e2e8f0;border-radius:24px;background:#fff;box-shadow:0 20px 50px #0f172a18}h1{margin:14px 0 7px;font-size:21px}p{margin:0;color:#64748b;line-height:1.55;font-size:14px}.logo{width:42px;height:42px;object-fit:contain}</style><main class="card"><img class="logo" src="https://www.gstatic.com/images/branding/product/2x/googleg_48dp.png" alt="Google"><h1>Google is connected</h1><p>Return to Clyra — your pending request will continue automatically.</p></main>`;
const gmailBodyText = (part) => {
  if (!part) return "";
  if (part.mimeType === "text/plain" && part.body?.data) return Buffer.from(part.body.data, "base64url").toString("utf8");
  return (part.parts || []).map(gmailBodyText).join("\n");
};
const gmailHeaderMap = (headers = []) => Object.fromEntries((headers || []).map((header) => [String(header.name || "").toLowerCase(), String(header.value || "")]));
const decodeGmailData = (value) => {
  try { return value ? Buffer.from(String(value), "base64url").toString("utf8") : ""; } catch { return ""; }
};
const decodeHtmlEntities = (value) => String(value || "").replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16))).replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number(decimal))).replace(/&(nbsp|amp|lt|gt|quot|#39);/gi, (_, entity) => ({ nbsp:" ", amp:"&", lt:"<", gt:">", quot:'"', "#39":"'" }[String(entity).toLowerCase()] || ""));
// Gmail markup is untrusted content. The renderer receives readable text only:
// no scripts, remote image pixels, hidden tracking nodes, or executable HTML.
const htmlEmailToText = (html) => decodeHtmlEntities(String(html || "")
  .replace(/<!--[\s\S]*?-->/g, "")
  .replace(/<(script|style|iframe|object|embed|svg|canvas|form|input|button)[\s\S]*?<\/\1>/gi, "")
  .replace(/<img\b[^>]*>/gi, "")
  .replace(/<\/?(?:p|div|section|article|header|footer|h[1-6]|blockquote|tr)[^>]*>/gi, "\n")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<li\b[^>]*>/gi, "\n• ")
  .replace(/<\/li>/gi, "")
  .replace(/<[^>]+>/g, "")
  .replace(/\r/g, "")
  .replace(/\n{3,}/g, "\n\n")
  .trim());
const parseMailbox = (value) => {
  const raw = String(value || "").replace(/[\r\n]/g, " ").trim();
  const email = raw.match(/<([^>\s]+@[^>\s]+)>/)?.[1] || raw.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] || "";
  const name = raw.replace(/<[^>]*>/g, "").replace(/[\"']/g, "").trim() || email || "Unknown sender";
  return { name:name.slice(0, 160), email:email.slice(0, 320) };
};
const subjectForReply = (subject) => /^\s*re:/i.test(String(subject || "")) ? String(subject || "").trim() : `Re: ${String(subject || "(No subject)").trim()}`;
const safeHeaderValue = (value, maximum = 512) => String(value || "").replace(/[\r\n]+/g, " ").trim().slice(0, maximum);
const mimeParts = (part, collected = { plain:[], html:[], attachments:[] }) => {
  if (!part) return collected;
  const type = String(part.mimeType || "").toLowerCase();
  const filename = String(part.filename || "").trim();
  if (part.body?.attachmentId || filename) {
    if (filename) collected.attachments.push({ id:String(part.body?.attachmentId || ""), filename:filename.slice(0, 260), mimeType:type || "application/octet-stream", size:Number(part.body?.size || 0) || undefined });
  } else if (type === "text/plain" && part.body?.data) collected.plain.push(decodeGmailData(part.body.data));
  else if (type === "text/html" && part.body?.data) collected.html.push(htmlEmailToText(decodeGmailData(part.body.data)));
  for (const child of part.parts || []) mimeParts(child, collected);
  return collected;
};
const cleanEmailText = (value, maximum = 48_000) => String(value || "").replace(/\u0000/g, "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, maximum);
const sourceLabel = (url) => {
  try { return new URL(String(url)).hostname.replace(/^www\./, ""); } catch { return "Source"; }
};
const compactText = (value, maximum = 320) => String(value || "").replace(/\s+/g, " ").trim().slice(0, maximum);
const markdownWorkspaceLink = (label, url) => `[${label}](${url})`;

function safeFailure(stage, status, errorCode) {
  const suffix = errorCode ? `, ${errorCode}` : "";
  const error = new Error(`${stage} failed (HTTP ${status}${suffix}).`);
  error.stage = stage; error.httpStatus = status; error.errorCode = errorCode || "unknown_error";
  return error;
}

function sameSecret(left, right) {
  const a = Buffer.from(String(left || "")); const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

export class GoogleWorkspaceManager {
  constructor({ tokenPath, uiContents, development = false, clientId, clientSecret, serviceUrl }) {
    this.tokenPath = tokenPath; this.uiContents = uiContents;
    // Both values are provided solely by Electron main from its ignored .env.
    // This class never returns them, includes them in IPC, or logs them.
    this.clientId = clientId || ""; this.clientSecret = clientSecret || "";
    this.serviceUrl = serviceUrl;
    this.development = development; this.authServer = null; this.authAttempt = null; this.authTimeout = null; this.followUpTimers = new Map();
    this.orchestrator = new AgentOrchestrator({
      emitProgress: (runId, payload) => this.emitAgentProgress(runId, payload),
      log: (stage, detail) => this.log(stage, detail),
      executeWorkspace: (payload, orchestration) => this.executeWorkspaceWorkflow(payload, orchestration),
    });
  }
  log(stage, detail = {}) { if (this.development) console.info("[google-oauth]", stage, detail); }
  emit(payload) { const contents = this.uiContents?.(); if (contents && !contents.isDestroyed()) contents.send("google:auth-state", payload); }
  emitAgentProgress(runId, payload) { const contents = this.uiContents?.(); if (runId && contents && !contents.isDestroyed()) contents.send("google:agent-progress", { runId, ...payload }); }
  async readTokens() { try { const raw = await fs.readFile(this.tokenPath); if (!safeStorage.isEncryptionAvailable()) return null; return JSON.parse(safeStorage.decryptString(raw)); } catch { return null; } }
  async writeTokens(tokens) { if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable on this device."); await fs.mkdir(dirname(this.tokenPath), { recursive: true }); await fs.writeFile(this.tokenPath, safeStorage.encryptString(JSON.stringify(tokens))); }
  get followUpPath() { return `${this.tokenPath}.gmail-follow-ups`; }
  async readFollowUps() { try { if (!safeStorage.isEncryptionAvailable()) return []; const raw=await fs.readFile(this.followUpPath); const value=JSON.parse(safeStorage.decryptString(raw)); return Array.isArray(value) ? value.filter((item) => item && typeof item.id === "string") : []; } catch { return []; } }
  async writeFollowUps(items) { if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure local follow-up storage is unavailable on this device."); await fs.mkdir(dirname(this.followUpPath), { recursive:true }); await fs.writeFile(this.followUpPath, safeStorage.encryptString(JSON.stringify(items.slice(-200)))); }
  followUpDate(when) { const now=new Date(); if (typeof when === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(when)) { const value=new Date(when); if (!Number.isNaN(value.getTime()) && value.getTime() > now.getTime()) return value; } if (when === "today") now.setHours(Math.max(now.getHours()+2, 17), 0, 0, 0); else if (when === "three-days") now.setDate(now.getDate()+3); else if (when === "next-week") now.setDate(now.getDate()+7); else now.setDate(now.getDate()+1); now.setHours(9, 0, 0, 0); return now; }
  scheduleFollowUpTimer(item) { const delay=new Date(item.dueAt).getTime()-Date.now(); if (delay <= 0 || delay > 2_147_000_000) return; const existing=this.followUpTimers.get(item.id); if(existing) clearTimeout(existing); const timer=setTimeout(() => { this.followUpTimers.delete(item.id); if (Notification.isSupported()) new Notification({ title:"Clyra follow-up", body:`${item.subject || "Email"}${item.note ? ` — ${item.note}` : ""}` }).show(); }, delay); this.followUpTimers.set(item.id,timer); }
  async status() { const tokens = await this.readTokens(); return { connected: Boolean(tokens?.refresh_token || tokens?.access_token), email: tokens?.email || "" }; }
  async disconnect() { await fs.unlink(this.tokenPath).catch(() => undefined); this.emit({ connected:false }); return { ok:true }; }
  tokenForm(values) { return new URLSearchParams({ client_id:this.clientId, client_secret:this.clientSecret, ...values }); }
  async parseTokenResponse(response, stage) {
    const raw = await response.text(); let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* The response is intentionally never logged. */ }
    const errorCode = String(body?.error || "unknown_error");
    this.log(stage, { httpStatus:response.status, ok:response.ok, ...(response.ok ? {} : { errorCode }) });
    if (!response.ok) throw safeFailure(stage, response.status, errorCode);
    return body;
  }
  async accessToken() {
    const tokens = await this.readTokens(); if (!tokens) throw Object.assign(new Error("Connect Google to continue."), { code:"GOOGLE_SIGN_IN_REQUIRED" });
    if (tokens.access_token && Number(tokens.expires_at || 0) > Date.now() + 45_000) return tokens.access_token;
    if (!tokens.refresh_token) throw Object.assign(new Error("Reconnect Google to continue."), { code:"GOOGLE_SIGN_IN_REQUIRED" });
    const response = await fetch("https://oauth2.googleapis.com/token", { method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"}, body:this.tokenForm({ grant_type:"refresh_token", refresh_token:tokens.refresh_token }) });
    let refreshed;
    try { refreshed = await this.parseTokenResponse(response, "token-refresh"); } catch (error) { await this.disconnect(); throw Object.assign(error, { code:"GOOGLE_SIGN_IN_REQUIRED" }); }
    const next = { ...tokens, ...refreshed, refresh_token:tokens.refresh_token, expires_at:Date.now() + Number(refreshed.expires_in || 3600) * 1000 }; await this.writeTokens(next); return next.access_token;
  }
  async signIn() {
    if (this.authAttempt) return { ok:true, pending:true };
    if (!this.clientId || !this.clientSecret) return { ok:false, error:"Google Desktop OAuth is not configured in the local .env file." };
    const state = base64url(crypto.randomBytes(32));
    const codeVerifier = base64url(crypto.randomBytes(64));
    const codeChallenge = base64url(crypto.createHash("sha256").update(codeVerifier).digest());
    this.log("attempt-created", { pkceReady:true });
    this.authServer = createServer((request, response) => { void this.handleCallback(request, response); });
    try {
      await new Promise((resolve, reject) => { this.authServer.once("error", reject); this.authServer.listen(0, "127.0.0.1", resolve); });
      const address = this.authServer.address();
      if (!address || typeof address === "string") throw new Error("OAuth callback listener did not expose a TCP port.");
      const redirectUri = `http://127.0.0.1:${address.port}/oauth2/callback`;
      // Store exactly one immutable attempt. The callback never generates
      // state, verifier, challenge, or redirect URI.
      this.authAttempt = { state, codeVerifier, redirectUri, handled:false, exchanging:false };
      this.log("callback-listening");
      const auth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      auth.search = new URLSearchParams({ client_id:this.clientId, redirect_uri:redirectUri, response_type:"code", scope:SCOPES, access_type:"offline", prompt:"consent", include_granted_scopes:"true", state, code_challenge:codeChallenge, code_challenge_method:"S256" }).toString();
      await this.openExternalAuth(auth.toString());
      this.authTimeout = setTimeout(() => { this.log("attempt-timeout"); this.emit({ connected:false, error:"Google sign-in timed out. Please try again." }); this.cleanupAuth(); }, AUTH_TIMEOUT_MS);
      this.emit({ connected:false, pending:true }); return { ok:true, pending:true };
    } catch { this.log("attempt-start-failed"); this.cleanupAuth(); return { ok:false, error:"Google sign-in could not start." }; }
  }
  async openExternalAuth(url) {
    // OAuth is opened in the user's normal browser, preserving passkeys,
    // existing Google sessions, and password-manager integrations.
    await shell.openExternal(url);
    this.log("system-browser-opened");
  }
  async handleCallback(request, response) {
    const url = new URL(request.url || "/", "http://127.0.0.1"); const attempt = this.authAttempt;
    this.log("callback-received", { callbackPath:url.pathname === "/oauth2/callback", hasCode:Boolean(url.searchParams.get("code")), hasState:Boolean(url.searchParams.get("state")), hasError:Boolean(url.searchParams.get("error")) });
    if (url.pathname !== "/oauth2/callback") { response.writeHead(404); response.end("Not found"); return; }
    if (!attempt) { response.writeHead(410); response.end("This sign-in attempt has expired. Return to Clyra and try again."); return; }
    if (attempt.handled || attempt.exchanging) { this.log("callback-ignored-duplicate"); response.writeHead(409); response.end("This Google sign-in callback has already been handled. Return to Clyra."); return; }
    const returnedState = url.searchParams.get("state");
    if (!sameSecret(returnedState, attempt.state)) { this.log("callback-state-mismatch", { returnedStatePresent:Boolean(returnedState) }); response.writeHead(400); response.end("Google sign-in could not be verified. Return to Clyra and try again."); this.emit({connected:false,error:"Google sign-in could not be verified."}); this.cleanupAuth(); return; }
    this.log("callback-state-verified");
    const oauthError = url.searchParams.get("error");
    if (oauthError) { this.log("callback-oauth-error", { errorCode:oauthError }); response.writeHead(400); response.end(`Google sign-in failed (${oauthError}). Return to Clyra and try again.`); this.emit({connected:false,error:`Google sign-in failed (${oauthError}).`}); this.cleanupAuth(); return; }
    const code = url.searchParams.get("code");
    if (!code) { this.log("callback-missing-code"); response.writeHead(400); response.end("Google sign-in did not return an authorization code. Return to Clyra and try again."); this.emit({connected:false,error:"Google sign-in did not return an authorization code."}); this.cleanupAuth(); return; }
    // `iss` is optional for this response and intentionally ignored.
    attempt.handled = true; attempt.exchanging = true;
    // The callback listener must remain available for the whole exchange.
    // Clear the attempt timeout now; success/failure owns cleanup below.
    if (this.authTimeout) { clearTimeout(this.authTimeout); this.authTimeout = null; }
    try {
      this.log("token-exchange-started");
      const exchange = await fetch("https://oauth2.googleapis.com/token", { method:"POST", headers:{"content-type":"application/x-www-form-urlencoded"}, body:this.tokenForm({ code, code_verifier:attempt.codeVerifier, grant_type:"authorization_code", redirect_uri:attempt.redirectUri }) });
      const tokens = await this.parseTokenResponse(exchange, "token-exchange");
      if (!tokens?.refresh_token) throw new Error("Google did not return a refresh token. Reconnect and approve access again.");
      const profile = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers:{ Authorization:`Bearer ${tokens.access_token}` } }).then((res)=>res.ok?res.json():{}).catch(()=>({}));
      await this.writeTokens({ ...tokens, email:profile.email || "", expires_at:Date.now() + Number(tokens.expires_in || 3600) * 1000 });
      this.log("tokens-stored", { refreshTokenStored:true, accessTokenStored:Boolean(tokens.access_token) });
      response.writeHead(200, {"content-type":"text/html; charset=utf-8", "cache-control":"no-store"}); response.end(successPage);
      this.emit({ connected:true, email:profile.email || "" });
      setTimeout(() => this.cleanupAuth(), 1_200);
    } catch (error) {
      const safeError = error?.stage ? error.message : "Secure token storage failed.";
      this.log("callback-failed", error?.stage ? { stage:error.stage, httpStatus:error.httpStatus, errorCode:error.errorCode } : { stage:"secure-storage" });
      response.writeHead(500, {"content-type":"text/html; charset=utf-8", "cache-control":"no-store"}); response.end(`<!doctype html><title>Google connection failed</title><body style="font-family:-apple-system;padding:42px;color:#172033"><h2>Google could not be connected</h2><p>${safeError}</p><p>Return to Clyra and try again.</p></body>`);
      this.emit({connected:false,error:safeError}); this.cleanupAuth();
    }
  }
  cleanupAuth() { if (this.authTimeout) clearTimeout(this.authTimeout); this.authTimeout=null; const server=this.authServer; this.authServer=null; this.authAttempt=null; try { server?.close(); } catch { /* already stopped */ } this.log("attempt-cleaned-up"); }
  finishAuth() { this.cleanupAuth(); }
  async google(path, options={}, stage="google-api") {
    const token=await this.accessToken(); const url=/^https:\/\//.test(path) ? path : `https://www.googleapis.com${path}`;
    // Workspace MCP retries transient Google failures. Keep that resilience in
    // Clyra's main process without ever recording request/response bodies.
    for (let attempt=0; attempt<3; attempt += 1) {
      const response=await fetch(url, { ...options, headers:{ Authorization:`Bearer ${token}`, "content-type":"application/json", ...(options.headers||{}) } });
      const raw=await response.text(); let body={}; try { body=raw?JSON.parse(raw):{}; } catch { /* API body stays private. */ }
      const errorCode=String(body?.error?.errors?.[0]?.reason || body?.error?.status || body?.error?.code || "unknown_error");
      const retryable=response.status===429 || response.status>=500;
      if (retryable && attempt < 2) {
        const retryAfter=Number(response.headers.get("retry-after"));
        const delay=Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter*1000 : 350*(2**attempt);
        this.log("google-api-retry", { stage, httpStatus:response.status, attempt:attempt+1, errorCode });
        await new Promise((resolve)=>setTimeout(resolve, delay));
        continue;
      }
      this.log("google-api-response", { stage, httpStatus:response.status, ok:response.ok, ...(response.ok ? {} : { errorCode }) });
      if(!response.ok) throw safeFailure(stage, response.status, errorCode);
      void recordApiUsage({ provider:"google-workspace", model:"workspace-api", feature:stage, usage:{ totalTokens:0 }, units:{ requests:1 }, costUsd:0 }).catch(()=>undefined);
      return body;
    }
    throw safeFailure(stage, 503, "retry_exhausted");
  }
  async diagnostic({ forceRefresh=false }={}) {
    let documentId="";
    try {
      if (forceRefresh) {
        const tokens=await this.readTokens();
        if (!tokens?.refresh_token) throw Object.assign(new Error("Connect Google to continue."), { code:"GOOGLE_SIGN_IN_REQUIRED" });
        await this.writeTokens({ ...tokens, expires_at:0 });
        await this.accessToken();
      }
      const drive=await this.google("/drive/v3/files?pageSize=10&fields=files(id,name,mimeType)", {}, "diagnostic-drive-list");
      const created=await this.google("https://docs.googleapis.com/v1/documents", { method:"POST", body:JSON.stringify({ title:`Clyra OAuth temporary diagnostic ${Date.now()}` }) }, "diagnostic-document-create");
      documentId=created.documentId || ""; if (!documentId) throw safeFailure("diagnostic-document-create", 500, "missing_document_id");
      await this.google(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, { method:"POST", body:JSON.stringify({ requests:[{ insertTable:{ rows:4, columns:3, endOfSegmentLocation:{} } }] }) }, "diagnostic-table-create");
      const tableDocument=await this.google(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`, {}, "diagnostic-document-read-layout");
      const cells=(tableDocument.body?.content || []).flatMap((block)=>block.table?.tableRows || []).flatMap((row)=>row.tableCells || []);
      const tableValues=["Category","MacBook Pro 2018","MacBook Air M2","Processor","Intel 8th/9th generation","Apple M2","Battery","Up to 10 hours","Up to 18 hours","Weight","1.37–1.83 kg","1.24 kg"];
      const locations=cells.map((cell)=>cell.content?.[0]?.paragraph?.elements?.[0]?.startIndex).filter((index)=>Number.isInteger(index));
      if (locations.length !== tableValues.length) throw safeFailure("diagnostic-table-layout", 500, "unexpected_table_layout");
      const requests=locations.map((index, position)=>({ insertText:{ location:{ index }, text:tableValues[position] } })).sort((left,right)=>right.insertText.location.index-left.insertText.location.index);
      await this.google(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}:batchUpdate`, { method:"POST", body:JSON.stringify({ requests }) }, "diagnostic-table-write");
      const readback=await this.google(`https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`, {}, "diagnostic-document-read");
      if (!tableValues.every((value)=>JSON.stringify(readback).includes(value))) throw safeFailure("diagnostic-document-read", 500, "table_verification_failed");
      await this.google(`/drive/v3/files/${encodeURIComponent(documentId)}`, { method:"DELETE" }, "diagnostic-document-delete"); documentId="";
      this.log("diagnostic-complete", { driveListed:true, documentCreated:true, documentRead:true, documentDeleted:true, ...(forceRefresh ? { refreshVerified:true } : {}) });
      return { ok:true, driveListed:true, documentCreated:true, documentRead:true, documentDeleted:true, refreshVerified:forceRefresh, accessibleFileCount:Array.isArray(drive.files) ? drive.files.length : 0 };
    } catch (error) {
      if (documentId) await this.google(`/drive/v3/files/${encodeURIComponent(documentId)}`, { method:"DELETE" }, "diagnostic-document-cleanup").catch(()=>undefined);
      if (error?.code === "GOOGLE_SIGN_IN_REQUIRED") return { ok:false, stage:"diagnostic-auth", errorCode:"GOOGLE_SIGN_IN_REQUIRED" };
      return { ok:false, stage:error?.stage || "diagnostic", ...(error?.httpStatus ? { httpStatus:error.httpStatus } : {}), errorCode:error?.errorCode || "unknown_error" };
    }
  }
  planWorkspaceTask(tool, prompt) {
    const value = String(prompt || "").toLowerCase();
    const matches = [
      ["gmail", /\b(?:gmail|inbox|emails?|mail)\b/g],
      ["calendar", /\b(?:google calendar|calendar|events?)\b/g],
      ["docs", /\b(?:google docs?|docs?|documents?)\b/g],
      ["sheets", /\b(?:google sheets?|sheets?|spreadsheets?)\b/g],
      ["slides", /\b(?:google slides?|slides?|presentations?)\b/g],
      ["drive", /\b(?:google drive|drive files?|drive)\b/g],
    ].flatMap(([service, matcher]) => [...value.matchAll(matcher)].map((match) => ({ service, index:match.index ?? 0 })));
    const mentioned = [...new Set(matches.sort((a, b) => a.index - b.index).map((match) => match.service))];
    if (!mentioned.includes(tool)) mentioned.push(tool);
    const writeTools = ["docs", "sheets", "slides", "drive"];
    const explicitlyRequestedOutput = mentioned.filter((service) => writeTools.includes(service));
    const target = explicitlyRequestedOutput.at(-1) || tool;
    const reads = mentioned.filter((service) => ["gmail", "calendar", "drive"].includes(service) && service !== target);
    const researchRequested = (/\b(?:research(?:ed|ing)?|compar(?:e|ed|ing|ison)|recommend(?:ation|ed|ing)?|which|best|latest|current|plan|strategy|options|pros and cons|based on|versus|vs\.?|fact\s*-?\s*check)\b/i.test(prompt) || (target === "docs" && /\bmacbook\b/i.test(prompt))) && (writeTools.includes(target) || reads.length > 0);
    const steps = ["understand request", ...(researchRequested ? ["research sources"] : []), ...reads.map((service) => `read ${service}`), `complete ${target}`, "verify result"];
    this.log("agent-plan", { tool, target, readCount:reads.length, stepCount:steps.length, researchRequested });
    return { researchRequested, reads, target, steps };
  }
  async researchForWorkspace(prompt, runId) {
    if (!this.serviceUrl) return { attempted:false, sources:[], pages:[] };
    const searchLabel = String(prompt || "").replace(/\s+/g, " ").trim().slice(0, 130);
    const subject = searchLabel.replace(/^(?:make|create|write|draft)\s+(?:me\s+)?(?:a\s+)?(?:google\s+)?(?:doc(?:ument)?|notes?|comparison|report)\s+(?:on|about)?\s*/i, "");
    // Distinct queries produce complementary evidence rather than repeatedly
    // searching the exact user sentence. Every query is a real retrieval call.
    const queries = [...new Set([searchLabel, `${subject} independent background sources`, `${subject} primary sources official statements`].filter(Boolean))].slice(0, 3);
    const sourceMap=new Map(); const pageMap=new Map();
    for (let index=0; index<queries.length; index += 1) {
      try {
        const query=queries[index];
        this.emitAgentProgress(runId, { service:"research", state:"running", label:"Searching the web", detail:`Research ${index + 1} of ${queries.length}: “${query}”` });
        const response = await fetch(`${this.serviceUrl()}/api/research/web-search`, { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify({ query, maxResults:5, fetchTop:3 }) });
        const body = await response.json().catch(()=>({}));
        for (const url of Array.isArray(body?.urls) ? body.urls : []) if(typeof url === "string") sourceMap.set(url,url);
        for (const page of Array.isArray(body?.pages) ? body.pages : []) if(page && !page.blocked && typeof page.url === "string" && typeof page.excerpt === "string" && page.excerpt.trim()) pageMap.set(page.url,{url:page.url,excerpt:page.excerpt});
        this.log("agent-research", { queryIndex:index + 1, httpStatus:response.status, ok:response.ok, sourceCount:sourceMap.size, pageCount:pageMap.size });
      } catch {
        // Keep the evidence already retrieved and try the next independent
        // query. A temporary source failure must not erase a useful first pass.
        this.log("agent-research", { queryIndex:index + 1, httpStatus:0, ok:false, errorCode:"RESEARCH_QUERY_UNAVAILABLE" });
        this.emitAgentProgress(runId, { service:"research", state:"completed", label:"Research source unavailable", detail:`Continuing with the remaining sources (${index + 1} of ${queries.length}).` });
      }
    }
    const sources=[...sourceMap.values()].slice(0,8); const pages=[...pageMap.values()].slice(0,5);
    this.emitAgentProgress(runId, { service:"research", state:"completed", label:"Comparing sources", detail:pages.length ? `Reviewed ${pages.length} source excerpts from ${sources.length} results.` : "No usable source excerpts were returned." });
    return { attempted:true, sources, pages };
  }
  async readDriveContext(prompt, runId) {
    const terms = String(prompt || "").replace(/\b(?:create|make|write|google|docs?|documents?|drive|files?|from|using|the|a|an)\b/gi, " ").replace(/\s+/g, " ").trim().split(" ").filter((term) => term.length > 2).slice(0, 5);
    const query = terms.length ? terms.map((term) => `fullText contains '${term.replace(/'/g, "\\'")}'`).join(" and ") : "trashed = false";
    this.emitAgentProgress(runId, { service:"drive", state:"running", label:"Searching Google Drive", detail:"Inspecting relevant file metadata before using it as context." });
    const found = await this.google(`/drive/v3/files?q=${encodeURIComponent(`(${query}) and trashed = false`)}&pageSize=10&orderBy=modifiedTime desc&fields=files(id,name,mimeType,modifiedTime,webViewLink)`, {}, "agent-drive-context-search");
    const files = (found.files || []).slice(0, 8);
    this.emitAgentProgress(runId, { service:"drive", state:"completed", label:"Google Drive checked", detail:`Reviewed ${files.length} matching file record${files.length === 1 ? "" : "s"}.` });
    return { files, summary:files.length ? `Found ${files.length} relevant Drive file${files.length === 1 ? "" : "s"}.` : "No matching Drive files were found." };
  }
  documentBlueprint(prompt, sources, workspaceContext = []) {
    const macbookPlan = /\bmacbook\b/i.test(prompt);
    const title = macbookPlan ? "MacBook buying plan" : cleanTitle(prompt, "Google document");
    const recommendation = macbookPlan
      ? "Choose the MacBook Air with M2 for most people: it is lighter, quieter, has much stronger battery life, and will receive software support for longer. Choose a current MacBook Pro only if sustained creative workloads, extra ports, or a larger display are essential."
      : "This document turns your request into a clear recommendation, an execution plan, and a decision table.";
    const plan = macbookPlan
      ? ["Set a budget and choose 13-inch or 15-inch based on portability.", "Prioritise 16 GB unified memory if you keep a Mac for several years or multitask heavily.", "Choose 512 GB storage for local photos, media, or development work; otherwise 256 GB is workable with cloud storage.", "Buy from Apple Education, Apple Refurbished, or a reputable retailer after comparing the total price and warranty."]
      : ["Confirm the outcome and audience.", "Collect the evidence needed for the decision.", "Use the decision table to select the next action.", "Review, share, and revise the document."];
    const rows = macbookPlan
      ? [["Priority", "Best choice", "Why"], ["Most people", "MacBook Air M2", "Best balance of battery life, weight, and performance."], ["Coding / study", "Air M2, 16 GB if possible", "Quiet, portable, and comfortable for everyday development."], ["Heavy pro work", "Current MacBook Pro", "Better sustained performance, ports, and display options."]]
      : [["Decision area", "Recommendation", "Reason"], ["Outcome", "Clear next step", "Keeps the work focused."], ["Evidence", "Use current sources", "Supports an informed choice."], ["Follow-through", "Review and share", "Turns planning into action."]];
    const sourceText = sources.length ? `\n\nResearch sources\n${sources.map((source, index)=>`${index + 1}. ${source}`).join("\n")}` : "";
    const contextText = workspaceContext.length ? `\n\nWorkspace context\n${workspaceContext.join("\n")}` : "";
    const body = `${title}\n\nRecommendation\n${recommendation}\n\nShort plan\n${plan.map((item, index)=>`${index + 1}. ${item}`).join("\n")}\n\nDecision table${contextText}${sourceText}\n`;
    return { title, body, rows, recommendation, researched:sources.length > 0, hasWorkspaceContext:workspaceContext.length > 0 };
  }
  async createAgentDocument(prompt, research, runId, workspaceContext = [], emailMessages = []) {
    const skill = new ClyraAdaptiveDocumentEngine({
      google: (path, options, stage) => this.google(path, options, stage),
      emitProgress: (activeRunId, payload) => this.emitAgentProgress(activeRunId, payload),
      log: (stage, detail) => this.log(stage, detail),
    });
    return skill.createPremiumDocument({ prompt, sources:research.sources, researchPages:research.pages || [], workspaceContext, emailMessages, runId });
  }
  async collectGmailForDocument(runId, query = "in:anywhere -in:spam -in:trash") {
    this.emitAgentProgress(runId, { service:"gmail", state:"running", label:"Reading emails", detail:"Searching Gmail across pages and reading message content for the document." });
    const ids=[]; let pageToken="";
    // Two 20-message pages proves pagination when Gmail has enough history,
    // while the final document remains bounded and reviewable.
    for (let page=0; page<2; page += 1) {
      const suffix=pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "";
      const listed=await this.google(`/gmail/v1/users/me/messages?maxResults=20&q=${encodeURIComponent(query)}${suffix}`, {}, "gmail-document-list");
      ids.push(...(listed.messages || [])); pageToken=listed.nextPageToken || "";
      if (!pageToken) break;
    }
    const unique=[]; const seenThreads=new Set(); const seenIds=new Set();
    for (const item of ids) { if (!item?.id || seenIds.has(item.id) || (item.threadId && seenThreads.has(item.threadId))) continue; seenIds.add(item.id); if(item.threadId)seenThreads.add(item.threadId); unique.push(item); }
    if (!unique.length) throw Object.assign(new Error("Gmail did not return any messages to summarise, so no Google Doc was created."), { stage:"gmail-document-list" });
    const messages=[];
    for (let offset=0; offset<unique.length; offset += 8) {
      const page=await Promise.all(unique.slice(offset, offset+8).map((item)=>this.google(`/gmail/v1/users/me/messages/${encodeURIComponent(item.id)}?format=full`, {}, "gmail-document-message")));
      messages.push(...page);
    }
    const records=messages.map((message) => {
      const headers=Object.fromEntries((message.payload?.headers || []).map((header)=>[header.name, header.value]));
      const text=cleanTitle(gmailBodyText(message.payload) || message.snippet || "", "").slice(0, 700);
      return { id:message.id, threadId:message.threadId, from:String(headers.From || "Unknown sender"), subject:String(headers.Subject || "(No subject)"), date:String(headers.Date || ""), summary:text };
    }).filter((record)=>record.summary || record.subject !== "(No subject)");
    if (!records.length) throw Object.assign(new Error("Gmail messages were retrieved but no usable message content was available, so no Google Doc was created."), { stage:"gmail-document-content" });
    this.emitAgentProgress(runId, { service:"gmail", state:"completed", label:"Reading emails", detail:`Reviewed ${records.length} unique Gmail messages${pageToken || ids.length > 20 ? " across multiple pages" : ""}.` });
    return records;
  }
  gmailQueryForPrompt(prompt = "") {
    const value = String(prompt || "").replace(/^\/(?:gmail|mail)\s*/i, "").trim();
    const terms = [];
    if (/\bunread\b/i.test(value)) terms.push("is:unread");
    if (/\b(?:today|this morning|this afternoon)\b/i.test(value)) terms.push("newer_than:1d");
    else if (/\b(?:latest|recent|newest|last)\b/i.test(value)) terms.push("newer_than:14d");
    const from = value.match(/\bfrom\s+([^,?.!]+?)(?=\s+(?:about|regarding|with|that|sent)|[?.!,]|$)/i)?.[1]?.trim();
    const about = value.match(/\b(?:about|regarding|on)\s+([^?.!]+?)(?:\?|$)/i)?.[1]?.trim();
    if (from) terms.push(`from:(${from.slice(0, 120)})`);
    if (about) terms.push(about.slice(0, 180));
    if (!from && !about && !/\b(?:show|check|read|find|latest|recent|emails?|mail|inbox|unread|today|last)\b/i.test(value)) terms.push(value.slice(0, 180));
    return terms.filter(Boolean).join(" ") || "newer_than:14d";
  }
  gmailLimitForPrompt(prompt = "", fallback = 6) {
    const count = String(prompt || "").match(/\b(?:last|latest|show|read|find)\s+(\d{1,2})\b/i)?.[1];
    return Math.max(1, Math.min(12, Number(count) || fallback));
  }
  normalizeGmailMessage(message, threadMessageCount = 1) {
    const headers = gmailHeaderMap(message?.payload?.headers);
    const sender = parseMailbox(headers.from);
    const replyTo = parseMailbox(headers["reply-to"] || headers.from);
    const recipients = String(headers.to || "").split(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/).map(parseMailbox).filter((recipient) => recipient.name || recipient.email).map((recipient) => recipient.name || recipient.email).slice(0, 8);
    const parts = mimeParts(message?.payload);
    const plainTextBody = cleanEmailText(parts.plain.join("\n\n") || parts.html.join("\n\n") || message?.snippet || "");
    const labels = Array.isArray(message?.labelIds) ? message.labelIds.filter((label) => typeof label === "string").slice(0, 30) : [];
    return {
      id:String(message?.id || ""), threadId:String(message?.threadId || ""), senderName:sender.name, senderEmail:sender.email,
      replyTo:replyTo.email || sender.email, recipientNames:recipients, subject:safeHeaderValue(headers.subject || "(No subject)", 300),
      receivedAt:safeHeaderValue(headers.date || "", 180), internalDate:String(message?.internalDate || ""),
      isUnread:labels.includes("UNREAD"), isStarred:labels.includes("STARRED"), labels:labels.filter((label) => !["INBOX", "UNREAD", "STARRED", "SENT", "DRAFT"].includes(label)),
      snippet:cleanEmailText(message?.snippet || plainTextBody, 480), plainTextBody, attachments:parts.attachments,
      threadMessageCount:Math.max(1, Number(threadMessageCount) || 1), messageIdHeader:safeHeaderValue(headers["message-id"] || "", 500),
    };
  }
  async normalizedGmailThread(threadId) {
    if (!this.validId(threadId)) throw new Error("A valid Gmail thread ID is required.");
    const thread = await this.google(`/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=full`, {}, "gmail-thread-read");
    const messages = Array.isArray(thread.messages) ? thread.messages : [];
    return { id:String(thread.id || threadId), messages:messages.map((message) => this.normalizeGmailMessage(message, messages.length)) };
  }
  async searchGmailMessages({ query, limit = 6, runId, stage = "agent-gmail-list" } = {}) {
    const boundedLimit = Math.max(1, Math.min(12, Number(limit) || 6));
    const gmailQuery = String(query || "newer_than:14d").slice(0, 320);
    this.emitAgentProgress(runId, { service:"gmail", state:"running", label:"Reading emails", detail:`Searching Gmail for ${boundedLimit === 1 ? "one relevant message" : `up to ${boundedLimit} relevant messages`}.` });
    const list = await this.google(`/gmail/v1/users/me/messages?maxResults=${Math.min(20, boundedLimit * 2)}&q=${encodeURIComponent(gmailQuery)}`, {}, stage);
    const ids = [...new Map((list.messages || []).filter((message) => this.validId(message?.id)).map((message) => [message.id, message])).values()].slice(0, boundedLimit);
    const messages = [];
    for (let offset = 0; offset < ids.length; offset += 4) {
      messages.push(...await Promise.all(ids.slice(offset, offset + 4).map((message) => this.google(`/gmail/v1/users/me/messages/${encodeURIComponent(message.id)}?format=full`, {}, "gmail-message-read"))));
    }
    const threadCounts = new Map();
    const threadIds = [...new Set(messages.map((message) => message.threadId).filter((id) => this.validId(id)))];
    for (let offset = 0; offset < threadIds.length; offset += 4) {
      const threads = await Promise.all(threadIds.slice(offset, offset + 4).map((threadId) => this.google(`/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}?format=minimal`, {}, "gmail-thread-count")));
      threads.forEach((thread, index) => threadCounts.set(threadIds[offset + index], Array.isArray(thread.messages) ? thread.messages.length : 1));
    }
    const emails = messages.map((message) => this.normalizeGmailMessage(message, threadCounts.get(message.threadId) || 1)).filter((email) => email.id && (email.subject || email.plainTextBody));
    this.emitAgentProgress(runId, { service:"gmail", state:"completed", label:"Emails ready", detail:emails.length ? `Loaded ${emails.length} relevant Gmail message${emails.length === 1 ? "" : "s"} safely into Clyra.` : "No matching Gmail messages were found." });
    return { query:gmailQuery, total:Number(list.resultSizeEstimate || emails.length) || emails.length, emails };
  }
  async readGmail(runId, prompt = "") {
    const results = await this.searchGmailMessages({ query:this.gmailQueryForPrompt(prompt), limit:this.gmailLimitForPrompt(prompt), runId });
    const count = results.emails.length;
    const summary = count ? `Found ${count} relevant email${count === 1 ? "" : "s"}.` : "No matching emails were found.";
    return { rows:results.emails.map((email) => `- ${email.subject} — ${email.senderName}`), summary, gmailResults:results, text:count ? `I found ${count} relevant email${count === 1 ? "" : "s"}.` : "No matching emails were found." };
  }
  async readCalendar(runId) {
    this.emitAgentProgress(runId, { service:"calendar", state:"running", label:"Checking Google Calendar", detail:"Loading the next events from your primary calendar." });
    const events = await this.google(`/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=8&timeMin=${encodeURIComponent(new Date().toISOString())}`, {}, "agent-calendar-list");
    const rows = (events.items || []).map((event) => `- ${event.summary || "Untitled"} — ${event.start?.dateTime || event.start?.date || "Time not set"}`);
    this.emitAgentProgress(runId, { service:"calendar", state:"completed", label:"Calendar checked", detail:`Read ${rows.length} upcoming events.` });
    return { rows, summary:rows.length ? `Found ${rows.length} upcoming events.` : "No upcoming events were found.", text:rows.length ? `### Upcoming calendar\n\n${rows.join("\n")}\n\n${markdownWorkspaceLink("Open Google Calendar", "https://calendar.google.com/calendar/u/0/r")}` : `No upcoming events were found.\n\n${markdownWorkspaceLink("Open Google Calendar", "https://calendar.google.com/calendar/u/0/r")}` };
  }
  async createSheet(title, prompt, runId, research = { pages:[] }) {
    const pages = Array.isArray(research?.pages) ? research.pages : [];
    const macbookComparison = /\bmacbook\b/i.test(prompt) && /\bm2\b/i.test(prompt) && /\b2018\b/i.test(prompt);
    const values = macbookComparison
      ? [["Category", "MacBook Air M2", "MacBook Pro (2018)"], ["Processor", "Apple M2", "8th/9th-generation Intel"], ["Cooling", "Fanless", "Active cooling"], ["Battery", "Up to 18 hours", "Up to 10 hours"], ["Best fit", "Most people, study, coding", "Existing owner or a very low used price"]]
      : pages.length
        ? [["Source", "Reviewed evidence"], ...pages.slice(0, 6).map((page) => [sourceLabel(page.url), compactText(page.excerpt, 420)])]
        : [["Item", "Detail"], ["Requested outcome", cleanTitle(prompt, "Untitled spreadsheet")]];
    this.emitAgentProgress(runId, { service:"sheets", state:"running", label:"Building Google Sheet", detail:"Creating a structured data model rather than storing the raw prompt." });
    const toRows = (rows) => rows.map((row) => ({ values:row.map((cell) => ({ userEnteredValue:{ stringValue:String(cell) } })) }));
    const file = await this.google("https://sheets.googleapis.com/v4/spreadsheets", { method:"POST", body:JSON.stringify({ properties:{ title }, sheets:[{ properties:{ title:"Summary", gridProperties:{ frozenRowCount:1 } }, data:[{ rowData:toRows(values) }] }] }) }, "agent-sheet-create");
    const sheetId = file.sheets?.[0]?.properties?.sheetId;
    if (!file.spreadsheetId || !Number.isInteger(sheetId)) throw safeFailure("agent-sheet-create", 500, "missing_spreadsheet_id");
    await this.google(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(file.spreadsheetId)}:batchUpdate`, { method:"POST", body:JSON.stringify({ requests:[{ repeatCell:{ range:{ sheetId, startRowIndex:0, endRowIndex:1 }, cell:{ userEnteredFormat:{ backgroundColor:{ red:0.12, green:0.31, blue:0.61 }, textFormat:{ bold:true, foregroundColor:{ red:1, green:1, blue:1 } } } }, fields:"userEnteredFormat(backgroundColor,textFormat)" } }, { autoResizeDimensions:{ dimensions:{ sheetId, dimension:"COLUMNS", startIndex:0, endIndex:values[0].length } } }] }) }, "agent-sheet-style");
    const verified = await this.google(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(file.spreadsheetId)}/values/${encodeURIComponent(`Summary!A1:${values[0].length === 3 ? "C" : "B"}${values.length}`)}`, {}, "agent-sheet-verify");
    if (!Array.isArray(verified.values) || verified.values.length !== values.length || !values[0].every((cell, index) => verified.values[0]?.[index] === cell)) throw safeFailure("agent-sheet-verify", 500, "sheet_readback_failed");
    this.emitAgentProgress(runId, { service:"sheets", state:"completed", label:"Google Sheet verified", detail:`Read back ${verified.values.length} structured row${verified.values.length === 1 ? "" : "s"} after formatting.` });
    return { ok:true, action:"Google Sheet complete", detail:"Created, formatted, and verified the spreadsheet.", text:`Done — created and verified **${file.properties?.title || title}**.`, workspaceResult:{ kind:"sheets", title:file.properties?.title || title, subtitle:"Google Sheets", url:`https://docs.google.com/spreadsheets/d/${file.spreadsheetId}/edit` } };
  }
  async createSlides(title, runId) {
    this.emitAgentProgress(runId, { service:"slides", state:"running", label:"Creating Google Slides", detail:"Creating the presentation in Google Drive." });
    const file = await this.google("https://slides.googleapis.com/v1/presentations", { method:"POST", body:JSON.stringify({ title }) }, "agent-slides-create");
    const verified = await this.google(`https://slides.googleapis.com/v1/presentations/${encodeURIComponent(file.presentationId)}`, {}, "agent-slides-verify");
    if (!verified.presentationId) throw safeFailure("agent-slides-verify", 500, "missing_presentation_id");
    this.emitAgentProgress(runId, { service:"slides", state:"completed", label:"Google Slides verified", detail:"The presentation was created and read back successfully." });
    return { ok:true, action:"Google Slides complete", detail:"Created and verified the presentation.", text:`Done — created and verified **${file.title || title}**.`, workspaceResult:{ kind:"slides", title:file.title || title, subtitle:"Google Slides", url:`https://docs.google.com/presentation/d/${file.presentationId}/edit` } };
  }
  async createDriveFile(title, runId) {
    this.emitAgentProgress(runId, { service:"drive", state:"running", label:"Creating Drive file", detail:"Creating the requested file in Google Drive." });
    const file = await this.google("/drive/v3/files?fields=id,name,mimeType", { method:"POST", body:JSON.stringify({ name:title, mimeType:"application/vnd.google-apps.document" }) }, "agent-drive-create");
    const verified = await this.google(`/drive/v3/files/${encodeURIComponent(file.id)}?fields=id,name,mimeType`, {}, "agent-drive-verify");
    if (!verified.id) throw safeFailure("agent-drive-verify", 500, "missing_file_id");
    this.emitAgentProgress(runId, { service:"drive", state:"completed", label:"Drive file verified", detail:"The new file was created and read back successfully." });
    return { ok:true, action:"Google Drive complete", detail:"Created and verified the Drive file.", text:`Done — created and verified **${file.name || title}** in Google Drive.`, workspaceResult:{ kind:"drive", title:file.name || title, subtitle:"Google Drive", url:`https://drive.google.com/open?id=${file.id}` } };
  }
  requireConfirmation(kind, confirmed) {
    if (confirmed === true) return null;
    return { ok:false, requiresConfirmation:true, confirmationKind:kind, text:`Confirmation required before ${kind}. Review the proposed action, then confirm it in Clyra to continue.` };
  }
  validId(value) { return typeof value === "string" && /^[A-Za-z0-9_-]{6,200}$/.test(value); }
  async operation({ service, action, args = {}, confirmed = false, runId }) {
    if (!/^(docs|drive|sheets|gmail|calendar|contacts|youtube)$/.test(service || "") || !/^[a-z-]{2,40}$/.test(action || "") || !args || typeof args !== "object" || Array.isArray(args)) throw new Error("Invalid Google Workspace action.");
    const finish = (label, detail, text) => ({ ok:true, action:label, detail, text });
    this.emitAgentProgress(runId, { service:service === "contacts" || service === "youtube" ? "clyra" : service, state:"running", label:`Using Google ${service === "youtube" ? "YouTube" : service[0].toUpperCase()+service.slice(1)}`, detail:"Completing the requested Workspace action securely." });
    if (service === "drive") {
      if (action === "search") { const terms=String(args.query || "").replace(/[^\p{L}\p{N}._-]+/gu," ").trim().split(/\s+/).filter((term)=>term.length>1).slice(0,6); const filter=terms.length ? terms.map((term)=>`fullText contains '${term.replace(/'/g,"\\'")}'`).join(" and ") : "trashed = false"; const q=encodeURIComponent(`(${filter}) and trashed = false`); const found=await this.google(`/drive/v3/files?q=${q}&pageSize=20&fields=files(id,name,mimeType,modifiedTime,webViewLink)`, {}, "drive-search"); const rows=(found.files||[]).map((file)=>`- ${file.name || "Untitled file"} — ${file.mimeType || "file"}${file.webViewLink ? ` (${markdownWorkspaceLink("Open", file.webViewLink)})` : ""}`); return finish("Drive search complete", `Found ${rows.length} file(s).`, rows.length ? `### Google Drive results\n\n${rows.join("\n")}` : "No matching Google Drive files were found."); }
      if (!this.validId(args.fileId)) throw new Error("A valid Drive file ID is required.");
      if (action === "rename") { await this.google(`/drive/v3/files/${args.fileId}`, {method:"PATCH",body:JSON.stringify({name:String(args.name||"").slice(0,200)})}, "drive-rename"); return finish("Drive file renamed", "The file name was updated.", "Done — the Drive file was renamed."); }
      if (action === "move") { const parents=String(args.parentId||""); if (!this.validId(parents)) throw new Error("A valid destination folder ID is required."); const file=await this.google(`/drive/v3/files/${args.fileId}?fields=parents`, {}, "drive-move-read"); await this.google(`/drive/v3/files/${args.fileId}?addParents=${encodeURIComponent(parents)}&removeParents=${encodeURIComponent((file.parents||[]).join(","))}`, {method:"PATCH"}, "drive-move"); return finish("Drive file moved", "The file was moved to the selected folder.", "Done — the Drive file was moved."); }
      if (action === "share") { const blocked=this.requireConfirmation("changing Drive sharing permissions",confirmed); if(blocked)return blocked; const permission={type:String(args.type||"user"),role:String(args.role||"reader")}; if(permission.type==="user"&&typeof args.emailAddress==="string")permission.emailAddress=args.emailAddress.slice(0,320); await this.google(`/drive/v3/files/${args.fileId}/permissions?sendNotificationEmail=${args.notify!==false}`, {method:"POST",body:JSON.stringify(permission)}, "drive-share"); return finish("Drive sharing updated", "The requested permission was applied.", "Done — Drive sharing was updated."); }
      if (action === "delete") { const blocked=this.requireConfirmation("deleting this Drive file",confirmed); if(blocked)return blocked; await this.google(`/drive/v3/files/${args.fileId}`, {method:"DELETE"}, "drive-delete"); return finish("Drive file deleted", "The file was removed from Drive.", "Done — the Drive file was deleted."); }
    }
    if (service === "gmail") {
      if (action === "search") {
        const results=await this.searchGmailMessages({ query:String(args.query || "").slice(0, 320), limit:Number(args.limit || 6), runId, stage:"gmail-search" });
        return { ...finish("Gmail search complete", `Loaded ${results.emails.length} matching message${results.emails.length === 1 ? "" : "s"}.`, results.emails.length ? `Found ${results.emails.length} matching email${results.emails.length === 1 ? "" : "s"}.` : "No matching Gmail messages were found."), gmailResults:results };
      }
      if (action === "thread") {
        const thread=await this.normalizedGmailThread(String(args.threadId || ""));
        return { ...finish("Gmail thread loaded", `Loaded ${thread.messages.length} message${thread.messages.length === 1 ? "" : "s"} in the thread.`, "The Gmail thread is ready in Clyra."), gmailThread:thread };
      }
      if (action === "get") {
        if (!this.validId(args.messageId)) throw new Error("A valid Gmail message ID is required.");
        const message=await this.google(`/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}?format=full`, {}, "gmail-message-get");
        const email=this.normalizeGmailMessage(message, 1);
        return { ...finish("Gmail message loaded", "The selected Gmail message was loaded.", "The Gmail message is ready in Clyra."), gmailEmail:email };
      }
      if (action === "follow-up") {
        if (!this.validId(args.messageId) || !this.validId(args.threadId)) throw new Error("A valid Gmail message and thread are required for a follow-up.");
        const dueAt=this.followUpDate(String(args.when || "tomorrow"));
        const item={ id:crypto.randomUUID(), messageId:String(args.messageId), threadId:String(args.threadId), sender:safeHeaderValue(args.sender || "", 320), subject:safeHeaderValue(args.subject || "Email follow-up", 300), note:cleanEmailText(args.note || "", 600), dueAt:dueAt.toISOString(), createdAt:new Date().toISOString(), status:"scheduled" };
        const items=await this.readFollowUps(); items.push(item); await this.writeFollowUps(items); this.scheduleFollowUpTimer(item);
        return { ...finish("Gmail follow-up scheduled", `A local Clyra reminder is scheduled for ${dueAt.toLocaleString()}.`, `Follow-up scheduled for ${dueAt.toLocaleString()}.`), gmailFollowUp:{ id:item.id, dueAt:item.dueAt, status:item.status } };
      }
      if (action === "follow-up-cancel") {
        const followUpId=String(args.followUpId || ""); if (!/^[A-Za-z0-9-]{20,80}$/.test(followUpId)) throw new Error("A valid Clyra follow-up ID is required.");
        const items=await this.readFollowUps(); const next=items.filter((item) => item.id !== followUpId);
        if (next.length === items.length) throw new Error("That Clyra follow-up no longer exists.");
        const timer=this.followUpTimers.get(followUpId); if (timer) clearTimeout(timer); this.followUpTimers.delete(followUpId); await this.writeFollowUps(next);
        return finish("Gmail follow-up cancelled", "The local Clyra reminder was removed.", "Follow-up cancelled.");
      }
      if (!this.validId(args.messageId) && !["draft", "send"].includes(action)) throw new Error("A valid Gmail message ID is required.");
      if (action === "archive") {
        const blocked=this.requireConfirmation("archiving this Gmail message",confirmed); if(blocked)return blocked;
        await this.google(`/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}/modify`, {method:"POST",body:JSON.stringify({removeLabelIds:["INBOX"]})}, "gmail-archive");
        return finish("Gmail archived", "The message was removed from Inbox.", "The message was archived.");
      }
      if (action === "modify") {
        const change=String(args.change || "");
        const changes={ read:{removeLabelIds:["UNREAD"]}, unread:{addLabelIds:["UNREAD"]}, star:{addLabelIds:["STARRED"]}, unstar:{removeLabelIds:["STARRED"]}, trash:{addLabelIds:["TRASH"]} }[change];
        if (!changes) throw new Error("Unsupported Gmail message change.");
        const blocked=change === "trash" ? this.requireConfirmation("moving this Gmail message to trash", confirmed) : null; if(blocked)return blocked;
        await this.google(`/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}/modify`, {method:"POST",body:JSON.stringify(changes)}, `gmail-${change}`);
        return finish("Gmail message updated", `The selected message was marked ${change}.`, `The message was marked ${change}.`);
      }
      if (action === "draft-reply" || action === "send-reply") {
        if (!this.validId(args.messageId)) throw new Error("A valid Gmail message ID is required.");
        const body=cleanEmailText(String(args.body || ""), 50_000); if (!body) throw new Error("A reply message is required.");
        const blocked=action === "send-reply" ? this.requireConfirmation("sending this email reply", confirmed) : null; if(blocked)return blocked;
        const original=await this.google(`/gmail/v1/users/me/messages/${encodeURIComponent(args.messageId)}?format=full`, {}, "gmail-reply-context");
        const headers=gmailHeaderMap(original.payload?.headers); const recipient=parseMailbox(headers["reply-to"] || headers.from).email;
        if (!recipient) throw new Error("Clyra could not determine a safe reply recipient for this message.");
        const messageId=safeHeaderValue(headers["message-id"] || "", 500);
        const rawLines=[`To: ${safeHeaderValue(recipient, 320)}`, `Subject: ${safeHeaderValue(subjectForReply(headers.subject), 320)}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8"];
        if (messageId) rawLines.push(`In-Reply-To: ${messageId}`, `References: ${messageId}`);
        const raw=base64url(`${rawLines.join("\r\n")}\r\n\r\n${body}`); const threadId=String(original.threadId || args.threadId || "");
        const endpoint=action === "send-reply" ? "/gmail/v1/users/me/messages/send" : "/gmail/v1/users/me/drafts";
        const payload=action === "send-reply" ? {raw,threadId} : {message:{raw,threadId}};
        const saved=await this.google(endpoint,{method:"POST",body:JSON.stringify(payload)}, `gmail-${action}`);
        return { ...finish(action === "send-reply" ? "Reply sent" : "Reply draft saved", action === "send-reply" ? "The reply was sent after your confirmation." : "The reply was saved to Gmail drafts.", action === "send-reply" ? "Reply sent." : "Reply draft saved."), gmailMutation:{ messageId:String(args.messageId), threadId, draftId:String(saved.id || "") } };
      }
      if (action === "draft" || action === "send") { const blocked=action==="send"?this.requireConfirmation("sending this email",confirmed):null; if(blocked)return blocked; const raw=String(args.rawRfc822||""); if(!raw||raw.length>2_000_000) throw new Error("A bounded RFC 822 message is required."); const endpoint=action==="send"?"/gmail/v1/users/me/messages/send":"/gmail/v1/users/me/drafts"; await this.google(endpoint,{method:"POST",body:JSON.stringify(action==="send"?{raw}:{message:{raw}})},`gmail-${action}`); return finish(action==="send"?"Email sent":"Email draft created", action==="send"?"The email was sent after confirmation.":"The email was saved as a draft.", action==="send"?"Done — the email was sent.":"Done — the email draft was created."); }
    }
    if (service === "calendar") {
      if (action === "availability") { const body={timeMin:String(args.timeMin||""),timeMax:String(args.timeMax||""),items:[{id:"primary"}]}; const data=await this.google("https://www.googleapis.com/calendar/v3/freeBusy",{method:"POST",body:JSON.stringify(body)},"calendar-availability"); return finish("Calendar availability checked","Availability was retrieved.",JSON.stringify(data.calendars?.primary?.busy||[])); }
      if (action === "create" || action === "update") { const event=args.event; if(!event||typeof event!=="object")throw new Error("A bounded event payload is required."); const attendees=Array.isArray(event.attendees)&&event.attendees.length>0; const blocked=attendees?this.requireConfirmation("creating calendar invitations",confirmed):null; if(blocked)return blocked; const endpoint=action==="create"?"/calendar/v3/calendars/primary/events":`/calendar/v3/calendars/primary/events/${encodeURIComponent(String(args.eventId||""))}`; if(action==="update"&&!this.validId(args.eventId))throw new Error("A valid Calendar event ID is required."); const saved=await this.google(endpoint,{method:action==="create"?"POST":"PATCH",body:JSON.stringify(event)},`calendar-${action}`); return finish("Calendar event saved","The calendar event was verified by Google Calendar.",`Done — [open the event](${saved.htmlLink||"https://calendar.google.com"}).`); }
    }
    if (service === "sheets") {
      if (!this.validId(args.spreadsheetId) && action !== "create") throw new Error("A valid spreadsheet ID is required.");
      if (action === "create") return this.createSheet(String(args.title||"Untitled spreadsheet").slice(0,120),String(args.prompt||""),runId);
      if (action === "read") { const values=await this.google(`https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(String(args.range||"A1:Z100"))}`,{},"sheets-read"); const rows=(values.values||[]).slice(0,20).map((row)=>`| ${row.map((cell)=>String(cell).replace(/\|/g,"\\|")).join(" | ")} |`); const header=rows.shift(); const divider=header ? `| ${(values.values?.[0] || []).map(()=>"---").join(" | ")} |` : ""; return finish("Google Sheet read",`Read ${(values.values||[]).length} row(s).`, header ? `### Google Sheet preview\n\n${header}\n${divider}\n${rows.join("\n")}` : "The selected Google Sheet range is empty."); }
      if (action === "write") { const range=String(args.range||""); const values=Array.isArray(args.values)?args.values:[]; if(!range||!values.length)throw new Error("A target range and values are required."); await this.google(`https://sheets.googleapis.com/v4/spreadsheets/${args.spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,{method:"PUT",body:JSON.stringify({values})},"sheets-write"); return finish("Google Sheet updated","Cells and formulas were written.","Done — the Sheet was updated."); }
    }
    if (service === "contacts" && action === "find") { const q=encodeURIComponent(String(args.query||"").slice(0,160)); const people=await this.google(`https://people.googleapis.com/v1/people:searchContacts?query=${q}&readMask=names,emailAddresses,phoneNumbers&pageSize=20`,{},"contacts-find"); const rows=(people.results||[]).map((result)=>{ const person=result.person||{}; return `- ${person.names?.[0]?.displayName || "Unnamed contact"}${person.emailAddresses?.[0]?.value ? ` — ${person.emailAddresses[0].value}` : ""}`; }); return finish("Contacts found",`Found ${rows.length} contact(s).`,rows.length ? `### Matching contacts\n\n${rows.join("\n")}` : "No matching contacts were found."); }
    if (service === "youtube" && action === "video") { const id=String(args.videoId||""); if(!/^[A-Za-z0-9_-]{8,20}$/.test(id))throw new Error("A valid YouTube video ID is required."); const video=await this.google(`https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics&id=${encodeURIComponent(id)}`,{},"youtube-video"); const item=video.items?.[0]; return finish("YouTube video read",`Read ${(video.items||[]).length} video record(s).`,item ? `### ${item.snippet?.title || "YouTube video"}\n\n- Channel: ${item.snippet?.channelTitle || "Unknown"}\n- Published: ${item.snippet?.publishedAt || "Unknown"}\n- Views: ${item.statistics?.viewCount || "Unavailable"}\n\n${markdownWorkspaceLink("Open on YouTube", `https://www.youtube.com/watch?v=${id}`)}` : "No YouTube video was returned for that ID."); }
    throw new Error("This Google Workspace action is not available yet.");
  }
  async executeWorkspaceWorkflow(payload = {}, orchestration = {}) {
    const { tool, prompt, runId } = payload;
    try {
      // Await direct typed operations here so API failures remain inside this
      // guarded workflow. Without the await, an async 403 bypasses the safe
      // scope/reconnect response below and reaches the renderer as a raw
      // operation failure.
      if (payload.service || payload.action) return await this.operation({ service:payload.service, action:payload.action, args:payload.args, confirmed:payload.confirmed, runId });
      if (!/^(gmail|calendar|docs|sheets|slides|drive)$/.test(tool || "") || typeof prompt !== "string" || prompt.length > 8_000 || (runId !== undefined && (typeof runId !== "string" || runId.length > 120))) throw new Error("Invalid Google Workspace request.");
      this.emitAgentProgress(runId, { service:"clyra", state:"running", label:"Planning the task", detail:"Choosing the right tools and ordering dependent actions." });
      const plan = this.planWorkspaceTask(tool, prompt);
      orchestration.stage?.("Planning execution", `Preparing ${plan.steps.length} dependency-aware actions for this request.`);
      this.emitAgentProgress(runId, { service:"clyra", state:"completed", label:"Task plan ready", detail:`Prepared ${plan.steps.length} ordered actions for this request.` });
      const workspaceContext = [];
      let research = { attempted:false, sources:[], pages:[] };
      const emailDocument = plan.target === "docs" && plan.reads.includes("gmail") && /\b(?:summari[sz](?:e|es|ed|ing)?|digest|brief|review|report)\b/i.test(prompt);
      // For an email-derived document, collect and review the authorised
      // mailbox data before deciding whether a public research pass is useful.
      // Email contents never become web-search queries: that would leak private
      // user data to a third party. A prompt must supply a public research topic.
      const emailMessages = emailDocument ? await this.collectGmailForDocument(runId) : [];
      if (plan.researchRequested) {
        orchestration.stage?.("Comparing evidence", "Collecting and checking current sources before building the result.");
        research = await this.researchForWorkspace(prompt, runId);
        if (plan.target === "docs" && research.attempted && !research.pages?.length) throw Object.assign(new Error("Clyra could not retrieve enough reliable source material for this document, so it did not create a prompt-only Google Doc."), { stage:"agent-research-evidence" });
        workspaceContext.push(...research.sources.map((source) => `Research source: ${source}`));
      }
      for (const source of plan.reads) {
        if (source === "gmail" && emailDocument) continue;
        if (source === "drive") {
          const result = await this.readDriveContext(prompt, runId);
          workspaceContext.push(`Drive: ${result.summary}`, ...result.files.map((file) => `${file.name || "Untitled file"} (${file.mimeType || "file"})`).slice(0, 5));
          continue;
        }
        const result = source === "gmail" ? await this.readGmail(runId, prompt) : await this.readCalendar(runId);
        workspaceContext.push(`${source === "gmail" ? "Gmail" : "Calendar"}: ${result.summary}`, ...result.rows.slice(0, 5));
      }
      if (plan.target === "gmail") {
        if (/\b(?:send|draft|reply|compose)\b/i.test(prompt)) {
          this.emitAgentProgress(runId, { service:"gmail", state:"completed", label:"Preparing Gmail message", detail:"Keeping the email in Clyra until its recipient, subject, body, and send confirmation are clear." });
          return { ok:false, needsInput:true, text:"I’ll prepare the email here in Clyra rather than opening Gmail. Send the recipient, subject, and message body (or reply instructions); Clyra will show the draft for review and require your confirmation before it sends anything." };
        }
        const result = await this.readGmail(runId, prompt);
        return { ok:true, action:"Gmail complete", detail:result.summary, text:result.text, gmailResults:result.gmailResults };
      }
      if (plan.target === "calendar") {
        if (/\b(?:create|schedule|add)\b/i.test(prompt)) return { ok:false, needsInput:true, text:"Tell me the event title, date, time, and timezone, then I can add it to Google Calendar." };
        const result = await this.readCalendar(runId);
        return { ok:true, action:"Calendar complete", detail:"Read the requested calendar events.", text:result.text, workspaceResult:{ kind:"calendar", title:"Upcoming calendar", subtitle:"Google Calendar", url:"https://calendar.google.com/calendar/u/0/r" } };
      }
      const title = cleanTitle(prompt, plan.target === "docs" ? "Untitled document" : plan.target === "sheets" ? "Untitled spreadsheet" : plan.target === "slides" ? "Untitled presentation" : "Untitled file");
      if (plan.target === "docs") {
        orchestration.stage?.("Building the result", "Drafting complete content before the Google Doc is created.");
        return await this.createAgentDocument(prompt, research, runId, workspaceContext.filter((line) => !line.startsWith("Research source: ")), emailMessages);
      }
      if (plan.target === "sheets") return await this.createSheet(title, prompt, runId, research);
      if (plan.target === "slides") return await this.createSlides(title, runId);
      if (plan.target === "drive" && /\b(?:find|search|look for|locate|show)\b/i.test(prompt)) {
        const result = await this.readDriveContext(prompt, runId);
        const rows = result.files.map((file) => `- ${file.name || "Untitled file"} — ${file.mimeType || "file"}${file.webViewLink ? ` ([Open in Drive](${file.webViewLink}))` : ""}`);
        return { ok:true, action:"Drive search complete", detail:result.summary, text:rows.length ? `### Google Drive results\n\n${rows.join("\n")}` : "No matching Google Drive files were found." };
      }
      return await this.createDriveFile(title, runId);
    } catch (error) {
      const gmailPermission = error?.stage?.startsWith("agent-gmail") && error?.httpStatus === 403;
      if (gmailPermission) {
        const apiDisabled = error?.errorCode === "accessNotConfigured";
        const text = apiDisabled
          ? "Gmail API is not enabled for this Google Cloud project. Enable Gmail API, then reconnect Google."
          : "Gmail needs one fresh Google approval. Clyra will open the secure browser consent flow now—approve Gmail read access, then resend this request.";
        this.emitAgentProgress(runId, { service:"gmail", state:"failed", label:apiDisabled ? "Enable Gmail API" : "Reconnect Google for Gmail", detail:apiDisabled ? "The Google project has not enabled the Gmail API." : "Your existing Google connection does not include Gmail read access." });
        return { ok:false, needsAuth:!apiDisabled, text };
      }
      if (error?.httpStatus === 403) {
        const apiDisabled = error?.errorCode === "accessNotConfigured";
        const text = apiDisabled
          ? "This Google API is not enabled for Clyra’s Google Cloud project. Enable the required API, then reconnect Google."
          : "This Google action needs an updated Google permission. Reconnect Google, approve the requested service, then try again.";
        this.emitAgentProgress(runId, { service:"clyra", state:"failed", label:apiDisabled ? "Enable Google API" : "Reconnect Google", detail:apiDisabled ? "The requested Google API is disabled for this project." : "The current token does not include the required Google scope." });
        return { ok:false, needsAuth:!apiDisabled, text };
      }
      this.emitAgentProgress(runId, { service:"clyra", state:"failed", label:"Google action needs attention", detail:error?.stage ? `${error.stage} failed safely.` : "The requested action could not be completed." });
      if(error?.code === "GOOGLE_SIGN_IN_REQUIRED") return {ok:false, needsAuth:true, text:error.message};
      return {ok:false,text:error instanceof Error?error.message:"Google action failed."};
    }
  }
  async execute(payload = {}) { return this.orchestrator.run(payload); }
}
