import type { APIRoute } from 'astro';

const SITE_URL = 'https://aitorsanchez.pages.dev';

const staticRoutes = [
  { url: '/', priority: '1.0', changefreq: 'weekly' },
  { url: '/blog', priority: '0.9', changefreq: 'daily' },
  { url: '/contacto', priority: '0.5', changefreq: 'monthly' },
];

export const GET: APIRoute = async ({ locals }) => {
  const db = locals.runtime?.env?.DB;
  let posts: any[] = [];

  if (db) {
    const result = await db.prepare(
      `SELECT slug, pub_date FROM posts WHERE draft != 1 ORDER BY pub_date DESC`
    ).all();
    posts = result.results ?? [];
  }

  const urls = [
    ...staticRoutes.map(({ url, priority, changefreq }) => `
  <url>
    <loc>${SITE_URL}${url}</loc>
    <changefreq>${changefreq}</changefreq>
    <priority>${priority}</priority>
  </url>`),
    ...posts.map((post) => `
  <url>
    <loc>${SITE_URL}/blog/${post.slug}</loc>
    <lastmod>${new Date(post.pub_date).toISOString().split('T')[0]}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.7</priority>
  </url>`),
  ].join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
