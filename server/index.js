const express = require("express");
const AWS = require("aws-sdk");
const cors = require("cors");
const path = require("path"); // ✅ Add this

require("dotenv").config();

const app = express();
app.use(cors());

// ✅ Serve frontend from correct folder
app.use(express.static(path.join(__dirname, "../public")));

const s3 = new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  signatureVersion: "v4",
});

const BUCKET = process.env.S3_BUCKET_NAME;

app.get("/get-signed-url", async (req, res) => {
  const { filename } = req.query;

  const params = {
    Bucket: BUCKET,
    Key: filename,
    Expires: 60,
    ContentType: "image/jpeg",
  };

  const url = await s3.getSignedUrlPromise("putObject", params);
  res.json({ url });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running at http://localhost:${PORT}`));
