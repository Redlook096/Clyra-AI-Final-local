/**
 * Clyra-bridged LLM service for OpenCluely.
 * - Vision: Clyra /api/companion/vision-frame (Gemini — GEMINI_API_KEY on Clyra server)
 * - Text / chat: Clyra /api/companion/ask (DeepSeek V4 Flash stack)
 * Uses Node http (not Electron fetch) so localhost calls stay reliable.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('../core/logger').createServiceLogger('LLM');
const config = require('../core/config');
const { promptLoader } = require('../../prompt-loader');

function httpJson(url, { method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method,
        headers: {
          ...headers,
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let json = {};
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {
            json = { raw };
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode,
            json,
            text: raw,
          });
        });
      },
    );
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function sanitizeModelText(text) {
  let out = String(text || '').replace(/\s+/g, ' ').trim();
  if (!out) return out;
  // Collapse runaway token loops like "the the the..." or repeated phrases
  out = out.replace(/\b(\w+)(?:\s+\1){3,}\b/gi, '$1');
  // Collapse repeated 4–12 word phrases
  out = out.replace(/((?:\b\w+\b[\s,.-]*){4,12})\1{2,}/gi, '$1');
  // Strip Clyra companion overlay pitch that pollutes OpenCluely vision replies
  out = out.replace(/\s*Talk to me while you work[^.?!]*[.?!]/gi, ' ').trim();
  out = out.replace(/\s*(?:open the Electron overlay|⌘\s*⇧\s*J|Atlas cursor)[^.?!]*[.?!]?/gi, ' ').trim();
  // Fix empty numbered labels from VLMs: "1.  : The Google logo" → "1. The Google logo"
  out = out.replace(/(\d+)\.\s*:\s*/g, '$1. ');
  // Hard cap extremely long garbled replies
  if (out.length > 1200) out = `${out.slice(0, 1100).trim()}…`;
  return out.replace(/\s+/g, ' ').trim();
}

class LLMService {
  constructor() {
    this.client = { provider: 'clyra+gemini' };
    this.model = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
    this.initializeClient();
  }

  initializeClient() {
    this.model =
      process.env.GEMINI_VISION_MODEL ||
      config.get('llm.vision.model') ||
      'gemini-3.1-flash-lite';
    this.clyraBase = String(
      process.env.CLYRA_API_BASE || config.get('llm.clyra.baseUrl') || 'http://127.0.0.1:31415',
    ).replace(/\/$/, '');
    this.isInitialized = true;
    logger.info('Clyra + Gemini vision bridge ready', {
      model: this.model,
      clyraBase: this.clyraBase,
      visionEndpoint: `${this.clyraBase}/api/companion/vision-frame`,
    });
  }

  updateApiKey() {
    this.initializeClient();
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      model: this.model,
      provider: 'clyra+gemini',
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      visionModel: this.model,
      textEndpoint: `${this.clyraBase}/api/companion/ask`,
      visionEndpoint: `${this.clyraBase}/api/companion/vision-frame`,
    };
  }

  async checkNetworkConnectivity() {
    try {
      const health = await httpJson(`${this.clyraBase}/api/companion/vision-health`, { timeoutMs: 8000 });
      const clyra = await httpJson(`${this.clyraBase}/api/companion/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'ping' }),
        timeoutMs: 4000,
      }).catch(() => null);
      return {
        ok: health.ok,
        gemini: health.ok,
        clyra: Boolean(clyra && (clyra.ok || clyra.status < 500)),
        model: health.json?.model || this.model,
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async testConnection() {
    try {
      const connectivity = await this.checkNetworkConnectivity();
      if (!connectivity.gemini) {
        throw new Error(
          'Gemini vision is not reachable. Set GEMINI_API_KEY on the Clyra server (.env.local) and restart.',
        );
      }
      return { ok: true, ...connectivity, model: this.model };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  formatImageInstruction(activeSkill, programmingLanguage, visionMode = null, userQuestion = null) {
    const skill = activeSkill || 'general';
    const asked = String(userQuestion || '').trim();
    if (visionMode === 'screen-ask' || asked) {
      return [
        "You are given a real screenshot of the user's live desktop. The image always contains something.",
        asked ? `The user asked: "${asked.slice(0, 400)}"` : 'Describe what is visible on screen.',
        'Never say you cannot see the screen, that the image is blank, or that you lack vision — describe what is there.',
        'Answer using only what is actually visible: apps, windows, text, UI, wallpaper.',
        'Read on-screen text literally. Quote key titles/headings when relevant.',
        'Say which app or website is open if the window chrome or URL bar is visible.',
        'Do not invent apps, sites, books, chats, or text that are not in the image.',
        'Be concise and practical. Do not mention overlays, shortcuts, Electron, or Atlas.',
      ].join(' ');
    }
    if (visionMode === 'auto' || skill === 'auto') {
      return [
        "Look at this screenshot of the user's screen carefully.",
        'Use your initiative: if there is a visible question, quiz, exam problem, coding challenge, interview prompt, form, error message, or task the user likely needs solved — answer or solve it directly and helpfully.',
        'Quote key on-screen text literally when relevant.',
        'If there is no clear question, briefly describe what is on screen and suggest the most useful next step.',
        'Write in short plain prose or a clean numbered list like "1. Item" — never empty labels like "1. :".',
        'Do not invent apps, sites, or text that are not visible. Be concise. Do not mention overlays, shortcuts, or Atlas.',
      ].join(' ');
    }
    if (skill === 'general' || skill === 'screen') {
      return [
        "Look at this screenshot of the user's screen.",
        'Read the visible text literally. Quote the main heading/title exactly.',
        'Say which app or website is open (from the window chrome or URL bar if visible).',
        'Do not invent unrelated apps, books, chats, or websites that are not in the image.',
        'Be concise and practical. No stealth.',
      ].join(' ');
    }
    const lang = programmingLanguage ? ` Prefer ${programmingLanguage}.` : '';
    return [
      'You are OpenCluely connected to Clyra. Describe what is on screen clearly and helpfully.',
      `Active skill: ${skill}.${lang}`,
      'No stealth. Be concise and practical.',
    ].join(' ');
  }

  async callVision(imageBuffer, prompt) {
    const base64 = imageBuffer.toString('base64');
    const dataUrl = `data:image/png;base64,${base64}`;
    const question =
      prompt || 'What is on this screen? Summarise the main title and key text.';
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await httpJson(`${this.clyraBase}/api/companion/vision-frame`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ image: dataUrl, question }),
          timeoutMs: 60_000,
        });
        if (!response.ok) {
          throw new Error(
            `Gemini vision failed (${response.status}): ${String(response.json?.error || response.text || '').slice(0, 200)}`,
          );
        }
        const text = sanitizeModelText(
          String(response.json?.summary || response.json?.text || '').trim(),
        );
        if (text) return text;
        lastError = new Error('Gemini vision returned an empty reply');
      } catch (error) {
        lastError = error;
        logger.warn('Vision attempt failed', { attempt, error: error.message });
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    throw lastError || new Error('Vision failed');
  }

  async callClyraAsk({ question, visionSummary = '', ocrText = '' }) {
    const response = await httpJson(`${this.clyraBase}/api/companion/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, visionSummary, ocrText }),
      timeoutMs: 45000,
    });
    const payload = response.json || {};
    if (!response.ok && !payload.text) {
      throw new Error(payload.error || `Clyra ask failed (${response.status})`);
    }
    return {
      text: String(payload.text || payload?.choices?.[0]?.message?.content || '').trim(),
      source: payload.source || 'clyra-api',
      payload,
    };
  }

  /**
   * Tight web-search heuristic — only fire when the user clearly wants research.
   * Avoids treating screen/local questions ("what's on my screen", "what is 2+2")
   * as web searches.
   */
  looksLikeWebSearchQuery(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    if (/^\/search\b/i.test(raw)) return true;
    const t = raw.replace(/^\/search\s+/i, '').trim() || raw;
    // Never web-search screen / local / math / coding help phrasing.
    if (
      /\b(on (my )?screen|my (screen|desktop|window|display)|screenshot|what do you see|can you see|looking at|read (the )?page)\b/i.test(
        t,
      )
    ) {
      return false;
    }
    if (/^[\d\s.+\-*/()^=%]+$/.test(t)) return false;
    if (
      /^(?:how (?:do|can|to)|help me|explain|write|fix|debug|refactor)\b/i.test(t) &&
      !/\b(?:online|web|internet|latest|news)\b/i.test(t)
    ) {
      return false;
    }
    if (
      /^(?:search|look\s*up|research|google)\b/i.test(t) ||
      /\b(?:search the web|look online|from the (?:web|internet)|web search)\b/i.test(t) ||
      /\b(?:latest|current|today'?s|this week'?s|breaking)\b.+\b(?:news|price|score|release|update|headline)s?\b/i.test(
        t,
      )
    ) {
      return true;
    }
    // Factual lookups only — exclude UI-help phrasing.
    if (
      /^(?:who is|when (?:did|was)|how many)\b.+/i.test(t) &&
      !/\b(button|click|menu|tab|field|screen|window|app)\b/i.test(t)
    ) {
      return true;
    }
    return false;
  }

  normalizeSearchQuery(text) {
    return String(text || '')
      .trim()
      .replace(/^\/search\s+/i, '')
      .trim();
  }

  /**
   * Chat-tool backend: POST /api/research/web-search (DuckDuckGo + page fetch).
   * Returns analysisPrompt suitable for companion/ask synthesis.
   */
  async callWebSearch(query, { maxResults = 6, fetchTop = 3 } = {}) {
    const q = this.normalizeSearchQuery(query);
    if (!q) throw new Error('Search query required');
    const response = await httpJson(`${this.clyraBase}/api/research/web-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, maxResults, fetchTop }),
      timeoutMs: 90000,
    });
    const payload = response.json || {};
    if (!response.ok || payload.ok === false) {
      const errObj = payload.error;
      const errMsg =
        typeof errObj === 'string'
          ? errObj
          : errObj?.message || `Web search failed (${response.status})`;
      throw new Error(errMsg);
    }
    const urls = Array.isArray(payload.urls)
      ? payload.urls
      : Array.isArray(payload.results)
        ? payload.results.map((r) => r.url || r.href).filter(Boolean)
        : [];
    return {
      query: q,
      urls,
      pages: Array.isArray(payload.pages) ? payload.pages : [],
      analysisPrompt: String(payload.analysisPrompt || '').trim(),
      source: 'clyra-web-search',
      payload,
    };
  }

  async processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null, onStatus = null) {
    if (!this.isInitialized) throw new Error('LLM service not initialized');
    const startTime = Date.now();
    this.requestCount += 1;
    const skillPrompt = promptLoader.getSkillPrompt?.(activeSkill, programmingLanguage) || '';
    const history = Array.isArray(sessionMemory)
      ? sessionMemory
          .slice(-6)
          .map((m) => `${m.role || 'user'}: ${m.content || m.text || ''}`)
          .join('\n')
      : '';

    let userText = String(text || '').trim();
    let usedWebSearch = false;
    let searchUrls = [];
    let searchSource = '';

    // When the user needs research, run the same backend web search as the chat tool,
    // then synthesize with companion/ask using the grounded analysisPrompt.
    if (this.looksLikeWebSearchQuery(userText)) {
      const q = this.normalizeSearchQuery(userText);
      try {
        if (typeof onStatus === 'function') {
          onStatus({ phase: 'searching', message: `Searching the web for “${q.slice(0, 80)}”…` });
        }
        logger.info('Running Clyra web search for OpenCluely ask', { query: q.slice(0, 120) });
        const research = await this.callWebSearch(q);
        usedWebSearch = true;
        searchUrls = research.urls;
        searchSource = research.source;
        if (research.analysisPrompt) {
          userText = [
            `The user asked OpenCluely: ${q}`,
            '',
            research.analysisPrompt,
            '',
            'Answer helpfully using the research above. Cite sources briefly when useful.',
          ].join('\n');
        } else if (research.urls.length) {
          userText = [
            `User question: ${q}`,
            `Web search found these URLs: ${research.urls.slice(0, 6).join(', ')}`,
            'Answer using this research context.',
          ].join('\n');
        }
        if (typeof onStatus === 'function') {
          onStatus({
            phase: 'synthesizing',
            message: `Found ${research.urls.length || 0} sources — writing an answer…`,
          });
        }
      } catch (searchError) {
        logger.warn('Web search failed; falling back to plain ask', { error: searchError.message });
        if (typeof onStatus === 'function') {
          onStatus({
            phase: 'search-failed',
            message: `Web search unavailable (${searchError.message}). Answering without live research…`,
          });
        }
        userText = this.normalizeSearchQuery(String(text || '').trim()) || userText;
      }
    }

    const question = [
      skillPrompt ? `Skill context:\n${skillPrompt.slice(0, 1200)}` : '',
      history ? `Recent:\n${history}` : '',
      `User: ${userText}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const { text: reply, source } = await this.callClyraAsk({
        question,
        visionSummary: '',
        ocrText: '',
      });
      return {
        response: reply || 'No reply from Clyra API.',
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: `txt-${this.requestCount}`,
          usedFallback: false,
          source: usedWebSearch ? `${searchSource}+${source}` : source,
          usedWebSearch,
          searchUrls,
        },
      };
    } catch (error) {
      this.errorCount += 1;
      logger.error('Text processing failed', { error: error.message });
      throw error;
    }
  }

  async processTextWithSkillStream(text, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta, onStatus) {
    const result = await this.processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage, onStatus);
    if (typeof onDelta === 'function' && result.response) onDelta(result.response);
    return result;
  }

  async processImageWithSkill(
    imageBuffer,
    mimeType,
    activeSkill,
    sessionMemory = [],
    programmingLanguage = null,
    visionMode = null,
    userQuestion = null,
  ) {
    if (!this.isInitialized) throw new Error('LLM service not initialized');
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      throw new Error('Invalid image buffer provided to processImageWithSkill');
    }
    const startTime = Date.now();
    this.requestCount += 1;
    const instruction = this.formatImageInstruction(
      activeSkill,
      programmingLanguage,
      visionMode,
      userQuestion,
    );
    try {
      const visionText = sanitizeModelText(await this.callVision(imageBuffer, instruction));
      let finalText = visionText;
      let source = this.model;
      try {
        const asked = String(userQuestion || '').trim();
        const refined = await this.callClyraAsk({
          question: [
            instruction,
            asked ? `User question: ${asked}` : '',
            `Vision model saw:\n${visionText}`,
            'Rewrite into a short helpful answer for the user. Keep facts from the vision notes. Do not mention Electron overlays, keyboard shortcuts, or Atlas. Do not repeat yourself.',
          ]
            .filter(Boolean)
            .join('\n\n'),
          visionSummary: visionText,
          ocrText: visionText,
        });
        if (refined.text) {
          const cleaned = sanitizeModelText(refined.text);
          // vision-local often just echoes vision + marketing pitch — keep pure vision then.
          const sourceName = String(refined.source || '');
          const addsSubstance =
            cleaned &&
            cleaned.length >= Math.min(48, visionText.length) &&
            cleaned !== visionText &&
            !/^I am ready to help/i.test(cleaned);
          if (addsSubstance && sourceName !== 'vision-local') {
            finalText = cleaned;
            source = `${this.model}+${sourceName}`;
          } else if (addsSubstance && cleaned.length > visionText.length + 20) {
            finalText = cleaned;
            source = `${this.model}+${sourceName}`;
          } else {
            finalText = visionText;
            source = this.model;
          }
        }
      } catch (refineError) {
        logger.warn('Clyra refine skipped; using vision only', { error: refineError.message });
      }
      return {
        response: finalText,
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: `img-${this.requestCount}`,
          usedFallback: false,
          source,
          mimeType,
          visionModel: this.model,
          visionMode: visionMode || 'describe',
        },
      };
    } catch (error) {
      this.errorCount += 1;
      logger.error('Image processing failed', { error: error.message });
      throw error;
    }
  }

  async processImageWithSkillStream(
    imageBuffer,
    mimeType,
    activeSkill,
    sessionMemory = [],
    programmingLanguage = null,
    onDelta,
    visionMode = null,
    userQuestion = null,
  ) {
    const result = await this.processImageWithSkill(
      imageBuffer,
      mimeType,
      activeSkill,
      sessionMemory,
      programmingLanguage,
      visionMode,
      userQuestion,
    );
    if (typeof onDelta === 'function' && result.response) onDelta(result.response);
    return result;
  }

  async processTranscriptionWithIntelligentResponse(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
    return this.processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage);
  }

  async processTranscriptionWithIntelligentResponseStream(
    text,
    activeSkill,
    sessionMemory = [],
    programmingLanguage = null,
    onDelta,
  ) {
    return this.processTextWithSkillStream(text, activeSkill, sessionMemory, programmingLanguage, onDelta);
  }

  generateIntelligentFallbackResponse(text, activeSkill) {
    return {
      response: `I heard: "${String(text || '').slice(0, 200)}". OpenCluely is connected to Clyra + local vision (skill: ${activeSkill || 'general'}). Ask me what's on your screen.`,
      metadata: { usedFallback: true, source: 'local-fallback' },
    };
  }
}

module.exports = new LLMService();
