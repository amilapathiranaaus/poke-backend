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

// Load Pokémon names once at startup
const pokemonNames = fs.readFileSync('pokemon_names.txt', 'utf-8')
  .split('\n')
  .map(name => name.trim().toUpperCase())
  .filter(Boolean);

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

    const lines = text.split('\n').map(line => line.trim().toUpperCase());
    let cardName = 'Unknown';

    // Try matching any line with a known Pokémon name
    for (let line of lines) {
      if (pokemonNames.includes(line)) {
        cardName = line;
        break;
      }
    }

    // Fallback: look for names after BASIC, STAGE 1, etc.
    if (cardName === 'Unknown') {
      for (let i = 0; i < lines.length; i++) {
        if (['BASIC', 'STAGE 1', 'STAGE 2', 'V', 'VSTAR', 'VMAX'].includes(lines[i])) {
          const nextLine = lines[i + 1];
          if (pokemonNames.includes(nextLine)) {
            cardName = nextLine;
            break;
          }
        }
      }
    }

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
