const { desktopCapturer, screen, nativeImage } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('CAPTURE');

class CaptureService {
  constructor() {
    this.isProcessing = false;
  }

  listDisplays() {
    try {
      const displays = screen.getAllDisplays().map(d => ({
        id: d.id,
        bounds: d.bounds,
        size: d.size,
        scaleFactor: d.scaleFactor,
        rotation: d.rotation,
        touchSupport: d.touchSupport || 'unknown'
      }));
      return { success: true, displays };
    } catch (error) {
      logger.error('Failed to list displays', { error: error.message });
      return { success: false, error: error.message };
    }
  }

  /**
   * Capture screenshot and return an image buffer.
   * options: { displayId?: number, area?: { x, y, width, height } }
   */
  async captureAndProcess(options = {}) {
    if (this.isProcessing) throw new Error('Capture already in progress');
    this.isProcessing = true;
    const startTime = Date.now();
    try {
      const { image, metadata } = await this.captureScreenshot(options);

      // Crop if area specified
      let finalImage = image;
      if (options.area && this._isValidArea(options.area)) {
        try {
          finalImage = image.crop(options.area);
        } catch (e) {
          logger.warn('Crop failed, returning full image', { error: e.message, area: options.area });
        }
      }

      const buffer = finalImage.toPNG();
      try {
        fs.writeFileSync(path.join(os.tmpdir(), 'oc-last-capture.png'), buffer);
      } catch (_) {
        /* ignore */
      }

      logger.logPerformance('Screenshot capture', startTime, {
        bytes: buffer.length,
        dimensions: finalImage.getSize(),
        method: metadata.method || 'unknown'
      });

      return {
        imageBuffer: buffer,
        mimeType: 'image/png',
        metadata: {
          timestamp: new Date().toISOString(),
          source: metadata,
          processingTime: Date.now() - startTime
        }
      };
    } finally {
      this.isProcessing = false;
    }
  }

  async captureScreenshot(options = {}) {
    const targetDisplay = this._getTargetDisplay(options.displayId);

    // On Linux/Xvfb, Electron desktopCapturer often returns stale/wrong frames
    // that make vision models hallucinate. Prefer ImageMagick + active-window crop.
    if (process.platform === 'linux') {
      try {
        const linux = this._captureWithImageMagick(targetDisplay);
        if (linux) return linux;
      } catch (error) {
        logger.warn('Linux ImageMagick capture failed; falling back to desktopCapturer', {
          error: error.message
        });
      }
    }

    return this._captureWithDesktopCapturer(targetDisplay, options);
  }

  _captureWithImageMagick(targetDisplay) {
    const display = process.env.DISPLAY || ':0';
    const env = { ...process.env, DISPLAY: display };
    const outPath = path.join(os.tmpdir(), `oc-import-${process.pid}-${Date.now()}.png`);

    // Prefer capturing the focused app window (Chrome, etc.) so the VLM sees
    // readable page text instead of a tiny window on a huge wallpaper.
    const focused = this._findFocusCaptureTarget(env);
    if (focused?.id) {
      try {
        execFileSync(
          'import',
          ['-window', focused.id, '-display', display, '-quality', '92', outPath],
          { timeout: 15000, env }
        );
        const image = this._loadPng(outPath);
        const size = image.getSize();
        if (size.width >= 200 && size.height >= 200) {
          logger.info('Using Linux ImageMagick focused-window capture', {
            windowId: focused.id,
            title: focused.title,
            imageSize: size
          });
          return {
            image,
            metadata: {
              displayId: targetDisplay.id,
              sourceName: focused.title || 'focused-window',
              method: 'imagemagick-focused-window',
              windowId: focused.id,
              dimensions: size,
              captureTime: new Date().toISOString()
            }
          };
        }
      } catch (error) {
        logger.warn('Focused-window import failed; trying root', { error: error.message });
      }
    }

    execFileSync('import', ['-window', 'root', '-display', display, '-quality', '92', outPath], {
      timeout: 15000,
      env
    });
    let image = this._loadPng(outPath);

    // Crop root capture to the largest useful app window if we can find one.
    const crop = this._largestAppWindowCrop(env, image.getSize());
    if (crop) {
      try {
        image = image.crop(crop);
        logger.info('Cropped root capture to app window', { crop, imageSize: image.getSize() });
      } catch (error) {
        logger.warn('Root crop failed', { error: error.message, crop });
      }
    } else {
      logger.info('Using Linux ImageMagick root capture', { imageSize: image.getSize() });
    }

    return {
      image,
      metadata: {
        displayId: targetDisplay.id,
        sourceName: crop ? 'imagemagick-root-cropped' : 'imagemagick-root',
        method: crop ? 'imagemagick-root-cropped' : 'imagemagick-import',
        dimensions: image.getSize(),
        captureTime: new Date().toISOString()
      }
    };
  }

  _findFocusCaptureTarget(env) {
    try {
      const activeId = execFileSync('xdotool', ['getactivewindow'], {
        timeout: 3000,
        env,
        encoding: 'utf8'
      }).trim();
      if (!activeId) return null;
      const title = this._windowName(activeId, env);
      if (this._isSelfWindow(title)) {
        // OpenCluely was still focused — pick the largest other useful window.
        return this._largestAppWindow(env);
      }
      return { id: activeId, title };
    } catch (_) {
      return this._largestAppWindow(env);
    }
  }

  _largestAppWindow(env) {
    const windows = this._listWindows(env)
      .filter((w) => !this._isSelfWindow(w.title))
      .filter((w) => w.width >= 400 && w.height >= 300)
      .sort((a, b) => b.width * b.height - a.width * a.height);
    return windows[0] || null;
  }

  _largestAppWindowCrop(env, rootSize) {
    const win = this._largestAppWindow(env);
    if (!win) return null;
    const x = Math.max(0, win.x);
    const y = Math.max(0, win.y);
    const width = Math.min(win.width, rootSize.width - x);
    const height = Math.min(win.height, rootSize.height - y);
    if (width < 200 || height < 200) return null;
    // Prefer content area: skip a bit of chrome UI chrome if tall enough
    const contentY = height > 120 ? Math.min(90, Math.floor(height * 0.12)) : 0;
    return {
      x,
      y: y + contentY,
      width,
      height: height - contentY
    };
  }

  _listWindows(env) {
    try {
      const ids = execFileSync('xdotool', ['search', '--name', '.'], {
        timeout: 5000,
        env,
        encoding: 'utf8'
      })
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const out = [];
      for (const id of ids.slice(0, 80)) {
        try {
          const geom = execFileSync('xdotool', ['getwindowgeometry', '--shell', id], {
            timeout: 2000,
            env,
            encoding: 'utf8'
          });
          const vals = Object.fromEntries(
            geom
              .trim()
              .split('\n')
              .map((line) => line.split('='))
              .filter((p) => p.length === 2)
          );
          const title = this._windowName(id, env);
          out.push({
            id,
            title,
            x: Number(vals.X) || 0,
            y: Number(vals.Y) || 0,
            width: Number(vals.WIDTH) || 0,
            height: Number(vals.HEIGHT) || 0
          });
        } catch (_) {
          /* skip */
        }
      }
      return out;
    } catch (_) {
      return [];
    }
  }

  _windowName(id, env) {
    try {
      return execFileSync('xdotool', ['getwindowname', id], {
        timeout: 2000,
        env,
        encoding: 'utf8'
      }).trim();
    } catch (_) {
      return '';
    }
  }

  _isSelfWindow(title = '') {
    const t = String(title).toLowerCase();
    return (
      t.includes('opencluely') ||
      t.includes('live transcription') ||
      t.includes('ai response') ||
      t.includes('clyra') ||
      t === 'settings'
    );
  }

  _loadPng(filePath) {
    const buffer = fs.readFileSync(filePath);
    try {
      fs.unlinkSync(filePath);
    } catch (_) {
      /* ignore */
    }
    const image = nativeImage.createFromBuffer(buffer);
    if (!image || image.isEmpty()) {
      throw new Error('ImageMagick import produced an empty image');
    }
    return image;
  }

  async _captureWithDesktopCapturer(targetDisplay, options = {}) {
    const { width, height } = targetDisplay.size || { width: 1920, height: 1080 };

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    });

    if (sources.length === 0) {
      throw new Error('No screen sources available for capture');
    }

    let source = sources[0];
    const match = sources.find(s => {
      const size = s.thumbnail.getSize();
      return size.width === width && size.height === height;
    });
    if (match) source = match;

    const image = source.thumbnail;
    if (!image) throw new Error('Failed to capture screen thumbnail');

    logger.debug('Screenshot captured via desktopCapturer', {
      sourceName: source.name,
      imageSize: image.getSize()
    });

    return {
      image,
      metadata: {
        displayId: targetDisplay.id,
        sourceName: source.name,
        method: 'desktopCapturer',
        dimensions: image.getSize(),
        captureTime: new Date().toISOString()
      }
    };
  }

  _getTargetDisplay(displayId) {
    const all = screen.getAllDisplays();
    if (!all || all.length === 0) return screen.getPrimaryDisplay();
    if (displayId == null) return screen.getPrimaryDisplay();
    const found = all.find(d => d.id === displayId);
    return found || screen.getPrimaryDisplay();
  }

  _isValidArea(area) {
    return area && Number.isFinite(area.x) && Number.isFinite(area.y) &&
      Number.isFinite(area.width) && Number.isFinite(area.height) &&
      area.width > 0 && area.height > 0;
  }
}

module.exports = new CaptureService();
