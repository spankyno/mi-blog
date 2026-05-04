import type { APIRoute } from 'astro';

const SITE_URL = 'https://aitorsanchez.pages.dev';
const SITE_NAME = 'Aitor Sánchez Gutiérrez';
const SITE_DESC = 'Reflexiones sobre sociedad, tecnología y estilo de vida.';

export const GET: APIRoute = async ({ locals }) => {
  const db = locals.runtime?.env?.DB;
  let posts: any[] = [];

  if (db) {
    const result = await db.prepare(
      `SELECT slug, title, description, pub_date FROM posts
       WHERE draft != 1 ORDER BY pub_date DESC LIMIT 50`
    ).all();
    posts = result.results ?? [];
  }

  const items = posts.map((post) => `
    <item>
      <title><![CDATA[${post.title}]]></title>
      <link>${SITE_URL}/blog/${post.slug}</link>
      <guid isPermaLink="true">${SITE_URL}/blog/${post.slug}</guid>
      <description><![CDATA[${post.description ?? ''}]]></description>
      <pubDate>${new Date(post.pub_date).toUTCString()}</pubDate>
    </item>`).join('');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${SITE_NAME}</title>
    <link>${SITE_URL}</link>
    <description>${SITE_DESC}</description>
    <language>es</language>
    <atom:link href="${SITE_URL}/rss.xml" rel="self" type="application/rss+xml" />
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    ${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
