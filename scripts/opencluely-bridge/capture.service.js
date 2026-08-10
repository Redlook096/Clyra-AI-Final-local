const { desktopCapturer, screen, nativeImage } = require('electron');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const logger = require('../core/logger').createServiceLogger('CAPTURE');

/**
 * Cross-platform screen capture:
 * - Linux: ImageMagick import (+ xdotool focused window)
 * - macOS: screencapture
 * - Windows: PowerShell GDI+ virtual-screen bitmap
 * Falls back to Electron desktopCapturer on every platform.
 */
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

  async captureAndProcess(options = {}) {
    if (this.isProcessing) throw new Error('Capture already in progress');
    this.isProcessing = true;
    const startTime = Date.now();
    try {
      const { image, metadata } = await this.captureScreenshot(options);

      let finalImage = image;
      if (options.area && this._isValidArea(options.area)) {
        try {
          finalImage = image.crop(options.area);
        } catch (e) {
          logger.warn('Crop failed, returning full image', { error: e.message, area: options.area });
        }
      }

      const buffer = this._compressForVision(finalImage);
      try {
        fs.writeFileSync(path.join(os.tmpdir(), 'oc-last-capture.jpg'), buffer);
      } catch (_) {
        /* ignore */
      }

      logger.logPerformance('Screenshot capture', startTime, {
        bytes: buffer.length,
        dimensions: finalImage.getSize(),
        method: metadata.method || 'unknown',
        platform: process.platform
      });

      return {
        imageBuffer: buffer,
        mimeType: 'image/jpeg',
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

    try {
      if (process.platform === 'linux') {
        const linux = this._captureLinuxNative(targetDisplay, options);
        if (linux) return linux;
      } else if (process.platform === 'darwin') {
        const mac = this._captureMacNative(targetDisplay);
        if (mac) return mac;
      } else if (process.platform === 'win32') {
        const win = this._captureWindowsNative(targetDisplay);
        if (win) return win;
      }
    } catch (error) {
      logger.warn('Native capture failed; falling back to desktopCapturer', {
        platform: process.platform,
        error: error.message
      });
    }

    return this._captureWithDesktopCapturer(targetDisplay, options);
  }

  _captureLinuxNative(targetDisplay, options = {}) {
    const display = process.env.DISPLAY || ':0';
    const env = { ...process.env, DISPLAY: display };
    const outPath = path.join(os.tmpdir(), `oc-import-${process.pid}-${Date.now()}.png`);
    const wantFull = Boolean(options.fullScreen);

    if (!wantFull) {
      const focused = this._findLinuxFocusTarget(env);
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
                method: 'linux-imagemagick-focused',
                windowId: focused.id,
                dimensions: size,
                captureTime: new Date().toISOString()
              }
            };
          }
        } catch (error) {
          logger.warn('Linux focused-window import failed; trying root', { error: error.message });
        }
      }
    }

    execFileSync('import', ['-window', 'root', '-display', display, '-quality', '92', outPath], {
      timeout: 15000,
      env
    });
    let image = this._loadPng(outPath);
    let crop = null;
    if (!wantFull) {
      crop = this._largestLinuxAppCrop(env, image.getSize());
      if (crop) {
        try {
          image = image.crop(crop);
        } catch (_) {
          /* ignore */
        }
      }
    }
    logger.info('Using Linux ImageMagick root capture', {
      cropped: Boolean(crop),
      fullScreen: wantFull,
      imageSize: image.getSize()
    });
    return {
      image,
      metadata: {
        displayId: targetDisplay.id,
        sourceName: wantFull ? 'linux-root-fullscreen' : crop ? 'linux-root-cropped' : 'linux-root',
        method: wantFull
          ? 'linux-imagemagick-root-full'
          : crop
            ? 'linux-imagemagick-root-cropped'
            : 'linux-imagemagick-root',
        dimensions: image.getSize(),
        captureTime: new Date().toISOString()
      }
    };
  }

  _captureMacNative(targetDisplay) {
    const outPath = path.join(os.tmpdir(), `oc-screencapture-${process.pid}-${Date.now()}.png`);
    execFileSync('screencapture', ['-x', outPath], { timeout: 20000 });
    const image = this._loadPng(outPath);
    logger.info('Using macOS screencapture', { imageSize: image.getSize() });
    return {
      image,
      metadata: {
        displayId: targetDisplay.id,
        sourceName: 'screencapture',
        method: 'macos-screencapture',
        dimensions: image.getSize(),
        captureTime: new Date().toISOString()
      }
    };
  }

  _captureWindowsNative(targetDisplay) {
    const outPath = path.join(os.tmpdir(), `oc-win-capture-${process.pid}-${Date.now()}.png`);
    const escaped = outPath.replace(/'/g, "''");
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      'Add-Type -AssemblyName System.Drawing',
      '$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen',
      '$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height',
      '$g = [System.Drawing.Graphics]::FromImage($bmp)',
      '$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)',
      `$bmp.Save('${escaped}', [System.Drawing.Imaging.ImageFormat]::Png)`,
      '$g.Dispose(); $bmp.Dispose()'
    ].join('; ');
    execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps],
      { timeout: 25000, windowsHide: true }
    );
    if (!fs.existsSync(outPath)) {
      throw new Error('Windows PowerShell capture did not produce a file');
    }
    const image = this._loadPng(outPath);
    logger.info('Using Windows PowerShell screen capture', { imageSize: image.getSize() });
    return {
      image,
      metadata: {
        displayId: targetDisplay.id,
        sourceName: 'powershell-virtual-screen',
        method: 'windows-powershell',
        dimensions: image.getSize(),
        captureTime: new Date().toISOString()
      }
    };
  }

  _findLinuxFocusTarget(env) {
    try {
      const activeId = execFileSync('xdotool', ['getactivewindow'], {
        timeout: 3000,
        env,
        encoding: 'utf8'
      }).trim();
      if (!activeId) return null;
      const title = this._linuxWindowName(activeId, env);
      if (this._isSelfWindow(title)) return this._largestLinuxAppWindow(env);
      return { id: activeId, title };
    } catch (_) {
      return this._largestLinuxAppWindow(env);
    }
  }

  _largestLinuxAppWindow(env) {
    return this._listLinuxWindows(env)
      .filter((w) => !this._isSelfWindow(w.title))
      .filter((w) => w.width >= 400 && w.height >= 300)
      .sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
  }

  _largestLinuxAppCrop(env, rootSize) {
    const win = this._largestLinuxAppWindow(env);
    if (!win) return null;
    const x = Math.max(0, win.x);
    const y = Math.max(0, win.y);
    const width = Math.min(win.width, rootSize.width - x);
    const height = Math.min(win.height, rootSize.height - y);
    if (width < 200 || height < 200) return null;
    const contentY = height > 120 ? Math.min(90, Math.floor(height * 0.12)) : 0;
    return { x, y: y + contentY, width, height: height - contentY };
  }

  _listLinuxWindows(env) {
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
          out.push({
            id,
            title: this._linuxWindowName(id, env),
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

  _linuxWindowName(id, env) {
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
      t === 'settings' ||
      t === 'chat'
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
      throw new Error('Native capture produced an empty image');
    }
    return image;
  }

  async _captureWithDesktopCapturer(targetDisplay) {
    const { width, height } = targetDisplay.size || { width: 1920, height: 1080 };
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    });
    if (sources.length === 0) throw new Error('No screen sources available for capture');

    let source = sources[0];
    const match = sources.find((s) => {
      const size = s.thumbnail.getSize();
      return size.width === width && size.height === height;
    });
    if (match) source = match;

    const image = source.thumbnail;
    if (!image) throw new Error('Failed to capture screen thumbnail');

    logger.info('Screenshot captured via desktopCapturer', {
      platform: process.platform,
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
    return all.find((d) => d.id === displayId) || screen.getPrimaryDisplay();
  }

  _isValidArea(area) {
    return (
      area &&
      Number.isFinite(area.x) &&
      Number.isFinite(area.y) &&
      Number.isFinite(area.width) &&
      Number.isFinite(area.height) &&
      area.width > 0 &&
      area.height > 0
    );
  }

  /** Downscale + JPEG encode so vision payloads stay under Express limits. */
  _compressForVision(image, { maxEdge = 1280, quality = 72 } = {}) {
    let out = image;
    const { width, height } = out.getSize();
    const longest = Math.max(width, height);
    if (longest > maxEdge) {
      const scale = maxEdge / longest;
      out = out.resize({
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale)),
        quality: 'good',
      });
    }
    return out.toJPEG(Math.max(40, Math.min(90, quality)));
  }
}

module.exports = new CaptureService();
