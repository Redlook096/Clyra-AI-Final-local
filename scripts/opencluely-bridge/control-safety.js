/**
 * Safety rails for Take Control automation.
 * Allows click / type / keys for normal work, but blocks destructive file/system
 * actions unless the user's task explicitly asks for them.
 */

function userAllowsDestructive(task) {
  const t = String(task || '');
  return /\b(delete|remove|trash|erase|wipe|unlink|empty\s+(the\s+)?(trash|recycle(\s+bin)?)|permanently\s+remove|rm\s+-|del\s+|format\s+(the\s+)?(disk|drive|volume)|shred|destroy\s+files?|clear\s+(all\s+)?files)\b/i.test(
    t,
  );
}

const DANGEROUS_TYPE_RE =
  /\b(rm\s+(-[a-zA-Z0-9]*\s*)*|rmdir|unlink\s+|del\s+(\/s|\/q|\/f)?|Remove-Item|Clear-RecycleBin|rd\s+\/s|shred\s+|mkfs(\.| )|dd\s+if=|format\s+[a-z]:|gio\s+trash|trash-empty|empty[- ]trash|permanently\s+delete|sudo\s+rm)\b/i;

const DANGEROUS_LABEL_RE =
  /\b(empty\s+(trash|recycle)|delete\s+(file|folder|item|selected|all)|move\s+to\s+trash|permanently\s+delete|erase\s+(disk|drive|volume)|format\s+(disk|drive)|secure\s+delete|shred)\b/i;

const DANGEROUS_KEY_RE =
  /^(Shift\+Delete|shift\+Delete|Delete\+Shift|meta\+Delete|cmd\+Delete|Command\+Delete|Alt\+Delete)$/i;

/**
 * @param {object} action
 * @param {string} task
 * @returns {{ blocked: boolean, reason?: string }}
 */
function checkActionSafety(action, task) {
  if (!action || typeof action !== 'object') {
    return { blocked: true, reason: 'Invalid action' };
  }
  if (userAllowsDestructive(task)) {
    return { blocked: false, allowedDestructive: true };
  }

  const type = String(action.type || '').toLowerCase();
  const text = String(action.text || '');
  const key = String(action.key || '');
  const label = String(action.label || '');
  const note = String(action.note || '');
  const blob = `${label} ${note} ${text}`;

  if (type === 'type' && DANGEROUS_TYPE_RE.test(text)) {
    return {
      blocked: true,
      reason:
        'Blocked destructive typing (delete/remove/wipe commands). Ask the user to include delete/remove in the task if they want that.',
    };
  }

  if ((type === 'key' || type === 'hotkey') && DANGEROUS_KEY_RE.test(key)) {
    return {
      blocked: true,
      reason: 'Blocked permanent-delete hotkey. Include delete/remove in the task to allow it.',
    };
  }

  // Shift+Delete style keys sometimes arrive as key: "Delete" with modifiers
  const mods = []
    .concat(action.modifiers || [])
    .concat(String(action.mod || '').split('+'))
    .map((m) => String(m || '').toLowerCase())
    .filter(Boolean);
  if (
    (type === 'key' || type === 'hotkey') &&
    /^Delete|KP_Delete$/i.test(key) &&
    mods.some((m) => /shift|meta|cmd|command|super/.test(m))
  ) {
    return {
      blocked: true,
      reason: 'Blocked permanent-delete hotkey. Include delete/remove in the task to allow it.',
    };
  }

  if (DANGEROUS_LABEL_RE.test(blob)) {
    return {
      blocked: true,
      reason:
        'Blocked a destructive UI action (delete/trash/erase). Include delete/remove in the task to allow it.',
    };
  }

  return { blocked: false };
}

function safetyPromptRules(task) {
  const allow = userAllowsDestructive(task);
  if (allow) {
    return [
      'The user explicitly asked for a destructive/delete-related task — you MAY delete/remove only what they asked.',
      'Still avoid unrelated system wipe/format actions.',
    ].join(' ');
  }
  return [
    'SAFETY (mandatory): You may click, type, press keys, scroll, and navigate freely to complete the task.',
    'Do NOT delete files, empty Trash/Recycle Bin, format disks, shred data, or run rm/del/Remove-Item commands.',
    'Do NOT press Shift+Delete / permanent-delete hotkeys.',
    'If finishing the task would require deleting something, stop and set done:true with a note that deletion was blocked for safety.',
  ].join(' ');
}

module.exports = {
  userAllowsDestructive,
  checkActionSafety,
  safetyPromptRules,
  DANGEROUS_TYPE_RE,
  DANGEROUS_LABEL_RE,
};
