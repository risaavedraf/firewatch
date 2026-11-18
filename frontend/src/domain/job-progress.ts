// What the map is allowed to say about a batch that is being produced.
//
// The map used to have two states — a level, or no level — so "the batch is still
// processing" and "there is no information about this comuna" produced the same
// result, and an accepted request read as a missing assessment. The jobs view
// owns the progress; this module decides what that progress may become on the
// map, and keeps three different facts apart:
//
//   1. a batch is being produced (`processing`),
//   2. a batch was requested and its publication was never confirmed
//      (`unconfirmed`),
//   3. the request itself failed (`failed`).
//
// None of them is `INFORMACIÓN INSUFICIENTE`: that label is reserved for a level
// the server actually published as `desconocido`, so it must never be produced
// from the page's own ignorance about a pending job.

export type JobProgressKind = 'idle' | 'processing' | 'unconfirmed' | 'failed';

export interface JobProgress {
  readonly kind: JobProgressKind;
  // The zone the progress belongs to. A pending batch for another comuna is not
  // progress on the selected one, so the zone travels with the kind.
  readonly zone: string;
}

export const IDLE_JOB_PROGRESS: JobProgress = { kind: 'idle', zone: '' };

export type MapProgressState =
  | { readonly kind: 'none' }
  | { readonly kind: 'processing'; readonly text: string }
  | { readonly kind: 'unconfirmed'; readonly text: string }
  | { readonly kind: 'failed'; readonly text: string };

const PROCESSING_TEXT =
  'Lote en proceso: el servidor todavía no ha publicado un lote de esta zona. El mapa no informa un nivel hasta que ese lote se publique.';
const UNCONFIRMED_TEXT =
  'Lote solicitado sin confirmación: la consulta automática terminó sin verificar la publicación. El mapa no informa un nivel para esta zona.';
const FAILED_TEXT = 'La solicitud del lote falló; el mapa no informa un nivel para esta zona.';

// The render decision for the map's progress live region. `none` means the map
// says nothing about jobs at all and keeps its own vocabulary for an unread zone;
// every other branch states a fact the jobs view actually observed.
export function mapProgressState(progress: JobProgress, selectedZone: string): MapProgressState {
  if (selectedZone === '' || progress.zone !== selectedZone) return { kind: 'none' };
  switch (progress.kind) {
    case 'processing':
      return { kind: 'processing', text: PROCESSING_TEXT };
    case 'unconfirmed':
      return { kind: 'unconfirmed', text: UNCONFIRMED_TEXT };
    case 'failed':
      return { kind: 'failed', text: FAILED_TEXT };
    default:
      return { kind: 'none' };
  }
}
