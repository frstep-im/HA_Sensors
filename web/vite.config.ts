import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [
    react(),
    {
      name: "firebase-local-config",
      configureServer(server) {
        server.middlewares.use("/__/firebase/init.json", (_req, res) => {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            apiKey: "local-preview-only",
            authDomain: "soter-updater-59ead.firebaseapp.com",
            projectId: "soter-updater-59ead",
            appId: "1:857499231311:web:localpreview",
          }));
        });
      },
    },
  ],
  server: { port: 5173 },
});
