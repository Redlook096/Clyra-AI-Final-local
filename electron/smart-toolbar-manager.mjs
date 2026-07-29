import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BrowserWindow, clipboard, globalShortcut, screen, systemPreferences } from "electron";

const execFileAsync = promisify(execFile);
const WIDTH = 760;
const COMPACT_HEIGHT = 70;
const RESPONSE_HEIGHT = 265;
const MARGIN = 10;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function snapshotClipboard() {
  return clipboard.availableFormats().flatMap((format) => { try { return [{ format, value: clipboard.readBuffer(format).toString("base64") }]; } catch { return []; } });
}
function restoreClipboard(snapshot) { clipboard.clear(); for (const item of snapshot || []) { try { clipboard.writeBuffer(item.format, Buffer.from(item.value, "base64")); } catch { /* preserve what the platform accepts */ } } }
async function apple(script) { const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], { timeout: 1_800, maxBuffer: 96 * 1024 }); return String(stdout || "").trim(); }
function escapeApple(value) { return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"'); }
async function clipboardSelectionFallback() {
  // Clipboard probing is deliberately a last resort (for controls that omit
  // AXSelectedText). A unique marker prevents stale clipboard content from
  // becoming a false selection, and every available format is restored.
  const saved = snapshotClipboard();
  const marker = `__clyra_toolbar_probe_${crypto.randomUUID()}__`;
  try {
    clipboard.writeText(marker);
    if (process.platform === "darwin") await apple('tell application "System Events" to keystroke "c" using command down');
    else if (process.platform === "win32") await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')"], { timeout: 1_200 });
    await delay(52);
    const copied = clipboard.readText();
    return copied === marker ? "" : copied;
  } catch { return ""; } finally { restoreClipboard(saved); }
}

async function macSelection() {
  const script = `tell application "System Events"
    set p to first process whose frontmost is true
    set n to name of p
    try
      set e to focused UI element of front window of p
      set r to role of e as text
      set sr to subrole of e as text
      set t to value of attribute "AXSelectedText" of e as text
      set pos to position of e
      set siz to size of e
      return n & (ASCII character 31) & r & (ASCII character 31) & sr & (ASCII character 31) & t & (ASCII character 31) & (item 1 of pos) & "," & (item 2 of pos) & "," & (item 1 of siz) & "," & (item 2 of siz)
    on error
      return n & (ASCII character 31)
    end try
  end tell`;
  const raw = await apple(script); const [application = "", role = "", subrole = "", text = "", frame = ""] = raw.split("\u001f");
  const values = frame.split(",").map(Number); return { application, text, secure: /secure|password/i.test(`${role} ${subrole}`), frame: values.length === 4 ? { x: values[0], y: values[1], width: values[2], height: values[3] } : null };
}
async function windowsSelection() {
  const script = `Add-Type -AssemblyName UIAutomationClient; $e=[System.Windows.Automation.AutomationElement]::FocusedElement; if(!$e){exit}; $n=$e.Current.Name; $pw=$e.Current.IsPassword; $sep=[char]31; try{$p=$e.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern);$t=$p.GetSelection()|ForEach-Object{$_.GetText(-1)};$r=$p.GetSelection()|Select-Object -First 1; $b=$r.GetBoundingRectangles(); "$n$sep$pw$sep$t$sep$b"}catch{"$n$sep$pw$sep"}`;
  try { const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 1_800 }); const [application = "", secure = "False", text = ""] = String(stdout).trim().split("\u001f"); return { application, text, secure: secure === "True", frame: null }; } catch { return { application: "", text: "", secure: false, frame: null }; }
}

export class SmartToolbarManager {
  constructor({ uiContents, preloadPath, toolbarPath, serviceUrl, isSuppressed = () => false }) { this.uiContents = uiContents; this.preloadPath = preloadPath; this.toolbarPath = toolbarPath; this.serviceUrl = serviceUrl; this.isSuppressed = isSuppressed; this.window = null; this.timer = null; this.polling = false; this.selection = null; this.lastText = ""; this.lastCursor = null; this.hiddenAt = 0; this.escapeRegistered = false; this.lastClipboardProbeAt = 0; }
  isSender(contents) { return contents?.id === this.window?.webContents.id; }
  async initialize() { if (this.timer) return; this.timer = setInterval(() => void this.observe(), 700); }
  destroy() { if (this.timer) clearInterval(this.timer); this.timer = null; this.unregisterEscape(); this.window?.destroy(); this.window = null; }
  trusted() { try { return process.platform !== "darwin" || systemPreferences.isTrustedAccessibilityClient(false); } catch { return false; } }
  async readSelection() { if (process.platform === "darwin") return macSelection(); if (process.platform === "win32") return windowsSelection(); return { application: "", text: "", secure: false, frame: null }; }
  ensureWindow() { if (this.window && !this.window.isDestroyed()) return this.window; this.window = new BrowserWindow({ width: WIDTH, height: COMPACT_HEIGHT, show:false, frame:false, transparent:true, resizable:false, skipTaskbar:true, alwaysOnTop:true, hasShadow:false, title:"Clyra Smart Toolbar", webPreferences:{ preload:this.preloadPath, contextIsolation:true, nodeIntegration:false, sandbox:true, backgroundThrottling:false } }); this.window.setAlwaysOnTop(true,"floating"); this.window.setVisibleOnAllWorkspaces(true,{visibleOnFullScreen:true}); this.window.loadFile(this.toolbarPath).catch(()=>undefined); this.window.on("closed",()=>{this.window=null}); return this.window; }
  emit(payload) { const win=this.ensureWindow(); if (!win.webContents.isLoading()) win.webContents.send("smart-toolbar:state",payload); else win.webContents.once("did-finish-load",()=>win.webContents.send("smart-toolbar:state",payload)); }
  position(frame, height = COMPACT_HEIGHT) { const cursor=screen.getCursorScreenPoint(); const display=screen.getDisplayNearestPoint(cursor); const area=display.workArea; const anchor=frame ? { x: frame.x + frame.width / 2, y: frame.y + frame.height } : cursor; const x=Math.round(Math.max(area.x+MARGIN,Math.min(anchor.x-WIDTH/2,area.x+area.width-WIDTH-MARGIN))); let y=Math.round(anchor.y+MARGIN); if(y+height>area.y+area.height-MARGIN) y=Math.round(Math.max(area.y+MARGIN, (frame?frame.y:cursor.y)-height-MARGIN)); this.window?.setBounds({x,y,width:WIDTH,height}); }
  registerEscape() { if(this.escapeRegistered) return; this.escapeRegistered=globalShortcut.register("Escape",()=>this.hide()); }
  unregisterEscape() { if(!this.escapeRegistered) return; globalShortcut.unregister("Escape"); this.escapeRegistered=false; }
  show(selection) { this.selection=selection; this.lastText=selection.text; const win=this.ensureWindow(); this.position(selection.frame); this.emit({visible:true,card:false}); this.registerEscape(); win.showInactive(); }
  hide() { this.selection=null; this.lastText=""; this.hiddenAt=Date.now(); this.unregisterEscape(); if(this.window&&!this.window.isDestroyed()){this.emit({visible:false});setTimeout(()=>this.window?.hide(),180);} }
  async observe() { if(this.polling || !this.trusted()) return; if(this.isSuppressed()){if(this.selection)this.hide();return;} this.polling=true; try { const cursor=screen.getCursorScreenPoint(); const moved=!this.lastCursor || Math.hypot(cursor.x-this.lastCursor.x,cursor.y-this.lastCursor.y)>12; this.lastCursor=cursor; const current=await this.readSelection(); let text=String(current.text||"").trim(); const now=Date.now(); if(!text && moved && !current.secure && !/^Clyra$/i.test(current.application) && now-this.lastClipboardProbeAt>1_800){this.lastClipboardProbeAt=now;text=(await clipboardSelectionFallback()).trim();} const winFocused=this.window?.isFocused(); if(!text || current.secure || /^Clyra$/i.test(current.application) || winFocused || (moved && this.selection && text===this.lastText)) { if(this.selection && !winFocused) this.hide(); return; } if(text.length>20_000) return; const changed=!this.selection || text!==this.lastText || current.application!==this.selection.application; if(changed) this.show({ ...current, text }); } catch { /* Accessibility can disappear while another app is closing. */ } finally { this.polling=false; } }
  async action({ action, value }) { if(action==="copy") return this.copy(); if(action==="replace"||action==="below") return this.insert(action); if(!this.selection?.text) return; const prompts={ ask:"Answer the user's likely question about this selected text. Be concise and practical.", explain:"Explain this selected text in plain English. Keep it concise.", rewrite:"Rewrite this selected text for clarity and a premium professional tone. Return only the rewrite.", summarise:"Summarise this selected text in concise bullets.", translate:`Translate this selected text to ${value||"English"}. Return only the translation.`, more:"Give the most useful next insight or action for this selected text." }; this.position(this.selection.frame, RESPONSE_HEIGHT); this.emit({visible:true,card:true,action,loading:true,response:""}); try { const response=await fetch(`${this.serviceUrl()}/api/smart-toolbar/action`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action, text:this.selection.text, instruction:prompts[action]})}); const payload=await response.json(); if(!response.ok||!payload.ok) throw new Error(payload.error||"Clyra could not respond."); this.emit({visible:true,card:true,action,response:String(payload.text||"")}); } catch(error) { this.emit({visible:true,card:true,action,response:error instanceof Error?error.message:"Clyra could not respond."}); } }
  async copy() { const text=this.window?.webContents ? await this.window.webContents.executeJavaScript("document.querySelector('#answer').textContent") : ""; if(text) clipboard.writeText(String(text)); this.emit({visible:true,card:true,response:text,action:"more"}); }
  async focusTarget() { if(process.platform!=="darwin"||!this.selection?.application) return; await apple(`tell application "${escapeApple(this.selection.application)}" to activate`); await delay(65); }
  async insert(action) { const text=this.window?.webContents ? String(await this.window.webContents.executeJavaScript("document.querySelector('#answer').textContent")) : ""; if(!text) return; if(process.platform!=="darwin") { this.emit({visible:true,card:true,response:"Copied — use Ctrl+V to insert on this platform.",action:"more"}); clipboard.writeText(text); return; } const saved=snapshotClipboard(); try { await this.focusTarget(); clipboard.writeText(text); await delay(35); if(action==="below") await apple('tell application "System Events" to key code 124'); if(action==="below") await apple('tell application "System Events" to key code 36'); await apple('tell application "System Events" to keystroke "v" using command down'); this.hide(); } finally { await delay(90); restoreClipboard(saved); } }
}
