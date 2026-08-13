import express from "express";
import dotenv from "dotenv";
dotenv.config();

import router from "./routes/webhook.js";

const app = express();

// Keep the raw bytes alongside the parsed body. Meta signs the exact bytes it
// sent, so the HMAC cannot be recomputed from a re-serialised object — key
// order and whitespace would differ. See src/utils/verifySignature.js.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

// Mount the webhook route
app.use("/", router);

app.get("/", (req, res) => {
  res.send("✅ VIXA Server is running...");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
