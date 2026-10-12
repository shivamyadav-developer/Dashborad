
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const path = require("path");

const uploadRoutes = require("./routes/upload.routes");

const app = express();

/* ---------------------------------------------
   MIDDLEWARE
--------------------------------------------- */

app.use(cors());

app.use(express.json());

/* ---------------------------------------------
   PUBLIC FRONTEND
--------------------------------------------- */

app.use(express.static(path.join(__dirname, "public")));

/* ---------------------------------------------
   UPLOAD ROUTES
--------------------------------------------- */

app.use("/api/upload", uploadRoutes);

/* ---------------------------------------------
   HEALTH CHECK
--------------------------------------------- */

app.get("/api/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "HomeTown BigQuery uploader is running",
  });
});

/* ---------------------------------------------
   EXPORT EXPRESS APP FOR VERCEL
--------------------------------------------- */

module.exports = app;

/* ---------------------------------------------
   START SERVER LOCALLY
--------------------------------------------- */

if (require.main === module) {
  const PORT = process.env.PORT || 5000;

  app.listen(PORT, () => {
    console.log("--------------------------------");
    console.log(`Server running on http://localhost:${PORT}`);
    console.log("--------------------------------");
  });
}
