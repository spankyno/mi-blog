import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  areaPath, botLevel, buildInsights, bucketKeys, delta, fillSeries, flagEmoji, linePath, mondayOf,
  niceMax, parseStatsQuery, relTime, resolvePeriod, simplifyUA, statsHref, tickIndexes, toPoints,
} from '../src/lib/stats';

const NOW = new Date('2026-10-27T10:30:00Z'); // martes
const q = (s: string) => parseStatsQuery(new URLSearchParams(s));

describe('parseStatsQuery', () => {
  it('valores por defecto', () => {
    const r = q('');
    assert.equal(r.p, '30d');
    assert.equal(r.humans, false);
    assert.equal(r.kind, 'all');
    assert.equal(r.page, 1);
  });
  it('descarta valores inválidos', () => {
    const r = q('p=zzz&g=minute&k=x&pg=-4&c=españa&post=a%20b%3Bdrop&q=' + 'x'.repeat(200));
    assert.equal(r.p, '30d');
    assert.equal(r.g, null);
    assert.equal(r.kind, 'all');
    assert.equal(r.page, 1);
    assert.equal(r.country, '');
    assert.equal(r.post, '');
    assert.equal(r.q.length, 60);
  });
  it('custom sin fechas válidas vuelve al periodo por defecto', () => {
    assert.equal(q('p=custom&from=2026-13-40&to=hoy').p, '30d');
  });
  it('custom: ordena fechas invertidas y limita a 366 días', () => {
    const r = q('p=custom&from=2026-10-20&to=2026-10-10');
    assert.deepEqual([r.from, r.to], ['2026-10-10', '2026-10-20']);
    const long = q('p=custom&from=2020-01-01&to=2026-10-10');
    assert.equal(long.to, '2020-12-31');
  });
  it('"solo humanos" fuerza kind=human', () => {
    assert.equal(q('h=1&k=bot').kind, 'human');
  });
  it('acepta slugs con acentos y país en minúsculas', () => {
    const r = q('post=la-tiranía-de-la-imagen&c=us');
    assert.equal(r.post, 'la-tiranía-de-la-imagen');
    assert.equal(r.country, 'US');
  });
});

describe('statsHref', () => {
  it('omite valores por defecto y reinicia la paginación', () => {
    assert.equal(statsHref(q('pg=3')), '/panel/stats');
    assert.equal(statsHref(q('pg=3'), { p: '7d' }), '/panel/stats?p=7d');
    assert.equal(statsHref(q('p=7d'), { page: 2 }), '/panel/stats?p=7d&pg=2');
  });
  it('conserva filtros y añade ancla', () => {
    assert.equal(statsHref(q('p=7d&h=1'), { post: 'hola' }, '#visitas'), '/panel/stats?p=7d&h=1&post=hola#visitas');
  });
  it('humanos activado ignora kind', () => {
    assert.equal(statsHref(q('k=bot'), { humans: true }), '/panel/stats?h=1');
  });
  it('es estable: parsear lo generado devuelve lo mismo', () => {
    const original = q('p=custom&from=2026-10-01&to=2026-10-20&g=day&k=bot&q=madrid&c=ES&pg=2');
    assert.deepEqual(parseStatsQuery(new URL('http://x' + statsHref(original, { page: original.page })).searchParams), original);
  });
});

describe('resolvePeriod', () => {
  it('Hoy: desde las 00:00 UTC, por horas, comparado con ayer a la misma hora', () => {
    const p = resolvePeriod(q('p=today'), NOW);
    assert.equal(p.from.toISOString(), '2026-10-27T00:00:00.000Z');
    assert.equal(p.granularity, 'hour');
    assert.equal(p.prevFrom.toISOString(), '2026-10-26T00:00:00.000Z');
    assert.equal(p.prevTo.toISOString(), '2026-10-26T10:30:00.000Z');
  });
  it('7 días incluye hoy y 6 anteriores', () => {
    const p = resolvePeriod(q('p=7d'), NOW);
    assert.equal(p.from.toISOString(), '2026-10-21T00:00:00.000Z');
    assert.equal(p.granularity, 'day');
    assert.equal(p.prevFrom.toISOString(), '2026-10-14T00:00:00.000Z');
  });
  it('90 días usa semanas por defecto y respeta una granularidad válida', () => {
    assert.equal(resolvePeriod(q('p=90d'), NOW).granularity, 'week');
    assert.equal(resolvePeriod(q('p=90d&g=day'), NOW).granularity, 'day');
  });
  it('ignora granularidades inviables (horas en 30 d, semanas en 7 d)', () => {
    assert.equal(resolvePeriod(q('p=30d&g=hour'), NOW).granularity, 'day');
    assert.equal(resolvePeriod(q('p=7d&g=week'), NOW).granularity, 'day');
    assert.equal(resolvePeriod(q('p=7d&g=hour'), NOW).granularity, 'hour');
  });
  it('custom pasado: fin exclusivo y periodo anterior de igual longitud', () => {
    const p = resolvePeriod(q('p=custom&from=2026-10-10&to=2026-10-14'), NOW);
    assert.equal(p.to.toISOString(), '2026-10-15T00:00:00.000Z');
    assert.equal(p.prevFrom.toISOString(), '2026-10-05T00:00:00.000Z');
    assert.equal(p.prevTo.toISOString(), '2026-10-10T00:00:00.000Z');
  });
  it('custom que llega al futuro se corta en "ahora"', () => {
    const p = resolvePeriod(q('p=custom&from=2026-10-20&to=2026-12-31'), NOW);
    assert.equal(p.to.getTime(), NOW.getTime());
  });
});

describe('series', () => {
  it('mondayOf coincide con la semana ISO', () => {
    assert.equal(mondayOf('2026-10-27'), '2026-10-26'); // martes
    assert.equal(mondayOf('2026-10-25'), '2026-10-19'); // domingo
    assert.equal(mondayOf('2026-10-26'), '2026-10-26'); // lunes
  });
  it('bucketKeys: horas, días y semanas', () => {
    assert.equal(bucketKeys(new Date('2026-10-27T00:00:00Z'), NOW, 'hour').length, 11);
    assert.equal(bucketKeys(new Date('2026-10-21T00:00:00Z'), NOW, 'day').length, 7);
    assert.deepEqual(bucketKeys(new Date('2026-10-14T00:00:00Z'), NOW, 'week'), ['2026-10-12', '2026-10-19', '2026-10-26']);
  });
  it('fillSeries rellena huecos con ceros y calcula bots = total − humanos', () => {
    const pts = fillSeries([{ b: '2026-10-22', h: 3, t: 10 }], new Date('2026-10-21T00:00:00Z'), NOW, 'day');
    assert.equal(pts.length, 7);
    assert.deepEqual([pts[0].h, pts[0].b], [0, 0]);
    assert.deepEqual([pts[1].h, pts[1].b], [3, 7]);
  });
});

describe('geometría', () => {
  it('niceMax es múltiplo de 4 y ≥ valor', () => {
    for (const n of [0, 1, 4, 5, 17, 99, 129, 1000, 4495]) {
      const m = niceMax(n);
      assert.ok(m >= n && m % 4 === 0, `${n} → ${m}`);
    }
    assert.equal(niceMax(129), 200);
  });
  it('toPoints con un solo valor dibuja línea plana', () => {
    assert.deepEqual(toPoints([2], 4, 100, 100), [[0, 50], [100, 50]]);
  });
  it('linePath/areaPath sin datos devuelven vacío y con datos cierran la forma', () => {
    assert.equal(linePath([]), '');
    assert.equal(areaPath([], 300), '');
    assert.match(areaPath([[0, 10], [10, 20]], 300), /Z$/);
  });
  it('tickIndexes limita las etiquetas e incluye extremos', () => {
    assert.deepEqual(tickIndexes(3), [0, 1, 2]);
    assert.equal(tickIndexes(7).length, 7); // 7 días: todas las etiquetas
    const t = tickIndexes(30, 6);
    assert.equal(t.length, 6);
    assert.equal(t[0], 0);
    assert.equal(t[5], 29);
  });
});

describe('delta y semáforo', () => {
  it('casos de variación', () => {
    assert.deepEqual(delta(120, 100), { dir: 'up', label: '+20%' });
    assert.deepEqual(delta(50, 100), { dir: 'down', label: '−50%' });
    assert.equal(delta(100, 100).dir, 'flat');
    assert.equal(delta(0, 0).dir, 'flat');
    assert.equal(delta(5, 0).dir, 'new');
  });
  it('puntos porcentuales', () => {
    assert.deepEqual(delta(65, 60, 'pp'), { dir: 'up', label: '+5,0 pp' });
    assert.equal(delta(60.2, 60, 'pp').dir, 'flat');
  });
  it('botLevel', () => {
    assert.equal(botLevel(10).tone, 'good');
    assert.equal(botLevel(45).tone, 'warn');
    assert.equal(botLevel(65).tone, 'bad');
  });
});

describe('país, fecha relativa y user-agent', () => {
  it('flagEmoji', () => {
    assert.equal(flagEmoji('ES'), '🇪🇸');
    assert.equal(flagEmoji('XX'), '🌐');
    assert.equal(flagEmoji('T1'), '🌐');
    assert.equal(flagEmoji(null), '🌐');
  });
  it('relTime', () => {
    assert.equal(relTime('2026-10-27T10:29:50Z', NOW), 'ahora');
    assert.match(relTime('2026-10-27T10:00:00Z', NOW), /30 min/);
    assert.match(relTime('2026-10-27T07:30:00Z', NOW), /3 h/);
    assert.equal(relTime(null, NOW), '—');
  });
  it('simplifyUA: navegadores', () => {
    assert.equal(simplifyUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'), 'Chrome 141 · Windows');
    assert.equal(simplifyUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0'), 'Edge 141 · Windows');
    assert.equal(simplifyUA('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'), 'Safari 18 · iOS');
    assert.equal(simplifyUA('Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0'), 'Firefox 130 · Linux');
  });
  it('simplifyUA: bots y herramientas', () => {
    assert.equal(simplifyUA('Mozilla/5.0 AppleWebKit/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html) Chrome/120 Safari/537.36'), 'Googlebot');
    assert.equal(simplifyUA('curl/8.5.0'), 'curl');
    assert.equal(simplifyUA('python-requests/2.31.0'), 'python-requests');
    assert.equal(simplifyUA('Mozilla/5.0 HeadlessChrome/120.0.0.0 Safari/537.36'), 'Chrome headless');
    assert.equal(simplifyUA(''), 'Desconocido');
    assert.equal(simplifyUA(null), 'Desconocido');
  });
});

describe('buildInsights', () => {
  const base = {
    cur: { total: 4495, humans: 1553, bots: 2942, posts: 12, countries: 30 },
    prev: { total: 4000, humans: 1294, bots: 2706, posts: 10, countries: 25 },
    posts: [{ key: 'ia-agentica', h: 129, b: 300 }, { key: 'georeferenciar-fotos', h: 128, b: 10 }],
    countries: [{ key: 'US', h: 700, b: 39 }, { key: 'SG', h: 2, b: 108 }, { key: 'ES', h: 266, b: 0 }],
    series: [],
    humansOnly: false,
    titleOf: (s: string) => (s === 'ia-agentica' ? 'IA agéntica' : s),
  };
  it('genera las frases clave', () => {
    const ins = buildInsights(base);
    const text = ins.map((i) => i.text).join('\n');
    assert.match(text, /El 65% del tráfico es bot/);
    assert.match(text, /mejor tracción humana es «IA agéntica»/);
    assert.match(text, /suben un 20%/);
    assert.match(text, /Singapur: el 98% de sus visitas son bots/);
    assert.ok(ins.length <= 5);
    assert.equal(ins[0].tone, 'warn');
  });
  it('en modo solo humanos no destaca países de bots', () => {
    const text = buildInsights({ ...base, humansOnly: true }).map((i) => i.text).join('\n');
    assert.doesNotMatch(text, /Singapur/);
  });
  it('sin visitas no hay insights', () => {
    assert.deepEqual(buildInsights({ ...base, cur: { total: 0, humans: 0, bots: 0, posts: 0, countries: 0 } }), []);
  });
  it('sin bots lo dice en positivo', () => {
    const ins = buildInsights({ ...base, cur: { ...base.cur, bots: 0, total: 1553 } });
    assert.equal(ins[0].tone, 'good');
  });
});
