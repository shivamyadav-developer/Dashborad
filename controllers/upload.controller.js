const fs = require("fs");

const {
  uploadCsvToBigQuery,
  uploadArticleWiseDaily,
} = require("../services/bigquery.service");


/* ============================================================
   UPLOAD CSV
============================================================ */

async function uploadCsv(req, res) {
  try {

    /* --------------------------------------------------------
       Check file
    -------------------------------------------------------- */

    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: "CSV file is required",
      });
    }


    /* --------------------------------------------------------
       Get selected table
    -------------------------------------------------------- */

    const { table, startDate, endDate } = req.body;

    if (!table) {
      return res.status(400).json({
        success: false,
        message: "Table is required",
      });
    }


    /* ========================================================
       ARTICLE WISE
    ======================================================== */

    if (table === "article") {

      console.log("");

      console.log(
        "======================================"
      );

      console.log(
        "ARTICLE WISE CSV UPLOAD"
      );

      console.log(
        "======================================"
      );


      const result =
        await uploadArticleWiseDaily(
          req.file.path,
          {
            startDate,
            endDate,
          }
        );


      /* ------------------------------------------------------
         Delete original uploaded CSV
      ------------------------------------------------------ */

      if (
        req.file.path &&
        fs.existsSync(req.file.path)
      ) {
        fs.unlinkSync(
          req.file.path
        );
      }


      /* ------------------------------------------------------
         If target date was not found,
         don't return HTTP 500.
      ------------------------------------------------------ */

      if (!result.success) {
        return res.status(400).json(
          result
        );
      }


      /* ------------------------------------------------------
         Successful Article Wise response
      ------------------------------------------------------ */

      return res.status(200).json({

        success: true,

        message:
          result.message,

        startDate:
          result.startDate,

        endDate:
          result.endDate,

        targetDate:
          result.targetDate,

        latestDateInBigQuery:
          result.latestDateInBigQuery,

        totalCsvRows:
          result.totalCsvRows,

        rowsForTargetDate:
          result.rowsForTargetDate,

        rowsPerDate:
          result.rowsPerDate,

        missingDates:
          result.missingDates,

        table:
          result.table,

        jobId:
          result.stagingJobId,

      });

    }


    /* ========================================================
       ABP REPORT
    ======================================================== */

    if (table === "abp") {

      console.log("");

      console.log(
        "======================================"
      );

      console.log(
        "ABP CSV UPLOAD"
      );

      console.log(
        "======================================"
      );


      const result =
        await uploadCsvToBigQuery({

          filePath:
            req.file.path,

          tableName:
            "ABP_Report",

          mode:
            "REPLACE",

        });


      /* ------------------------------------------------------
         Delete uploaded file
      ------------------------------------------------------ */

      if (
        req.file.path &&
        fs.existsSync(req.file.path)
      ) {
        fs.unlinkSync(
          req.file.path
        );
      }


      return res.status(200).json({

        success: true,

        message:
          "ABP Report uploaded successfully.",

        result,

      });

    }


    /* ========================================================
       INVALID TABLE
    ======================================================== */

    if (
      req.file.path &&
      fs.existsSync(req.file.path)
    ) {
      fs.unlinkSync(
        req.file.path
      );
    }


    return res.status(400).json({

      success: false,

      message:
        "Invalid table selected.",

    });

  } catch (error) {

    console.error("");

    console.error(
      "======================================"
    );

    console.error(
      "UPLOAD ERROR"
    );

    console.error(
      "======================================"
    );

    console.error(error);

    console.error(
      "======================================"
    );


    /* --------------------------------------------------------
       Remove original uploaded file
       if it still exists.
    -------------------------------------------------------- */

    if (
      req.file?.path &&
      fs.existsSync(req.file.path)
    ) {

      try {

        fs.unlinkSync(
          req.file.path
        );

      } catch (deleteError) {

        console.error(
          "Could not delete uploaded file:",
          deleteError.message
        );

      }

    }


    return res.status(500).json({

      success: false,

      message:
        error.message ||
        "CSV upload failed.",

    });

  }
}


/* ============================================================
   EXPORT
============================================================ */

module.exports = {
  uploadCsv,
};