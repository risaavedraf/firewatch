// T3 — la cobertura de tipos que el catálogo sintético declara por comuna.
//
// El tablero de diseño (`04-cobertura-territorial.html`) presenta una cobertura
// de lectura por sector. Este producto no sirve lecturas por sector:
// `/v1/risk/infrastructure` entrega zonas que son comunas por código CUT, así que
// el único hecho de cobertura que el payload sostiene es cuántos de los cinco
// tipos del catálogo declara cada comuna.
//
// Módulo puro y sin React: la vista y la barra comparten el mismo cálculo y
// ninguna de las dos puede inventar un porcentaje que el servicio no publica.

import {
  INFRASTRUCTURE_TYPES,
  infrastructureTypeLabel,
  type InfrastructureType,
  type InfrastructureZone,
} from '../../core/infrastructure';

// Un tipo "informado" es un tipo con al menos un elemento declarado por el
// fixture. No es cobertura del territorio ni una evaluación del terreno: es un
// conteo de lo que el catálogo trae.
export interface ZoneCoverage {
  zoneId: string;
  typesTotal: number;
  typesInformed: number;
  // Los cinco tipos en el orden del catálogo, con su etiqueta y su presencia.
  types: ReadonlyArray<{ type: InfrastructureType; label: string; present: boolean }>;
  // Solo los tipos con elementos, en el mismo orden.
  presentLabels: string[];
}

export function zoneCoverage(zone: InfrastructureZone): ZoneCoverage {
  const types = INFRASTRUCTURE_TYPES.map(type => ({
    type,
    label: infrastructureTypeLabel(type),
    present: zone.counts[type] > 0,
  }));
  return {
    zoneId: zone.zone_id,
    typesTotal: INFRASTRUCTURE_TYPES.length,
    typesInformed: types.filter(entry => entry.present).length,
    types,
    presentLabels: types.filter(entry => entry.present).map(entry => entry.label),
  };
}

// Una frase, no un porcentaje: el payload no declara qué parte del territorio
// cubre cada tipo, así que el conteo habla de tipos declarados.
export function coveragePhrase(coverage: ZoneCoverage): string {
  return `${coverage.typesInformed} de ${coverage.typesTotal} tipos`;
}
