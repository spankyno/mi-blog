export async function onRequest(context) {
  const url = new URL(context.request.url);
  const queryString = url.search;

  // Mapa con tus 14 redirecciones exactas del Excel
  const redirectMap = {
    "?/archives/57-Bloc-de-Notas-Web.html": "/blog/mnw-mis-notas-web",
    "?/archives/41-La-higiene-en-el-siglo-XVII.html": "/blog/la-higiene-en-el-siglo-xvii",
    "?/archives/20-Por-que-MS-Access-se-quedo-fuera-de-la-revolucion-de-la-IA.html": "/blog/ms-access-fuera-de-la-revolucion-de-la-ia",
    "?/archives/22-La-tirania-de-la-imagen-aparentar-en-tiempos-del-espejo-social.html": "/blog/la-tirania-de-la-imagen-aparentar-en-tiempos-del-espejo-social",
    "?/archives/27-El-Sueno-El-Taller-Nocturno-de-Tu-Cuerpo.html": "/blog/el-sueno-el-taller-nocturno-de-tu-cuerpo",
    "?/archives/25-Desinformacion,-bulos-y-Caos-La-Epidemia-Invisible-que-nos-Envenena.html": "/blog/desinformacion-bulos-y-caos-la-epidemia-invisible-que-nos-envenena",
    "?/archives/4-Frases-celebres.html": "/blog/frases-celebres",
    "?/archives/40-Pensar-con-la-cabeza.html": "/blog/pensar-con-la-cabeza",
    "?/archives/52-Ninos-a-la-carta.html": "/blog/ninos-a-la-carta",
    "?/archives/29-Que-tal.html": "/blog/que-tal-todo",
    "?/archives/32-Como-Sobrevivir-en-un-Mundo-Disenado-para-Jodernos.html": "/blog/como-sobrevivir-en-un-mundo-disenado-para-jodernos",
    "?/archives/36-Gobernar-para-el-aplauso-de-hoy-La-trampa-que-esta-hipotecando-nuestro-futuro.html": "/blog/gobernar-para-el-aplauso-de-hoy",
    "?/archives/43-Vivienda-y-Clase-Media-La-sentencia-de-muerte-al-Milenial.html": "/blog/vivienda-y-clase-media",
    "?/archives/44-No-votes.html": "/blog/no-votes"
  };

  // Si la petición actual tiene uno de los query strings del Excel, redirige
  if (redirectMap[queryString]) {
    const destination = new URL(redirectMap[queryString], url.origin);
    return Response.redirect(destination.toString(), 301);
  }

  // Si no coincide, deja que la web cargue el contenido normal de tu Pages
  return next();
}