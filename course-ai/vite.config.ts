import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const host = process.env.TAURI_DEV_HOST;

function utf8ContentTypePlugin(): Plugin {
  return {
    name: "course-ai-utf8-content-type",
    configureServer(server) {
      server.middlewares.use((_req, res, next) => {
        const setHeader = res.setHeader.bind(res);
        res.setHeader = (name, value) => {
          if (
            typeof name === "string" &&
            name.toLowerCase() === "content-type" &&
            typeof value === "string" &&
            /^(text|application\/javascript|application\/json)/i.test(value) &&
            !/charset=/i.test(value)
          ) {
            return setHeader(name, `${value}; charset=utf-8`);
          }
          return setHeader(name, value);
        };
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [utf8ContentTypePlugin(), react(), tailwindcss()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "0.0.0.0",
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
