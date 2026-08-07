/**
 * Clyra-bridged LLM service for OpenCluely.
 * - Vision: free local Moondream (Ollama) — lightweight, ~1.7GB, 8GB-RAM safe
 * - Text / chat: Clyra /api/companion/ask (project DeepSeek stack)
 * Keeps the public method signatures OpenCluely's main.js expects.
 * Stealth / Gemini are intentionally not used.
 */
const logger = require('../core/logger').createServiceLogger('LLM');
const config = require('../core/config');
const { promptLoader } = require('../../prompt-loader');

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
    this.model = config.get('llm.vision.model') || 'llava-phi3';
    this.clyraBase = String(
      process.env.CLYRA_API_BASE ||
        config.get('llm.clyra.baseUrl') ||
        'http://127.0.0.1:31415',
    ).replace(/\/$/, '');
    this.ollamaBase = String(
      process.env.OLLAMA_BASE_URL ||
        config.get('llm.vision.ollamaBaseUrl') ||
        'http://127.0.0.1:11434',
    ).replace(/\/$/, '');
    this.isInitialized = true;
    logger.info('Clyra + Moondream LLM bridge ready', {
      model: this.model,
      clyraBase: this.clyraBase,
      ollamaBase: this.ollamaBase,
    });
  }

  updateApiKey(_apiKey) {
    // Gemini key unused — Clyra/DeepSeek + local Moondream
    this.initializeClient();
  }

  getStats() {
    return {
      isInitialized: this.isInitialized,
      model: this.model,
      provider: 'clyra+llava-phi3',
      requestCount: this.requestCount,
      errorCount: this.errorCount,
      visionModel: this.model,
      textEndpoint: `${this.clyraBase}/api/companion/ask`,
    };
  }

  async checkNetworkConnectivity() {
    try {
      const ollama = await fetch(`${this.ollamaBase}/api/tags`, {
        signal: AbortSignal.timeout(4000),
      });
      const clyra = await fetch(`${this.clyraBase}/api/companion/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: 'ping' }),
        signal: AbortSignal.timeout(4000),
      }).catch(() => null);
      return {
        ok: ollama.ok,
        ollama: ollama.ok,
        clyra: Boolean(clyra && (clyra.ok || clyra.status < 500)),
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  async testConnection() {
    try {
      const connectivity = await this.checkNetworkConnectivity();
      if (!connectivity.ollama) {
        throw new Error('Ollama / Moondream not reachable at ' + this.ollamaBase);
      }
      return { ok: true, ...connectivity, model: this.model };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  formatImageInstruction(activeSkill, programmingLanguage) {
    const skill = activeSkill || 'general';
    const lang = programmingLanguage ? ` Prefer ${programmingLanguage}.` : '';
    return [
      'You are OpenCluely connected to Clyra. Describe what is on screen clearly and helpfully.',
      `Active skill: ${skill}.${lang}`,
      'No stealth. Be concise and practical.',
    ].join(' ');
  }

  async callMoondreamVision(imageBuffer, prompt) {
    // Moondream is happier with modest frames (keeps 8GB RAM + latency in check)
    let buffer = imageBuffer;
    try {
      const { execFileSync } = require('child_process');
      const fs = require('fs');
      const os = require('os');
      const path = require('path');
      const tmpIn = path.join(os.tmpdir(), `oc-vision-in-${process.pid}.png`);
      const tmpOut = path.join(os.tmpdir(), `oc-vision-out-${process.pid}.png`);
      fs.writeFileSync(tmpIn, imageBuffer);
      execFileSync(
        'convert',
        [tmpIn, '-resize', '1024x1024>', '-quality', '90', tmpOut],
        { timeout: 15000 },
      );
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
        const response = await fetch(`${this.ollamaBase}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        });
        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          throw new Error(`Moondream vision failed (${response.status}): ${errText.slice(0, 200)}`);
        }
        const payload = await response.json();
        const text = String(payload?.response || '').trim();
        if (text) return text;

        // Fallback: /api/chat format
        const chatRes = await fetch(`${this.ollamaBase}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: this.model,
            messages: [{ role: 'user', content: body.prompt, images: [base64] }],
            stream: false,
          }),
          signal: AbortSignal.timeout(90_000),
        });
        const chatPayload = await chatRes.json().catch(() => ({}));
        const chatText = String(chatPayload?.message?.content || '').trim();
        if (chatText) return chatText;
        lastError = new Error('Moondream returned an empty vision reply');
      } catch (error) {
        lastError = error;
        logger.warn('Moondream attempt failed', { attempt, error: error.message });
        await new Promise((r) => setTimeout(r, 800 * attempt));
      }
    }
    throw lastError || new Error('Moondream vision failed');
  }

  async callClyraAsk({ question, visionSummary = '', ocrText = '' }) {
    const response = await fetch(`${this.clyraBase}/api/companion/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, visionSummary, ocrText }),
      signal: AbortSignal.timeout(45_000),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok && !payload.text) {
      throw new Error(payload.error || `Clyra ask failed (${response.status})`);
    }
    return {
      text: String(payload.text || payload?.choices?.[0]?.message?.content || '').trim(),
      source: payload.source || 'clyra-api',
      payload,
    };
  }

  async processImageWithSkill(imageBuffer, mimeType, activeSkill, sessionMemory = [], programmingLanguage = null) {
    if (!this.isInitialized) throw new Error('LLM service not initialized');
    if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) {
      throw new Error('Invalid image buffer provided to processImageWithSkill');
    }
    const startTime = Date.now();
    this.requestCount += 1;
    const instruction = this.formatImageInstruction(activeSkill, programmingLanguage);
    try {
      const visionText = await this.callMoondreamVision(imageBuffer, instruction);
      // Optionally refine with Clyra chat model using the vision summary
      let finalText = visionText;
      let source = 'llava-phi3';
      try {
        const refined = await this.callClyraAsk({
          question: `${instruction}\n\nVision model saw:\n${visionText}\n\nGive a short helpful answer for the user.`,
          visionSummary: visionText,
          ocrText: visionText,
        });
        if (refined.text) {
          finalText = refined.text;
          source = `llava-phi3+${refined.source}`;
        }
      } catch (refineError) {
        logger.warn('Clyra refine skipped; using Moondream only', { error: refineError.message });
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
  ) {
    const result = await this.processImageWithSkill(
      imageBuffer,
      mimeType,
      activeSkill,
      sessionMemory,
      programmingLanguage,
    );
    if (typeof onDelta === 'function' && result.response) {
      onDelta(result.response);
    }
    return result;
  }

  async processTextWithSkill(text, activeSkill, sessionMemory = [], programmingLanguage = null) {
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
    const question = [
      skillPrompt ? `Skill context:\n${skillPrompt.slice(0, 1200)}` : '',
      history ? `Recent:\n${history}` : '',
      `User: ${text}`,
    ]
      .filter(Boolean)
      .join('\n\n');

    try {
      const { text: reply, source } = await this.callClyraAsk({
        question,
        visionSummary: 'OpenCluely text chat via Clyra API (no stealth).',
      });
      return {
        response: reply || 'No reply from Clyra API.',
        metadata: {
          skill: activeSkill,
          programmingLanguage,
          processingTime: Date.now() - startTime,
          requestId: `txt-${this.requestCount}`,
          usedFallback: false,
          source,
        },
      };
    } catch (error) {
      this.errorCount += 1;
      logger.error('Text processing failed', { error: error.message });
      throw error;
    }
  }

  async processTextWithSkillStream(
    text,
    activeSkill,
    sessionMemory = [],
    programmingLanguage = null,
    onDelta,
  ) {
    const result = await this.processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage);
    if (typeof onDelta === 'function' && result.response) {
      onDelta(result.response);
    }
    return result;
  }

  async processTranscriptionWithIntelligentResponse(
    text,
    activeSkill,
    sessionMemory = [],
    programmingLanguage = null,
  ) {
    return this.processTextWithSkill(text, activeSkill, sessionMemory, programmingLanguage);
  }

  async processTranscriptionWithIntelligentResponseStream(
    text,
    activeSkill,
    sessionMemory = [],
    programmingLanguage = null,
    onDelta,
  ) {
    return this.processTextWithSkillStream(
      text,
      activeSkill,
      sessionMemory,
      programmingLanguage,
      onDelta,
    );
  }

  generateIntelligentFallbackResponse(text, activeSkill) {
    return {
      response: `I heard: "${String(text || '').slice(0, 200)}". OpenCluely is connected to Clyra + Moondream vision (skill: ${activeSkill || 'general'}). Ask me what's on your screen.`,
      metadata: { usedFallback: true, source: 'local-fallback' },
    };
  }
}

module.exports = new LLMService();
