import type { APIRoute } from 'astro';

// Cada tabla exportable declara su SELECT base y la columna de fecha
// usada para el filtro de rango (misma convención que /panel/visitas).
const TABLES: Record<string, { select: string; dateColumn: string }> = {
  posts: {
    select: `SELECT * FROM posts`,
    dateColumn: 'pub_date',
  },
  comments: {
    select: `SELECT * FROM comments`,
    dateColumn: 'created_at',
  },
  page_views: {
    select: `SELECT * FROM page_views`,
    dateColumn: 'viewed_at',
  },
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function fetchTable(
  db: D1Database,
  tabla: string,
  startDate: string | null,
  endDate: string | null
) {
  const { select, dateColumn } = TABLES[tabla];
  let query = select;
  const params: string[] = [];

  if (startDate && endDate) {
    query += ` WHERE date(${dateColumn}) BETWEEN ? AND ?`;
    params.push(startDate, endDate);
  }
  query += ` ORDER BY ${dateColumn} DESC`;

  const result = await db.prepare(query).bind(...params).all();
  return result.results ?? [];
}

export const GET: APIRoute = async ({ url, locals }) => {
  const db = locals.runtime?.env?.DB;
  if (!db) return new Response('DB no disponible', { status: 500 });

  const tabla = url.searchParams.get('tabla') ?? '';

  const startParam = url.searchParams.get('start');
  const endParam = url.searchParams.get('end');
  const startDate = startParam && DATE_RE.test(startParam) ? startParam : null;
  const endDate = endParam && DATE_RE.test(endParam) ? endParam : null;
  // El rango solo se aplica si ambos extremos son válidos.
  const hasRange = startDate !== null && endDate !== null;

  let data: unknown;
  let filenameBase: string;

  if (tabla === 'todos') {
    filenameBase = 'todos';
    const entries = await Promise.all(
      Object.keys(TABLES).map(async (t) => [
        t,
        await fetchTable(db, t, hasRange ? startDate : null, hasRange ? endDate : null),
      ] as const)
    );
    data = Object.fromEntries(entries);
  } else if (TABLES[tabla]) {
    filenameBase = tabla;
    data = await fetchTable(db, tabla, hasRange ? startDate : null, hasRange ? endDate : null);
  } else {
    return new Response('Tabla no válida', { status: 400 });
  }

  const rango = hasRange ? `_${startDate}_a_${endDate}` : '';
  const fecha = new Date().toISOString().split('T')[0];
  const filename = `${filenameBase}${rango}-${fecha}.json`;

  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
};
