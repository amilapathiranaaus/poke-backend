const express = require('express');
const cors = require('cors');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const vision = require('@google-cloud/vision');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Load AWS credentials from environment variables or hardcoded for dev
const s3 = new S3Client({
  region: 'YOUR_REGION',
  credentials: {
    accessKeyId: 'YOUR_ACCESS_KEY_ID',
    secretAccessKey: 'YOUR_SECRET_ACCESS_KEY',
  },
});

const S3_BUCKET_NAME = 'YOUR_BUCKET_NAME';

// Load Google Vision credentials directly (no env needed)
const credentials = require('./gcloud-key.json');
const client = new vision.ImageAnnotatorClient({
  credentials: credentials,
});

// Route to generate a signed URL for uploading image
app.get('/get-signed-url', async (req, res) => {
  try {
    const filename = req.query.filename;
    console.log("Signing upload URL for:", filename);

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET_NAME,
      Key: filename,
      ContentType: 'image/jpeg',
    });

    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 60 });
    res.json({ url: signedUrl });

  } catch (error) {
    console.error("🔥 Error in /get-signed-url:", error);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Optional: route to use Google Vision on an image URL (future feature)
app.post('/detect-card', async (req, res) => {
  try {
    const { imageUrl } = req.body;
    const [result] = await client.textDetection(imageUrl);
    const detections = result.textAnnotations;
    res.json({ detections });
  } catch (error) {
    console.error("🔥 Error in /detect-card:", error);
    res.status(500).json({ error: "Failed to analyze image" });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Server is running on http://localhost:${PORT}`);
});
