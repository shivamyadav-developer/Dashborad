const fs = require("fs");
const path = require("path");
const os = require("os");

const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");

const bigquery = require("../config/bigquery");

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const DATASET = process.env.BQ_DATASET;

/*
  Safety limit: automatic catch-up will never load more than
  this many days in one run. Use manual From/To dates to go beyond.
*/
const MAX_CATCHUP_DAYS = 31;


/* ============================================================
   DATE HELPERS  (all dates are "YYYY-MM-DD" strings)
============================================================ */

/*
  Yesterday's date in India.
  The BAse CSV contains data only up to yesterday.
*/
function getYesterdayIndiaDate() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = Number(parts.find((p) => p.type === "year").value);
  const month = Number(parts.find((p) => p.type === "month").value);
  const day = Number(parts.find((p) => p.type === "day").value);

  return addDays(
    `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    -1
  );
}

function isValidIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) {
    return false;
  }
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function addDays(isoDate, n) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/* Inclusive list of dates between start and end. */
function listDates(startDate, endDate) {
  const dates = [];
  let current = startDate;
  while (current <= endDate) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

/*
  CSV date  DD-MM-YYYY (or DD/MM/YYYY)  ->  YYYY-MM-DD
*/
function parseCsvDate(value) {
  if (!value) {
    return null;
  }

  const cleaned = String(value).trim().replace(/\//g, "-");
  const match = cleaned.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);

  if (!match) {
    return null;
  }

  const day = match[1].padStart(2, "0");
  const month = match[2].padStart(2, "0");
  const year = match[3];

  return `${year}-${month}-${day}`;
}


/* ============================================================
   FIND HEADER ROW

   BAse CSV: Row 1 blank, Row 2 header, Row 3+ data.
   We search for the "Date" column instead of trusting row numbers.
============================================================ */

function findHeaderRow(allRows) {
  for (let i = 0; i < allRows.length; i++) {
    const row = allRows[i];

    const dateIndex = row.findIndex(
      (value) =>
        String(value).replace(/^\uFEFF/, "").trim().toLowerCase() === "date"
    );

    if (dateIndex !== -1) {
      return { headerRowIndex: i, headers: row, dateIndex };
    }
  }

  return null;
}


/* ============================================================
   LATEST DATE ALREADY IN BIGQUERY

   Reads MAX(date) from Article_Wise_Report.
   Returns "YYYY-MM-DD" or null if the table is empty.
============================================================ */

async function getLatestDateInTable(tableName) {
  const query = `
    SELECT
      FORMAT_DATE(
        '%Y-%m-%d',
        MAX(SAFE.PARSE_DATE('%d-%m-%Y', TRIM(Sales_Date)))
      ) AS latest_date
    FROM \`${PROJECT_ID}.${DATASET}.${tableName}\`
  `;

  const [rows] = await bigquery.query({ query, useLegacySql: false });

  return rows[0] && rows[0].latest_date ? rows[0].latest_date : null;
}


/* ============================================================
   CREATE FILTERED CSV FOR A DATE RANGE (inclusive)

   FULL BAse CSV -> validate all rows -> keep startDate..endDate
   -> clean temporary CSV
============================================================ */

async function createDateRangeCsv(sourceFile, startDate, endDate) {
  const tempFile = path.join(
    os.tmpdir(),
    `article_range_${Date.now()}.csv`
  );

  const csvText = fs.readFileSync(sourceFile, "utf8");

  console.log("");
  console.log("--------------------------------");
  console.log("Reading complete CSV file");
  console.log("Source:", sourceFile);
  console.log("File size:", fs.statSync(sourceFile).size, "bytes");
  console.log("--------------------------------");

  let allRows;

  try {
    allRows = parse(csvText, {
      bom: true,
      relax_quotes: true,
      relax_column_count: false,
      skip_empty_lines: false,
      record_delimiter: ["\r\n", "\n", "\r"],
      quote: '"',
      escape: '"',
    });
  } catch (error) {
    throw new Error(`CSV parsing failed: ${error.message}`);
  }

  console.log("CSV records parsed:", allRows.length);

  const headerInfo = findHeaderRow(allRows);

  if (!headerInfo) {
    throw new Error('CSV does not contain a "Date" column.');
  }

  const { headerRowIndex, headers, dateIndex } = headerInfo;

  headers[0] = String(headers[0]).replace(/^\uFEFF/, "");

  const expectedColumnCount = headers.length;

  console.log("");
  console.log("--------------------------------");
  console.log("CSV structure detected");
  console.log("Header row:", headerRowIndex + 1);
  console.log("Number of columns:", expectedColumnCount);
  console.log("Date column:", headers[dateIndex]);
  console.log("Date range to upload:", startDate, "to", endDate);
  console.log("--------------------------------");

  /*
    Article_Wise_Report must have exactly 43 columns.
  */
  if (expectedColumnCount !== 43) {
    throw new Error(
      `CSV structure error. Expected 43 columns but found ${expectedColumnCount}. ` +
      `Nothing was changed in BigQuery.`
    );
  }

  let totalRows = 0;
  let validRows = 0;
  let invalidRows = 0;

  const outputRows = [];
  const invalidRowDetails = [];
  const rowsPerDate = {};
  let latestDateInCsv = null;

  for (let i = headerRowIndex + 1; i < allRows.length; i++) {
    const row = allRows[i];

    const isEmptyRow = row.every(
      (value) => String(value ?? "").trim() === ""
    );

    if (isEmptyRow) {
      continue;
    }

    totalRows++;

    if (row.length !== expectedColumnCount) {
      invalidRows++;

      if (invalidRowDetails.length < 10) {
        invalidRowDetails.push({
          csvRowNumber: i + 1,
          actualColumns: row.length,
          expectedColumns: expectedColumnCount,
          dateValue: row[dateIndex] || "",
        });
      }

      continue;
    }

    validRows++;

    const rowDate = parseCsvDate(row[dateIndex]);

    if (rowDate && (!latestDateInCsv || rowDate > latestDateInCsv)) {
      latestDateInCsv = rowDate;
    }

    /*
      ISO dates compare correctly as plain strings.
    */
    if (rowDate && rowDate >= startDate && rowDate <= endDate) {
      outputRows.push(row);
      rowsPerDate[rowDate] = (rowsPerDate[rowDate] || 0) + 1;
    }
  }

  const selectedRows = outputRows.length;

  const expectedDates = listDates(startDate, endDate);
  const missingDates = expectedDates.filter((d) => !rowsPerDate[d]);

  console.log("");
  console.log("--------------------------------");
  console.log("CSV VALIDATION RESULT");
  console.log("Total CSV data rows:", totalRows);
  console.log("Valid rows:", validRows);
  console.log("Invalid rows:", invalidRows);
  console.log("Latest date in CSV:", latestDateInCsv);
  console.log("Rows selected for range:", selectedRows);
  console.log("Rows per date:", rowsPerDate);

  if (missingDates.length > 0) {
    console.log("WARNING - dates with no rows in CSV:", missingDates);
  }

  console.log("--------------------------------");

  if (invalidRows > 0) {
    console.log("");
    console.log("INVALID ROW DETAILS");
    console.log(invalidRowDetails);

    throw new Error(
      `CSV validation failed. ` +
      `${invalidRows} row(s) have an incorrect number of columns. ` +
      `Expected ${expectedColumnCount} columns. ` +
      `Nothing was changed in BigQuery.`
    );
  }

  if (selectedRows === 0) {
    return {
      tempFile: null,
      totalRows,
      validRows,
      invalidRows,
      selectedRows: 0,
      rowsPerDate,
      missingDates,
      latestDateInCsv,
    };
  }

  const csvOutput = stringify(outputRows, {
    header: true,
    columns: headers,
  });

  fs.writeFileSync(tempFile, csvOutput, "utf8");

  if (!fs.existsSync(tempFile)) {
    throw new Error("Temporary filtered CSV could not be created.");
  }

  console.log("Filtered temporary CSV created:", tempFile);

  return {
    tempFile,
    totalRows,
    validRows,
    invalidRows,
    selectedRows,
    rowsPerDate,
    missingDates,
    latestDateInCsv,
  };
}


/* ============================================================
   CREATE STAGING TABLE (same schema as Article_Wise_Report)
============================================================ */

async function createStagingTable(targetTableName, stagingTableName) {
  const targetFullName = `\`${PROJECT_ID}.${DATASET}.${targetTableName}\``;
  const stagingFullName = `\`${PROJECT_ID}.${DATASET}.${stagingTableName}\``;

  await bigquery.query({
    query: `CREATE TABLE ${stagingFullName} LIKE ${targetFullName}`,
    useLegacySql: false,
  });

  console.log("Staging table created:", stagingTableName);
}


/* ============================================================
   LOAD CSV INTO STAGING TABLE
============================================================ */

async function loadCsvIntoExistingTable({ filePath, tableName }) {
  const table = bigquery.dataset(DATASET).table(tableName);

  const metadata = {
    sourceFormat: "CSV",
    skipLeadingRows: 1,
    autodetect: false,
    writeDisposition: "WRITE_APPEND",
    allowQuotedNewlines: true,
    allowJaggedRows: false,
    ignoreUnknownValues: false,
    fieldDelimiter: ",",
  };

  console.log("--------------------------------");
  console.log("Loading CSV into staging");
  console.log("Table:", tableName);
  console.log("File:", filePath);
  console.log("--------------------------------");

  const [job] = await table.createLoadJob(filePath, metadata);

  await job.promise();

  console.log("BigQuery Load Job:", job.id);

  const [jobMetadata] = await job.getMetadata();

  if (jobMetadata.status && jobMetadata.status.errorResult) {
    throw new Error(JSON.stringify(jobMetadata.status.errorResult));
  }

  if (
    jobMetadata.status &&
    jobMetadata.status.errors &&
    jobMetadata.status.errors.length > 0
  ) {
    throw new Error(JSON.stringify(jobMetadata.status.errors));
  }

  return {
    jobId: job.id,
    table: `${PROJECT_ID}.${DATASET}.${tableName}`,
  };
}


/* ============================================================
   VERIFY STAGING (row count + dates inside the range)
============================================================ */

async function getStagingValidation(stagingTableName, startDate, endDate) {
  const query = `
    SELECT
      COUNT(*) AS total_rows,
      COUNTIF(d BETWEEN DATE(@startDate) AND DATE(@endDate)) AS in_range_rows,
      COUNTIF(d IS NULL) AS invalid_date_rows
    FROM (
      SELECT SAFE.PARSE_DATE('%d-%m-%Y', TRIM(Sales_Date)) AS d
      FROM \`${PROJECT_ID}.${DATASET}.${stagingTableName}\`
    )
  `;

  const [rows] = await bigquery.query({
    query,
    params: { startDate, endDate },
    useLegacySql: false,
  });

  return {
    totalRows: Number(rows[0].total_rows),
    inRangeRows: Number(rows[0].in_range_rows),
    invalidDateRows: Number(rows[0].invalid_date_rows),
  };
}


/* ============================================================
   ARTICLE WISE UPLOAD (single day OR catch-up for missed days)

   options.startDate / options.endDate  (optional, "YYYY-MM-DD")

   Default behaviour (no options):
     startDate = latest date in BigQuery + 1 day
     endDate   = yesterday (India)

   Example: BigQuery latest = 2026-09-24, today = 2026-09-28
     -> uploads 2026-09-25, 2026-09-26, 2026-09-27

   Flow:
     find range -> read CSV -> validate -> filter range
     -> staging -> verify count + dates
     -> DELETE range from target + INSERT staging (transaction)
============================================================ */

async function uploadArticleWiseDaily(filePath, options = {}) {
  const targetTable = "Article_Wise_Report";

  console.log("");
  console.log("============================================");
  console.log("ARTICLE WISE UPLOAD");
  console.log("============================================");
  console.log("Source file:", filePath);

  /* ---------- Step 0: decide date range ---------- */

  const yesterday = getYesterdayIndiaDate();

  const manualStart = options.startDate ? String(options.startDate).trim() : "";
  const manualEnd = options.endDate ? String(options.endDate).trim() : "";

  if (manualStart && !isValidIsoDate(manualStart)) {
    throw new Error(`Invalid From date "${manualStart}". Use YYYY-MM-DD.`);
  }

  if (manualEnd && !isValidIsoDate(manualEnd)) {
    throw new Error(`Invalid To date "${manualEnd}". Use YYYY-MM-DD.`);
  }

  const latestInBigQuery = await getLatestDateInTable(targetTable);

  console.log("Latest date in BigQuery:", latestInBigQuery);
  console.log("Yesterday (India):", yesterday);

  let startDate;
  let endDate;
  let isManual = false;

  if (manualStart || manualEnd) {
    isManual = true;
    startDate = manualStart || manualEnd;
    endDate = manualEnd || manualStart;
  } else {
    endDate = yesterday;
    startDate = latestInBigQuery ? addDays(latestInBigQuery, 1) : yesterday;
  }

  if (endDate > yesterday) {
    throw new Error(
      `To date ${endDate} is after yesterday (${yesterday}). ` +
      `The CSV only contains data up to yesterday.`
    );
  }

  if (startDate > endDate) {
    return {
      success: true,
      message:
        `BigQuery is already up to date (latest date: ${latestInBigQuery}). ` +
        `Nothing to upload.`,
      latestDateInBigQuery: latestInBigQuery,
      startDate,
      endDate,
      rowsForTargetDate: 0,
    };
  }

  const daysToLoad = listDates(startDate, endDate).length;

  if (!isManual && daysToLoad > MAX_CATCHUP_DAYS) {
    throw new Error(
      `Automatic catch-up would load ${daysToLoad} days ` +
      `(${startDate} to ${endDate}), which is above the safety limit of ` +
      `${MAX_CATCHUP_DAYS}. Enter From/To dates manually. ` +
      `Nothing was changed in BigQuery.`
    );
  }

  console.log("Upload range:", startDate, "to", endDate, `(${daysToLoad} day(s))`);

  /* ---------- Step 1: read and filter CSV ---------- */

  const filtered = await createDateRangeCsv(filePath, startDate, endDate);

  if (filtered.selectedRows === 0) {
    return {
      success: false,
      message:
        `No rows found in the CSV for ${startDate} to ${endDate}. ` +
        `Latest date in this CSV: ${filtered.latestDateInCsv || "unknown"}. ` +
        `Nothing was changed in BigQuery.`,
      startDate,
      endDate,
      latestDateInBigQuery: latestInBigQuery,
      totalCsvRows: filtered.totalRows,
      rowsForTargetDate: 0,
    };
  }

  /* ---------- Step 2: staging ---------- */

  const stagingTable = `Article_Wise_Staging_${Date.now()}`;

  try {
    await createStagingTable(targetTable, stagingTable);

    const loadResult = await loadCsvIntoExistingTable({
      filePath: filtered.tempFile,
      tableName: stagingTable,
    });

    console.log("Staging load successful.");

    /* ---------- Step 3: verify staging ---------- */

    const check = await getStagingValidation(stagingTable, startDate, endDate);

    console.log("");
    console.log("--------------------------------");
    console.log("STAGING VERIFICATION");
    console.log("CSV selected rows:", filtered.selectedRows);
    console.log("Staging total rows:", check.totalRows);
    console.log("Rows inside date range:", check.inRangeRows);
    console.log("Invalid date rows:", check.invalidDateRows);
    console.log("--------------------------------");

    if (check.totalRows !== filtered.selectedRows) {
      throw new Error(
        `SAFETY CHECK FAILED. CSV selected ${filtered.selectedRows} rows, ` +
        `but staging contains ${check.totalRows}. ` +
        `Article_Wise_Report was NOT changed.`
      );
    }

    if (check.invalidDateRows > 0) {
      throw new Error(
        `DATE VALIDATION FAILED. ${check.invalidDateRows} staging row(s) ` +
        `have an invalid date. Article_Wise_Report was NOT changed.`
      );
    }

    if (check.inRangeRows !== filtered.selectedRows) {
      throw new Error(
        `DATE VALIDATION FAILED. Expected ${filtered.selectedRows} rows ` +
        `between ${startDate} and ${endDate}, but only ${check.inRangeRows} ` +
        `are in range. Article_Wise_Report was NOT changed.`
      );
    }

    /* ---------- Step 4: replace the range in target ---------- */

    const targetFullName = `\`${PROJECT_ID}.${DATASET}.${targetTable}\``;
    const stagingFullName = `\`${PROJECT_ID}.${DATASET}.${stagingTable}\``;

    const query = `
      BEGIN TRANSACTION;

      DELETE FROM ${targetFullName}
      WHERE SAFE.PARSE_DATE('%d-%m-%Y', TRIM(Sales_Date))
            BETWEEN DATE(@startDate) AND DATE(@endDate);

      INSERT INTO ${targetFullName}
      SELECT * FROM ${stagingFullName};

      COMMIT TRANSACTION;
    `;

    console.log("--------------------------------");
    console.log("Replacing date range in BigQuery");
    console.log("Range:", startDate, "to", endDate);
    console.log("Verified rows being inserted:", check.totalRows);
    console.log("--------------------------------");

    await bigquery.query({
      query,
      params: { startDate, endDate },
      useLegacySql: false,
    });

    console.log("Date range replaced successfully.");

    const datesLabel =
      startDate === endDate ? startDate : `${startDate} to ${endDate}`;

    return {
      success: true,
      message: `Article Wise data uploaded successfully for ${datesLabel}.`,
      startDate,
      endDate,
      targetDate: datesLabel,
      latestDateInBigQuery: latestInBigQuery,
      totalCsvRows: filtered.totalRows,
      rowsForTargetDate: filtered.selectedRows,
      rowsPerDate: filtered.rowsPerDate,
      missingDates: filtered.missingDates,
      stagingJobId: loadResult.jobId,
      stagingRows: check.totalRows,
      table: `${PROJECT_ID}.${DATASET}.${targetTable}`,
    };
  } finally {
    try {
      await bigquery.dataset(DATASET).table(stagingTable).delete();
      console.log("Staging table deleted:", stagingTable);
    } catch (cleanupError) {
      console.error("Could not delete staging table:", cleanupError.message);
    }

    if (filtered.tempFile && fs.existsSync(filtered.tempFile)) {
      try {
        fs.unlinkSync(filtered.tempFile);
      } catch (cleanupError) {
        console.error("Could not delete temporary CSV:", cleanupError.message);
      }
    }
  }
}


/* ============================================================
   NORMAL CSV UPLOAD  (used for ABP_Report, REPLACE mode)
============================================================ */

async function uploadCsvToBigQuery({ filePath, tableName, mode = "APPEND" }) {
  const table = bigquery.dataset(DATASET).table(tableName);

  const writeDisposition =
    mode === "REPLACE" ? "WRITE_TRUNCATE" : "WRITE_APPEND";

  const metadata = {
    sourceFormat: "CSV",
    skipLeadingRows: 1,
    autodetect: true,
    writeDisposition,
    allowQuotedNewlines: true,
    allowJaggedRows: false,
    ignoreUnknownValues: false,
    fieldDelimiter: ",",
  };

  console.log("--------------------------------");
  console.log("Uploading CSV");
  console.log("Table:", tableName);
  console.log("Mode:", mode);
  console.log("File:", filePath);
  console.log("--------------------------------");

  const [job] = await table.createLoadJob(filePath, metadata);

  await job.promise();

  console.log("BigQuery Job ID:", job.id);

  const [jobResult] = await job.getMetadata();

  if (jobResult.status && jobResult.status.errorResult) {
    throw new Error(JSON.stringify(jobResult.status.errorResult));
  }

  if (
    jobResult.status &&
    jobResult.status.errors &&
    jobResult.status.errors.length > 0
  ) {
    throw new Error(JSON.stringify(jobResult.status.errors));
  }

  return {
    jobId: job.id,
    table: `${PROJECT_ID}.${DATASET}.${tableName}`,
    mode,
    status: "SUCCESS",
  };
}


/* ============================================================
   EXPORTS
============================================================ */

module.exports = {
  uploadCsvToBigQuery,
  uploadArticleWiseDaily,
};