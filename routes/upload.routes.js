const express = require("express");

const upload = require("../middleware/upload.middleware");

const {
  uploadCsv,
} = require("../controllers/upload.controller");

const router = express.Router();

router.post(
  "/csv",
  upload.single("file"),
  uploadCsv
);

module.exports = router;