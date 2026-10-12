const { BigQuery } = require("@google-cloud/bigquery");

const options = {
  projectId: process.env.GCP_PROJECT_ID,
};

if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  try {
    options.credentials = JSON.parse(
      process.env.GOOGLE_SERVICE_ACCOUNT_JSON
    );
  } catch (error) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON.",
      { cause: error }
    );
  }
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  options.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
}

const bigquery = new BigQuery(options);

module.exports = bigquery;