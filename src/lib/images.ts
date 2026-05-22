const CLOUD_NAME = 'kalbo';
const OG_BASE_ID = 'foto-portada_ddtnbq';

/**
 * Genera una OG image dinámica usando Cloudinary Text Overlay.
 * Superpone el título del post, el dominio (en dorado) y el autor
 * sobre la imagen de portada con un degradado oscuro ascendente.
 * Resultado: imagen 1200x630 lista para og:image.
 */
export function cloudinaryOgImage(title: string): string {
  const safeTitle = encodeURIComponent(
    title
      .replace(/,/g, ' ')   // comas rompen la cadena de transformaciones
      .replace(/\//g, ' ') // barras rompen la ruta
      .slice(0, 80)         // límite para que no desborde
  );

  const layers = [
    'w_1200,h_630,c_fill',           // recorta a 1200x630 exactos
    'e_gradient_fade,y_-0.5,b_rgb:080e1a',
    `l_text:Arial_40_bold:${safeTitle},co_rgb:f5f2ec,g_south_west,x_80,y_100,w_900,c_fit`,
    'l_text:Arial_22:aitorsanchez.pages.dev,co_rgb:c9a84c,g_south_west,x_80,y_54',
    'l_text:Arial_20:Aitor%20Sa%CC%81nchez%20Guti%C3%A9rrez,co_rgb:ffffff80,g_south_west,x_80,y_26',
  ].join('/');

  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/${layers}/${OG_BASE_ID}.webp`;
}

/**
 * Optimiza URLs de Cloudinary al vuelo mediante transformaciones en la URL.
 *
 * Parámetros aplicados:
 *   f_auto  → formato óptimo (WebP en Chrome/Firefox, AVIF si soportado)
 *   q_auto  → calidad automática según contenido de la imagen
 *   w_N     → redimensiona al ancho indicado
 *   c_limit → nunca amplía la imagen si es más pequeña que el ancho pedido
 *   dpr_auto→ adapta la resolución al pixel ratio del dispositivo
 *
 * Si la URL no es de Cloudinary, la devuelve sin modificar.
 */
export function cloudinaryOptimize(
  url: string | null | undefined,
  width: number,
): string {
  if (!url) return '';
  if (!url.includes('res.cloudinary.com')) return url;

  // Evita duplicar transformaciones si ya las tiene
  if (url.includes('/upload/f_auto')) return url;

  return url.replace(
    '/upload/',
    `/upload/f_auto,q_auto,w_${width},c_limit,dpr_auto/`,
  );
}
