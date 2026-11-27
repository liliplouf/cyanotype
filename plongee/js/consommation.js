// Consommation de gaz : litres « surface » par segment et bilan des bouteilles.

/**
 * Litres consommés sur un segment où la pression ambiante varie linéairement :
 * SAC × Pamb moyenne × durée.
 * @param {number} sac consommation en surface (L/min)
 * @param {number} pambDebut bar
 * @param {number} pambFin bar
 * @param {number} duree minutes
 */
export function consoSegment(sac, pambDebut, pambFin, duree) {
  if (!(duree > 0)) return 0;
  return sac * ((pambDebut + pambFin) / 2) * duree;
}

/**
 * Bilan de consommation d'une plongée.
 * @param {Array<{type:string, pambDebut:number, pambFin:number, duree:number, gaz:{o2:number, nom:string, indexDeco:number}}>} segments
 *   segments sous l'eau ; indexDeco = −1 pour le gaz fond, sinon index dans gazDeco
 * @param {{sac:number, volume:number, pression:number, reserve:number}} conso
 * @param {Array<{o2:number, volume?:number, pression?:number, reserve?:number}>} [gazDeco]
 */
export function bilanConsommation(segments, conso, gazDeco = []) {
  const parType = new Map();
  const parGaz = new Map();
  for (const s of segments) {
    const l = consoSegment(conso.sac, s.pambDebut, s.pambFin, s.duree);
    parType.set(s.type, (parType.get(s.type) ?? 0) + l);
    const cle = s.gaz.indexDeco;
    const g = parGaz.get(cle) ?? { gaz: s.gaz.nom, o2: s.gaz.o2, indexDeco: cle, litres: 0 };
    g.litres += l;
    parGaz.set(cle, g);
  }
  const litres = [...parType.values()].reduce((a, b) => a + b, 0);
  const litresFond = parGaz.get(-1)?.litres ?? 0;
  const pressionRestante = conso.pression - litresFond / conso.volume;
  const reserveEntamee = pressionRestante < conso.reserve;
  const gaz = [...parGaz.values()]
    .sort((a, b) => a.indexDeco - b.indexDeco)
    .map((g) => {
      const bouteille = g.indexDeco < 0 ? conso : gazDeco[g.indexDeco];
      const volume = bouteille?.volume > 0 ? bouteille.volume : null;
      const pression = volume && bouteille.pression > 0 ? bouteille.pression : null;
      const restante = volume && pression ? pression - g.litres / volume : null;
      const reserve = restante !== null ? (bouteille.reserve ?? 0) : null;
      return {
        gaz: g.gaz,
        o2: g.o2,
        litres: g.litres,
        volume,
        pressionRestante: restante,
        reserveEntamee: restante !== null ? restante < reserve : null,
      };
    });
  return {
    litres,
    litresFond,
    pressionRestante,
    reserveEntamee,
    parPhase: [...parType].map(([type, l]) => ({ type, litres: l })),
    parGaz: gaz,
  };
}
