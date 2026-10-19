// Tipos globales de Astro. `locals.defense` lo rellena src/middleware.ts.
declare namespace App {
  interface Locals {
    defense?: import('./lib/defense/config').DefenseInfo;
  }
}
