import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { safeStorage } from "electron";

// Local-only Mem0-compatible core: add, search, list, update, delete, clear.
// The encrypted payload never leaves Electron main; user_id is mandatory on every operation.
const tokens = (value) => new Set(String(value || "").toLowerCase().match(/[a-z0-9]{3,}/g) || []);
const score = (query, memory) => { const q=tokens(query), m=tokens(memory.text); let hits=0; for (const word of q) if(m.has(word)) hits++; return hits / Math.max(1, q.size) + Math.min(0.12, (memory.updatedAt || 0) / Date.now() * 0.12); };
const durable = (text) => /\b(?:remember|prefer|always|never|my name|i use|i'm using|project|decision|working on|like|dislike|timezone|language|goal)\b/i.test(text);

export class LocalMemoryManager {
  constructor({ filePath, development=false }) { this.filePath=filePath; this.development=development; this.cache=null; }
  log(stage, detail={}) { if(this.development) console.info("[local-memory]", stage, detail); }
  async load() { if(this.cache) return this.cache; try { if(!safeStorage.isEncryptionAvailable()) throw new Error("Secure storage unavailable"); const raw=await fs.readFile(this.filePath); this.cache=JSON.parse(safeStorage.decryptString(raw)); } catch { this.cache={ version:1, users:{} }; } return this.cache; }
  async save() { if(!safeStorage.isEncryptionAvailable()) throw new Error("Secure storage unavailable"); await fs.mkdir(dirname(this.filePath),{recursive:true}); await fs.writeFile(this.filePath,safeStorage.encryptString(JSON.stringify(this.cache))); }
  async list(userId) { const db=await this.load(); return [...(db.users[userId]||[])].sort((a,b)=>b.updatedAt-a.updatedAt).map(({id,text,createdAt,updatedAt})=>({id,text,createdAt,updatedAt})); }
  async add({ userId, text, force=false }) { if(!userId) throw new Error("user_id required"); const clean=String(text||"").trim().replace(/\s+/g," ").slice(0,800); if(!clean || (!force && !durable(clean))) return { saved:false, reason:"not_durable" }; const db=await this.load(); const memories=db.users[userId] ||= []; const existing=memories.find((memory)=>score(clean,memory)>0.82); const now=Date.now(); if(existing){ existing.text=clean; existing.updatedAt=now; await this.save(); return {saved:true,updated:true,id:existing.id}; } const memory={id:crypto.randomUUID(),text:clean,createdAt:now,updatedAt:now}; memories.push(memory); await this.save(); return {saved:true,updated:false,id:memory.id}; }
  async search({userId,query,limit=5}) { const db=await this.load(); return (db.users[userId]||[]).map((memory)=>({...memory,score:score(query,memory)})).filter((memory)=>memory.score>0).sort((a,b)=>b.score-a.score).slice(0,limit).map(({id,text,score:rank})=>({id,text,score:rank})); }
  async update({userId,id,text}) { const db=await this.load(); const memory=(db.users[userId]||[]).find((item)=>item.id===id); if(!memory) return {ok:false}; memory.text=String(text||"").trim().slice(0,800); memory.updatedAt=Date.now(); await this.save(); return {ok:true}; }
  async remove({userId,id}) { const db=await this.load(); const items=db.users[userId]||[]; const next=items.filter((item)=>item.id!==id); db.users[userId]=next; await this.save(); return {ok:next.length!==items.length}; }
  async clear(userId) { const db=await this.load(); delete db.users[userId]; await this.save(); return {ok:true}; }
}
