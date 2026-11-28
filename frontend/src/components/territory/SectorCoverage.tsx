// V1-P-01 / PM-12 — the sector table.
//
// One row per commune the land-cover layer declares. Every cell is a served value:
// the class, the NDVI mean, the dominant share and the declared provenance all come
// from `landCoverView`, so a payload that contradicted itself contributes no row.
//
// The table is wrapped in `TableWrap` because it is wider than its panel: the
// wrapper — not the table — is the scroll container a keyboard user has to reach,
// and its name says what the area holds.

import type { SectorCoverageRow } from '../../domain/vegetation';
import { TableWrap } from '../ui';

export function SectorCoverageTable({ rows }: { rows: SectorCoverageRow[] }) {
  if (rows.length === 0) return null;
  return (
    <TableWrap id="sector-coverage-table" label="Cobertura y entorno por comuna">
      <table>
        <caption className="sr-only">
          Cobertura de suelo, clase de entorno y NDVI medio por comuna del catálogo
        </caption>
        <thead>
          <tr>
            <th scope="col">Comuna</th>
            <th scope="col">Clase de entorno</th>
            <th scope="col">NDVI medio</th>
            <th scope="col">Cobertura dominante</th>
            <th scope="col">Procedencia</th>
          </tr>
        </thead>
        <tbody id="sector-coverage-rows">
          {rows.map(row => (
            <tr key={row.zoneId}>
              {/* The row header carries the code AND the name: a screen reader
                  announces which commune the following cells describe. */}
              <th scope="row">{`${row.zoneId} · ${row.zoneName}`}</th>
              <td>{row.environment}</td>
              <td>{row.ndviMean}</td>
              <td>{row.dominant}</td>
              <td>{row.synthetic}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableWrap>
  );
}
