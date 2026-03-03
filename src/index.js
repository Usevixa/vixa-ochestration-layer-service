import express from "express";
import dotenv from "dotenv";
dotenv.config();

import router from "./routes/webhook.js";

const app = express();
app.use(express.json());

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
