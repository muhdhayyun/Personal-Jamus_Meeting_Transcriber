import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from '../utils/fsx.js';
import { outputBaseName } from '../pipeline/session.js';

function srtTimestamp(totalSeconds) {
  const ms = Math.max(0, Math.round(totalSeconds * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const rem = ms % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(rem, 3)}`;
}

/**
 * Render a timeline to a .srt subtitle file. Expects fine-grained entries (one per Whisper
 * segment, not coalesced multi-sentence turns) so caption timing stays accurate — callers
 * should pass `mergeTranscripts({ ..., coalesce: false })`.
 * @returns {string} the written file path.
 */
export function writeSrt(cfg, { session, timeline, speakerPrefix = true }) {
  const lines = [];
  timeline.forEach((entry, i) => {
    const text = speakerPrefix ? `${entry.speaker}: ${entry.text}` : entry.text;
    lines.push(String(i + 1));
    lines.push(`${srtTimestamp(entry.start)} --> ${srtTimestamp(entry.end)}`);
    lines.push(text);
    lines.push('');
  });

  const dir = ensureDir(cfg.resolved.transcripts);
  const file = path.join(dir, `${outputBaseName(session)}.srt`);
  fs.writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}
