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
