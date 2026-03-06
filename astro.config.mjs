// @ts-check
import { defineConfig } from "astro/config";

import tailwindcss from "@tailwindcss/vite";

// https://astro.build/config
export default defineConfig({
  site: "https://xiaoluxtl.github.io",
  base: "/luis-r",
  trailingSlash: "always",
  output: "static",
  compressHTML: true,
  prefetch: {
    prefetchAll: true,
  },
  build: {
    assets: "assets", // Esto cambia el nombre de la carpeta '_astro' a 'assets'
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
