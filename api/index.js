// Vercel serverless entry: vercel.json rewrites /v1/*, /health and /api/docs here.
// Vercel's Node runtime accepts the Web Standard `fetch` export.
import { app } from "./_lib/app.js";

export default {
  fetch(request) {
    return app.handle(request);
  }
};
