import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async redirects() {
    // The scripted demo arena is gone: the practice ring is the real, playable version.
    return [{ source: "/arena/demo", destination: "/ring", permanent: false }];
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value:
              `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'${
                // next dev evaluates modules with eval(); production builds do not.
                process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""
              }; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`,
          },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        ],
      },
    ];
  },
  serverExternalPackages: ["better-sqlite3", "postgres"],
  outputFileTracingIncludes: {
    "*": ["./fixtures/**/*.json", "./llms.txt", "./spec/**/*.json", "./feeds/seeds/*.json", "./skill/**/*.md", "./public/fonts/*.ttf"],
  },
  experimental: {
    extensionAlias: {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    },
  },
};

export default nextConfig;
