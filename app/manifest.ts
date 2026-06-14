import type { MetadataRoute } from "next";

// Web app manifest. theme/background match the dark "Void Black" background.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "unerr docs",
    short_name: "unerr",
    theme_color: "#0A0A0F",
    background_color: "#0A0A0F",
    display: "standalone",
    start_url: "/",
    icons: [
      {
        src: "/web-app-manifest-192x192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/web-app-manifest-512x512.png",
        sizes: "512x512",
        type: "image/png",
      },
    ],
  };
}
