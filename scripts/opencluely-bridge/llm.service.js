/**
 * Clyra-bridged LLM service for OpenCluely.
 * - Vision: local open VLM via Ollama (default llava-phi3, 8GB-safe)
 * - Text / chat: Clyra /api/companion/ask (project DeepSeek stack)
 * Uses Node http (not Electron fetch) so localhost calls stay reliable.
 * Stealth / Gemini are intentionally not used.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
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

class LLMService {
  constructor() {
    this.client = { provider: 'clyra+llava-phi3' };
    this.model = null;
    this.isInitialized = false;
    this.requestCount = 0;
    this.errorCount = 0;
    this.initializeClient();
  }

  initializeClient() {
    this.model = config.get('llm.vision.model') || process.env.OPENCLUELY_VISION_MODEL || 'llava-phi3';
    this.clyraBase = String(
      process.env.CLYRA_API_BASE || config.get('llm.clyra.baseUrl') || 'http://127.0.0.1:31415',
    ).replace(/\/$/, '');
    this.ollamaBase = String(
      process.env.OLLAMA_BASE_URL || config.get('llm.vision.ollamaBaseUrl') || 'http://127.0.0.1:11434',
    ).replace(/\/$/, '');
    this.isInitialized = true;
    logger.info('Clyra + local vision LLM bridge ready', {
      model: this.model,
      clyraBase: this.clyraBase,
      ollamaBase: this.ollamaBase,
    });
  }

  updateApiKey() {
    this.initializeClient();
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      model: this.model,
      provider: 'clyra+local-vision',
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      visionModel: this.model,
      textEndpoint: `${this.clyraBase}/api/companion/ask`,
    };
  }

  async checkNetworkConnectivity() {
    try {
      const ollama = await httpJson(`${this.ollamaBase}/api/tags`, { timeoutMs: 4000 });
      const clyra = await httpJson(`${this.clyraBase}/api/companion/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'ping' }),
        timeoutMs: 4000,
      }).catch(() => null);
      return { ok: ollama.ok, ollama: ollama.ok, clyra: Boolean(clyra && (clyra.ok || clyra.status < 500)) };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async testConnection() {
    try {
      const connectivity = await this.checkNetworkConnectivity();
      if (!connectivity.ollama) throw new Error(`Ollama not reachable at ${this.ollamaBase}`);
      return { ok: true, ...connectivity, model: this.model };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  formatImageInstruction(activeSkill, programmingLanguage, visionMode = null) {
    const skill = activeSkill || 'general';
    if (visionMode === 'auto' || skill === 'auto') {
      return [
        "Look at this screenshot of the user's screen carefully.",
        'Use your initiative: if there is a visible question, quiz, exam problem, coding challenge, interview prompt, form, error message, or task the user likely needs solved — answer or solve it directly and helpfully.',
        'Quote key on-screen text literally when relevant.',
        'If there is no clear question, briefly describe what is on screen and suggest the most useful next step.',
        'Do not invent apps, sites, or text that are not visible. Be concise. No stealth.',
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
    let buffer = imageBuffer;
    try {
      const tmpIn = path.join(os.tmpdir(), `oc-vision-in-${process.pid}.png`);
      const tmpOut = path.join(os.tmpdir(), `oc-vision-out-${process.pid}.png`);
      fs.writeFileSync(tmpIn, imageBuffer);
      execFileSync('convert', [tmpIn, '-resize', '1024x1024>', '-quality', '90', tmpOut], {
        timeout: 15000,
      });
      buffer = fs.readFileSync(tmpOut);
      try {
        fs.unlinkSync(tmpIn);
        fs.unlinkSync(tmpOut);
      } catch (_) {
        /* ignore */
      }
    } catch (_) {
      buffer = imageBuffer;
    }

    const base64 = buffer.toString('base64');
    const body = {
      model: this.model,
      prompt: prompt || 'What is on this screen? Summarise the main title and key text.',
      images: [base64],
      stream: false,
    };
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const response = await httpJson(`${this.ollamaBase}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          timeoutMs: 120000,
        });
        if (!response.ok) {
          throw new Error(`Vision failed (${response.status}): ${String(response.text || '').slice(0, 200)}`);
        }
        const text = String(response.json?.response || '').trim();
        if (text) return text;

        const chatRes = await httpJson(`${this.ollamaBase}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: 'user', content: body.prompt, images: [base64] }],
            stream: false,
          }),
          timeoutMs: 120000,
        });
        const chatText = String(chatRes.json?.message?.content || '').trim();
        if (chatText) return chatText;
        lastError = new Error('Vision model returned an empty reply');
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
   * Same heuristic as Clyra chat tool — when true, run /api/research/web-search first.
   */
  looksLikeWebSearchQuery(text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    const t = raw.replace(/^\/search\s+/i, '').trim() || raw;
    if (/^\/search\b/i.test(raw)) return true;
    return (
      /^(?:search|look\s*up|find|research|google)\b/i.test(t) ||
      /\b(?:search the web|look online|from the (?:web|internet)|web search)\b/i.test(t) ||
      /\b(?:latest|current|today'?s|this week'?s|breaking)\b.+\b(?:news|price|score|release|update|headline)s?\b/i.test(
        t,
      ) ||
      /^(?:what(?:'| i)?s|who is|when (?:did|is|was)|how many)\b.+/i.test(t)
    );
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
      throw new Error(payload.error || `Web search failed (${response.status})`);
    }
    return {
      query: q,
      urls: Array.isArray(payload.urls) ? payload.urls : [],
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

  async processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null, visionMode = null) {
    if (!this.isInitialized) throw new Error('LLM service not initialized');
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      throw new Error('Invalid image buffer provided to processImageWithSkill');
    }
    const startTime = Date.now();
    this.requestCount += 1;
    const instruction = this.formatImageInstruction(activeSkill, programmingLanguage, visionMode);
    try {
      const visionText = await this.callVision(imageBuffer, instruction);
      let finalText = visionText;
      let source = this.model;
      try {
        const refined = await this.callClyraAsk({
          question: `${instruction}\n\nVision model saw:\n${visionText}\n\nGive a short helpful answer for the user.`,
          visionSummary: visionText,
          ocrText: visionText,
        });
        if (refined.text) {
          finalText = refined.text;
          source = `${this.model}+${refined.source}`;
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

  async processImageWithSkillStream(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null, onDelta, visionMode = null) {
    const result = await this.processImageWithSkill(
      imageBuffer,
      mimeType,
      activeSkill,
      sessionMemory,
      programmingLanguage,
      visionMode,
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
