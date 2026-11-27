import { levelLabel } from '../../domain';

// T5 — the level mark board 05 puts beside every published batch.
//
// The domain owns the vocabulary: `levelLabel` states `bajo`/`medio`/`alto` in
// words, says `INFORMACIÓN INSUFICIENTE` for the fourth honest level and
// `SIN CLASIFICAR` for a value it does not know. Nothing here maps a value to a
// severity, and nothing here decides whether a level exists.
//
// The dot repeats the level with the shipped `--level-*` tokens and is
// decorative (`aria-hidden`). The word is the claim: a reader without colour,
// and a screen reader, get the level from the text alone.

export type HistoryLevelTone = 'high' | 'medium' | 'low' | 'unknown' | 'neutral';

function historyLevelTone(level: unknown): HistoryLevelTone {
  switch (level) {
    case 'alto':
      return 'high';
    case 'medio':
      return 'medium';
    case 'bajo':
      return 'low';
    case 'desconocido':
      return 'unknown';
    default:
      return 'neutral';
  }
}

export function HistoryLevelMark({ level }: { level: unknown }) {
  return (
    <span className={`history-level history-level-${historyLevelTone(level)}`}>
      <span className="history-level-dot" aria-hidden="true" />
      {levelLabel(level)}
    </span>
  );
}
