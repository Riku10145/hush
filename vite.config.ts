/// <reference types="vitest/config" />
import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import * as esbuild from "esbuild";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

function audioWorkletPlugin(): Plugin {
  const entry = path.resolve(import.meta.dirname, "src/audio/processor.ts");

  async function bundle(): Promise<string> {
    const result = await esbuild.build({
      absWorkingDir: import.meta.dirname,
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      target: "es2022",
      logLevel: "silent",
    });
    const file = result.outputFiles[0];
    if (!file) {
      throw new Error("worklet bundle was empty");
    }
    return file.text;
  }

  return {
    name: "hush-worklet",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url?.startsWith("/hush-processor.js")) {
          next();
          return;
        }
        void bundle().then((code) => {
          res.setHeader("Content-Type", "text/javascript");
          res.end(code);
        });
      });
    },
    async generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "hush-processor.js",
        source: await bundle(),
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), audioWorkletPlugin()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 43147,
    strictPort: true,
  },
  preview: {
    host: "127.0.0.1",
    port: 43147,
    strictPort: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
