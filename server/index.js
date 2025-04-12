const express = require('express');
const cors = require('cors');
const AWS = require('aws-sdk');
const vision = require('@google-cloud/vision');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// AWS S3 setup
AWS.config.update({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const s3 = new AWS.S3();
const BUCKET = process.env.S3_BUCKET_NAME;

// Google Vision setup
const googleCredentials = require('./gcloud-key.json');
const client = new vision.ImageAnnotatorClient({
  credentials: googleCredentials,
});

// 🔍 Function to intelligently extract card name
function extractCardNameFromText(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
  let nameCandidate = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Skip too long lines or ones with digits/symbols
    if (line.length > 20 || /[\d@#\$%\^&\*\(\)\[\]\{\}]/.test(line)) continue;

    // If previous line is a keyword, use this one
    const prevLine = lines[i - 1]?.toUpperCase();
    if (['BASIC', 'STAGE 1', 'STAGE 2', 'V', 'VSTAR', 'VMAX'].includes(prevLine)) {
      return line;
    }

    // If it's a clean, capitalized short phrase, remember it
    if (
      /^[A-Z][a-z]+(?: [A-Z][a-z]+)?$/.test(line) &&
      (lines[i + 1]?.includes('damage') || lines[i + 1]?.length > 10)
    ) {
      nameCandidate = line;
    }
  }

  return nameCandidate || 'Unknown';
}

// POST /process-card
app.post('/process-card', async (req, res) => {
  try {
    const base64 = req.body.imageBase64.split(',')[1];
    const buffer = Buffer.from(base64, 'base64');
    const id = `pokemon-${Date.now()}`;
    const imageKey = `${id}.jpg`;
    const metadataKey = `${id}.json`;

    // Upload image to S3
    await s3.putObject({
      Bucket: BUCKET,
      Key: imageKey,
      Body: buffer,
      ContentType: 'image/jpeg',
    }).promise();

    const imageUrl = `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${imageKey}`;

    // Analyze with Google Cloud Vision
    const [result] = await client.textDetection({ image: { content: buffer } });
    const text = result.textAnnotations[0]?.description || 'No text found';
    console.log('🔍 Full OCR text:\n', text);

    const cardName = extractCardNameFromText(text);

    const cardData = {
      name: cardName,
      fullText: text,
      imageUrl,
    };

    // Save card metadata to S3
    await s3.putObject({
      Bucket: BUCKET,
      Key: metadataKey,
      Body: JSON.stringify(cardData),
      ContentType: 'application/json',
    }).promise();

    res.json(cardData);
  } catch (err) {
    console.error("❌ Error:", err);
    res.status(500).json({ error: 'Processing failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Server running on http://localhost:${PORT}`));
