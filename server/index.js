const express = require('express');
const cors = require('cors');
const AWS = require('aws-sdk');
const vision = require('@google-cloud/vision');
const dotenv = require('dotenv');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

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

// Load Pokémon name list
const pokemonNames = fs.readFileSync('pokemon_names.txt', 'utf-8')
  .split('\n')
  .map(name => name.trim().toLowerCase())
  .filter(name => name.length > 0);

// Set name keywords
const setKeywords = [
  'base set', 'jungle', 'fossil', 'team rocket', 'gym heroes', 'gym challenge',
  'neo genesis', 'neo discovery', 'neo revelation', 'neo destiny', 'legendary collection',
  'expedition', 'aquapolis', 'skyridge', 'ex ruby', 'ex sandstorm', 'ex dragon',
  'ex team magma', 'ex hidden legends', 'ex fire red', 'diamond & pearl',
  'platinum', 'heartgold', 'black & white', 'xy', 'sun & moon', 'sword & shield',
  'scarlet & violet', 'celebrations', 'evolving skies', 'chilling reign', 'fusion strike',
  'vivid voltage', 'battle styles'
];

// Google Vision client
const googleCredentials = require('./gcloud-key.json');
const client = new vision.ImageAnnotatorClient({
  credentials: googleCredentials,
});

// Helper: find Pokémon name in text
function findPokemonName(text) {
  const lines = text.split('\n');
  for (let line of lines) {
    const clean = line.trim().toLowerCase();
    if (pokemonNames.includes(clean)) {
      return line.trim(); // preserve original casing
    }
  }
  return 'Unknown';
}

// Helper: find card number (e.g., 60/102)
function findCardNumber(text) {
  const match = text.match(/\b\d{1,3}\/\d{1,3}\b/);
  return match ? match[0] : 'Unknown';
}

// Helper: find set name using keywords
function findSetName(text) {
  const lowerText = text.toLowerCase();
  for (let keyword of setKeywords) {
    if (lowerText.includes(keyword)) {
      return keyword;
    }
  }
  return 'Unknown';
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

    // OCR analysis
    const [result] = await client.textDetection({ image: { content: buffer } });
    const text = result.textAnnotations[0]?.description || 'No text found';
    console.log('🔍 Full OCR text:\n', text);

    const name = findPokemonName(text);
    const cardNumber = findCardNumber(text);
    const setName = findSetName(text);

    const cardData = {
      name,
      cardNumber,
      setName,
      fullText: text,
      imageUrl,
    };

    // Save metadata to S3
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
